// ChangeStore — Change/Release Management for Beacon.
//
// "Every deployment, config edit, maintenance window, or auto-
// remediation is logged here. When an incident opens, the
// correlation engine answers 'was anything just changed?' which is
// the single most useful question in operations."
//
// Schema:
//   • changes  (id=CHG-<hex>, type, asset_id, description, risk_level,
//               scheduled_at, started_at, completed_at, created_by,
//               status, metadata, source, related_runbook_run_id)
//
// Status transitions:
//   planned → in_progress → completed | failed | rolled_back
// The same row carries the full timeline so a "change history for
// asset X" query needs no joins.
//
// Hooks: the API surface fires onChangeCreated / onChangeCompleted
// via the existing PluginManager fan-out so external CMDBs / Slack /
// JIRA mirror state without core code knowing about them.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export type ChangeType = 'deployment' | 'config' | 'maintenance' | 'emergency' | 'auto-remediation';
export type ChangeStatus = 'planned' | 'in_progress' | 'completed' | 'failed' | 'rolled_back';
export type ChangeRisk = 'low' | 'medium' | 'high';
export type ChangeSource = 'manual' | 'runbook' | 'remediation' | 'workflow' | 'external';

export interface Change {
  id: string;
  type: ChangeType;
  status: ChangeStatus;
  riskLevel: ChangeRisk;
  /** Linked CMDB asset id, or null when the change isn't tied to one. */
  assetId: string | null;
  /** Optional ServerRegistry id for changes targeting a server before
   *  an asset row has been registered. The correlation engine reads
   *  this alongside assetId. */
  serverId: string | null;
  title: string;
  description: string | null;
  /** Author — username from the JWT subject for API-created rows;
   *  agent name for auto-remediation rows; or "system" for boot-time
   *  changes. */
  createdBy: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Source classifier — distinguishes a runbook execution from a
   *  hand-typed change-log entry. Used by ChangeCorrelation to
   *  weight a runbook change higher when matching to an incident. */
  source: ChangeSource;
  relatedRunbookRunId: string | null;
  relatedIncidentId: string | null;
  /** Free-form payload — config diff, version numbers, command list,
   *  etc. The API renders this as a key/value table; never trust as
   *  HTML. */
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeFilter {
  status?: ChangeStatus;
  type?: ChangeType;
  assetId?: string;
  serverId?: string;
  /** ISO string — only rows updated/created at or after this time. */
  since?: string;
  /** ISO string — only rows updated/created at or before this time. */
  until?: string;
}

export class ChangeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info('[ChangeStore] opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'planned',
        risk_level   TEXT NOT NULL DEFAULT 'medium',
        asset_id     TEXT,
        server_id    TEXT,
        title        TEXT NOT NULL,
        description  TEXT,
        created_by   TEXT,
        scheduled_at TEXT,
        started_at   TEXT,
        completed_at TEXT,
        source       TEXT NOT NULL DEFAULT 'manual',
        related_runbook_run_id TEXT,
        related_incident_id TEXT,
        metadata     TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chg_asset    ON changes(asset_id);
      CREATE INDEX IF NOT EXISTS idx_chg_server   ON changes(server_id);
      CREATE INDEX IF NOT EXISTS idx_chg_status   ON changes(status);
      CREATE INDEX IF NOT EXISTS idx_chg_created  ON changes(created_at);
      CREATE INDEX IF NOT EXISTS idx_chg_runbook  ON changes(related_runbook_run_id);
    `);
    addTenantColumnSqlite(this.db, 'changes');
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  create(input: {
    type: ChangeType;
    title: string;
    description?: string | null;
    riskLevel?: ChangeRisk;
    assetId?: string | null;
    serverId?: string | null;
    createdBy?: string | null;
    scheduledAt?: string | null;
    status?: ChangeStatus;
    source?: ChangeSource;
    relatedRunbookRunId?: string | null;
    relatedIncidentId?: string | null;
    metadata?: Record<string, unknown>;
  }): Change {
    if (!input.title?.trim()) throw new Error('title is required');
    const id = newChangeId();
    const now = new Date().toISOString();
    const status: ChangeStatus = input.status ?? 'planned';
    const row = {
      id,
      type: input.type,
      status,
      risk_level: input.riskLevel ?? 'medium',
      asset_id: input.assetId ?? null,
      server_id: input.serverId ?? null,
      title: input.title.trim(),
      description: input.description ?? null,
      created_by: input.createdBy ?? null,
      scheduled_at: input.scheduledAt ?? null,
      started_at: status === 'in_progress' ? now : null,
      completed_at: status === 'completed' || status === 'failed' || status === 'rolled_back' ? now : null,
      source: input.source ?? 'manual',
      related_runbook_run_id: input.relatedRunbookRunId ?? null,
      related_incident_id: input.relatedIncidentId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO changes (id, type, status, risk_level, asset_id, server_id, title, description, created_by, scheduled_at, started_at, completed_at, source, related_runbook_run_id, related_incident_id, metadata, created_at, updated_at)
      VALUES (@id, @type, @status, @risk_level, @asset_id, @server_id, @title, @description, @created_by, @scheduled_at, @started_at, @completed_at, @source, @related_runbook_run_id, @related_incident_id, @metadata, @created_at, @updated_at)
    `).run(row);
    return this.toChange(row);
  }

  get(id: string): Change | null {
    const row = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as any;
    return row ? this.toChange(row) : null;
  }

  list(filter: ChangeFilter = {}): Change[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.status)   { where.push('status = ?');    params.push(filter.status); }
    if (filter.type)     { where.push('type = ?');      params.push(filter.type); }
    if (filter.assetId)  { where.push('asset_id = ?');  params.push(filter.assetId); }
    if (filter.serverId) { where.push('server_id = ?'); params.push(filter.serverId); }
    if (filter.since)    { where.push('created_at >= ?'); params.push(filter.since); }
    if (filter.until)    { where.push('created_at <= ?'); params.push(filter.until); }
    const sql = `SELECT * FROM changes${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(r => this.toChange(r));
  }

  /** Patch — null/undefined fields preserve current values. Status
   *  transitions auto-stamp started_at and completed_at. */
  update(id: string, patch: Partial<{
    status: ChangeStatus;
    title: string;
    description: string | null;
    riskLevel: ChangeRisk;
    scheduledAt: string | null;
    metadata: Record<string, unknown>;
    relatedIncidentId: string | null;
  }>): Change | null {
    const existing = this.db.prepare('SELECT * FROM changes WHERE id = ?').get(id) as any;
    if (!existing) return null;
    const now = new Date().toISOString();
    const next: any = {
      ...existing,
      status: patch.status ?? existing.status,
      title: patch.title ?? existing.title,
      description: patch.description !== undefined ? patch.description : existing.description,
      risk_level: patch.riskLevel ?? existing.risk_level,
      scheduled_at: patch.scheduledAt !== undefined ? patch.scheduledAt : existing.scheduled_at,
      related_incident_id: patch.relatedIncidentId !== undefined ? patch.relatedIncidentId : existing.related_incident_id,
      updated_at: now,
    };
    if (patch.metadata !== undefined) {
      next.metadata = JSON.stringify({
        ...JSON.parse(existing.metadata || '{}'),
        ...patch.metadata,
      });
    }
    // Auto-stamp transition timestamps.
    if (patch.status && patch.status !== existing.status) {
      if (patch.status === 'in_progress' && !existing.started_at) next.started_at = now;
      if ((patch.status === 'completed' || patch.status === 'failed' || patch.status === 'rolled_back') && !existing.completed_at) next.completed_at = now;
    }
    this.db.prepare(`
      UPDATE changes SET status = ?, title = ?, description = ?, risk_level = ?, scheduled_at = ?, started_at = ?, completed_at = ?, related_incident_id = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.status, next.title, next.description, next.risk_level, next.scheduled_at,
      next.started_at, next.completed_at, next.related_incident_id, next.metadata, next.updated_at, id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM changes WHERE id = ?').run(id).changes > 0;
  }

  /** Window query — every change whose created_at falls in [since, until].
   *  Used by the correlation engine on every incident open. */
  changesInWindow(since: string, until: string, opts?: { assetId?: string; serverId?: string }): Change[] {
    const where = ['created_at >= ?', 'created_at <= ?'];
    const params: any[] = [since, until];
    if (opts?.assetId)  { where.push('asset_id  = ?'); params.push(opts.assetId); }
    if (opts?.serverId) { where.push('server_id = ?'); params.push(opts.serverId); }
    const sql = `SELECT * FROM changes WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as any[]).map(r => this.toChange(r));
  }

  stats(): { total: number; byStatus: Record<ChangeStatus, number>; byType: Record<ChangeType, number> } {
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM changes GROUP BY status').all() as any[]) {
      byStatus[r.status] = r.n;
    }
    const byType: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT type, COUNT(*) AS n FROM changes GROUP BY type').all() as any[]) {
      byType[r.type] = r.n;
    }
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number }).n;
    return { total, byStatus: byStatus as Record<ChangeStatus, number>, byType: byType as Record<ChangeType, number> };
  }

  close(): void { try { this.db.close(); } catch { /* idempotent */ } }

  private toChange(r: any): Change {
    return {
      id: r.id,
      type: r.type as ChangeType,
      status: r.status as ChangeStatus,
      riskLevel: r.risk_level as ChangeRisk,
      assetId: r.asset_id ?? null,
      serverId: r.server_id ?? null,
      title: r.title,
      description: r.description ?? null,
      createdBy: r.created_by ?? null,
      scheduledAt: r.scheduled_at ?? null,
      startedAt: r.started_at ?? null,
      completedAt: r.completed_at ?? null,
      source: (r.source as ChangeSource) ?? 'manual',
      relatedRunbookRunId: r.related_runbook_run_id ?? null,
      relatedIncidentId: r.related_incident_id ?? null,
      metadata: safeJson(r.metadata),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

function newChangeId(): string {
  return 'CHG-' + randomBytes(4).toString('hex').toUpperCase();
}

function safeJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

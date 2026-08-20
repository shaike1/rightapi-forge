// SQLite-backed persistence for itops-agents key stores

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Task } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from './tenantMigration.js';
import { getCurrentTenantId, SYSTEM_TENANT_ID } from '../tenancy/index.js';

export class SqliteTaskStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[SqliteTaskStore] Opened ${dbPath}`);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id          TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        status      TEXT NOT NULL,
        owner_id    TEXT NOT NULL,
        assigned_to TEXT,
        category    TEXT,
        priority    TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_owner    ON tasks(owner_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
    `);
    // Tenant scoping — adds the column to existing databases that
    // predate multi-tenancy. Idempotent: existing rows keep their
    // SYSTEM_TENANT_ID default and new writes stamp the active scope.
    addTenantColumnSqlite(this.db, 'tasks');

    // Composite indexes covering the (tenant_id, …) WHERE patterns used
    // by listByOwner / listByStatus / listByCategory. Created after the
    // tenant column migration so tenant_id always exists.
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status   ON tasks(tenant_id, status)'); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_owner    ON tasks(tenant_id, owner_id)'); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_category ON tasks(tenant_id, category)'); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_tenant_created  ON tasks(tenant_id, created_at DESC)'); } catch { /* exists */ }
  }

  /** Resolve the active tenant for the current call. Optional `tenantId`
   *  arg wins; otherwise getCurrentTenantId() reads the AsyncLocalStorage
   *  scope set by the request middleware. SYSTEM_TENANT_ID is the
   *  fallback for code paths outside any scope (background sweeps,
   *  bootstrap), keeping pre-multi-tenant deployments untouched. */
  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  upsert(task: Task, tenantId?: string): void {
    this.db.prepare(`
      INSERT INTO tasks (id, data, status, owner_id, assigned_to, category, priority, created_at, updated_at, tenant_id)
      VALUES (@id, @data, @status, @owner_id, @assigned_to, @category, @priority, @created_at, @updated_at, @tenant_id)
      ON CONFLICT(id) DO UPDATE SET
        data = excluded.data,
        status = excluded.status,
        assigned_to = excluded.assigned_to,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `).run({
      id: task.id,
      data: JSON.stringify(task),
      status: task.status,
      owner_id: task.ownerId,
      assigned_to: task.assignedTo ?? null,
      category: task.category,
      priority: task.priority,
      created_at: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
      updated_at: task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
      tenant_id: this.resolveTenant(tenantId),
    });
  }

  get(id: string, tenantId?: string): Task | undefined {
    const t = this.resolveTenant(tenantId);
    const row = this.db.prepare('SELECT data FROM tasks WHERE id = ? AND tenant_id = ?').get(id, t) as { data: string } | undefined;
    return row ? this.deserialize(row.data) : undefined;
  }

  getAll(tenantId?: string): Task[] {
    const t = this.resolveTenant(tenantId);
    return (this.db.prepare('SELECT data FROM tasks WHERE tenant_id = ? ORDER BY created_at DESC').all(t) as { data: string }[])
      .map(r => this.deserialize(r.data));
  }

  getByStatus(status: string, tenantId?: string): Task[] {
    const t = this.resolveTenant(tenantId);
    return (this.db.prepare('SELECT data FROM tasks WHERE status = ? AND tenant_id = ?').all(status, t) as { data: string }[])
      .map(r => this.deserialize(r.data));
  }

  getByOwner(ownerId: string, tenantId?: string): Task[] {
    const t = this.resolveTenant(tenantId);
    return (this.db.prepare('SELECT data FROM tasks WHERE owner_id = ? AND tenant_id = ?').all(ownerId, t) as { data: string }[])
      .map(r => this.deserialize(r.data));
  }

  getByCategory(category: string, tenantId?: string): Task[] {
    const t = this.resolveTenant(tenantId);
    return (this.db.prepare('SELECT data FROM tasks WHERE category = ? AND tenant_id = ?').all(category, t) as { data: string }[])
      .map(r => this.deserialize(r.data));
  }

  delete(id: string, tenantId?: string): void {
    const t = this.resolveTenant(tenantId);
    this.db.prepare('DELETE FROM tasks WHERE id = ? AND tenant_id = ?').run(id, t);
  }

  count(tenantId?: string): number {
    const t = this.resolveTenant(tenantId);
    return (this.db.prepare('SELECT COUNT(*) as n FROM tasks WHERE tenant_id = ?').get(t) as { n: number }).n;
  }

  private deserialize(data: string): Task {
    const t = JSON.parse(data);
    // Rehydrate Date fields
    if (t.createdAt && typeof t.createdAt === 'string') t.createdAt = new Date(t.createdAt);
    if (t.updatedAt && typeof t.updatedAt === 'string') t.updatedAt = new Date(t.updatedAt);
    return t as Task;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Incident Store ────────────────────────────────────────────────────────

export type IncidentSeverity = 'critical' | 'high' | 'medium' | 'low';
export type IncidentStatus   = 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed';
export type IncidentSource   = 'manual' | 'alert-rule' | 'agent';
export type TimelineEventType = 'opened' | 'escalated' | 'note' | 'resolved' | 'closed' | 'updated';

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  /** Free-form operator label. Pre-existing field — typically a human
   *  name/email, sometimes the display name of the assigned agent. */
  assignedTo: string | null;
  /** Stable agent id (uuid) assigned to handle the incident. Set by
   *  IncidentManager when it routes a new incident; cleared when the
   *  incident resolves. Distinct from `assignedTo` so queries can
   *  reliably find "all incidents agent X is working on" without
   *  fuzzy-matching display strings. */
  assignedAgent: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  source: IncidentSource;
  sourceRef: string | null;
  slaMinutes: number;
  jiraKey?: string;       // Jira ticket key e.g. "OPS-123"
  jiraUrl?: string;       // Full URL to Jira ticket
  ticketingSynced?: boolean;
  githubIssueNumber?: number;
  aiAnalysis?: string;    // JSON string of IncidentAnalysis
  /** Current escalation pipeline level for this incident.
   *    0 = new / not yet handled
   *    1 = agent ReAct loop running
   *    2 = auto-remediator running
   *    3 = human notified (OpenClaw alert sent, manual intervention requested)
   *    4 = critical (stuck at L3 past timeout — severity bumped, urgent alert) */
  escalationLevel?: number;
  /** ISO timestamp of when the current escalation level was set. Null at level 0. */
  escalatedAt?: string | null;
  /** Stable id of the server this incident is filed against (ServerRegistry).
   *  Nullable for backward compat — pre-multi-server incidents and manually
   *  filed rows don't have one. Health-monitor and alert-rule sources stamp
   *  it so the per-server breakdown in /api/external/status and the UI
   *  can group incidents by host. */
  serverId?: string | null;
  /** Username of the principal that created this incident. Set from the
   *  JWT subject on POST /api/incidents and POST /api/incidents/mine; null
   *  for legacy rows + system-generated incidents (alert-rule, agent,
   *  health-monitor) which run with no user context. Used by the self-
   *  service portal to scope `requester` accounts to their own rows. */
  createdBy?: string | null;
}

export interface TimelineEntry {
  id: string;
  incidentId: string;
  timestamp: string;
  actor: string;
  type: TimelineEventType;
  message: string;
}

export class SqliteIncidentStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[SqliteIncidentStore] Opened ${dbPath}`);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        severity    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        assigned_to TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        resolved_at TEXT,
        source      TEXT NOT NULL DEFAULT 'manual',
        source_ref  TEXT,
        sla_minutes INTEGER NOT NULL DEFAULT 240,
        jira_key    TEXT,
        jira_url    TEXT,
        ticketing_synced INTEGER NOT NULL DEFAULT 0,
        github_issue_number INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_inc_status   ON incidents(status);
      CREATE INDEX IF NOT EXISTS idx_inc_severity ON incidents(severity);
      -- AVG(resolved-created) on resolved-only rows reads every row with
      -- resolved_at IS NOT NULL — partial index keeps it cheap.
      CREATE INDEX IF NOT EXISTS idx_inc_resolved ON incidents(resolved_at) WHERE resolved_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS incident_timeline (
        id          TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        timestamp   TEXT NOT NULL,
        actor       TEXT NOT NULL DEFAULT 'system',
        type        TEXT NOT NULL,
        message     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tl_incident ON incident_timeline(incident_id);
    `);

    // Migration: add jira columns to existing databases
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN jira_key TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN jira_url TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN ai_analysis TEXT'); } catch { /* already exists */ }
    // Stable agent id assigned to the incident. Independent of the
    // free-form `assigned_to` operator label so queries can reliably
    // find "incidents currently owned by agent X" without fuzzy matching.
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN assigned_agent TEXT'); } catch { /* already exists */ }
    // Escalation pipeline state — see Incident.escalationLevel / escalatedAt
    // doc for semantics. Persisted so a process restart can resume the L3→L4
    // timer logic by comparing escalated_at against now().
    try { this.db.exec("ALTER TABLE incidents ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN escalated_at TEXT'); } catch { /* already exists */ }
    // Multi-server monitoring (Phase 33): which server this incident is
    // filed against. Nullable so old rows + operator-created incidents
    // without a server context still load cleanly.
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN server_id TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN ticketing_synced INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN github_issue_number INTEGER'); } catch { /* already exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_inc_server ON incidents(server_id)'); } catch { /* exists */ }
    // Self-service portal: track creator so requester accounts can be
    // scoped to their own rows. Nullable so legacy + system-generated
    // incidents (alert-rule, agent, health-monitor) still load cleanly.
    try { this.db.exec('ALTER TABLE incidents ADD COLUMN created_by TEXT'); } catch { /* already exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_inc_created_by ON incidents(created_by)'); } catch { /* exists */ }

    // Tenant scoping for the legacy incident tables. Existing rows get
    // SYSTEM_TENANT_ID; new rows pick up the active scope at write time.
    addTenantColumnSqlite(this.db, 'incidents');
    addTenantColumnSqlite(this.db, 'incident_timeline');

    // Composite index for the most common query pattern: list incidents
    // for a tenant newest-first. Created after the tenant migration so
    // the column exists. Covers list() + getByUser() ORDER BYs.
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_inc_tenant_created ON incidents(tenant_id, created_at DESC)'); } catch { /* exists */ }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS incidents_fts USING fts5(
        id UNINDEXED,
        title,
        description,
        content='incidents',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS incidents_ai AFTER INSERT ON incidents BEGIN
        INSERT INTO incidents_fts(rowid, id, title, description) VALUES (new.rowid, new.id, new.title, COALESCE(new.description,''));
      END;

      CREATE TRIGGER IF NOT EXISTS incidents_ad AFTER DELETE ON incidents BEGIN
        INSERT INTO incidents_fts(incidents_fts, rowid, id, title, description) VALUES('delete', old.rowid, old.id, old.title, COALESCE(old.description,''));
      END;

      CREATE TRIGGER IF NOT EXISTS incidents_au AFTER UPDATE ON incidents BEGIN
        INSERT INTO incidents_fts(incidents_fts, rowid, id, title, description) VALUES('delete', old.rowid, old.id, old.title, COALESCE(old.description,''));
        INSERT INTO incidents_fts(rowid, id, title, description) VALUES (new.rowid, new.id, new.title, COALESCE(new.description,''));
      END;
    `);
  }

  /** Resolve the active tenant for the call. Same fallback semantics as
   *  SqliteTaskStore.resolveTenant(). */
  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  upsert(inc: Incident, tenantId?: string): void {
    this.db.prepare(`
      INSERT INTO incidents (id,title,description,severity,status,assigned_to,assigned_agent,created_at,updated_at,resolved_at,source,source_ref,sla_minutes,jira_key,jira_url,escalation_level,escalated_at,server_id,created_by,tenant_id,ticketing_synced,github_issue_number)
      VALUES (@id,@title,@description,@severity,@status,@assigned_to,@assigned_agent,@created_at,@updated_at,@resolved_at,@source,@source_ref,@sla_minutes,@jira_key,@jira_url,@escalation_level,@escalated_at,@server_id,@created_by,@tenant_id,@ticketing_synced,@github_issue_number)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, description=excluded.description,
        severity=excluded.severity, status=excluded.status,
        assigned_to=excluded.assigned_to, assigned_agent=excluded.assigned_agent,
        updated_at=excluded.updated_at,
        resolved_at=excluded.resolved_at, source_ref=excluded.source_ref,
        jira_key=excluded.jira_key, jira_url=excluded.jira_url,
        escalation_level=excluded.escalation_level, escalated_at=excluded.escalated_at,
        server_id=excluded.server_id,
        ticketing_synced=excluded.ticketing_synced, github_issue_number=excluded.github_issue_number
    `).run({
      id: inc.id, title: inc.title, description: inc.description,
      severity: inc.severity, status: inc.status,
      assigned_to: inc.assignedTo ?? null,
      assigned_agent: inc.assignedAgent ?? null,
      created_at: inc.createdAt, updated_at: inc.updatedAt,
      resolved_at: inc.resolvedAt ?? null,
      source: inc.source, source_ref: inc.sourceRef ?? null,
      sla_minutes: inc.slaMinutes,
      jira_key: inc.jiraKey ?? null,
      jira_url: inc.jiraUrl ?? null,
      escalation_level: inc.escalationLevel ?? 0,
      escalated_at: inc.escalatedAt ?? null,
      server_id: inc.serverId ?? null,
      // created_by deliberately is NOT in the ON CONFLICT update list —
      // we never want a later upsert to rewrite who originally filed the
      // ticket. The INSERT path stamps it; subsequent updates preserve it.
      created_by: inc.createdBy ?? null,
      tenant_id: this.resolveTenant(tenantId),
      ticketing_synced: inc.ticketingSynced ? 1 : 0,
      github_issue_number: inc.githubIssueNumber ?? null,
    });
  }

  /** List incidents this principal created. Used by /api/incidents/mine
   *  for the self-service portal. Tenant-scoped like list(). */
  listByCreator(username: string, tenantId?: string): Incident[] {
    const t = this.resolveTenant(tenantId);
    const rows = this.db.prepare(
      'SELECT * FROM incidents WHERE created_by = ? AND tenant_id = ? ORDER BY created_at DESC'
    ).all(username, t) as any[];
    return rows.map(r => this.rowToIncident(r));
  }

  addTimeline(entry: TimelineEntry, tenantId?: string): void {
    this.db.prepare(`
      INSERT INTO incident_timeline (id, incident_id, timestamp, actor, type, message, tenant_id)
      VALUES (@id, @incident_id, @timestamp, @actor, @type, @message, @tenant_id)
    `).run({
      id: entry.id, incident_id: entry.incidentId,
      timestamp: entry.timestamp, actor: entry.actor,
      type: entry.type, message: entry.message,
      tenant_id: this.resolveTenant(tenantId),
    });
  }

  get(id: string, tenantId?: string): Incident | null {
    const t = this.resolveTenant(tenantId);
    const row = this.db.prepare('SELECT * FROM incidents WHERE id = ? AND tenant_id = ?').get(id, t) as any;
    return row ? this.rowToIncident(row) : null;
  }

  list(filter?: { status?: string; severity?: string; assignedTo?: string; tenantId?: string }): Incident[] {
    const t = this.resolveTenant(filter?.tenantId);
    let q = 'SELECT * FROM incidents WHERE tenant_id = ?';
    const params: any[] = [t];
    if (filter?.status)     { q += ' AND status = ?';      params.push(filter.status); }
    if (filter?.severity)   { q += ' AND severity = ?';    params.push(filter.severity); }
    if (filter?.assignedTo) { q += ' AND assigned_to = ?'; params.push(filter.assignedTo); }
    q += ' ORDER BY created_at DESC';
    return (this.db.prepare(q).all(...params) as any[]).map(r => this.rowToIncident(r));
  }

  search(q: string, tenantId?: string): string[] {
    const t = this.resolveTenant(tenantId);
    // Join FTS results back to incidents to apply the tenant filter — the
    // FTS table itself is content-mirroring and doesn't carry tenant_id.
    const rows = this.db.prepare(`
      SELECT i.id FROM incidents_fts f
      JOIN incidents i ON i.id = f.id
      WHERE incidents_fts MATCH ? AND i.tenant_id = ?
      ORDER BY rank
    `).all(q, t) as { id: string }[];
    return rows.map(r => r.id);
  }

  getTimeline(incidentId: string, tenantId?: string): TimelineEntry[] {
    const t = this.resolveTenant(tenantId);
    return (this.db.prepare(
      'SELECT * FROM incident_timeline WHERE incident_id = ? AND tenant_id = ? ORDER BY timestamp ASC'
    ).all(incidentId, t) as any[]).map(r => ({
      id: r.id, incidentId: r.incident_id,
      timestamp: r.timestamp, actor: r.actor,
      type: r.type as TimelineEventType, message: r.message
    }));
  }

  stats(): { open: number; investigating: number; resolved: number; avgResolutionMinutes: number; slaBreaches: number } {
    const counts = this.db.prepare(`
      SELECT status, COUNT(*) as n FROM incidents GROUP BY status
    `).all() as { status: string; n: number }[];
    const byStatus: Record<string, number> = {};
    for (const { status, n } of counts) byStatus[status] = n;

    const resolved = this.db.prepare(`
      SELECT AVG(
        (julianday(resolved_at) - julianday(created_at)) * 1440
      ) as avg_min FROM incidents WHERE resolved_at IS NOT NULL
    `).get() as { avg_min: number | null };

    const breaches = this.db.prepare(`
      SELECT COUNT(*) as n FROM incidents
      WHERE status NOT IN ('resolved','closed')
        AND (julianday('now') - julianday(created_at)) * 1440 > sla_minutes
    `).get() as { n: number };

    return {
      open: byStatus['open'] ?? 0,
      investigating: byStatus['investigating'] ?? 0,
      resolved: byStatus['resolved'] ?? 0,
      avgResolutionMinutes: Math.round(resolved.avg_min ?? 0),
      slaBreaches: breaches.n
    };
  }

  private rowToIncident(r: any): Incident {
    return {
      id: r.id, title: r.title, description: r.description,
      severity: r.severity, status: r.status,
      assignedTo: r.assigned_to ?? null,
      assignedAgent: r.assigned_agent ?? null,
      createdAt: r.created_at, updatedAt: r.updated_at,
      resolvedAt: r.resolved_at ?? null,
      source: r.source, sourceRef: r.source_ref ?? null,
      slaMinutes: r.sla_minutes,
      jiraKey: r.jira_key ?? undefined,
      jiraUrl: r.jira_url ?? undefined,
      aiAnalysis: r.ai_analysis ?? undefined,
      escalationLevel: typeof r.escalation_level === 'number' ? r.escalation_level : 0,
      escalatedAt: r.escalated_at ?? null,
      serverId: r.server_id ?? null,
      createdBy: r.created_by ?? null,
      ticketingSynced: !!r.ticketing_synced,
      githubIssueNumber: typeof r.github_issue_number === 'number' ? r.github_issue_number : undefined,
    };
  }

  markTicketingSynced(id: string, githubIssueNumber?: number): void {
    this.db.prepare('UPDATE incidents SET ticketing_synced = 1, github_issue_number = coalesce(?, github_issue_number), updated_at = ? WHERE id = ?')
      .run(githubIssueNumber ?? null, new Date().toISOString(), id);
  }

  updateGitHubIssueNumber(id: string, issueNumber: number): void {
    this.db.prepare('UPDATE incidents SET github_issue_number = ?, updated_at = ? WHERE id = ?')
      .run(issueNumber, new Date().toISOString(), id);
  }

  updateJiraKey(id: string, jiraKey: string, jiraUrl: string): void {
    this.db.prepare('UPDATE incidents SET jira_key = ?, jira_url = ?, updated_at = ? WHERE id = ?')
      .run(jiraKey, jiraUrl, new Date().toISOString(), id);
  }

  saveAnalysis(id: string, analysisJson: string): void {
    this.db.prepare('UPDATE incidents SET ai_analysis = ?, updated_at = ? WHERE id = ?')
      .run(analysisJson, new Date().toISOString(), id);
  }

  purge(opts: { maxAgeDays?: number; keepLatest?: number; statusFilter?: string[]; dryRun?: boolean }): number {
    const { maxAgeDays = 30, keepLatest = 500, statusFilter = ['resolved', 'closed'], dryRun = false } = opts;

    if (statusFilter.length === 0) return 0;

    const statusPlaceholders = statusFilter.map(() => '?').join(', ');
    const clauses: string[] = [];
    const params: unknown[] = [...statusFilter];
    if (maxAgeDays > 0) {
      clauses.push('created_at < ?');
      params.push(new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString());
    }
    if (keepLatest > 0) {
      clauses.push(`id NOT IN (SELECT id FROM incidents WHERE status IN (${statusPlaceholders}) ORDER BY created_at DESC LIMIT ?)`);
      params.push(...statusFilter, keepLatest);
    }
    if (clauses.length === 0) return 0;
    const where = `status IN (${statusPlaceholders}) AND (${clauses.join(' OR ')})`;
    if (dryRun) return (this.db.prepare(`SELECT COUNT(*) AS n FROM incidents WHERE ${where}`).get(...params) as { n: number }).n;
    return this.db.prepare(`DELETE FROM incidents WHERE ${where}`).run(...params).changes;
  }

  close(): void { this.db.close(); }
}

// ─── Agent Memory Store ────────────────────────────────────────────────────

export interface ResolutionStep {
  tool?: string;
  params?: unknown;
  result?: string;
  thought?: string;
}

export interface ResolutionRecord {
  id: string;
  agent_id: string;
  incident_title: string;
  incident_severity: string;
  resolution: string;
  runbook_used: string | null;
  problem_description: string;
  steps_tried: ResolutionStep[];
  what_worked: string;
  resolution_time_ms: number;
  outcome: 'success' | 'partial' | 'failed';
  created_at: string;
}

// Reflection record on the way in (mirrors SelfReflection.ReflectionResult
// but with the optional taskTitle the store wants for keyword recall).
export interface ReflectionRecord {
  taskId: string;
  agentId: string;
  selfRating: number;
  whatWorked: string[];
  whatDidntWork: string[];
  lessonsLearned: string[];
  suggestedImprovements: string[];
  toolEfficiency: Array<{ tool: string; useful: boolean; reason: string }>;
  wouldDoDifferently: string;
  taskTitle?: string;
  timestamp?: string;
}

// Reflection record on the way out (adds the storage-assigned id).
export interface StoredReflection extends Required<Omit<ReflectionRecord, 'timestamp'>> {
  id: string;
  timestamp: string;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch { return []; }
}

function parseJsonObjectArray(value: unknown): any[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function rowToReflection(r: any): StoredReflection {
  return {
    id: r.id,
    taskId: r.task_id,
    agentId: r.agent_id,
    selfRating: typeof r.self_rating === 'number' ? r.self_rating : 0,
    whatWorked: parseJsonArray(r.what_worked),
    whatDidntWork: parseJsonArray(r.what_didnt_work),
    lessonsLearned: parseJsonArray(r.lessons_learned),
    suggestedImprovements: parseJsonArray(r.suggested_improvements),
    toolEfficiency: parseJsonObjectArray(r.tool_efficiency).map((e: any) => ({
      tool: typeof e?.tool === 'string' ? e.tool : '',
      useful: !!e?.useful,
      reason: typeof e?.reason === 'string' ? e.reason : '',
    })),
    wouldDoDifferently: typeof r.would_do_differently === 'string' ? r.would_do_differently : '',
    taskTitle: typeof r.task_title === 'string' ? r.task_title : '',
    timestamp: r.timestamp,
  };
}

function rowToResolutionRecord(r: any): ResolutionRecord {
  let steps: ResolutionStep[] = [];
  try { steps = JSON.parse(r.steps_tried ?? '[]'); } catch { steps = []; }
  return {
    id: r.id,
    agent_id: r.agent_id ?? '',
    incident_title: r.incident_title,
    incident_severity: r.incident_severity,
    resolution: r.resolution,
    runbook_used: r.runbook_used ?? null,
    problem_description: r.problem_description ?? '',
    steps_tried: steps,
    what_worked: r.what_worked ?? '',
    resolution_time_ms: typeof r.resolution_time_ms === 'number' ? r.resolution_time_ms : 0,
    outcome: (r.outcome as ResolutionRecord['outcome']) ?? 'success',
    created_at: r.created_at,
  };
}

export class SqliteAgentMemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_facts (
        agent_id   TEXT NOT NULL,
        fact       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, fact)
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_agent ON agent_messages(agent_id, id DESC);
    `);
    logger.info('[SqliteAgentMemoryStore] Opened', { dbPath });
    this.migrateResolutions();
    this.migrateReflections();
    // Tenant scoping. Adds tenant_id to every memory table created
    // before this migration; new rows pick up the active scope at
    // write time. Idempotent across re-runs.
    addTenantColumnSqlite(this.db, 'agent_facts');
    addTenantColumnSqlite(this.db, 'agent_messages');
    addTenantColumnSqlite(this.db, 'agent_resolutions');
    addTenantColumnSqlite(this.db, 'agent_reflections');
  }

  /** Resolve the active tenant for the call. */
  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  private migrateResolutions(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_resolutions (
        id           TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL,
        incident_title    TEXT NOT NULL,
        incident_severity TEXT NOT NULL DEFAULT 'medium',
        resolution   TEXT NOT NULL,
        runbook_used TEXT,
        tags         TEXT NOT NULL DEFAULT '[]',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_res_agent ON agent_resolutions(agent_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS agent_resolutions_fts USING fts5(
        id UNINDEXED,
        agent_id UNINDEXED,
        incident_title,
        resolution,
        tags,
        content='agent_resolutions',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS agent_res_ai AFTER INSERT ON agent_resolutions BEGIN
        INSERT INTO agent_resolutions_fts(rowid, id, agent_id, incident_title, resolution, tags)
        VALUES (new.rowid, new.id, new.agent_id, new.incident_title, new.resolution, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS agent_res_ad AFTER DELETE ON agent_resolutions BEGIN
        INSERT INTO agent_resolutions_fts(agent_resolutions_fts, rowid, id, agent_id, incident_title, resolution, tags)
        VALUES ('delete', old.rowid, old.id, old.agent_id, old.incident_title, old.resolution, old.tags);
      END;
    `);

    // Augmented incident-memory columns (idempotent — older DBs add the columns,
    // new DBs already have them via the CREATE above which we keep additive).
    try { this.db.exec(`ALTER TABLE agent_resolutions ADD COLUMN problem_description TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE agent_resolutions ADD COLUMN steps_tried TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE agent_resolutions ADD COLUMN what_worked TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE agent_resolutions ADD COLUMN resolution_time_ms INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE agent_resolutions ADD COLUMN outcome TEXT NOT NULL DEFAULT 'success'`); } catch { /* exists */ }
  }

  saveFact(agentId: string, fact: string, tenantId?: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO agent_facts(agent_id, fact, tenant_id) VALUES (?, ?, ?)`)
      .run(agentId, fact, this.resolveTenant(tenantId));
  }

  // alias for API consistency
  rememberFact(agentId: string, fact: string, tenantId?: string): void {
    this.saveFact(agentId, fact, tenantId);
  }

  getFacts(agentId: string, tenantId?: string): { fact: string; created_at: string }[] {
    return this.db.prepare(
      `SELECT fact, created_at FROM agent_facts WHERE agent_id = ? AND tenant_id = ? ORDER BY created_at`
    ).all(agentId, this.resolveTenant(tenantId)) as { fact: string; created_at: string }[];
  }

  listFacts(agentId: string, tenantId?: string): string[] {
    return (this.getFacts(agentId, tenantId)).map(r => r.fact);
  }

  storeResolution(
    agentId: string,
    incident: { title: string; severity: string },
    resolution: string,
    runbookUsed?: string
  ): void {
    this.recordResolution({
      agentId,
      incidentTitle: incident.title,
      incidentSeverity: incident.severity,
      problemDescription: '',
      stepsTried: [],
      whatWorked: resolution,
      resolution,
      runbookUsed,
      resolutionTimeMs: 0,
      outcome: 'success'
    });
  }

  /**
   * Rich resolution record used by the ReAct executor. Captures problem description,
   * the chronological steps the agent tried, what worked, total resolution time, and
   * outcome — so future tasks can learn from prior incidents (Agent Memory System).
   */
  recordResolution(input: {
    agentId: string;
    incidentTitle: string;
    incidentSeverity?: string;
    problemDescription?: string;
    stepsTried?: Array<{ tool?: string; params?: unknown; result?: string; thought?: string }>;
    whatWorked?: string;
    resolution: string;
    runbookUsed?: string;
    resolutionTimeMs?: number;
    outcome?: 'success' | 'partial' | 'failed';
  }): string {
    const id = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const severity = input.incidentSeverity || 'medium';
    const stepsJson = JSON.stringify(input.stepsTried ?? []);
    const tags = JSON.stringify([
      'incident-resolution',
      severity,
      input.outcome ?? 'success',
      ...input.incidentTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 8)
    ]);

    const tenant = this.resolveTenant();
    this.db.prepare(`
      INSERT INTO agent_resolutions
        (id, agent_id, incident_title, incident_severity, resolution, runbook_used, tags,
         problem_description, steps_tried, what_worked, resolution_time_ms, outcome, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.agentId,
      input.incidentTitle,
      severity,
      input.resolution,
      input.runbookUsed ?? null,
      tags,
      input.problemDescription ?? '',
      stepsJson,
      input.whatWorked ?? input.resolution,
      Math.max(0, Math.round(input.resolutionTimeMs ?? 0)),
      input.outcome ?? 'success',
      tenant,
    );

    const factText = `Resolved "${input.incidentTitle}" (${severity}, ${input.outcome ?? 'success'}, ${Math.round((input.resolutionTimeMs ?? 0) / 1000)}s): ${(input.whatWorked ?? input.resolution).slice(0, 200)}`;
    this.saveFact(input.agentId, factText, tenant);
    return id;
  }

  recallSimilarResolutions(
    agentId: string,
    incidentTitle: string,
    severity: string,
    limit = 5
  ): ResolutionRecord[] {
    const cols = `r.id, r.agent_id, r.incident_title, r.incident_severity, r.resolution,
                  r.runbook_used, r.problem_description, r.steps_tried, r.what_worked,
                  r.resolution_time_ms, r.outcome, r.created_at`;

    // Try FTS first
    try {
      const words = incidentTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const query = words.map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
        const rows = this.db.prepare(`
          SELECT ${cols}
          FROM agent_resolutions_fts f
          JOIN agent_resolutions r ON f.id = r.id
          WHERE f.agent_id = ? AND agent_resolutions_fts MATCH ?
          ORDER BY f.rank
          LIMIT ?
        `).all(agentId, query, limit) as any[];
        if (rows.length > 0) return rows.map(rowToResolutionRecord);
      }
    } catch { /* fall through to LIKE */ }

    // Fallback: LIKE search on title + severity-priority order
    const keyword = `%${incidentTitle.slice(0, 40)}%`;
    const rows = this.db.prepare(`
      SELECT ${cols}
      FROM agent_resolutions r
      WHERE r.agent_id = ? AND (r.incident_title LIKE ? OR ? = '')
      ORDER BY (r.incident_severity = ?) DESC, r.created_at DESC
      LIMIT ?
    `).all(agentId, keyword, keyword, severity, limit) as any[];
    return rows.map(rowToResolutionRecord);
  }

  /**
   * Build a compact prompt fragment summarising similar past incidents the agent
   * resolved. Returned as a markdown block ready to inject into a system prompt.
   * Returns empty string if no similar incidents exist.
   */
  buildIncidentRecallPrompt(
    agentId: string,
    incidentTitle: string,
    severity: string,
    limit = 3
  ): string {
    const records = this.recallSimilarResolutions(agentId, incidentTitle, severity, limit);
    if (records.length === 0) return '';

    const lines: string[] = ['## Past Similar Incidents (for reference, not authoritative)'];
    for (const r of records) {
      const when = r.created_at?.slice(0, 10) ?? 'unknown';
      const dur = r.resolution_time_ms > 0
        ? `${Math.round(r.resolution_time_ms / 1000)}s`
        : 'n/a';
      lines.push(`- [${when}] "${r.incident_title}" (${r.incident_severity}, ${r.outcome}, ${dur})`);
      if (r.problem_description) lines.push(`    problem: ${r.problem_description.slice(0, 200)}`);
      if (r.what_worked) lines.push(`    what worked: ${r.what_worked.slice(0, 240)}`);
      if (r.steps_tried.length > 0) {
        const tools = r.steps_tried.map(s => s.tool).filter(Boolean).slice(0, 6);
        if (tools.length > 0) lines.push(`    steps: ${tools.join(' → ')}`);
      }
      if (r.runbook_used) lines.push(`    runbook: ${r.runbook_used}`);
    }
    return lines.join('\n');
  }

  getMemoryStats(agentId: string): { totalFacts: number; resolutionPatterns: number; lastUpdated: string | null } {
    const factsRow = this.db.prepare(
      `SELECT COUNT(*) as n, MAX(created_at) as last FROM agent_facts WHERE agent_id = ?`
    ).get(agentId) as { n: number; last: string | null };

    let resRow: { n: number; last: string | null } = { n: 0, last: null };
    try {
      resRow = this.db.prepare(
        `SELECT COUNT(*) as n, MAX(created_at) as last FROM agent_resolutions WHERE agent_id = ?`
      ).get(agentId) as { n: number; last: string | null };
    } catch { /* table may not exist yet */ }

    const lastUpdated = [factsRow.last, resRow.last]
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    return {
      totalFacts: factsRow.n,
      resolutionPatterns: resRow.n,
      lastUpdated
    };
  }

  clearAll(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_facts WHERE agent_id = ?`).run(agentId);
    try {
      this.db.prepare(`DELETE FROM agent_resolutions WHERE agent_id = ?`).run(agentId);
    } catch { /* table may not exist */ }
    this.clearMessages(agentId);
  }

  listResolutions(agentId: string): ResolutionRecord[] {
    const rows = this.db.prepare(`
      SELECT id, agent_id, incident_title, incident_severity, resolution, runbook_used,
             problem_description, steps_tried, what_worked, resolution_time_ms, outcome,
             created_at
      FROM agent_resolutions
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `).all(agentId) as any[];
    return rows.map(rowToResolutionRecord);
  }

  saveMessage(agentId: string, role: string, content: string, tenantId?: string): void {
    this.db.prepare(`INSERT INTO agent_messages(agent_id, role, content, tenant_id) VALUES (?, ?, ?, ?)`)
      .run(agentId, role, content, this.resolveTenant(tenantId));
  }

  getRecentMessages(agentId: string, limit = 50, tenantId?: string): { role: string; content: string }[] {
    const t = this.resolveTenant(tenantId);
    const rows = this.db.prepare(
      `SELECT role, content FROM agent_messages WHERE agent_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT ?`
    ).all(agentId, t, limit) as { role: string; content: string }[];
    return rows.reverse();
  }

  clearMessages(agentId: string, tenantId?: string): void {
    this.db.prepare(`DELETE FROM agent_messages WHERE agent_id = ? AND tenant_id = ?`)
      .run(agentId, this.resolveTenant(tenantId));
  }

  purgeMessages(opts: { maxAgeDays?: number; keepLatestPerAgent?: number; dryRun?: boolean }): number {
    const { maxAgeDays = 60, keepLatestPerAgent = 200, dryRun = false } = opts;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (maxAgeDays > 0) {
      clauses.push('created_at < ?');
      params.push(new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString());
    }
    if (keepLatestPerAgent > 0) {
      clauses.push(`id NOT IN (
          SELECT id FROM agent_messages am2
          WHERE am2.agent_id = agent_messages.agent_id
          ORDER BY id DESC LIMIT ?
        )`);
      params.push(keepLatestPerAgent);
    }
    if (clauses.length === 0) return 0;
    const where = clauses.map(clause => `(${clause})`).join(' OR ');
    if (dryRun) return (this.db.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE ${where}`).get(...params) as { n: number }).n;
    return this.db.prepare(`DELETE FROM agent_messages WHERE ${where}`).run(...params).changes;
  }

  purgeFacts(opts: { maxAgeDays?: number; dryRun?: boolean }): number {
    const { maxAgeDays = 60, dryRun = false } = opts;
    if (maxAgeDays <= 0) return 0;

    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    if (dryRun) return (this.db.prepare('SELECT COUNT(*) AS n FROM agent_facts WHERE created_at < ?').get(cutoff) as { n: number }).n;
    return this.db.prepare('DELETE FROM agent_facts WHERE created_at < ?').run(cutoff).changes;
  }

  // ─── Self-reflection storage ────────────────────────────────────────────

  private migrateReflections(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_reflections (
        id                     TEXT PRIMARY KEY,
        task_id                TEXT NOT NULL,
        agent_id               TEXT NOT NULL,
        self_rating            INTEGER NOT NULL,
        what_worked            TEXT NOT NULL DEFAULT '[]',
        what_didnt_work        TEXT NOT NULL DEFAULT '[]',
        lessons_learned        TEXT NOT NULL DEFAULT '[]',
        suggested_improvements TEXT NOT NULL DEFAULT '[]',
        tool_efficiency        TEXT NOT NULL DEFAULT '[]',
        would_do_differently   TEXT NOT NULL DEFAULT '',
        task_title             TEXT NOT NULL DEFAULT '',
        timestamp              TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_refl_agent  ON agent_reflections(agent_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_refl_rating ON agent_reflections(agent_id, self_rating);
    `);
    // task_title column was added later — older DBs won't have it.
    try { this.db.exec(`ALTER TABLE agent_reflections ADD COLUMN task_title TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
  }

  storeReflection(reflection: ReflectionRecord, tenantId?: string): string {
    const id = `refl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO agent_reflections
        (id, task_id, agent_id, self_rating, what_worked, what_didnt_work,
         lessons_learned, suggested_improvements, tool_efficiency,
         would_do_differently, task_title, timestamp, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      reflection.taskId,
      reflection.agentId,
      reflection.selfRating,
      JSON.stringify(reflection.whatWorked ?? []),
      JSON.stringify(reflection.whatDidntWork ?? []),
      JSON.stringify(reflection.lessonsLearned ?? []),
      JSON.stringify(reflection.suggestedImprovements ?? []),
      JSON.stringify(reflection.toolEfficiency ?? []),
      reflection.wouldDoDifferently ?? '',
      reflection.taskTitle ?? '',
      reflection.timestamp ?? new Date().toISOString(),
      this.resolveTenant(tenantId),
    );
    return id;
  }

  getReflections(agentId: string, limit = 50, tenantId?: string): StoredReflection[] {
    const t = this.resolveTenant(tenantId);
    const rows = this.db.prepare(`
      SELECT id, task_id, agent_id, self_rating, what_worked, what_didnt_work,
             lessons_learned, suggested_improvements, tool_efficiency,
             would_do_differently, task_title, timestamp
      FROM agent_reflections
      WHERE agent_id = ? AND tenant_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(agentId, t, limit) as any[];
    return rows.map(rowToReflection);
  }

  getReflectionsByRating(agentId: string, minRating = 1, maxRating = 5, limit = 50, tenantId?: string): StoredReflection[] {
    const t = this.resolveTenant(tenantId);
    const rows = this.db.prepare(`
      SELECT id, task_id, agent_id, self_rating, what_worked, what_didnt_work,
             lessons_learned, suggested_improvements, tool_efficiency,
             would_do_differently, task_title, timestamp
      FROM agent_reflections
      WHERE agent_id = ? AND tenant_id = ? AND self_rating BETWEEN ? AND ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(agentId, t, minRating, maxRating, limit) as any[];
    return rows.map(rowToReflection);
  }

  getAverageRating(agentId: string): number {
    const row = this.db.prepare(
      `SELECT AVG(self_rating) AS avg, COUNT(*) AS n FROM agent_reflections WHERE agent_id = ?`
    ).get(agentId) as { avg: number | null; n: number };
    return row?.n > 0 ? Number(row.avg) : 0;
  }

  /**
   * Pull lessons from past reflections that look relevant to a new task.
   * Used by Agent.executeTaskDetailed when building the system prompt.
   * Prioritises low-rated reflections first (those are where the agent
   * actually learned something) and de-duplicates by lesson text. Each
   * returned lesson is clipped to ~120 chars.
   */
  getRelevantLessons(
    agentId: string,
    taskTitle: string,
    opts: { limit?: number; maxLowRating?: number } = {}
  ): {
    lessons: string[];
    wouldDoDifferently: string[];
    averageRating: number;
    recentTrend: 'improving' | 'declining' | 'stable' | 'insufficient';
    sampleSize: number;
  } {
    const limit = opts.limit ?? 3;
    const lowRating = opts.maxLowRating ?? 3;

    // Match keywords from the task title against reflection task_title
    // (cheap LIKE-OR over individual words ≥ 3 chars).
    const words = taskTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const collected: Array<{ rating: number; lesson: string; would: string; ts: string }> = [];

    if (words.length > 0) {
      const likeClauses = words.map(() => 'LOWER(task_title) LIKE ?').join(' OR ');
      const params = words.map(w => `%${w}%`);
      const rows = this.db.prepare(`
        SELECT self_rating, lessons_learned, would_do_differently, timestamp
        FROM agent_reflections
        WHERE agent_id = ? AND (${likeClauses})
        ORDER BY (self_rating <= ${lowRating}) DESC, timestamp DESC
        LIMIT 30
      `).all(agentId, ...params) as any[];
      for (const r of rows) {
        const lessons = parseJsonArray(r.lessons_learned);
        for (const l of lessons) collected.push({ rating: r.self_rating, lesson: l, would: r.would_do_differently ?? '', ts: r.timestamp });
      }
    }

    // De-duplicate lessons (prefer lower-rated source) and clip length.
    const seen = new Set<string>();
    const lessons: string[] = [];
    const wouldSet = new Set<string>();
    for (const e of collected) {
      const clipped = e.lesson.length > 120 ? e.lesson.slice(0, 117) + '...' : e.lesson;
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lessons.push(clipped);
      if (e.would && !wouldSet.has(e.would.toLowerCase())) {
        wouldSet.add(e.would.toLowerCase());
      }
      if (lessons.length >= limit) break;
    }

    const wouldDoDifferently = Array.from(wouldSet).slice(0, limit).map(s =>
      s.length > 120 ? s.slice(0, 117) + '...' : s
    );

    const averageRating = this.getAverageRating(agentId);
    const trend = this.computeRatingTrend(agentId);

    return {
      lessons,
      wouldDoDifferently,
      averageRating,
      recentTrend: trend.direction,
      sampleSize: trend.sampleSize,
    };
  }

  /** Compare the most recent 5 ratings against the prior 5 to detect a trend. */
  private computeRatingTrend(agentId: string): { direction: 'improving' | 'declining' | 'stable' | 'insufficient'; sampleSize: number } {
    const rows = this.db.prepare(
      `SELECT self_rating FROM agent_reflections WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 10`
    ).all(agentId) as { self_rating: number }[];
    if (rows.length < 6) return { direction: 'insufficient', sampleSize: rows.length };
    const recent = rows.slice(0, 5).map(r => r.self_rating);
    const prior = rows.slice(5, 10).map(r => r.self_rating);
    const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgP = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = avgR - avgP;
    if (delta > 0.4) return { direction: 'improving', sampleSize: rows.length };
    if (delta < -0.4) return { direction: 'declining', sampleSize: rows.length };
    return { direction: 'stable', sampleSize: rows.length };
  }

  /** Aggregate stats for the performance dashboard. */
  getPerformanceStats(agentId: string): {
    totalReflections: number;
    averageRating: number;
    trend: 'improving' | 'declining' | 'stable' | 'insufficient';
    ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
    mostEffectiveTools: Array<{ tool: string; usefulCount: number; total: number }>;
    commonFailurePatterns: Array<{ pattern: string; count: number }>;
  } {
    const total = this.db.prepare(
      `SELECT COUNT(*) AS n FROM agent_reflections WHERE agent_id = ?`
    ).get(agentId) as { n: number };
    if (total.n === 0) {
      return {
        totalReflections: 0,
        averageRating: 0,
        trend: 'insufficient',
        ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        mostEffectiveTools: [],
        commonFailurePatterns: [],
      };
    }

    const dist = this.db.prepare(
      `SELECT self_rating, COUNT(*) AS n FROM agent_reflections WHERE agent_id = ? GROUP BY self_rating`
    ).all(agentId) as Array<{ self_rating: 1 | 2 | 3 | 4 | 5; n: number }>;
    const ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of dist) ratingDistribution[r.self_rating] = r.n;

    const recentRows = this.db.prepare(
      `SELECT tool_efficiency, what_didnt_work FROM agent_reflections WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 100`
    ).all(agentId) as Array<{ tool_efficiency: string; what_didnt_work: string }>;

    const toolCounts = new Map<string, { useful: number; total: number }>();
    const failureCounts = new Map<string, number>();
    for (const r of recentRows) {
      for (const e of parseJsonObjectArray(r.tool_efficiency)) {
        const tool = typeof e?.tool === 'string' ? e.tool : '';
        if (!tool) continue;
        const cur = toolCounts.get(tool) ?? { useful: 0, total: 0 };
        cur.total++;
        if (e?.useful) cur.useful++;
        toolCounts.set(tool, cur);
      }
      for (const f of parseJsonArray(r.what_didnt_work)) {
        const key = f.toLowerCase().slice(0, 60);
        failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
      }
    }

    const mostEffectiveTools = Array.from(toolCounts.entries())
      .map(([tool, v]) => ({ tool, usefulCount: v.useful, total: v.total }))
      .sort((a, b) => (b.usefulCount / Math.max(b.total, 1)) - (a.usefulCount / Math.max(a.total, 1)))
      .slice(0, 5);

    const commonFailurePatterns = Array.from(failureCounts.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalReflections: total.n,
      averageRating: this.getAverageRating(agentId),
      trend: this.computeRatingTrend(agentId).direction,
      ratingDistribution,
      mostEffectiveTools,
      commonFailurePatterns,
    };
  }

  close(): void { this.db.close(); }
}

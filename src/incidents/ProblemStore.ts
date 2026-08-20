// ProblemStore — SQLite-backed problem records + many-to-many incident links.
//
// "Problem" is the higher-level abstraction above an incident: when the
// same kind of incident keeps recurring, the platform groups them into
// one problem record so an operator can investigate the underlying root
// cause once instead of fighting fires N times.
//
// Schema is intentionally minimal — recurrence counting is derived from
// problem_incidents on read, not stored as a denormalised counter that
// could drift. The status column is the operator-facing lifecycle.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export type ProblemStatus = 'open' | 'investigating' | 'resolved';
export type ProblemSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AiConfidence = 'high' | 'medium' | 'low';

export interface Problem {
  id: string;
  title: string;
  description: string;
  status: ProblemStatus;
  severity: ProblemSeverity;
  /** SQL LIKE pattern used by the detector to attach future incidents
   *  to this problem (e.g. `disk:%`). Null when the detector grouped
   *  via serverId + title similarity instead. */
  sourceRefPattern: string | null;
  /** Set when every linked incident shares the same server. Null
   *  otherwise (e.g. a fleet-wide disk-cleanup problem). */
  serverId: string | null;
  rootCause: string | null;
  suggestedFix: string | null;
  aiConfidence: AiConfidence | null;
  /** Full JSON of the most recent AI analysis call. Persisted so the
   *  UI can render the structured prevention runbook without
   *  re-prompting. */
  aiRaw: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ProblemWithIncidents extends Problem {
  incidentIds: string[];
  occurrences: number;
}

interface ProblemRow {
  id: string;
  title: string;
  description: string;
  status: string;
  severity: string;
  source_ref_pattern: string | null;
  server_id: string | null;
  root_cause: string | null;
  suggested_fix: string | null;
  ai_confidence: string | null;
  ai_raw: string | null;
  resolution: string | null;
  resolved_by: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface CreateProblemInput {
  title: string;
  description: string;
  severity: ProblemSeverity;
  sourceRefPattern?: string | null;
  serverId?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UpdateProblemInput {
  title?: string;
  description?: string;
  status?: ProblemStatus;
  severity?: ProblemSeverity;
  rootCause?: string | null;
  suggestedFix?: string | null;
  aiConfidence?: AiConfidence | null;
  aiRaw?: string | null;
  resolution?: string | null;
  resolvedBy?: string | null;
  lastSeenAt?: string;
}

export interface ListProblemsFilter {
  status?: ProblemStatus | ProblemStatus[];
  severity?: ProblemSeverity;
  serverId?: string;
  limit?: number;
  offset?: number;
}

export class ProblemStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info('[ProblemStore] opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS problems (
        id                  TEXT PRIMARY KEY,
        title               TEXT NOT NULL,
        description         TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'open',
        severity            TEXT NOT NULL,
        source_ref_pattern  TEXT,
        server_id           TEXT,
        root_cause          TEXT,
        suggested_fix       TEXT,
        ai_confidence       TEXT,
        ai_raw              TEXT,
        resolution          TEXT,
        resolved_by         TEXT,
        first_seen_at       TEXT NOT NULL,
        last_seen_at        TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        resolved_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_problems_status  ON problems(status);
      CREATE INDEX IF NOT EXISTS idx_problems_server  ON problems(server_id);
      CREATE INDEX IF NOT EXISTS idx_problems_sourceref ON problems(source_ref_pattern);

      CREATE TABLE IF NOT EXISTS problem_incidents (
        problem_id   TEXT NOT NULL,
        incident_id  TEXT NOT NULL,
        linked_at    TEXT NOT NULL,
        PRIMARY KEY (problem_id, incident_id)
      );
      CREATE INDEX IF NOT EXISTS idx_problem_incidents_incident ON problem_incidents(incident_id);
    `);
    addTenantColumnSqlite(this.db, 'problems');
    addTenantColumnSqlite(this.db, 'problem_incidents');
  }

  // ─── Problem CRUD ────────────────────────────────────────────────────

  create(input: CreateProblemInput): Problem {
    const id = 'PRB-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO problems
        (id, title, description, status, severity, source_ref_pattern, server_id,
         root_cause, suggested_fix, ai_confidence, ai_raw, resolution, resolved_by,
         first_seen_at, last_seen_at, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, 'open', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL)
    `).run(
      id, input.title, input.description, input.severity,
      input.sourceRefPattern ?? null, input.serverId ?? null,
      input.firstSeenAt, input.lastSeenAt, now, now,
    );
    return this.get(id)!;
  }

  get(id: string): Problem | null {
    const row = this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as ProblemRow | undefined;
    return row ? this.rowToProblem(row) : null;
  }

  /** Get the problem with its linked incident ids + occurrence count. */
  getWithIncidents(id: string): ProblemWithIncidents | null {
    const p = this.get(id);
    if (!p) return null;
    const incidentIds = this.getLinkedIncidents(id);
    return { ...p, incidentIds, occurrences: incidentIds.length };
  }

  update(id: string, patch: UpdateProblemInput): Problem | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: Problem = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    } as Problem;
    // Resolving stamps resolved_at; un-resolving (status flipped back)
    // clears it so the metrics stay honest.
    if (patch.status === 'resolved' && !existing.resolvedAt) {
      next.resolvedAt = new Date().toISOString();
    } else if (patch.status && patch.status !== 'resolved' && existing.resolvedAt) {
      next.resolvedAt = null;
    }
    this.db.prepare(`
      UPDATE problems SET
        title=?, description=?, status=?, severity=?,
        root_cause=?, suggested_fix=?, ai_confidence=?, ai_raw=?,
        resolution=?, resolved_by=?, last_seen_at=?, updated_at=?, resolved_at=?
      WHERE id=?
    `).run(
      next.title, next.description, next.status, next.severity,
      next.rootCause, next.suggestedFix, next.aiConfidence, next.aiRaw,
      next.resolution, next.resolvedBy, next.lastSeenAt, next.updatedAt, next.resolvedAt,
      id,
    );
    return this.get(id);
  }

  list(filter: ListProblemsFilter = {}): Problem[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      if (Array.isArray(filter.status)) {
        where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
        params.push(...filter.status);
      } else {
        where.push('status = ?');
        params.push(filter.status);
      }
    }
    if (filter.severity) { where.push('severity = ?'); params.push(filter.severity); }
    if (filter.serverId) { where.push('server_id = ?'); params.push(filter.serverId); }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const q = `SELECT * FROM problems ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_seen_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = this.db.prepare(q).all(...params) as ProblemRow[];
    return rows.map(r => this.rowToProblem(r));
  }

  // ─── Incident linking ────────────────────────────────────────────────

  /** Idempotent: linking the same incident twice is a no-op. Bumps
   *  last_seen_at to keep the recurrence window honest. */
  linkIncident(problemId: string, incidentId: string, incidentTime: string): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO problem_incidents (problem_id, incident_id, linked_at)
      VALUES (?, ?, ?)
    `).run(problemId, incidentId, now);
    // Always advance last_seen if the new incident is more recent —
    // the problem's "still happening" signal depends on this.
    this.db.prepare(`
      UPDATE problems
      SET last_seen_at = CASE WHEN ? > last_seen_at THEN ? ELSE last_seen_at END,
          updated_at = ?
      WHERE id = ?
    `).run(incidentTime, incidentTime, now, problemId);
    if (result.changes === 0) {
      logger.debug('[ProblemStore] linkIncident noop (already linked)', { problemId, incidentId });
    }
  }

  unlinkIncident(problemId: string, incidentId: string): void {
    this.db.prepare('DELETE FROM problem_incidents WHERE problem_id = ? AND incident_id = ?').run(problemId, incidentId);
  }

  getLinkedIncidents(problemId: string): string[] {
    const rows = this.db.prepare(
      'SELECT incident_id FROM problem_incidents WHERE problem_id = ? ORDER BY linked_at ASC'
    ).all(problemId) as Array<{ incident_id: string }>;
    return rows.map(r => r.incident_id);
  }

  /** Reverse lookup: which problem does this incident belong to (if any)? */
  findProblemForIncident(incidentId: string): Problem | null {
    const row = this.db.prepare(`
      SELECT p.* FROM problems p
      JOIN problem_incidents pi ON pi.problem_id = p.id
      WHERE pi.incident_id = ?
      LIMIT 1
    `).get(incidentId) as ProblemRow | undefined;
    return row ? this.rowToProblem(row) : null;
  }

  // ─── Pattern lookup for the detector ─────────────────────────────────

  /** Find an OPEN problem whose source_ref_pattern matches the given
   *  sourceRef. The detector calls this on every new incident so it can
   *  attach to an existing problem instead of opening a new one. */
  findBySourcePattern(sourceRef: string, opts: { serverId?: string | null } = {}): Problem | null {
    // `source_ref_pattern` is a SQL LIKE pattern (e.g. 'disk:%') —
    // SQLite's LIKE matches against the incoming sourceRef directly.
    let q = `
      SELECT * FROM problems
      WHERE status IN ('open','investigating')
        AND source_ref_pattern IS NOT NULL
        AND ? LIKE source_ref_pattern
    `;
    const params: unknown[] = [sourceRef];
    if (opts.serverId !== undefined) {
      // When the candidate problem is server-scoped, only match if the
      // incoming incident is on the same server. Fleet-wide problems
      // (server_id IS NULL) match any server.
      q += ' AND (server_id IS NULL OR server_id = ?)';
      params.push(opts.serverId ?? '');
    }
    q += ' ORDER BY last_seen_at DESC LIMIT 1';
    const row = this.db.prepare(q).get(...params) as ProblemRow | undefined;
    return row ? this.rowToProblem(row) : null;
  }

  /** Find an OPEN problem on a specific server. The detector falls back
   *  to this when source-pattern matching fails so it can still group
   *  by serverId + title similarity. Caller filters by title similarity. */
  listOpenProblemsForServer(serverId: string): Problem[] {
    const rows = this.db.prepare(`
      SELECT * FROM problems
      WHERE status IN ('open','investigating')
        AND server_id = ?
      ORDER BY last_seen_at DESC
    `).all(serverId) as ProblemRow[];
    return rows.map(r => this.rowToProblem(r));
  }

  // ─── Stats for the dashboard widget ──────────────────────────────────

  stats(): { open: number; investigating: number; resolved: number; total: number } {
    const rows = this.db.prepare(
      "SELECT status, COUNT(*) AS n FROM problems GROUP BY status"
    ).all() as Array<{ status: string; n: number }>;
    const out = { open: 0, investigating: 0, resolved: 0, total: 0 };
    for (const r of rows) {
      out.total += r.n;
      if (r.status === 'open') out.open = r.n;
      else if (r.status === 'investigating') out.investigating = r.n;
      else if (r.status === 'resolved') out.resolved = r.n;
    }
    return out;
  }

  /** Top N problems by occurrence count, restricted to non-resolved.
   *  Used by the dashboard widget. */
  topRecurring(limit = 3): Array<{ problem: Problem; occurrences: number }> {
    const rows = this.db.prepare(`
      SELECT p.*, COUNT(pi.incident_id) AS n
      FROM problems p
      LEFT JOIN problem_incidents pi ON pi.problem_id = p.id
      WHERE p.status IN ('open','investigating')
      GROUP BY p.id
      ORDER BY n DESC, p.last_seen_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 20)) as Array<ProblemRow & { n: number }>;
    return rows.map(r => ({ problem: this.rowToProblem(r), occurrences: r.n }));
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private rowToProblem(r: ProblemRow): Problem {
    return {
      id: r.id, title: r.title, description: r.description,
      status: r.status as ProblemStatus, severity: r.severity as ProblemSeverity,
      sourceRefPattern: r.source_ref_pattern, serverId: r.server_id,
      rootCause: r.root_cause, suggestedFix: r.suggested_fix,
      aiConfidence: r.ai_confidence as AiConfidence | null, aiRaw: r.ai_raw,
      resolution: r.resolution, resolvedBy: r.resolved_by,
      firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
      createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
    };
  }

  close(): void { this.db.close(); }
}

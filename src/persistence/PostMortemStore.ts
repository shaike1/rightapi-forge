// PostMortemStore — SQLite-backed store for the incident knowledge base.
//
// Sits beside SqliteIncidentStore (same DB pattern: WAL, FTS5, tenant-
// scoped). Every resolved medium-or-worse incident yields one row here so
// future agents can search past resolutions before re-deriving the fix
// from scratch.
//
// Search uses FTS5 over title + root_cause + resolution + tags, ranked by
// rank() and (where the caller asks) optionally filtered by serverId or
// incident_type. `findSimilar()` is the knowledge-base lookup the agent
// path uses — it boosts matches that share serverId or sourceRef prefix.

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { addTenantColumnSqlite } from './tenantMigration.js';
import { getCurrentTenantId } from '../tenancy/index.js';
import { logger } from '../utils/logger.js';

export interface PostMortem {
  id: string;
  incidentId: string;
  serverId: string | null;
  /** Short stable tag (disk-cleanup, container-crash, memory-pressure, …)
   *  derived from the source incident. Used to group resolutions in the
   *  stats endpoint and to filter searches. */
  incidentType: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  rootCause: string;
  /** Ordered list of actions the agent (or operator) took, in plain
   *  language — typically extracted from the incident timeline. */
  actionsTaken: string[];
  resolution: string;
  durationMinutes: number;
  /** Lessons learned in agent-readable form. Each entry is a single
   *  declarative sentence the next agent can apply. */
  lessons: string[];
  /** Concrete prevention suggestions (alert tweaks, runbook updates,
   *  capacity changes, etc.). */
  prevention: string[];
  /** Free-form tags for grouping / search boosting. Always includes the
   *  incidentType; may include severity and serverId. */
  tags: string[];
  /** AI model that generated this post-mortem (claude-sonnet-4-6, etc).
   *  Null when the row was written by an operator or by a fallback
   *  generator without an AI call. */
  aiModel: string | null;
  createdAt: string;
}

export interface PostMortemListFilter {
  limit?: number;
  offset?: number;
  serverId?: string;
  incidentType?: string;
  severity?: string;
  /** Lower bound on createdAt (ISO). Used by stats() to scope a window. */
  since?: string;
}

export interface PostMortemStats {
  total: number;
  avgDurationMinutes: number;
  byIncidentType: Record<string, number>;
  bySeverity: Record<string, number>;
  byServer: Record<string, number>;
}

export class PostMortemStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[PostMortemStore] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS post_mortems (
        id                TEXT PRIMARY KEY,
        incident_id       TEXT NOT NULL,
        server_id         TEXT,
        incident_type     TEXT NOT NULL DEFAULT 'general',
        title             TEXT NOT NULL,
        severity          TEXT NOT NULL,
        root_cause        TEXT NOT NULL,
        actions_taken     TEXT NOT NULL,
        resolution        TEXT NOT NULL,
        duration_minutes  INTEGER NOT NULL DEFAULT 0,
        lessons           TEXT NOT NULL DEFAULT '[]',
        prevention        TEXT NOT NULL DEFAULT '[]',
        tags              TEXT NOT NULL DEFAULT '[]',
        ai_model          TEXT,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pm_incident  ON post_mortems(incident_id);
      CREATE INDEX IF NOT EXISTS idx_pm_server    ON post_mortems(server_id);
      CREATE INDEX IF NOT EXISTS idx_pm_type      ON post_mortems(incident_type);
      CREATE INDEX IF NOT EXISTS idx_pm_severity  ON post_mortems(severity);
      CREATE INDEX IF NOT EXISTS idx_pm_created   ON post_mortems(created_at);
    `);

    // Tenant scoping. New rows pick up the active tenant; legacy rows get
    // the system tenant via addTenantColumnSqlite's backfill.
    addTenantColumnSqlite(this.db, 'post_mortems');

    // Composite tenant+created index covers the "list for tenant, newest
    // first" pattern used by the public list endpoints.
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_pm_tenant_created ON post_mortems(tenant_id, created_at DESC)'); } catch { /* exists */ }

    // FTS5 mirror — covers everything an agent might keyword-match against
    // (title, root cause, resolution, the JSON tags + lessons blob).
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS post_mortems_fts USING fts5(
        id UNINDEXED,
        title,
        root_cause,
        resolution,
        tags,
        lessons,
        content='post_mortems',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS post_mortems_ai AFTER INSERT ON post_mortems BEGIN
        INSERT INTO post_mortems_fts(rowid, id, title, root_cause, resolution, tags, lessons)
        VALUES (new.rowid, new.id, new.title, new.root_cause, new.resolution, new.tags, new.lessons);
      END;

      CREATE TRIGGER IF NOT EXISTS post_mortems_ad AFTER DELETE ON post_mortems BEGIN
        INSERT INTO post_mortems_fts(post_mortems_fts, rowid, id, title, root_cause, resolution, tags, lessons)
        VALUES('delete', old.rowid, old.id, old.title, old.root_cause, old.resolution, old.tags, old.lessons);
      END;
    `);
  }

  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  /** Generate a fresh post-mortem id. Exposed so callers (the
   *  PostMortemGenerator in particular) can stash the id in their own
   *  output before the row is written. */
  static newId(): string {
    return 'PM-' + uuidv4().slice(0, 8).toUpperCase();
  }

  /** Insert a new post-mortem. Returns the persisted row (with the
   *  authoritative createdAt set if the caller didn't supply one). */
  insert(pm: Omit<PostMortem, 'id' | 'createdAt'> & { id?: string; createdAt?: string }, tenantId?: string): PostMortem {
    const row: PostMortem = {
      id: pm.id ?? PostMortemStore.newId(),
      incidentId: pm.incidentId,
      serverId: pm.serverId ?? null,
      incidentType: pm.incidentType || 'general',
      title: pm.title,
      severity: pm.severity,
      rootCause: pm.rootCause,
      actionsTaken: pm.actionsTaken ?? [],
      resolution: pm.resolution,
      durationMinutes: pm.durationMinutes ?? 0,
      lessons: pm.lessons ?? [],
      prevention: pm.prevention ?? [],
      tags: pm.tags ?? [],
      aiModel: pm.aiModel ?? null,
      createdAt: pm.createdAt ?? new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO post_mortems
        (id, incident_id, server_id, incident_type, title, severity,
         root_cause, actions_taken, resolution, duration_minutes,
         lessons, prevention, tags, ai_model, created_at, tenant_id)
      VALUES
        (@id, @incident_id, @server_id, @incident_type, @title, @severity,
         @root_cause, @actions_taken, @resolution, @duration_minutes,
         @lessons, @prevention, @tags, @ai_model, @created_at, @tenant_id)
    `).run({
      id: row.id,
      incident_id: row.incidentId,
      server_id: row.serverId,
      incident_type: row.incidentType,
      title: row.title,
      severity: row.severity,
      root_cause: row.rootCause,
      actions_taken: JSON.stringify(row.actionsTaken),
      resolution: row.resolution,
      duration_minutes: row.durationMinutes,
      lessons: JSON.stringify(row.lessons),
      prevention: JSON.stringify(row.prevention),
      tags: JSON.stringify(row.tags),
      ai_model: row.aiModel,
      created_at: row.createdAt,
      tenant_id: this.resolveTenant(tenantId),
    });
    return row;
  }

  get(id: string, tenantId?: string): PostMortem | null {
    const t = this.resolveTenant(tenantId);
    const row = this.db.prepare('SELECT * FROM post_mortems WHERE id = ? AND tenant_id = ?').get(id, t) as any;
    return row ? this.rowToPostMortem(row) : null;
  }

  /** Get all post-mortems written for a given incident. Usually returns 0
   *  or 1 row, but the schema doesn't enforce that — the generator is
   *  idempotent in practice, not by SQL constraint. */
  byIncident(incidentId: string, tenantId?: string): PostMortem[] {
    const t = this.resolveTenant(tenantId);
    const rows = this.db.prepare(
      'SELECT * FROM post_mortems WHERE incident_id = ? AND tenant_id = ? ORDER BY created_at DESC'
    ).all(incidentId, t) as any[];
    return rows.map(r => this.rowToPostMortem(r));
  }

  list(filter: PostMortemListFilter = {}, tenantId?: string): { items: PostMortem[]; total: number } {
    const t = this.resolveTenant(tenantId);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const offset = Math.max(filter.offset ?? 0, 0);

    let where = 'tenant_id = ?';
    const params: any[] = [t];
    if (filter.serverId)     { where += ' AND server_id = ?';     params.push(filter.serverId); }
    if (filter.incidentType) { where += ' AND incident_type = ?'; params.push(filter.incidentType); }
    if (filter.severity)     { where += ' AND severity = ?';      params.push(filter.severity); }
    if (filter.since)        { where += ' AND created_at >= ?';   params.push(filter.since); }

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM post_mortems WHERE ${where}`)
      .get(...params) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT * FROM post_mortems WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];
    return { items: rows.map(r => this.rowToPostMortem(r)), total };
  }

  /** Full-text search across title/root_cause/resolution/tags/lessons.
   *  Returns at most `limit` matches ranked by FTS5 rank(). */
  search(query: string, opts: { limit?: number; tenantId?: string } = {}): PostMortem[] {
    if (!query || !query.trim()) return [];
    const t = this.resolveTenant(opts.tenantId);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    // FTS5 requires us to massage the query so plain "disk full" doesn't
    // trip on the space. Split into tokens, drop short noise words, OR them.
    const ftsQuery = this.sanitizeFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      const rows = this.db.prepare(`
        SELECT p.* FROM post_mortems_fts f
        JOIN post_mortems p ON p.id = f.id
        WHERE post_mortems_fts MATCH ? AND p.tenant_id = ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, t, limit) as any[];
      return rows.map(r => this.rowToPostMortem(r));
    } catch (e) {
      // FTS5 throws on malformed queries we couldn't sanitize. Fall back
      // to a plain LIKE so we still return something.
      logger.warn('[PostMortemStore] FTS search failed, falling back to LIKE', {
        err: e instanceof Error ? e.message : String(e),
      });
      const like = '%' + query.replace(/[%_]/g, '') + '%';
      const rows = this.db.prepare(`
        SELECT * FROM post_mortems
        WHERE tenant_id = ?
          AND (title LIKE ? OR root_cause LIKE ? OR resolution LIKE ? OR tags LIKE ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(t, like, like, like, like, limit) as any[];
      return rows.map(r => this.rowToPostMortem(r));
    }
  }

  /** Knowledge-base lookup: surface the K post-mortems most likely to be
   *  relevant to a new incident. Strategy:
   *    1. FTS5 keyword match on title + tags (the strongest signal).
   *    2. Boost matches that share the incident's serverId.
   *    3. Boost matches whose tags include the sourceRef prefix
   *       (e.g. "disk:" or "docker:"), since those are the same
   *       generated `incidentType` the generator stamped.
   *    4. Drop the post-mortem written for this exact incident id, if any.
   *  Returns the K highest-scoring rows; empty array if no FTS hits
   *  and no shared serverId.  */
  findSimilar(
    incident: { id?: string; title: string; description?: string; serverId?: string | null; sourceRef?: string | null },
    k: number = 3,
    tenantId?: string,
  ): PostMortem[] {
    const t = this.resolveTenant(tenantId);

    // Build a candidate pool — start with FTS5 keyword hits on the title
    // and sourceRef, plus rows from the same server. Union and re-rank.
    const candidates = new Map<string, { pm: PostMortem; score: number }>();

    // 1. Keyword search on the title.
    const titleHits = this.search(incident.title, { limit: 25, tenantId: t });
    for (let i = 0; i < titleHits.length; i++) {
      const pm = titleHits[i];
      // FTS rank is implicit in order — first hit best. Score declines linearly.
      candidates.set(pm.id, { pm, score: 10 - i });
    }

    // 2. Same-server boost.
    if (incident.serverId) {
      const sameServer = this.db.prepare(
        'SELECT * FROM post_mortems WHERE server_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 25'
      ).all(incident.serverId, t) as any[];
      for (const row of sameServer) {
        const pm = this.rowToPostMortem(row);
        const existing = candidates.get(pm.id);
        if (existing) existing.score += 4;
        else candidates.set(pm.id, { pm, score: 3 });
      }
    }

    // 3. Same incident_type boost (derived from sourceRef prefix on the
    //    new incident — see deriveIncidentType in PostMortemGenerator).
    const newType = deriveIncidentType({ title: incident.title, sourceRef: incident.sourceRef });
    if (newType && newType !== 'general') {
      const sameType = this.db.prepare(
        'SELECT * FROM post_mortems WHERE incident_type = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 25'
      ).all(newType, t) as any[];
      for (const row of sameType) {
        const pm = this.rowToPostMortem(row);
        const existing = candidates.get(pm.id);
        if (existing) existing.score += 5;
        else candidates.set(pm.id, { pm, score: 4 });
      }
    }

    // 4. Drop the post-mortem belonging to this exact incident.
    if (incident.id) {
      for (const [pmId, entry] of candidates) {
        if (entry.pm.incidentId === incident.id) candidates.delete(pmId);
      }
    }

    return Array.from(candidates.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(e => e.pm);
  }

  stats(tenantId?: string): PostMortemStats {
    const t = this.resolveTenant(tenantId);

    const total = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM post_mortems WHERE tenant_id = ?'
    ).get(t) as { n: number }).n;

    const avg = (this.db.prepare(
      'SELECT AVG(duration_minutes) AS m FROM post_mortems WHERE tenant_id = ?'
    ).get(t) as { m: number | null }).m;

    const byTypeRows = this.db.prepare(
      'SELECT incident_type AS k, COUNT(*) AS n FROM post_mortems WHERE tenant_id = ? GROUP BY incident_type'
    ).all(t) as { k: string; n: number }[];

    const bySeverityRows = this.db.prepare(
      'SELECT severity AS k, COUNT(*) AS n FROM post_mortems WHERE tenant_id = ? GROUP BY severity'
    ).all(t) as { k: string; n: number }[];

    const byServerRows = this.db.prepare(
      "SELECT COALESCE(server_id, 'unknown') AS k, COUNT(*) AS n FROM post_mortems WHERE tenant_id = ? GROUP BY COALESCE(server_id, 'unknown')"
    ).all(t) as { k: string; n: number }[];

    const toRecord = (rows: { k: string; n: number }[]): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const r of rows) out[r.k] = r.n;
      return out;
    };

    return {
      total,
      avgDurationMinutes: Math.round(avg ?? 0),
      byIncidentType: toRecord(byTypeRows),
      bySeverity: toRecord(bySeverityRows),
      byServer: toRecord(byServerRows),
    };
  }

  /** Delete a post-mortem. Mostly used by tests + operator-initiated
   *  housekeeping. Returns true if a row was removed. */
  remove(id: string, tenantId?: string): boolean {
    const t = this.resolveTenant(tenantId);
    const info = this.db.prepare('DELETE FROM post_mortems WHERE id = ? AND tenant_id = ?').run(id, t);
    return info.changes > 0;
  }

  /** Sanitize a free-text query into something FTS5 will accept. We OR
   *  the alphanumeric tokens together and quote them so punctuation in
   *  the source doesn't break the parser. Empty string → caller skips. */
  private sanitizeFtsQuery(q: string): string {
    const tokens = q
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2);
    if (tokens.length === 0) return '';
    // Quote each token so FTS5 doesn't interpret it as syntax. OR them.
    return tokens.map(t => `"${t}"`).join(' OR ');
  }

  private rowToPostMortem(r: any): PostMortem {
    return {
      id: r.id,
      incidentId: r.incident_id,
      serverId: r.server_id ?? null,
      incidentType: r.incident_type,
      title: r.title,
      severity: r.severity,
      rootCause: r.root_cause,
      actionsTaken: safeJsonArray(r.actions_taken),
      resolution: r.resolution,
      durationMinutes: r.duration_minutes,
      lessons: safeJsonArray(r.lessons),
      prevention: safeJsonArray(r.prevention),
      tags: safeJsonArray(r.tags),
      aiModel: r.ai_model ?? null,
      createdAt: r.created_at,
    };
  }
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Derive a stable, short incident-type tag from a freshly-resolved
 *  incident. Used both by the generator (when stamping new rows) and by
 *  findSimilar() (when matching new incidents against the KB).
 *
 *  Priority:
 *    1. Structured sourceRef prefix (`disk:`, `docker:`, etc.)
 *    2. Keyword scan over title (covers manual / alert-rule incidents)
 *    3. Falls through to 'general'. */
export function deriveIncidentType(input: { title: string; sourceRef?: string | null }): string {
  const ref = (input.sourceRef || '').toLowerCase();
  if (ref.startsWith('disk:') || /\bdisk\b/.test(ref))                 return 'disk-pressure';
  if (ref.startsWith('docker:') || /\bdocker\b/.test(ref))             return 'docker-issue';
  if (ref.startsWith('memory:') || /\bmemory\b/.test(ref))             return 'memory-pressure';
  if (ref.startsWith('cert:') || /\bcert\b|\bssl\b/.test(ref))         return 'cert-issue';
  if (ref.startsWith('cpu:') || /\bcpu\b|\biowait\b/.test(ref))        return 'cpu-pressure';
  if (ref.startsWith('network:') || /\bnetwork\b/.test(ref))           return 'network-issue';
  if (ref.startsWith('systemd:') || /\bsystemd\b|\bservice\b/.test(ref))return 'service-failure';

  const title = (input.title || '').toLowerCase();
  if (/\bdisk\b|\bfilesystem\b|\b\/var\b|\bvolume\b/.test(title))      return 'disk-pressure';
  if (/\bcontainer\b|\bdocker\b|\bunhealthy\b|\brestart loop\b/.test(title)) return 'docker-issue';
  if (/\bmemory\b|\boom\b|\bswap\b/.test(title))                       return 'memory-pressure';
  if (/\bcertificate\b|\bssl\b|\bexpir/.test(title))                   return 'cert-issue';
  if (/\bcpu\b|\bload\b|\biowait\b/.test(title))                       return 'cpu-pressure';
  if (/\bnetwork\b|\bdns\b|\bconnectivity\b/.test(title))              return 'network-issue';
  if (/\bservice\b|\bsystemd\b|\bunit\b/.test(title))                  return 'service-failure';

  return 'general';
}

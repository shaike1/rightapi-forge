// PostgreSQL-backed persistence — same surface as SqliteStore but using
// node-postgres (`pg`). Built so a deployment can flip DB_PROVIDER=postgres
// without touching consumer code (StoreFactory hands the right impl back).
//
// Schema notes:
//   • IDs stay TEXT (existing code generates UUIDs / prefixed ids).
//   • Dates are TIMESTAMPTZ, defaulted with NOW() so the server clock is
//     authoritative when a row is inserted without a timestamp.
//   • JSON-shaped columns (steps_tried, tool_efficiency, …) are JSONB.
//   • SQLite FTS5 → Postgres native tsvector with a GIN index. The columns
//     are kept in sync via an UPDATE in upsert; a trigger could do it but
//     keeping the write path explicit makes failure modes easier to reason
//     about (no surprise "oh that column updated itself" debugging).
//   • Migrations run idempotently at construction time using IF NOT EXISTS.
//
// Methods are async (`Promise<T>`) because pg is async — the shared
// TaskStore/IncidentStore/AgentMemoryStore interfaces are typed as
// "T | Promise<T>" so consumers awaiting either backend keep working.

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { Task } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { getCurrentTenantId } from '../tenancy/index.js';
import type {
  Incident,
  TimelineEntry,
  TimelineEventType,
  ResolutionRecord,
  ResolutionStep,
  ReflectionRecord,
  StoredReflection,
} from './interfaces.js';

// ─── Pool helpers ──────────────────────────────────────────────────────────

export interface PostgresPoolConfig {
  connectionString: string;
  /** Max concurrent connections in the pool. Default 10 — enough headroom
   *  for the webhook / scheduled-task / health-check workloads without
   *  hammering smaller managed Postgres instances. */
  max?: number;
  /** ms a client can sit idle in the pool before being released. */
  idleTimeoutMs?: number;
  /** ms a client.query() can wait for an idle connection. */
  connectionTimeoutMs?: number;
}

let sharedPool: Pool | null = null;

/**
 * Get (or lazily create) the shared connection pool. All three Postgres
 * stores share a single pool so a process running them all doesn't
 * triple its connection footprint.
 */
export function getSharedPool(cfg: PostgresPoolConfig): Pool {
  if (sharedPool) return sharedPool;
  sharedPool = new pg.Pool({
    connectionString: cfg.connectionString,
    max: cfg.max ?? 10,
    idleTimeoutMillis: cfg.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: cfg.connectionTimeoutMs ?? 5_000,
  });
  sharedPool.on('error', (err) => {
    logger.error('[PostgresStore] pool error', { err: err.message });
  });
  return sharedPool;
}

/** Release the shared pool — used by GracefulShutdown. */
export async function closeSharedPool(): Promise<void> {
  const p = sharedPool;
  sharedPool = null;
  if (p) await p.end().catch(() => { /* best-effort */ });
}

/** Returns true once the schema has been created. Safe to call repeatedly. */
let schemaReady = false;
export async function ensureSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(SCHEMA_SQL);
    // Idempotent tenant migration. ADD COLUMN IF NOT EXISTS makes
    // re-runs safe; existing rows pick up the 'system' default.
    for (const t of [
      'tasks', 'incidents', 'incident_timeline',
      'agent_facts', 'agent_messages', 'agent_resolutions', 'agent_reflections',
    ]) {
      await client.query(
        `ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON ${t}(tenant_id)`,
      );
    }
    await client.query('COMMIT');
    schemaReady = true;
    logger.info('[PostgresStore] schema ensured');
  } catch (e: any) {
    await client.query('ROLLBACK').catch(() => { /* */ });
    throw new Error(`[PostgresStore] schema migration failed: ${e?.message ?? String(e)}`);
  } finally {
    client.release();
  }
}

/** Drop the schema-ready cache — used by tests that recreate the DB. */
export function _resetSchemaReady(): void { schemaReady = false; }

// ─── Schema (idempotent) ───────────────────────────────────────────────────

const SCHEMA_SQL = `
  -- Tasks ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    status      TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    assigned_to TEXT,
    category    TEXT,
    priority    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_owner    ON tasks(owner_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);

  -- Incidents -----------------------------------------------------------
  CREATE TABLE IF NOT EXISTS incidents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    severity    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    assigned_to TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    source      TEXT NOT NULL DEFAULT 'manual',
    source_ref  TEXT,
    sla_minutes INTEGER NOT NULL DEFAULT 240,
    jira_key    TEXT,
    jira_url    TEXT,
    ai_analysis JSONB,
    assigned_agent TEXT,
    -- tsvector kept in sync from upsert(); GIN index for full-text search.
    search_tsv  TSVECTOR
  );
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS assigned_agent TEXT;
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS server_id TEXT;
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS ticketing_synced INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE incidents ADD COLUMN IF NOT EXISTS github_issue_number INTEGER;
  CREATE INDEX IF NOT EXISTS idx_inc_server ON incidents(server_id);
  CREATE INDEX IF NOT EXISTS idx_inc_status     ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_inc_severity   ON incidents(severity);
  CREATE INDEX IF NOT EXISTS idx_inc_search_tsv ON incidents USING GIN (search_tsv);

  CREATE TABLE IF NOT EXISTS incident_timeline (
    id          TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    timestamp   TIMESTAMPTZ NOT NULL,
    actor       TEXT NOT NULL DEFAULT 'system',
    type        TEXT NOT NULL,
    message     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tl_incident ON incident_timeline(incident_id);

  -- Agent facts / messages ---------------------------------------------
  CREATE TABLE IF NOT EXISTS agent_facts (
    agent_id   TEXT NOT NULL,
    fact       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agent_id, fact)
  );
  CREATE TABLE IF NOT EXISTS agent_messages (
    id         BIGSERIAL PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_agent_messages_agent ON agent_messages(agent_id, id DESC);

  -- Resolutions ---------------------------------------------------------
  CREATE TABLE IF NOT EXISTS agent_resolutions (
    id                     TEXT PRIMARY KEY,
    agent_id               TEXT NOT NULL,
    incident_title         TEXT NOT NULL,
    incident_severity      TEXT NOT NULL DEFAULT 'medium',
    resolution             TEXT NOT NULL,
    runbook_used           TEXT,
    tags                   JSONB NOT NULL DEFAULT '[]'::jsonb,
    problem_description    TEXT NOT NULL DEFAULT '',
    steps_tried            JSONB NOT NULL DEFAULT '[]'::jsonb,
    what_worked            TEXT NOT NULL DEFAULT '',
    resolution_time_ms     INTEGER NOT NULL DEFAULT 0,
    outcome                TEXT NOT NULL DEFAULT 'success',
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    search_tsv             TSVECTOR
  );
  CREATE INDEX IF NOT EXISTS idx_agent_res_agent  ON agent_resolutions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_agent_res_search ON agent_resolutions USING GIN (search_tsv);

  -- Reflections ---------------------------------------------------------
  CREATE TABLE IF NOT EXISTS agent_reflections (
    id                     TEXT PRIMARY KEY,
    task_id                TEXT NOT NULL,
    agent_id               TEXT NOT NULL,
    self_rating            INTEGER NOT NULL,
    what_worked            JSONB NOT NULL DEFAULT '[]'::jsonb,
    what_didnt_work        JSONB NOT NULL DEFAULT '[]'::jsonb,
    lessons_learned        JSONB NOT NULL DEFAULT '[]'::jsonb,
    suggested_improvements JSONB NOT NULL DEFAULT '[]'::jsonb,
    tool_efficiency        JSONB NOT NULL DEFAULT '[]'::jsonb,
    would_do_differently   TEXT NOT NULL DEFAULT '',
    task_title             TEXT NOT NULL DEFAULT '',
    timestamp              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_agent_refl_agent  ON agent_reflections(agent_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_refl_rating ON agent_reflections(agent_id, self_rating);
`;

// ─── Helpers ──────────────────────────────────────────────────────────────

function isoOf(value: any): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(value).toISOString();
}

function rowToTask(r: any): Task {
  const t = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  if (t.createdAt && typeof t.createdAt === 'string') t.createdAt = new Date(t.createdAt);
  if (t.updatedAt && typeof t.updatedAt === 'string') t.updatedAt = new Date(t.updatedAt);
  return t as Task;
}

function rowToIncident(r: any): Incident {
  return {
    id: r.id, title: r.title, description: r.description ?? '',
    severity: r.severity, status: r.status,
    assignedTo: r.assigned_to ?? null,
    assignedAgent: r.assigned_agent ?? null,
    createdAt: isoOf(r.created_at),
    updatedAt: isoOf(r.updated_at),
    resolvedAt: r.resolved_at ? isoOf(r.resolved_at) : null,
    source: r.source, sourceRef: r.source_ref ?? null,
    slaMinutes: r.sla_minutes,
    jiraKey: r.jira_key ?? undefined,
    jiraUrl: r.jira_url ?? undefined,
    aiAnalysis: r.ai_analysis
      ? (typeof r.ai_analysis === 'string' ? r.ai_analysis : JSON.stringify(r.ai_analysis))
      : undefined,
    escalationLevel: typeof r.escalation_level === 'number' ? r.escalation_level : 0,
    escalatedAt: r.escalated_at ? isoOf(r.escalated_at) : null,
    serverId: r.server_id ?? null,
  };
}

function asArrayString(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter(x => typeof x === 'string');
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.filter(x => typeof x === 'string') : []; }
    catch { return []; }
  }
  return [];
}

function asArrayObject(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; }
    catch { return []; }
  }
  return [];
}

function rowToResolution(r: any): ResolutionRecord {
  return {
    id: r.id,
    agent_id: r.agent_id ?? '',
    incident_title: r.incident_title,
    incident_severity: r.incident_severity,
    resolution: r.resolution,
    runbook_used: r.runbook_used ?? null,
    problem_description: r.problem_description ?? '',
    steps_tried: asArrayObject(r.steps_tried) as ResolutionStep[],
    what_worked: r.what_worked ?? '',
    resolution_time_ms: typeof r.resolution_time_ms === 'number' ? r.resolution_time_ms : 0,
    outcome: (r.outcome as ResolutionRecord['outcome']) ?? 'success',
    created_at: isoOf(r.created_at),
  };
}

function rowToReflection(r: any): StoredReflection {
  return {
    id: r.id,
    taskId: r.task_id,
    agentId: r.agent_id,
    selfRating: typeof r.self_rating === 'number' ? r.self_rating : 0,
    whatWorked: asArrayString(r.what_worked),
    whatDidntWork: asArrayString(r.what_didnt_work),
    lessonsLearned: asArrayString(r.lessons_learned),
    suggestedImprovements: asArrayString(r.suggested_improvements),
    toolEfficiency: asArrayObject(r.tool_efficiency).map((e: any) => ({
      tool: typeof e?.tool === 'string' ? e.tool : '',
      useful: !!e?.useful,
      reason: typeof e?.reason === 'string' ? e.reason : '',
    })),
    wouldDoDifferently: typeof r.would_do_differently === 'string' ? r.would_do_differently : '',
    taskTitle: typeof r.task_title === 'string' ? r.task_title : '',
    timestamp: isoOf(r.timestamp),
  };
}

// ─── Task store ────────────────────────────────────────────────────────────

export class PostgresTaskStore {
  constructor(private pool: Pool) {}

  /** Resolve the active tenant for the call. The optional positional
   *  arg lets callers in cross-tenant tooling (admin views) override
   *  the AsyncLocalStorage-derived value. */
  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  async upsert(task: Task, tenantId?: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO tasks (id, data, status, owner_id, assigned_to, category, priority, created_at, updated_at, tenant_id)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        data = EXCLUDED.data, status = EXCLUDED.status,
        assigned_to = EXCLUDED.assigned_to, priority = EXCLUDED.priority,
        updated_at = EXCLUDED.updated_at
    `, [
      task.id, JSON.stringify(task), task.status, task.ownerId, task.assignedTo ?? null,
      task.category, task.priority,
      task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
      task.updatedAt instanceof Date ? task.updatedAt.toISOString() : task.updatedAt,
      this.resolveTenant(tenantId),
    ]);
  }

  async get(id: string, tenantId?: string): Promise<Task | undefined> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT data FROM tasks WHERE id = $1 AND tenant_id = $2', [id, t]);
    return r.rows[0] ? rowToTask(r.rows[0]) : undefined;
  }

  async getAll(tenantId?: string): Promise<Task[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT data FROM tasks WHERE tenant_id = $1 ORDER BY created_at DESC', [t]);
    return r.rows.map(rowToTask);
  }

  async getByStatus(status: string, tenantId?: string): Promise<Task[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT data FROM tasks WHERE status = $1 AND tenant_id = $2', [status, t]);
    return r.rows.map(rowToTask);
  }
  async getByOwner(ownerId: string, tenantId?: string): Promise<Task[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT data FROM tasks WHERE owner_id = $1 AND tenant_id = $2', [ownerId, t]);
    return r.rows.map(rowToTask);
  }
  async getByCategory(category: string, tenantId?: string): Promise<Task[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT data FROM tasks WHERE category = $1 AND tenant_id = $2', [category, t]);
    return r.rows.map(rowToTask);
  }

  async delete(id: string, tenantId?: string): Promise<void> {
    const t = this.resolveTenant(tenantId);
    await this.pool.query('DELETE FROM tasks WHERE id = $1 AND tenant_id = $2', [id, t]);
  }
  async count(tenantId?: string): Promise<number> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT COUNT(*)::int AS n FROM tasks WHERE tenant_id = $1', [t]);
    return r.rows[0]?.n ?? 0;
  }
  async close(): Promise<void> { /* pool is shared; closeSharedPool() owns it */ }
}

// ─── Incident store ────────────────────────────────────────────────────────

export class PostgresIncidentStore {
  constructor(private pool: Pool) {}

  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  async upsert(inc: Incident, tenantId?: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO incidents
        (id, title, description, severity, status, assigned_to, assigned_agent, created_at, updated_at,
         resolved_at, source, source_ref, sla_minutes, jira_key, jira_url, escalation_level, escalated_at, server_id, tenant_id, ticketing_synced, github_issue_number, search_tsv)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
              setweight(to_tsvector('simple', coalesce($2,'')), 'A')
              || setweight(to_tsvector('simple', coalesce($3,'')), 'B'))
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, description = EXCLUDED.description,
        severity = EXCLUDED.severity, status = EXCLUDED.status,
        assigned_to = EXCLUDED.assigned_to, assigned_agent = EXCLUDED.assigned_agent,
        updated_at = EXCLUDED.updated_at,
        resolved_at = EXCLUDED.resolved_at, source_ref = EXCLUDED.source_ref,
        jira_key = EXCLUDED.jira_key, jira_url = EXCLUDED.jira_url,
        escalation_level = EXCLUDED.escalation_level, escalated_at = EXCLUDED.escalated_at,
        server_id = EXCLUDED.server_id,
        ticketing_synced = EXCLUDED.ticketing_synced,
        github_issue_number = EXCLUDED.github_issue_number,
        search_tsv = EXCLUDED.search_tsv
    `, [
      inc.id, inc.title, inc.description, inc.severity, inc.status,
      inc.assignedTo ?? null, inc.assignedAgent ?? null,
      inc.createdAt, inc.updatedAt,
      inc.resolvedAt ?? null, inc.source, inc.sourceRef ?? null, inc.slaMinutes,
      inc.jiraKey ?? null, inc.jiraUrl ?? null,
      inc.escalationLevel ?? 0, inc.escalatedAt ?? null,
      inc.serverId ?? null,
      this.resolveTenant(tenantId),
    ]);
  }

  async addTimeline(entry: TimelineEntry, tenantId?: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO incident_timeline (id, incident_id, timestamp, actor, type, message, tenant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [entry.id, entry.incidentId, entry.timestamp, entry.actor, entry.type, entry.message, this.resolveTenant(tenantId)]);
  }

  async get(id: string, tenantId?: string): Promise<Incident | null> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT * FROM incidents WHERE id = $1 AND tenant_id = $2', [id, t]);
    return r.rows[0] ? rowToIncident(r.rows[0]) : null;
  }

  async list(filter?: { status?: string; severity?: string; assignedTo?: string; tenantId?: string }): Promise<Incident[]> {
    const t = this.resolveTenant(filter?.tenantId);
    const conds: string[] = ['tenant_id = $1'];
    const params: any[] = [t];
    if (filter?.status)     { params.push(filter.status);     conds.push(`status = $${params.length}`); }
    if (filter?.severity)   { params.push(filter.severity);   conds.push(`severity = $${params.length}`); }
    if (filter?.assignedTo) { params.push(filter.assignedTo); conds.push(`assigned_to = $${params.length}`); }
    const r = await this.pool.query(
      `SELECT * FROM incidents WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`, params,
    );
    return r.rows.map(rowToIncident);
  }

  async search(q: string, tenantId?: string): Promise<string[]> {
    if (!q || !q.trim()) return [];
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `SELECT id FROM incidents
       WHERE tenant_id = $2
         AND search_tsv @@ plainto_tsquery('simple', $1)
       ORDER BY ts_rank(search_tsv, plainto_tsquery('simple', $1)) DESC
       LIMIT 100`, [q, t]
    );
    return r.rows.map(x => x.id);
  }

  async getTimeline(incidentId: string, tenantId?: string): Promise<TimelineEntry[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      'SELECT * FROM incident_timeline WHERE incident_id = $1 AND tenant_id = $2 ORDER BY timestamp ASC', [incidentId, t]
    );
    return r.rows.map(x => ({
      id: x.id, incidentId: x.incident_id,
      timestamp: isoOf(x.timestamp), actor: x.actor,
      type: x.type as TimelineEventType, message: x.message,
    }));
  }

  async stats() {
    const counts = await this.pool.query(
      `SELECT status, COUNT(*)::int AS n FROM incidents GROUP BY status`
    );
    const byStatus: Record<string, number> = {};
    for (const row of counts.rows) byStatus[row.status] = row.n;

    const avg = await this.pool.query(
      `SELECT EXTRACT(EPOCH FROM AVG(resolved_at - created_at)) / 60 AS avg_min
       FROM incidents WHERE resolved_at IS NOT NULL`
    );
    const breaches = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM incidents
       WHERE status NOT IN ('resolved','closed')
         AND EXTRACT(EPOCH FROM (NOW() - created_at)) / 60 > sla_minutes`
    );

    return {
      open: byStatus['open'] ?? 0,
      investigating: byStatus['investigating'] ?? 0,
      resolved: byStatus['resolved'] ?? 0,
      avgResolutionMinutes: Math.round(avg.rows[0]?.avg_min ?? 0),
      slaBreaches: breaches.rows[0]?.n ?? 0,
    };
  }

  async markTicketingSynced(id: string, githubIssueNumber?: number): Promise<void> {
    await this.pool.query(
      `UPDATE incidents SET ticketing_synced = 1, github_issue_number = COALESCE($1, github_issue_number), updated_at = NOW() WHERE id = $2`,
      [githubIssueNumber ?? null, id]
    );
  }

  async updateGitHubIssueNumber(id: string, issueNumber: number): Promise<void> {
    await this.pool.query(
      `UPDATE incidents SET github_issue_number = $1, updated_at = NOW() WHERE id = $2`,
      [issueNumber, id]
    );
  }

  async updateJiraKey(id: string, jiraKey: string, jiraUrl: string): Promise<void> {
    await this.pool.query(
      `UPDATE incidents SET jira_key = $1, jira_url = $2, updated_at = NOW() WHERE id = $3`,
      [jiraKey, jiraUrl, id]
    );
  }

  async saveAnalysis(id: string, analysisJson: string): Promise<void> {
    await this.pool.query(
      `UPDATE incidents SET ai_analysis = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [analysisJson, id]
    );
  }

  async purge(opts: { maxAgeDays?: number; keepLatest?: number; statusFilter?: string[]; dryRun?: boolean }): Promise<number> {
    const { maxAgeDays = 30, keepLatest = 500, statusFilter = ['resolved', 'closed'], dryRun = false } = opts;
    if (statusFilter.length === 0) return 0;

    const statusPlaceholders = statusFilter.map((_, i) => `$${i + 1}`).join(', ');
    const clauses: string[] = [];
    const params: unknown[] = [...statusFilter];
    if (maxAgeDays > 0) {
      params.push(`${maxAgeDays} days`);
      clauses.push(`created_at < NOW() - $${params.length}::interval`);
    }
    if (keepLatest > 0) {
      const nested = statusFilter.map(status => { params.push(status); return `$${params.length}`; }).join(', ');
      params.push(keepLatest);
      clauses.push(`id NOT IN (SELECT id FROM incidents WHERE status IN (${nested}) ORDER BY created_at DESC LIMIT $${params.length})`);
    }
    if (clauses.length === 0) return 0;
    const where = `status IN (${statusPlaceholders}) AND (${clauses.join(' OR ')})`;
    const result = await this.pool.query(`${dryRun ? 'SELECT COUNT(*)::int AS n FROM' : 'DELETE FROM'} incidents WHERE ${where}`, params);
    return dryRun ? result.rows[0]?.n ?? 0 : result.rowCount ?? 0;
  }

  async close(): Promise<void> { /* pool is shared */ }
}

// ─── Agent memory store ───────────────────────────────────────────────────

export class PostgresAgentMemoryStore {
  constructor(private pool: Pool) {}

  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  // Facts ------------------------------------------------------------------
  async saveFact(agentId: string, fact: string, tenantId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_facts (agent_id, fact, tenant_id) VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, fact) DO NOTHING`,
      [agentId, fact, this.resolveTenant(tenantId)]
    );
  }
  async rememberFact(agentId: string, fact: string, tenantId?: string): Promise<void> {
    return this.saveFact(agentId, fact, tenantId);
  }
  async getFacts(agentId: string, tenantId?: string): Promise<{ fact: string; created_at: string }[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `SELECT fact, created_at FROM agent_facts WHERE agent_id = $1 AND tenant_id = $2 ORDER BY created_at`,
      [agentId, t]
    );
    return r.rows.map(x => ({ fact: x.fact, created_at: isoOf(x.created_at) }));
  }
  async listFacts(agentId: string, tenantId?: string): Promise<string[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `SELECT fact FROM agent_facts WHERE agent_id = $1 AND tenant_id = $2 ORDER BY created_at`, [agentId, t]
    );
    return r.rows.map(x => x.fact);
  }
  async purgeFacts(opts: { maxAgeDays?: number; dryRun?: boolean }): Promise<number> {
    const { maxAgeDays = 60, dryRun = false } = opts;
    if (maxAgeDays <= 0) return 0;
    const r = await this.pool.query(
      `${dryRun ? 'SELECT COUNT(*)::int AS n FROM' : 'DELETE FROM'} agent_facts WHERE created_at < NOW() - $1::interval`,
      [`${maxAgeDays} days`]
    );
    return dryRun ? r.rows[0]?.n ?? 0 : r.rowCount ?? 0;
  }

  // Resolutions ------------------------------------------------------------
  async storeResolution(
    agentId: string, incident: { title: string; severity: string },
    resolution: string, runbookUsed?: string
  ): Promise<void> {
    await this.recordResolution({
      agentId, incidentTitle: incident.title, incidentSeverity: incident.severity,
      problemDescription: '', stepsTried: [], whatWorked: resolution,
      resolution, runbookUsed, resolutionTimeMs: 0, outcome: 'success',
    });
  }

  async recordResolution(input: {
    agentId: string; incidentTitle: string; incidentSeverity?: string;
    problemDescription?: string;
    stepsTried?: Array<{ tool?: string; params?: unknown; result?: string; thought?: string }>;
    whatWorked?: string; resolution: string; runbookUsed?: string;
    resolutionTimeMs?: number; outcome?: 'success' | 'partial' | 'failed';
  }): Promise<string> {
    const id = `res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const severity = input.incidentSeverity || 'medium';
    const tags = [
      'incident-resolution', severity, input.outcome ?? 'success',
      ...input.incidentTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2).slice(0, 8),
    ];
    const tsvText = `${input.incidentTitle} ${input.resolution} ${(input.whatWorked ?? '')}`;

    const tenant = this.resolveTenant();
    await this.pool.query(`
      INSERT INTO agent_resolutions
        (id, agent_id, incident_title, incident_severity, resolution, runbook_used, tags,
         problem_description, steps_tried, what_worked, resolution_time_ms, outcome, search_tsv, tenant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,
              to_tsvector('simple', coalesce($13,'')), $14)
    `, [
      id, input.agentId, input.incidentTitle, severity, input.resolution,
      input.runbookUsed ?? null, JSON.stringify(tags),
      input.problemDescription ?? '', JSON.stringify(input.stepsTried ?? []),
      input.whatWorked ?? input.resolution, Math.max(0, Math.round(input.resolutionTimeMs ?? 0)),
      input.outcome ?? 'success', tsvText, tenant,
    ]);

    const factText = `Resolved "${input.incidentTitle}" (${severity}, ${input.outcome ?? 'success'}, ${Math.round((input.resolutionTimeMs ?? 0) / 1000)}s): ${(input.whatWorked ?? input.resolution).slice(0, 200)}`;
    await this.saveFact(input.agentId, factText, tenant);
    return id;
  }

  async recallSimilarResolutions(
    agentId: string, incidentTitle: string, severity: string, limit = 5
  ): Promise<ResolutionRecord[]> {
    const q = incidentTitle.trim();
    if (q) {
      const r = await this.pool.query(`
        SELECT * FROM agent_resolutions
        WHERE agent_id = $1
          AND search_tsv @@ plainto_tsquery('simple', $2)
        ORDER BY ts_rank(search_tsv, plainto_tsquery('simple', $2)) DESC
        LIMIT $3
      `, [agentId, q, limit]);
      if (r.rows.length > 0) return r.rows.map(rowToResolution);
    }

    // Fallback: severity-prioritised LIKE on title.
    const keyword = `%${incidentTitle.slice(0, 40)}%`;
    const r = await this.pool.query(`
      SELECT * FROM agent_resolutions
      WHERE agent_id = $1 AND (incident_title ILIKE $2 OR $2 = '')
      ORDER BY (incident_severity = $3) DESC, created_at DESC
      LIMIT $4
    `, [agentId, keyword, severity, limit]);
    return r.rows.map(rowToResolution);
  }

  async buildIncidentRecallPrompt(
    agentId: string, incidentTitle: string, severity: string, limit = 3
  ): Promise<string> {
    const records = await this.recallSimilarResolutions(agentId, incidentTitle, severity, limit);
    if (records.length === 0) return '';

    const lines: string[] = ['## Past Similar Incidents (for reference, not authoritative)'];
    for (const r of records) {
      const when = r.created_at?.slice(0, 10) ?? 'unknown';
      const dur = r.resolution_time_ms > 0 ? `${Math.round(r.resolution_time_ms / 1000)}s` : 'n/a';
      lines.push(`- [${when}] "${r.incident_title}" (${r.incident_severity}, ${r.outcome}, ${dur})`);
      if (r.problem_description) lines.push(`    problem: ${r.problem_description.slice(0, 200)}`);
      if (r.what_worked)         lines.push(`    what worked: ${r.what_worked.slice(0, 240)}`);
      if (r.steps_tried.length > 0) {
        const tools = r.steps_tried.map(s => s.tool).filter(Boolean).slice(0, 6);
        if (tools.length > 0) lines.push(`    steps: ${tools.join(' → ')}`);
      }
      if (r.runbook_used) lines.push(`    runbook: ${r.runbook_used}`);
    }
    return lines.join('\n');
  }

  async listResolutions(agentId: string, tenantId?: string): Promise<ResolutionRecord[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(`
      SELECT * FROM agent_resolutions WHERE agent_id = $1 AND tenant_id = $2 ORDER BY created_at DESC
    `, [agentId, t]);
    return r.rows.map(rowToResolution);
  }

  // Reflections ------------------------------------------------------------
  async storeReflection(reflection: ReflectionRecord, tenantId?: string): Promise<string> {
    const id = `refl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.pool.query(`
      INSERT INTO agent_reflections
        (id, task_id, agent_id, self_rating, what_worked, what_didnt_work,
         lessons_learned, suggested_improvements, tool_efficiency,
         would_do_differently, task_title, timestamp, tenant_id)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
    `, [
      id, reflection.taskId, reflection.agentId, reflection.selfRating,
      JSON.stringify(reflection.whatWorked ?? []),
      JSON.stringify(reflection.whatDidntWork ?? []),
      JSON.stringify(reflection.lessonsLearned ?? []),
      JSON.stringify(reflection.suggestedImprovements ?? []),
      JSON.stringify(reflection.toolEfficiency ?? []),
      reflection.wouldDoDifferently ?? '',
      reflection.taskTitle ?? '',
      reflection.timestamp ?? new Date().toISOString(),
      this.resolveTenant(tenantId),
    ]);
    return id;
  }

  async getReflections(agentId: string, limit = 50): Promise<StoredReflection[]> {
    const r = await this.pool.query(`
      SELECT * FROM agent_reflections WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT $2
    `, [agentId, limit]);
    return r.rows.map(rowToReflection);
  }

  async getReflectionsByRating(agentId: string, minRating = 1, maxRating = 5, limit = 50): Promise<StoredReflection[]> {
    const r = await this.pool.query(`
      SELECT * FROM agent_reflections
      WHERE agent_id = $1 AND self_rating BETWEEN $2 AND $3
      ORDER BY timestamp DESC LIMIT $4
    `, [agentId, minRating, maxRating, limit]);
    return r.rows.map(rowToReflection);
  }

  async getAverageRating(agentId: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT AVG(self_rating)::float8 AS avg, COUNT(*)::int AS n
       FROM agent_reflections WHERE agent_id = $1`, [agentId]
    );
    const row = r.rows[0];
    return row?.n > 0 ? Number(row.avg) : 0;
  }

  async getRelevantLessons(
    agentId: string, taskTitle: string,
    opts: { limit?: number; maxLowRating?: number } = {}
  ) {
    const limit = opts.limit ?? 3;
    const lowRating = opts.maxLowRating ?? 3;

    const words = taskTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const collected: Array<{ rating: number; lesson: string; would: string; ts: string }> = [];

    if (words.length > 0) {
      // Build OR'd ILIKE filters (one parameter per word).
      const conds = words.map((_, i) => `LOWER(task_title) LIKE $${i + 2}`).join(' OR ');
      const params: any[] = [agentId, ...words.map(w => `%${w}%`)];
      const r = await this.pool.query(`
        SELECT self_rating, lessons_learned, would_do_differently, timestamp
        FROM agent_reflections
        WHERE agent_id = $1 AND (${conds})
        ORDER BY (self_rating <= ${lowRating}) DESC, timestamp DESC
        LIMIT 30
      `, params);
      for (const row of r.rows) {
        for (const l of asArrayString(row.lessons_learned)) {
          collected.push({
            rating: row.self_rating, lesson: l,
            would: row.would_do_differently ?? '',
            ts: isoOf(row.timestamp),
          });
        }
      }
    }

    const seen = new Set<string>();
    const lessons: string[] = [];
    const wouldSet = new Set<string>();
    for (const e of collected) {
      const clipped = e.lesson.length > 120 ? e.lesson.slice(0, 117) + '...' : e.lesson;
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lessons.push(clipped);
      if (e.would && !wouldSet.has(e.would.toLowerCase())) wouldSet.add(e.would.toLowerCase());
      if (lessons.length >= limit) break;
    }

    const wouldDoDifferently = Array.from(wouldSet).slice(0, limit).map(s =>
      s.length > 120 ? s.slice(0, 117) + '...' : s
    );

    const averageRating = await this.getAverageRating(agentId);
    const trend = await this._computeRatingTrend(agentId);

    return {
      lessons, wouldDoDifferently, averageRating,
      recentTrend: trend.direction, sampleSize: trend.sampleSize,
    };
  }

  private async _computeRatingTrend(agentId: string): Promise<{ direction: 'improving' | 'declining' | 'stable' | 'insufficient'; sampleSize: number }> {
    const r = await this.pool.query(
      `SELECT self_rating FROM agent_reflections WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT 10`,
      [agentId]
    );
    if (r.rows.length < 6) return { direction: 'insufficient', sampleSize: r.rows.length };
    const recent = r.rows.slice(0, 5).map(x => x.self_rating);
    const prior  = r.rows.slice(5, 10).map(x => x.self_rating);
    const avgR = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgP = prior.reduce((a, b) => a + b, 0) / prior.length;
    const delta = avgR - avgP;
    if (delta > 0.4)  return { direction: 'improving', sampleSize: r.rows.length };
    if (delta < -0.4) return { direction: 'declining', sampleSize: r.rows.length };
    return { direction: 'stable', sampleSize: r.rows.length };
  }

  async getPerformanceStats(agentId: string) {
    const total = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM agent_reflections WHERE agent_id = $1`, [agentId]
    );
    const ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    if (total.rows[0]?.n === 0) {
      return {
        totalReflections: 0, averageRating: 0,
        trend: 'insufficient' as const, ratingDistribution,
        mostEffectiveTools: [], commonFailurePatterns: [],
      };
    }

    const dist = await this.pool.query(
      `SELECT self_rating, COUNT(*)::int AS n FROM agent_reflections WHERE agent_id = $1 GROUP BY self_rating`,
      [agentId]
    );
    for (const row of dist.rows) ratingDistribution[row.self_rating as 1 | 2 | 3 | 4 | 5] = row.n;

    const recent = await this.pool.query(
      `SELECT tool_efficiency, what_didnt_work FROM agent_reflections
       WHERE agent_id = $1 ORDER BY timestamp DESC LIMIT 100`, [agentId]
    );

    const toolCounts = new Map<string, { useful: number; total: number }>();
    const failureCounts = new Map<string, number>();
    for (const row of recent.rows) {
      for (const e of asArrayObject(row.tool_efficiency)) {
        const tool = typeof e?.tool === 'string' ? e.tool : '';
        if (!tool) continue;
        const cur = toolCounts.get(tool) ?? { useful: 0, total: 0 };
        cur.total++;
        if (e?.useful) cur.useful++;
        toolCounts.set(tool, cur);
      }
      for (const f of asArrayString(row.what_didnt_work)) {
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
      totalReflections: total.rows[0].n,
      averageRating: await this.getAverageRating(agentId),
      trend: (await this._computeRatingTrend(agentId)).direction,
      ratingDistribution,
      mostEffectiveTools,
      commonFailurePatterns,
    };
  }

  // Messages ---------------------------------------------------------------
  async saveMessage(agentId: string, role: string, content: string, tenantId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_messages (agent_id, role, content, tenant_id) VALUES ($1, $2, $3, $4)`,
      [agentId, role, content, this.resolveTenant(tenantId)]
    );
  }
  async getRecentMessages(agentId: string, limit = 50, tenantId?: string): Promise<{ role: string; content: string }[]> {
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `SELECT role, content FROM agent_messages WHERE agent_id = $1 AND tenant_id = $2 ORDER BY id DESC LIMIT $3`,
      [agentId, t, limit]
    );
    return r.rows.reverse();
  }
  async clearMessages(agentId: string, tenantId?: string): Promise<void> {
    await this.pool.query(`DELETE FROM agent_messages WHERE agent_id = $1 AND tenant_id = $2`,
      [agentId, this.resolveTenant(tenantId)]);
  }
  async purgeMessages(opts: { maxAgeDays?: number; keepLatestPerAgent?: number; dryRun?: boolean }): Promise<number> {
    const { maxAgeDays = 60, keepLatestPerAgent = 200, dryRun = false } = opts;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (maxAgeDays > 0) {
      params.push(`${maxAgeDays} days`);
      clauses.push(`created_at < NOW() - $${params.length}::interval`);
    }
    if (keepLatestPerAgent > 0) {
      params.push(keepLatestPerAgent);
      clauses.push(`id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn
            FROM agent_messages
          ) ranked WHERE rn > $${params.length}
        )`);
    }
    if (clauses.length === 0) return 0;
    const result = await this.pool.query(
      `${dryRun ? 'SELECT COUNT(*)::int AS n FROM' : 'DELETE FROM'} agent_messages WHERE ${clauses.map(clause => `(${clause})`).join(' OR ')}`,
      params,
    );
    return dryRun ? result.rows[0]?.n ?? 0 : result.rowCount ?? 0;
  }

  // Stats / lifecycle ------------------------------------------------------
  async getMemoryStats(agentId: string) {
    const facts = await this.pool.query(
      `SELECT COUNT(*)::int AS n, MAX(created_at) AS last FROM agent_facts WHERE agent_id = $1`,
      [agentId]
    );
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n, MAX(created_at) AS last FROM agent_resolutions WHERE agent_id = $1`,
      [agentId]
    );
    const lastUpdated = [facts.rows[0]?.last, res.rows[0]?.last]
      .filter(Boolean).map(isoOf).sort().pop() ?? null;
    return {
      totalFacts: facts.rows[0]?.n ?? 0,
      resolutionPatterns: res.rows[0]?.n ?? 0,
      lastUpdated,
    };
  }

  async clearAll(agentId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM agent_facts       WHERE agent_id = $1`, [agentId]);
      await client.query(`DELETE FROM agent_resolutions WHERE agent_id = $1`, [agentId]);
      await client.query(`DELETE FROM agent_messages    WHERE agent_id = $1`, [agentId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> { /* pool is shared */ }
}

// Re-export the schema SQL for tools that want to inspect what we'll create.
export const POSTGRES_SCHEMA_SQL = SCHEMA_SQL;

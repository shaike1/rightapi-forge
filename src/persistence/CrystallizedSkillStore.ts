// Persistence for CrystallizedSkill records.
//
// Simple two-key model:
//   - `crystallized_skills` table holds the canonical record per id.
//   - `recentUsage` is stored INSIDE the record (capped JSON list)
//     rather than in a separate table — auto-promotion only ever
//     looks at the most recent N outcomes, not the full history.
//     Keeping it in-row avoids a join on the hot read path.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { getCurrentTenantId } from '../tenancy/index.js';
// Type-only import; the canonical types live with the crystallization
// module that owns the lifecycle semantics.
import type {
  CrystallizedSkill,
  CrystallizedSkillStatus,
  CrystallizedSkillUsage,
} from '../crystallization/CrystallizedSkillTypes.js';

/** Cap on the in-row usage history. Auto-promotion only needs the
 *  most recent ~5 outcomes, but we keep 20 for the dashboard. */
export const RECENT_USAGE_CAP = 20;

export interface CrystallizedSkillStore {
  upsert(skill: CrystallizedSkill): void | Promise<void>;
  get(id: string, tenantId?: string): CrystallizedSkill | null | Promise<CrystallizedSkill | null>;
  list(filter?: {
    tenantId?: string;
    status?: CrystallizedSkillStatus;
    agentId?: string;
    /** Match on a single tag. */
    tag?: string;
    limit?: number;
  }): CrystallizedSkill[] | Promise<CrystallizedSkill[]>;
  setStatus(id: string, status: CrystallizedSkillStatus, tenantId?: string): boolean | Promise<boolean>;
  /** Append one usage outcome + bump usage_count atomically. Returns
   *  the updated record so the caller (AutoPromotion) can decide
   *  whether to demote. */
  recordUsage(id: string, usage: CrystallizedSkillUsage, tenantId?: string): CrystallizedSkill | null | Promise<CrystallizedSkill | null>;
  /** Per-day count for the rate-limit gate. The window is
   *  [startOfDayUtc, now]. */
  countDraftsTodayByAgent(agentId: string, tenantId?: string): number | Promise<number>;
  delete(id: string, tenantId?: string): boolean | Promise<boolean>;
  close(): void | Promise<void>;
}

// ─── SQLite ────────────────────────────────────────────────────────────

export class SqliteCrystallizedSkillStore implements CrystallizedSkillStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crystallized_skills (
        id                    TEXT PRIMARY KEY,
        tenant_id             TEXT NOT NULL DEFAULT 'system',
        name                  TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        source_resolution_id  TEXT NOT NULL,
        source_agent_id       TEXT NOT NULL,
        generated_workflow    TEXT NOT NULL,
        parameters            TEXT NOT NULL DEFAULT '[]',
        tags                  TEXT NOT NULL DEFAULT '[]',
        status                TEXT NOT NULL DEFAULT 'draft',
        confidence_score      REAL NOT NULL DEFAULT 0,
        usage_count           INTEGER NOT NULL DEFAULT 0,
        recent_usage          TEXT NOT NULL DEFAULT '[]',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cs_tenant       ON crystallized_skills(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_cs_status       ON crystallized_skills(status);
      CREATE INDEX IF NOT EXISTS idx_cs_agent        ON crystallized_skills(source_agent_id);
      CREATE INDEX IF NOT EXISTS idx_cs_created_at   ON crystallized_skills(created_at);
    `);
    logger.info(`[SqliteCrystallizedSkillStore] Opened ${dbPath}`);
  }

  private resolveTenant(t?: string): string { return t ?? getCurrentTenantId(); }

  upsert(s: CrystallizedSkill): void {
    this.db.prepare(`
      INSERT INTO crystallized_skills
        (id, tenant_id, name, description, source_resolution_id, source_agent_id,
         generated_workflow, parameters, tags, status, confidence_score,
         usage_count, recent_usage, created_at, updated_at)
      VALUES (@id, @tenantId, @name, @description, @sourceResolutionId, @sourceAgentId,
              @generatedWorkflow, @parameters, @tags, @status, @confidenceScore,
              @usageCount, @recentUsage, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        generated_workflow = excluded.generated_workflow,
        parameters = excluded.parameters,
        tags = excluded.tags,
        status = excluded.status,
        confidence_score = excluded.confidence_score,
        usage_count = excluded.usage_count,
        recent_usage = excluded.recent_usage,
        updated_at = excluded.updated_at
    `).run({
      id: s.id, tenantId: s.tenantId, name: s.name, description: s.description,
      sourceResolutionId: s.sourceResolutionId, sourceAgentId: s.sourceAgentId,
      generatedWorkflow: s.generatedWorkflow,
      parameters: JSON.stringify(s.parameters),
      tags:       JSON.stringify(s.tags),
      status: s.status, confidenceScore: s.confidenceScore,
      usageCount: s.usageCount,
      recentUsage: JSON.stringify(s.recentUsage),
      createdAt: s.createdAt, updatedAt: s.updatedAt,
    });
  }

  get(id: string, tenantId?: string): CrystallizedSkill | null {
    const t = this.resolveTenant(tenantId);
    const row = this.db.prepare('SELECT * FROM crystallized_skills WHERE id = ? AND tenant_id = ?').get(id, t) as RawRow | undefined;
    return row ? rowToSkill(row) : null;
  }

  list(filter: {
    tenantId?: string; status?: CrystallizedSkillStatus; agentId?: string; tag?: string; limit?: number;
  } = {}): CrystallizedSkill[] {
    const t = this.resolveTenant(filter.tenantId);
    let sql = 'SELECT * FROM crystallized_skills WHERE tenant_id = ?';
    const params: unknown[] = [t];
    if (filter.status)  { sql += ' AND status = ?';          params.push(filter.status); }
    if (filter.agentId) { sql += ' AND source_agent_id = ?'; params.push(filter.agentId); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    let out = rows.map(rowToSkill);
    // Tag filter happens post-row since tags are JSON-stringified.
    if (filter.tag) {
      const tag = filter.tag.toLowerCase();
      out = out.filter(s => s.tags.some(x => x.toLowerCase() === tag));
    }
    return out;
  }

  setStatus(id: string, status: CrystallizedSkillStatus, tenantId?: string): boolean {
    const t = this.resolveTenant(tenantId);
    return this.db.prepare(
      `UPDATE crystallized_skills SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    ).run(status, new Date().toISOString(), id, t).changes > 0;
  }

  recordUsage(id: string, usage: CrystallizedSkillUsage, tenantId?: string): CrystallizedSkill | null {
    const tx = this.db.transaction(() => {
      const t = this.resolveTenant(tenantId);
      const existing = this.get(id, t);
      if (!existing) return null;
      const next = [...existing.recentUsage, usage].slice(-RECENT_USAGE_CAP);
      this.db.prepare(
        `UPDATE crystallized_skills
           SET usage_count = usage_count + 1,
               recent_usage = ?,
               updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      ).run(JSON.stringify(next), new Date().toISOString(), id, t);
      return this.get(id, t);
    });
    return tx();
  }

  countDraftsTodayByAgent(agentId: string, tenantId?: string): number {
    const t = this.resolveTenant(tenantId);
    const since = startOfTodayUtc();
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM crystallized_skills
       WHERE tenant_id = ? AND source_agent_id = ? AND created_at >= ?`,
    ).get(t, agentId, since) as { n: number };
    return row?.n ?? 0;
  }

  delete(id: string, tenantId?: string): boolean {
    const t = this.resolveTenant(tenantId);
    return this.db.prepare('DELETE FROM crystallized_skills WHERE id = ? AND tenant_id = ?').run(id, t).changes > 0;
  }

  close(): void { this.db.close(); }
}

// ─── Postgres ──────────────────────────────────────────────────────────

export class PostgresCrystallizedSkillStore implements CrystallizedSkillStore {
  private readonly pool: Pool;
  private schemaReady = false;
  constructor(pool: Pool) { this.pool = pool; void this.ensureSchema(); }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS crystallized_skills (
          id                    TEXT PRIMARY KEY,
          tenant_id             TEXT NOT NULL DEFAULT 'system',
          name                  TEXT NOT NULL,
          description           TEXT NOT NULL DEFAULT '',
          source_resolution_id  TEXT NOT NULL,
          source_agent_id       TEXT NOT NULL,
          generated_workflow    JSONB NOT NULL,
          parameters            JSONB NOT NULL DEFAULT '[]'::jsonb,
          tags                  JSONB NOT NULL DEFAULT '[]'::jsonb,
          status                TEXT NOT NULL DEFAULT 'draft',
          confidence_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
          usage_count           INTEGER NOT NULL DEFAULT 0,
          recent_usage          JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_cs_tenant     ON crystallized_skills(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_cs_status     ON crystallized_skills(status);
        CREATE INDEX IF NOT EXISTS idx_cs_agent      ON crystallized_skills(source_agent_id);
        CREATE INDEX IF NOT EXISTS idx_cs_created_at ON crystallized_skills(created_at);
      `);
      this.schemaReady = true;
    } finally { client.release(); }
  }

  private resolveTenant(t?: string): string { return t ?? getCurrentTenantId(); }

  async upsert(s: CrystallizedSkill): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`
      INSERT INTO crystallized_skills
        (id, tenant_id, name, description, source_resolution_id, source_agent_id,
         generated_workflow, parameters, tags, status, confidence_score,
         usage_count, recent_usage, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13::jsonb,$14::timestamptz,$15::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        generated_workflow = EXCLUDED.generated_workflow,
        parameters = EXCLUDED.parameters, tags = EXCLUDED.tags,
        status = EXCLUDED.status, confidence_score = EXCLUDED.confidence_score,
        usage_count = EXCLUDED.usage_count, recent_usage = EXCLUDED.recent_usage,
        updated_at = EXCLUDED.updated_at
    `, [
      s.id, s.tenantId, s.name, s.description, s.sourceResolutionId, s.sourceAgentId,
      s.generatedWorkflow, JSON.stringify(s.parameters), JSON.stringify(s.tags),
      s.status, s.confidenceScore, s.usageCount,
      JSON.stringify(s.recentUsage), s.createdAt, s.updatedAt,
    ]);
  }

  async get(id: string, tenantId?: string): Promise<CrystallizedSkill | null> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT * FROM crystallized_skills WHERE id = $1 AND tenant_id = $2', [id, t]);
    return r.rows[0] ? rowToSkillPg(r.rows[0]) : null;
  }

  async list(filter: {
    tenantId?: string; status?: CrystallizedSkillStatus; agentId?: string; tag?: string; limit?: number;
  } = {}): Promise<CrystallizedSkill[]> {
    await this.ensureSchema();
    const t = this.resolveTenant(filter.tenantId);
    const where = ['tenant_id = $1'];
    const params: unknown[] = [t];
    if (filter.status)  { params.push(filter.status);  where.push(`status = $${params.length}`); }
    if (filter.agentId) { params.push(filter.agentId); where.push(`source_agent_id = $${params.length}`); }
    if (filter.tag)     { params.push(filter.tag.toLowerCase()); where.push(`LOWER(tags::text) LIKE '%' || $${params.length} || '%'`); }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    params.push(limit);
    const r = await this.pool.query(
      `SELECT * FROM crystallized_skills WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return r.rows.map(rowToSkillPg);
  }

  async setStatus(id: string, status: CrystallizedSkillStatus, tenantId?: string): Promise<boolean> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `UPDATE crystallized_skills SET status = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [status, id, t],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async recordUsage(id: string, usage: CrystallizedSkillUsage, tenantId?: string): Promise<CrystallizedSkill | null> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT recent_usage FROM crystallized_skills WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [id, t],
      );
      if (cur.rows.length === 0) { await client.query('ROLLBACK'); return null; }
      const recent = (cur.rows[0].recent_usage as CrystallizedSkillUsage[] | null) ?? [];
      const next = [...recent, usage].slice(-RECENT_USAGE_CAP);
      await client.query(
        `UPDATE crystallized_skills
            SET usage_count = usage_count + 1, recent_usage = $1::jsonb, updated_at = NOW()
          WHERE id = $2 AND tenant_id = $3`,
        [JSON.stringify(next), id, t],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => { /* */ });
      throw e;
    } finally { client.release(); }
    return this.get(id, t);
  }

  async countDraftsTodayByAgent(agentId: string, tenantId?: string): Promise<number> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM crystallized_skills
       WHERE tenant_id = $1 AND source_agent_id = $2
         AND created_at >= $3::timestamptz`,
      [t, agentId, startOfTodayUtc()],
    );
    return r.rows[0]?.n ?? 0;
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('DELETE FROM crystallized_skills WHERE id = $1 AND tenant_id = $2', [id, t]);
    return (r.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { /* shared pool */ }
}

// ─── helpers ───────────────────────────────────────────────────────────

interface RawRow {
  id: string; tenant_id: string; name: string; description: string;
  source_resolution_id: string; source_agent_id: string;
  generated_workflow: string; parameters: string; tags: string;
  status: CrystallizedSkillStatus; confidence_score: number;
  usage_count: number; recent_usage: string;
  created_at: string; updated_at: string;
}

function rowToSkill(r: RawRow): CrystallizedSkill {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, description: r.description,
    sourceResolutionId: r.source_resolution_id, sourceAgentId: r.source_agent_id,
    generatedWorkflow: r.generated_workflow,
    parameters: parseOr(r.parameters, []),
    tags:       parseOr(r.tags, []),
    status: r.status, confidenceScore: r.confidence_score,
    usageCount: r.usage_count,
    recentUsage: parseOr(r.recent_usage, []),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToSkillPg(row: Record<string, unknown>): CrystallizedSkill {
  return {
    id:                 row.id as string,
    tenantId:           row.tenant_id as string,
    name:               row.name as string,
    description:        (row.description as string) ?? '',
    sourceResolutionId: row.source_resolution_id as string,
    sourceAgentId:      row.source_agent_id as string,
    generatedWorkflow:  typeof row.generated_workflow === 'string'
                          ? row.generated_workflow
                          : JSON.stringify(row.generated_workflow),
    parameters: (row.parameters as CrystallizedSkill['parameters']) ?? [],
    tags:       (row.tags       as CrystallizedSkill['tags'])       ?? [],
    status:           row.status            as CrystallizedSkill['status'],
    confidenceScore:  row.confidence_score  as number,
    usageCount:       row.usage_count       as number,
    recentUsage:     (row.recent_usage      as CrystallizedSkill['recentUsage']) ?? [],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function parseOr<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

function startOfTodayUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

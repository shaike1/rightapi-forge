// Persistence for PersonalityProfile records. Same SQLite/Postgres
// contract pattern as the rest of the persistence layer; one row per
// agentId, the full profile lives in a JSON column so structural
// schema changes only require a schemaVersion bump on the JSON shape.
//
// Why a dedicated store rather than reusing the agent-memory one:
// PersonalityProfile is read on every LLM call (to compose the
// prompt fragment), so it benefits from a single-row hot path that
// doesn't compete with the multi-table memory schema. Keeping it in
// its own table also lets multi-tenant deployments scope it without
// touching the larger memory queries.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
// Type-only import — the schema lives with the agents module (where
// PersonalityEngine consumes it) but the store is pure persistence.
// `import type` is erased by the compiler so it doesn't create a
// runtime dependency edge from persistence → agents.
import type { PersonalityProfile } from '../agents/personality/PersonalityProfile.js';

export interface PersonalityStore {
  upsert(profile: PersonalityProfile): void | Promise<void>;
  get(agentId: string): PersonalityProfile | null | Promise<PersonalityProfile | null>;
  list(): PersonalityProfile[] | Promise<PersonalityProfile[]>;
  delete(agentId: string): boolean | Promise<boolean>;
  close(): void | Promise<void>;
}

// ─── SQLite ────────────────────────────────────────────────────────────

export class SqlitePersonalityStore implements PersonalityStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS personality_profiles (
        agent_id    TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
    logger.info(`[SqlitePersonalityStore] Opened ${dbPath}`);
  }

  upsert(profile: PersonalityProfile): void {
    this.db.prepare(`
      INSERT INTO personality_profiles (agent_id, data, created_at, updated_at)
      VALUES (@agentId, @data, @createdAt, @updatedAt)
      ON CONFLICT(agent_id) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at
    `).run({
      agentId:  profile.agentId,
      data:     JSON.stringify(profile),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
  }

  get(agentId: string): PersonalityProfile | null {
    const row = this.db.prepare('SELECT data FROM personality_profiles WHERE agent_id = ?').get(agentId) as { data: string } | undefined;
    return row ? safeParse(row.data) : null;
  }

  list(): PersonalityProfile[] {
    const rows = this.db.prepare('SELECT data FROM personality_profiles ORDER BY updated_at DESC').all() as { data: string }[];
    return rows.map(r => safeParse(r.data)).filter((p): p is PersonalityProfile => p !== null);
  }

  delete(agentId: string): boolean {
    return this.db.prepare('DELETE FROM personality_profiles WHERE agent_id = ?').run(agentId).changes > 0;
  }

  close(): void { this.db.close(); }
}

// ─── Postgres ─────────────────────────────────────────────────────────

export class PostgresPersonalityStore implements PersonalityStore {
  private readonly pool: Pool;
  private schemaReady = false;

  constructor(pool: Pool) {
    this.pool = pool;
    void this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS personality_profiles (
          agent_id    TEXT PRIMARY KEY,
          data        JSONB NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      this.schemaReady = true;
    } finally { client.release(); }
  }

  async upsert(profile: PersonalityProfile): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO personality_profiles (agent_id, data, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)
       ON CONFLICT (agent_id) DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at`,
      [profile.agentId, JSON.stringify(profile), profile.createdAt, profile.updatedAt],
    );
  }

  async get(agentId: string): Promise<PersonalityProfile | null> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT data FROM personality_profiles WHERE agent_id = $1', [agentId]);
    return res.rows[0] ? toProfile(res.rows[0].data) : null;
  }

  async list(): Promise<PersonalityProfile[]> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT data FROM personality_profiles ORDER BY updated_at DESC');
    return res.rows.map(r => toProfile(r.data)).filter((p): p is PersonalityProfile => p !== null);
  }

  async delete(agentId: string): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.pool.query('DELETE FROM personality_profiles WHERE agent_id = $1', [agentId]);
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { /* shared pool */ }
}

// ─── helpers ───────────────────────────────────────────────────────────

function safeParse(text: string): PersonalityProfile | null {
  try {
    const obj = JSON.parse(text);
    if (obj && obj.schemaVersion === 1) return obj as PersonalityProfile;
    return null;
  } catch { return null; }
}

function toProfile(data: unknown): PersonalityProfile | null {
  if (typeof data === 'string') return safeParse(data);
  if (data && typeof data === 'object' && (data as { schemaVersion?: number }).schemaVersion === 1) {
    return data as PersonalityProfile;
  }
  return null;
}

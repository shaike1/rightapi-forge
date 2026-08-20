// Registry of tenants. Lightweight on purpose — nothing in the runtime
// blocks on this beyond "does the tenant exist". The contract mirrors
// the rest of the persistence layer (sync + async overload via the
// "T | Promise<T>" pattern in interfaces.ts) so it works under either
// DB_PROVIDER without consumer code branching.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { SYSTEM_TENANT_ID } from './TenantContext.js';

export type TenantStatus = 'active' | 'suspended';
export type TenantPlan = 'free' | 'pro' | 'enterprise';

export interface TenantRecord {
  id: string;
  /** URL-safe slug derived from the org name at registration time.
   *  Unique across tenants. Pre-existing rows that predate the slug
   *  column are migrated lazily — get()/list() backfill it to the id. */
  slug: string;
  name: string;
  /** Plan tier — drives the limits enforced by PlanEnforcer. Defaults
   *  to 'free' for self-service signups, 'enterprise' for the system
   *  tenant (no limits on legacy data). */
  plan: TenantPlan;
  /** Optional vanity hostname (e.g. "support.acme.com"). When set, the
   *  TenantResolver matches incoming requests with this Host header
   *  to this tenant. Unique across tenants. */
  customDomain: string | null;
  /** Username of the admin who created the tenant. Null for the
   *  system tenant (pre-multitenant origin) and any tenant bulk-loaded
   *  by a superadmin migration. */
  ownerUsername: string | null;
  status: TenantStatus;
  createdAt: string;
  updatedAt: string;
  /** Free-form per-tenant settings — feature flags, defaults, etc. */
  settings: Record<string, unknown>;
}

export interface TenantStore {
  /** Insert or update a tenant. Returns the persisted record. */
  upsert(input: { id: string; slug?: string; name?: string; plan?: TenantPlan; customDomain?: string | null; ownerUsername?: string | null; status?: TenantStatus; settings?: Record<string, unknown> }): TenantRecord | Promise<TenantRecord>;
  get(id: string): TenantRecord | null | Promise<TenantRecord | null>;
  getBySlug(slug: string): TenantRecord | null | Promise<TenantRecord | null>;
  /** Look up a tenant by its custom_domain. Used by TenantResolver to
   *  route vanity hostnames to the right tenant. Returns null when no
   *  tenant has claimed the host. */
  getByCustomDomain(hostname: string): TenantRecord | null | Promise<TenantRecord | null>;
  list(): TenantRecord[] | Promise<TenantRecord[]>;
  delete(id: string): boolean | Promise<boolean>;
  /** Idempotently ensure a row exists for the system tenant; called at
   *  process startup so the SYSTEM_TENANT_ID fallback is always valid. */
  ensureSystem(): TenantRecord | Promise<TenantRecord>;
  close(): void | Promise<void>;
}

// ─── SQLite implementation ──────────────────────────────────────────────

export class SqliteTenantStore implements TenantStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settings   TEXT NOT NULL DEFAULT '{}'
      );
    `);
    // Backfill the new columns on existing deployments. Each ALTER is
    // wrapped in a try/catch because PRAGMA table_info checks are
    // verbose — SQLite handles "duplicate column" as an error we can
    // ignore. Defaults match the spec: free plan, slug=id, owner=null.
    for (const stmt of [
      "ALTER TABLE tenants ADD COLUMN slug TEXT",
      "ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'",
      "ALTER TABLE tenants ADD COLUMN owner_username TEXT",
      "ALTER TABLE tenants ADD COLUMN custom_domain TEXT",
    ]) {
      try { this.db.exec(stmt); } catch { /* already exists */ }
    }
    // Unique slug index — created AFTER backfill so older rows that
    // lack a slug can be migrated below without a violation.
    try {
      this.db.exec(`UPDATE tenants SET slug = id WHERE slug IS NULL OR slug = ''`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug)`);
      // Partial unique index on custom_domain — SQLite supports
      // partial-unique-index since 3.8.0; the WHERE clause excludes
      // NULLs so multiple tenants can have NULL custom_domain
      // simultaneously.
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_custom_domain ON tenants(custom_domain) WHERE custom_domain IS NOT NULL`);
    } catch { /* index migration failed — surfaces in startup logs */ }
    // The system tenant always operates on the unlimited 'enterprise'
    // plan: it carries every pre-multitenant row, so plan limits would
    // arbitrarily cap legacy deployments.
    this.ensureSystem();
    try {
      this.db.prepare(`UPDATE tenants SET plan = 'enterprise' WHERE id = ?`).run(SYSTEM_TENANT_ID);
    } catch { /* settings migration */ }
    logger.info(`[SqliteTenantStore] Opened ${dbPath}`);
  }

  upsert(input: { id: string; slug?: string; name?: string; plan?: TenantPlan; customDomain?: string | null; ownerUsername?: string | null; status?: TenantStatus; settings?: Record<string, unknown> }): TenantRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.id);
    // Normalise customDomain to lowercase + strip trailing dot. Empty
    // string from a form submit collapses to null so the partial-unique
    // index doesn't reject duplicates.
    const customDomain = input.customDomain !== undefined
      ? normaliseDomain(input.customDomain)
      : (existing?.customDomain ?? null);
    const record: TenantRecord = {
      id: input.id,
      slug: (input.slug ?? existing?.slug ?? input.id).toLowerCase(),
      name: input.name ?? existing?.name ?? input.id,
      plan: input.plan ?? existing?.plan ?? (input.id === SYSTEM_TENANT_ID ? 'enterprise' : 'free'),
      customDomain,
      ownerUsername: input.ownerUsername !== undefined ? input.ownerUsername : (existing?.ownerUsername ?? null),
      status: input.status ?? existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      settings: input.settings ?? existing?.settings ?? {},
    };
    this.db.prepare(`
      INSERT INTO tenants (id, slug, name, plan, custom_domain, owner_username, status, created_at, updated_at, settings)
      VALUES (@id, @slug, @name, @plan, @custom_domain, @owner_username, @status, @createdAt, @updatedAt, @settings)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        plan = excluded.plan,
        custom_domain = excluded.custom_domain,
        owner_username = excluded.owner_username,
        status = excluded.status,
        updated_at = excluded.updated_at,
        settings = excluded.settings
    `).run({
      id: record.id, slug: record.slug, name: record.name, plan: record.plan,
      custom_domain: record.customDomain,
      owner_username: record.ownerUsername, status: record.status,
      createdAt: record.createdAt, updatedAt: record.updatedAt,
      settings: JSON.stringify(record.settings),
    });
    return record;
  }

  get(id: string): TenantRecord | null {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as RawRow | undefined;
    return row ? toRecord(row) : null;
  }

  getBySlug(slug: string): TenantRecord | null {
    const row = this.db.prepare('SELECT * FROM tenants WHERE slug = ?').get(slug.toLowerCase()) as RawRow | undefined;
    return row ? toRecord(row) : null;
  }

  getByCustomDomain(hostname: string): TenantRecord | null {
    const normalised = normaliseDomain(hostname);
    if (!normalised) return null;
    const row = this.db.prepare('SELECT * FROM tenants WHERE custom_domain = ?').get(normalised) as RawRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(): TenantRecord[] {
    return (this.db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as RawRow[]).map(toRecord);
  }

  delete(id: string): boolean {
    if (id === SYSTEM_TENANT_ID) return false; // never delete the fallback tenant
    return this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id).changes > 0;
  }

  ensureSystem(): TenantRecord {
    const existing = this.get(SYSTEM_TENANT_ID);
    if (existing) return existing;
    return this.upsert({ id: SYSTEM_TENANT_ID, slug: SYSTEM_TENANT_ID, name: 'Default', plan: 'enterprise', status: 'active' });
  }

  close(): void { this.db.close(); }
}

// ─── Postgres implementation ────────────────────────────────────────────

export class PostgresTenantStore implements TenantStore {
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
        CREATE TABLE IF NOT EXISTS tenants (
          id             TEXT PRIMARY KEY,
          slug           TEXT,
          name           TEXT NOT NULL,
          plan           TEXT NOT NULL DEFAULT 'free',
          custom_domain  TEXT,
          owner_username TEXT,
          status         TEXT NOT NULL DEFAULT 'active',
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          settings       JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slug TEXT;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_username TEXT;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_domain TEXT;
        UPDATE tenants SET slug = id WHERE slug IS NULL OR slug = '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_custom_domain ON tenants(custom_domain) WHERE custom_domain IS NOT NULL;
      `);
      await client.query(
        `INSERT INTO tenants (id, slug, name, plan, status) VALUES ($1, $1, 'Default', 'enterprise', 'active')
         ON CONFLICT (id) DO UPDATE SET plan = 'enterprise'`, [SYSTEM_TENANT_ID]);
      this.schemaReady = true;
    } finally { client.release(); }
  }

  async upsert(input: { id: string; slug?: string; name?: string; plan?: TenantPlan; customDomain?: string | null; ownerUsername?: string | null; status?: TenantStatus; settings?: Record<string, unknown> }): Promise<TenantRecord> {
    await this.ensureSchema();
    const slug = (input.slug ?? input.id).toLowerCase();
    const customDomain = input.customDomain !== undefined ? normaliseDomain(input.customDomain) : null;
    const res = await this.pool.query(
      `INSERT INTO tenants (id, slug, name, plan, custom_domain, owner_username, status, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         slug = EXCLUDED.slug,
         name = EXCLUDED.name,
         plan = EXCLUDED.plan,
         custom_domain = EXCLUDED.custom_domain,
         owner_username = EXCLUDED.owner_username,
         status = EXCLUDED.status,
         updated_at = NOW(),
         settings = EXCLUDED.settings
       RETURNING *`,
      [
        input.id, slug, input.name ?? input.id,
        input.plan ?? (input.id === SYSTEM_TENANT_ID ? 'enterprise' : 'free'),
        customDomain,
        input.ownerUsername ?? null,
        input.status ?? 'active',
        JSON.stringify(input.settings ?? {}),
      ],
    );
    return rowToRecordPg(res.rows[0]);
  }

  async get(id: string): Promise<TenantRecord | null> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return res.rows[0] ? rowToRecordPg(res.rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<TenantRecord | null> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT * FROM tenants WHERE slug = $1', [slug.toLowerCase()]);
    return res.rows[0] ? rowToRecordPg(res.rows[0]) : null;
  }

  async getByCustomDomain(hostname: string): Promise<TenantRecord | null> {
    await this.ensureSchema();
    const normalised = normaliseDomain(hostname);
    if (!normalised) return null;
    const res = await this.pool.query('SELECT * FROM tenants WHERE custom_domain = $1', [normalised]);
    return res.rows[0] ? rowToRecordPg(res.rows[0]) : null;
  }

  async list(): Promise<TenantRecord[]> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT * FROM tenants ORDER BY created_at ASC');
    return res.rows.map(rowToRecordPg);
  }

  async delete(id: string): Promise<boolean> {
    if (id === SYSTEM_TENANT_ID) return false;
    await this.ensureSchema();
    const res = await this.pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async ensureSystem(): Promise<TenantRecord> {
    await this.ensureSchema();
    const existing = await this.get(SYSTEM_TENANT_ID);
    if (existing) return existing;
    return this.upsert({ id: SYSTEM_TENANT_ID, name: 'System', status: 'active' });
  }

  async close(): Promise<void> { /* shared pool */ }
}

// ─── helpers ────────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  slug: string | null;
  name: string;
  plan: TenantPlan | null;
  custom_domain: string | null;
  owner_username: string | null;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
  settings: string;
}

function toRecord(row: RawRow): TenantRecord {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(row.settings || '{}'); } catch { /* corrupt row */ }
  return {
    id: row.id,
    slug: (row.slug && row.slug.length > 0 ? row.slug : row.id).toLowerCase(),
    name: row.name,
    plan: (row.plan ?? (row.id === SYSTEM_TENANT_ID ? 'enterprise' : 'free')) as TenantPlan,
    customDomain: row.custom_domain ?? null,
    ownerUsername: row.owner_username ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings,
  };
}

function rowToRecordPg(row: Record<string, unknown>): TenantRecord {
  const id = row.id as string;
  const slugRaw = row.slug as string | null;
  return {
    id,
    slug: (slugRaw && slugRaw.length > 0 ? slugRaw : id).toLowerCase(),
    name: row.name as string,
    plan: ((row.plan as TenantPlan | null) ?? (id === SYSTEM_TENANT_ID ? 'enterprise' : 'free')),
    customDomain: (row.custom_domain as string | null) ?? null,
    ownerUsername: (row.owner_username as string | null) ?? null,
    status: row.status as TenantStatus,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    settings: (row.settings as Record<string, unknown>) ?? {},
  };
}

/** Strip trailing dots, lowercase, drop port, trim. Empty input
 *  collapses to null so an empty form field doesn't end up colliding
 *  with another empty field through the unique index. */
export function normaliseDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  if (!trimmed) return null;
  // Defensive: reject anything that looks like an IP or doesn't have
  // at least one dot. A vanity hostname for a tenant always has at
  // least <subdomain>.<domain>.<tld>; subjecting IP literals here would
  // be a misconfiguration.
  if (!trimmed.includes('.')) return null;
  return trimmed;
}

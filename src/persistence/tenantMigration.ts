// Helpers for adding tenant_id to legacy tables idempotently.
//
// Both backends already use a try/catch ALTER pattern for incremental
// schema changes; this module keeps the column-add invocation in one
// place so every store gets the same default + index treatment.
//
// Pattern:
//   - SQLite: ADD COLUMN IF NOT PRESENT via PRAGMA table_info (handles
//     re-runs without errors) + DEFAULT 'system' so existing rows have
//     a tenant.
//   - Postgres: ALTER TABLE … ADD COLUMN IF NOT EXISTS … (native).
//
// All migrations leave existing rows mapped to SYSTEM_TENANT_ID so a
// pre-tenant deployment continues to work the moment the new code
// boots up. Operators tag historical rows to specific tenants later
// via UPDATE if/when needed.

import type Database from 'better-sqlite3';
import type { Pool } from 'pg';
import { SYSTEM_TENANT_ID } from '../tenancy/index.js';

/** Idempotently add a tenant_id TEXT column with default 'system' to a
 *  SQLite table. No-op when the column already exists. */
export function addTenantColumnSqlite(db: Database.Database, table: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some(c => c.name === 'tenant_id')) return;
  // SQLite syntax: ALTER TABLE doesn't support DEFAULT in older versions
  // for ADD COLUMN, but better-sqlite3 ships a recent SQLite that does.
  db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${SYSTEM_TENANT_ID}'`);
  // Index for tenant-scoped queries; no-op when it already exists.
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`); }
  catch { /* table without rowid / generated column edge case — skip */ }
}

/** Idempotent Postgres equivalent. Runs inside the existing client/pool. */
export async function addTenantColumnPostgres(pool: Pool, table: string): Promise<void> {
  // ADD COLUMN IF NOT EXISTS is supported in Postgres ≥ 9.6 (covers
  // every supported deployment).
  await pool.query(
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${SYSTEM_TENANT_ID}'`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`,
  );
}

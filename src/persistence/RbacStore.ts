// Persistence for RBAC role definitions + user-role assignments.
//
// Two tables: rbac_roles (the definition catalogue) and
// rbac_assignments (user-tenant-role bindings). Identity matters here
// — a user can be tenant_admin in one tenant and viewer in another,
// so the assignment row is keyed by (userId, tenantId, roleId) with
// many rows per user supported.
//
// Built-in role definitions are seeded by RbacService on first run so
// even a fresh install has the four core roles available.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
// RBAC type definitions live with the security module (RbacService
// owns the policy logic); the store imports them as types only so
// this file stays a pure persistence concern.
import type { RoleDefinition, UserRoleAssignment } from '../security/rbac/RbacTypes.js';

export interface RbacStore {
  upsertRole(def: RoleDefinition): void | Promise<void>;
  getRole(id: string): RoleDefinition | null | Promise<RoleDefinition | null>;
  listRoles(): RoleDefinition[] | Promise<RoleDefinition[]>;
  deleteRole(id: string): boolean | Promise<boolean>;

  upsertAssignment(a: UserRoleAssignment): void | Promise<void>;
  getAssignments(userId: string, tenantId: string): UserRoleAssignment[] | Promise<UserRoleAssignment[]>;
  listAssignments(filter?: { userId?: string; tenantId?: string }): UserRoleAssignment[] | Promise<UserRoleAssignment[]>;
  removeAssignment(userId: string, tenantId: string, roleId: string): boolean | Promise<boolean>;
  close(): void | Promise<void>;
}

// ─── SQLite ─────────────────────────────────────────────────────────────

export class SqliteRbacStore implements RbacStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rbac_roles (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        description       TEXT,
        builtin           INTEGER NOT NULL DEFAULT 0,
        extra_permissions TEXT NOT NULL DEFAULT '[]',
        inherits_from     TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rbac_assignments (
        user_id     TEXT NOT NULL,
        tenant_id   TEXT NOT NULL,
        role_id     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, tenant_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rbac_assign_user   ON rbac_assignments(user_id);
      CREATE INDEX IF NOT EXISTS idx_rbac_assign_tenant ON rbac_assignments(tenant_id);
    `);
    logger.info(`[SqliteRbacStore] Opened ${dbPath}`);
  }

  upsertRole(def: RoleDefinition): void {
    this.db.prepare(`
      INSERT INTO rbac_roles (id, name, description, builtin, extra_permissions, inherits_from, created_at, updated_at)
      VALUES (@id, @name, @description, @builtin, @extra_permissions, @inherits_from, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        extra_permissions = excluded.extra_permissions,
        inherits_from = excluded.inherits_from,
        updated_at = excluded.updated_at
    `).run({
      id: def.id,
      name: def.name,
      description: def.description ?? null,
      builtin: def.builtin ? 1 : 0,
      extra_permissions: JSON.stringify(def.extraPermissions),
      inherits_from: def.inheritsFrom,
      createdAt: def.createdAt,
      updatedAt: def.updatedAt,
    });
  }
  getRole(id: string): RoleDefinition | null {
    const row = this.db.prepare('SELECT * FROM rbac_roles WHERE id = ?').get(id) as RawRoleRow | undefined;
    return row ? roleFromRow(row) : null;
  }
  listRoles(): RoleDefinition[] {
    return (this.db.prepare('SELECT * FROM rbac_roles ORDER BY id').all() as RawRoleRow[]).map(roleFromRow);
  }
  deleteRole(id: string): boolean {
    const row = this.db.prepare('SELECT builtin FROM rbac_roles WHERE id = ?').get(id) as { builtin: number } | undefined;
    if (!row) return false;
    if (row.builtin) return false; // built-in roles are protected
    return this.db.prepare('DELETE FROM rbac_roles WHERE id = ?').run(id).changes > 0;
  }

  upsertAssignment(a: UserRoleAssignment): void {
    this.db.prepare(`
      INSERT INTO rbac_assignments (user_id, tenant_id, role_id, created_at, updated_at)
      VALUES (@userId, @tenantId, @roleId, @createdAt, @updatedAt)
      ON CONFLICT(user_id, tenant_id, role_id) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(a);
  }
  getAssignments(userId: string, tenantId: string): UserRoleAssignment[] {
    return (this.db
      .prepare('SELECT user_id AS userId, tenant_id AS tenantId, role_id AS roleId, created_at AS createdAt, updated_at AS updatedAt FROM rbac_assignments WHERE user_id = ? AND tenant_id = ?')
      .all(userId, tenantId) as UserRoleAssignment[]);
  }
  listAssignments(filter?: { userId?: string; tenantId?: string }): UserRoleAssignment[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.userId)   { where.push('user_id = ?');   params.push(filter.userId); }
    if (filter?.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId); }
    const sql = `SELECT user_id AS userId, tenant_id AS tenantId, role_id AS roleId, created_at AS createdAt, updated_at AS updatedAt
                 FROM rbac_assignments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    return this.db.prepare(sql).all(...params) as UserRoleAssignment[];
  }
  removeAssignment(userId: string, tenantId: string, roleId: string): boolean {
    return this.db
      .prepare('DELETE FROM rbac_assignments WHERE user_id = ? AND tenant_id = ? AND role_id = ?')
      .run(userId, tenantId, roleId).changes > 0;
  }
  close(): void { this.db.close(); }
}

// ─── Postgres ──────────────────────────────────────────────────────────

export class PostgresRbacStore implements RbacStore {
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
        CREATE TABLE IF NOT EXISTS rbac_roles (
          id                TEXT PRIMARY KEY,
          name              TEXT NOT NULL,
          description       TEXT,
          builtin           BOOLEAN NOT NULL DEFAULT FALSE,
          extra_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
          inherits_from     TEXT NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS rbac_assignments (
          user_id     TEXT NOT NULL,
          tenant_id   TEXT NOT NULL,
          role_id     TEXT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, tenant_id, role_id)
        );
        CREATE INDEX IF NOT EXISTS idx_rbac_assign_user   ON rbac_assignments(user_id);
        CREATE INDEX IF NOT EXISTS idx_rbac_assign_tenant ON rbac_assignments(tenant_id);
      `);
      this.schemaReady = true;
    } finally { client.release(); }
  }

  async upsertRole(def: RoleDefinition): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO rbac_roles (id, name, description, builtin, extra_permissions, inherits_from, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description,
         extra_permissions = EXCLUDED.extra_permissions,
         inherits_from = EXCLUDED.inherits_from,
         updated_at = EXCLUDED.updated_at`,
      [def.id, def.name, def.description ?? null, def.builtin,
       JSON.stringify(def.extraPermissions), def.inheritsFrom,
       def.createdAt, def.updatedAt],
    );
  }
  async getRole(id: string): Promise<RoleDefinition | null> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT * FROM rbac_roles WHERE id = $1', [id]);
    return res.rows[0] ? rolePg(res.rows[0]) : null;
  }
  async listRoles(): Promise<RoleDefinition[]> {
    await this.ensureSchema();
    const res = await this.pool.query('SELECT * FROM rbac_roles ORDER BY id');
    return res.rows.map(rolePg);
  }
  async deleteRole(id: string): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.pool.query('DELETE FROM rbac_roles WHERE id = $1 AND NOT builtin', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async upsertAssignment(a: UserRoleAssignment): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO rbac_assignments (user_id, tenant_id, role_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (user_id, tenant_id, role_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      [a.userId, a.tenantId, a.roleId, a.createdAt, a.updatedAt],
    );
  }
  async getAssignments(userId: string, tenantId: string): Promise<UserRoleAssignment[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT user_id AS "userId", tenant_id AS "tenantId", role_id AS "roleId", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM rbac_assignments WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
    return res.rows;
  }
  async listAssignments(filter?: { userId?: string; tenantId?: string }): Promise<UserRoleAssignment[]> {
    await this.ensureSchema();
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (filter?.userId)   { where.push(`user_id = $${i++}`);   params.push(filter.userId); }
    if (filter?.tenantId) { where.push(`tenant_id = $${i++}`); params.push(filter.tenantId); }
    const sql = `SELECT user_id AS "userId", tenant_id AS "tenantId", role_id AS "roleId", created_at AS "createdAt", updated_at AS "updatedAt"
                 FROM rbac_assignments ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const res = await this.pool.query(sql, params);
    return res.rows;
  }
  async removeAssignment(userId: string, tenantId: string, roleId: string): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `DELETE FROM rbac_assignments WHERE user_id = $1 AND tenant_id = $2 AND role_id = $3`,
      [userId, tenantId, roleId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> { /* shared pool */ }
}

// ─── helpers ──────────────────────────────────────────────────────────

interface RawRoleRow {
  id: string; name: string; description: string | null; builtin: number;
  extra_permissions: string; inherits_from: string;
  created_at: string; updated_at: string;
}

function roleFromRow(r: RawRoleRow): RoleDefinition {
  let extras: RoleDefinition['extraPermissions'] = [];
  try { extras = JSON.parse(r.extra_permissions); } catch { /* corrupted row */ }
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    builtin: !!r.builtin,
    extraPermissions: extras,
    inheritsFrom: r.inherits_from as RoleDefinition['inheritsFrom'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rolePg(row: Record<string, unknown>): RoleDefinition {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    builtin: !!row.builtin,
    extraPermissions: (row.extra_permissions as RoleDefinition['extraPermissions']) ?? [],
    inheritsFrom: row.inherits_from as RoleDefinition['inheritsFrom'],
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

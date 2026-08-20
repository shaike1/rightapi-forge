// ServerRegistry — the set of hosts Beacon monitors.
//
// Before this module existed, every probe in SystemMonitors plus the
// inline disk/memory/CPU checks in server.ts ran exclusively against the
// box where the agent container itself lives (via `nsenter --target 1`
// into PID 1's namespaces). Adding a second server meant editing code.
//
// Now: monitored servers are persisted rows. The "local" row is special
// — it's always present and points back at nsenter so existing local
// monitoring keeps working unchanged. Remote rows hold the SSH info
// RemoteExecutor needs to reach the box.
//
// SSH algorithm pinning
// ─────────────────────
// The default SSH flags (KexAlgorithms / HostKeyAlgorithms) come from
// the task spec and match what works from Linux container clients to
// Ubuntu/Debian targets. Hosts that need different algorithm sets
// (Oracle Linux's ssh-rsa-only set, older AIX boxes, …) override via
// the `sshOptions` field — a JSON object of extra `-o KEY=VALUE` flags
// merged on top of the defaults.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

/** Stable ids — the "local" row is treated specially throughout the
 *  codebase (skips SSH, uses nsenter; never deletable from the API). */
export const LOCAL_SERVER_ID = 'local';

export interface MonitoredServer {
  id: string;
  name: string;
  /** Hostname or IP for SSH targets. Null/empty for is_local=1 (nsenter). */
  host: string | null;
  sshUser: string | null;
  sshPort: number;
  sshKeyPath: string | null;
  /** Free-form tags (e.g. "prod", "edge"). Returned as a string[]; stored as JSON. */
  tags: string[];
  /** Extra `-o KEY=VALUE` flags merged on top of the executor defaults.
   *  Use for per-host algorithm overrides (HostKeyAlgorithms, …). */
  sshOptions: Record<string, string>;
  enabled: boolean;
  isLocal: boolean;
  lastSeen: string | null;
  lastCheckStatus: 'ok' | 'error' | 'unknown';
  lastCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerInput {
  id?: string;
  name: string;
  host?: string | null;
  sshUser?: string | null;
  sshPort?: number;
  sshKeyPath?: string | null;
  tags?: string[];
  sshOptions?: Record<string, string>;
  enabled?: boolean;
  isLocal?: boolean;
}

export interface UpdateServerInput {
  name?: string;
  host?: string | null;
  sshUser?: string | null;
  sshPort?: number;
  sshKeyPath?: string | null;
  tags?: string[];
  sshOptions?: Record<string, string>;
  enabled?: boolean;
}

const KEBAB = /[^a-z0-9-]+/g;

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(KEBAB, '-').replace(/^-+|-+$/g, '');
  return slug || `srv-${Date.now()}`;
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export class ServerRegistry {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[ServerRegistry] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_servers (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        host               TEXT,
        ssh_user           TEXT,
        ssh_port           INTEGER NOT NULL DEFAULT 22,
        ssh_key_path       TEXT,
        tags               TEXT NOT NULL DEFAULT '[]',
        ssh_options        TEXT NOT NULL DEFAULT '{}',
        enabled            INTEGER NOT NULL DEFAULT 1,
        is_local           INTEGER NOT NULL DEFAULT 0,
        last_seen          TEXT,
        last_check_status  TEXT NOT NULL DEFAULT 'unknown',
        last_check_at      TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_servers_enabled ON monitored_servers(enabled);
    `);
    // Forward-compat migrations: if an earlier shape ever shipped without
    // ssh_options, ALTER it in. Both columns are no-ops on a fresh DB.
    try { this.db.exec("ALTER TABLE monitored_servers ADD COLUMN ssh_options TEXT NOT NULL DEFAULT '{}'"); } catch { /* exists */ }
    addTenantColumnSqlite(this.db, 'monitored_servers');
  }

  // ── Read ────────────────────────────────────────────────────────────

  get(id: string): MonitoredServer | null {
    const row = this.db.prepare('SELECT * FROM monitored_servers WHERE id = ?').get(id) as any;
    return row ? this.rowToServer(row) : null;
  }

  list(filter?: { enabled?: boolean }): MonitoredServer[] {
    let q = 'SELECT * FROM monitored_servers';
    const params: any[] = [];
    if (filter?.enabled !== undefined) {
      q += ' WHERE enabled = ?';
      params.push(filter.enabled ? 1 : 0);
    }
    q += ' ORDER BY is_local DESC, name ASC';
    return (this.db.prepare(q).all(...params) as any[]).map(r => this.rowToServer(r));
  }

  /** Enabled servers including the local one. Used by the health-monitor
   *  loop to dispatch probes everywhere in one pass. */
  enabledServers(): MonitoredServer[] {
    return this.list({ enabled: true });
  }

  // ── Write ───────────────────────────────────────────────────────────

  upsert(input: CreateServerInput): MonitoredServer {
    const now = new Date().toISOString();
    const id = (input.id ?? slugify(input.name)).trim();
    if (!id) throw new Error('server id is empty after slugify');
    const existing = this.get(id);
    const row: MonitoredServer = {
      id,
      name: input.name.trim(),
      host: input.host ?? null,
      sshUser: input.sshUser ?? null,
      sshPort: typeof input.sshPort === 'number' ? input.sshPort : 22,
      sshKeyPath: input.sshKeyPath ?? null,
      tags: Array.isArray(input.tags) ? input.tags.slice() : [],
      sshOptions: input.sshOptions ?? {},
      enabled: input.enabled ?? true,
      isLocal: input.isLocal ?? false,
      lastSeen: existing?.lastSeen ?? null,
      lastCheckStatus: existing?.lastCheckStatus ?? 'unknown',
      lastCheckAt: existing?.lastCheckAt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeRow(row);
    return row;
  }

  update(id: string, patch: UpdateServerInput): MonitoredServer | null {
    const cur = this.get(id);
    if (!cur) return null;
    // Local row's connection-identity is frozen: host/ssh fields must
    // not be mutated, since the executor branches on isLocal AND clients
    // address the row by the well-known LOCAL_SERVER_ID. Name, tags, and
    // enabled ARE editable — operators rename the local entry to match
    // their host naming convention (e.g. "vps1") and tag it for grouping.
    const merged: MonitoredServer = cur.isLocal
      ? {
          ...cur,
          name: patch.name?.trim() || cur.name,
          tags: patch.tags ?? cur.tags,
          enabled: patch.enabled ?? cur.enabled,
          updatedAt: new Date().toISOString(),
        }
      : {
          ...cur,
          name: patch.name ?? cur.name,
          host: patch.host !== undefined ? patch.host : cur.host,
          sshUser: patch.sshUser !== undefined ? patch.sshUser : cur.sshUser,
          sshPort: typeof patch.sshPort === 'number' ? patch.sshPort : cur.sshPort,
          sshKeyPath: patch.sshKeyPath !== undefined ? patch.sshKeyPath : cur.sshKeyPath,
          tags: patch.tags ?? cur.tags,
          sshOptions: patch.sshOptions ?? cur.sshOptions,
          enabled: patch.enabled ?? cur.enabled,
          updatedAt: new Date().toISOString(),
        };
    this.writeRow(merged);
    return merged;
  }

  /** Delete a server. The local row is undeletable — return false. */
  delete(id: string): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    if (cur.isLocal) return false;
    this.db.prepare('DELETE FROM monitored_servers WHERE id = ?').run(id);
    return true;
  }

  /** Stamp the connectivity-check result. Called by the executor after
   *  every successful run (so the dashboard can show "last seen"), and
   *  by the API's POST /:id/test endpoint to record explicit pings. */
  recordCheck(id: string, status: 'ok' | 'error', seenAt: string = new Date().toISOString()): void {
    const cur = this.get(id);
    if (!cur) return;
    const updated: MonitoredServer = {
      ...cur,
      lastSeen: status === 'ok' ? seenAt : cur.lastSeen,
      lastCheckStatus: status,
      lastCheckAt: seenAt,
      updatedAt: seenAt,
    };
    this.writeRow(updated);
  }

  // ── Seeding ─────────────────────────────────────────────────────────

  /** Idempotent — re-running this on every boot is safe. Only creates
   *  rows that don't already exist; doesn't overwrite operator edits.
   *
   *  Boot-time rename migration: when the existing row still carries the
   *  literal legacy default name "local", bring it forward to the env-
   *  configured default (`LOCAL_SERVER_NAME`, default "vps1"). Operators
   *  who already picked their own name keep it. */
  ensureLocal(): MonitoredServer {
    const desiredName = (process.env.LOCAL_SERVER_NAME || 'vps1').trim() || 'vps1';
    const existing = this.get(LOCAL_SERVER_ID);
    if (existing) {
      if (existing.name === 'local' && desiredName !== 'local') {
        const migrated: MonitoredServer = {
          ...existing,
          name: desiredName,
          updatedAt: new Date().toISOString(),
        };
        this.writeRow(migrated);
        return migrated;
      }
      return existing;
    }
    return this.upsert({
      id: LOCAL_SERVER_ID,
      name: desiredName,
      host: null,
      sshUser: null,
      sshPort: 22,
      tags: ['local', 'nsenter'],
      isLocal: true,
      enabled: true,
    });
  }

  /** Seed a non-local server only when it doesn't already exist.
   *  Returns the row that's now in the DB (existing or freshly created)
   *  so the caller can log "new" vs "kept". */
  ensureSeed(input: CreateServerInput): { server: MonitoredServer; created: boolean } {
    const id = input.id ?? slugify(input.name);
    const existing = this.get(id);
    if (existing) return { server: existing, created: false };
    return { server: this.upsert(input), created: true };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private writeRow(s: MonitoredServer): void {
    this.db.prepare(`
      INSERT INTO monitored_servers (
        id, name, host, ssh_user, ssh_port, ssh_key_path, tags, ssh_options,
        enabled, is_local, last_seen, last_check_status, last_check_at,
        created_at, updated_at
      ) VALUES (
        @id, @name, @host, @ssh_user, @ssh_port, @ssh_key_path, @tags, @ssh_options,
        @enabled, @is_local, @last_seen, @last_check_status, @last_check_at,
        @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        host = excluded.host,
        ssh_user = excluded.ssh_user,
        ssh_port = excluded.ssh_port,
        ssh_key_path = excluded.ssh_key_path,
        tags = excluded.tags,
        ssh_options = excluded.ssh_options,
        enabled = excluded.enabled,
        is_local = excluded.is_local,
        last_seen = excluded.last_seen,
        last_check_status = excluded.last_check_status,
        last_check_at = excluded.last_check_at,
        updated_at = excluded.updated_at
    `).run({
      id: s.id,
      name: s.name,
      host: s.host,
      ssh_user: s.sshUser,
      ssh_port: s.sshPort,
      ssh_key_path: s.sshKeyPath,
      tags: JSON.stringify(s.tags),
      ssh_options: JSON.stringify(s.sshOptions),
      enabled: s.enabled ? 1 : 0,
      is_local: s.isLocal ? 1 : 0,
      last_seen: s.lastSeen,
      last_check_status: s.lastCheckStatus,
      last_check_at: s.lastCheckAt,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    });
  }

  private rowToServer(r: any): MonitoredServer {
    return {
      id: r.id,
      name: r.name,
      host: r.host ?? null,
      sshUser: r.ssh_user ?? null,
      sshPort: typeof r.ssh_port === 'number' ? r.ssh_port : 22,
      sshKeyPath: r.ssh_key_path ?? null,
      tags: safeJSON<string[]>(r.tags, []),
      sshOptions: safeJSON<Record<string, string>>(r.ssh_options, {}),
      enabled: !!r.enabled,
      isLocal: !!r.is_local,
      lastSeen: r.last_seen ?? null,
      lastCheckStatus: (r.last_check_status as MonitoredServer['lastCheckStatus']) ?? 'unknown',
      lastCheckAt: r.last_check_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

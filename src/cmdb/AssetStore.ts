// AssetStore — SQLite-backed CMDB.
//
// Two tables:
//   • assets               — every "thing" Beacon tracks: server,
//                            service, application, network device
//   • asset_relationships  — directed edges between assets
//
// Asset IDs: 'AST-' + 8 hex chars uppercase (mirrors INC-/PRB-/CHG-/KB-).
//
// Design notes:
//   • An asset row optionally carries a `server_id` pointing back to
//     a ServerRegistry row — the auto-discovery hook upserts an asset
//     of type='server' for every monitored host so the existing
//     `incident.server_id` link surfaces in the CMDB without a
//     separate join table.
//   • Relationships are directed; ImpactAnalyzer traverses them in
//     either direction (downstream = follow outgoing edges,
//     upstream = follow incoming edges). All inserts go through the
//     same path so dedup is idempotent on (parent, child, type).
//   • Metadata is a free-form JSON blob — keeps the schema stable
//     while letting different asset types carry their own fields
//     (e.g. application version, network device VLAN). Validation
//     happens at the API boundary, not the store.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export type AssetType = 'server' | 'service' | 'application' | 'network' | 'database' | 'other';
export type RelationshipType = 'hosts' | 'runs' | 'depends_on' | 'connects_to';

export interface Asset {
  id: string;
  type: AssetType;
  name: string;
  /** Free-form key/value bag — e.g. `{ os: 'ubuntu-22.04', cpuCores: 8 }`. */
  metadata: Record<string, unknown>;
  /** Stable id of the ServerRegistry row this asset mirrors. Only set
   *  for type='server' rows; null for everything else. */
  serverId: string | null;
  /** Free-form descriptive text — surfaces in list/detail views. */
  description: string | null;
  /** Tags used for filtering — owner, environment, criticality, etc. */
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  id: string;
  parentId: string;
  childId: string;
  type: RelationshipType;
  createdAt: string;
}

export interface AssetWithRelationships extends Asset {
  relationships: {
    /** Outgoing edges: this asset → other assets. */
    downstream: Array<{ id: string; childId: string; type: RelationshipType }>;
    /** Incoming edges: other assets → this asset. */
    upstream:   Array<{ id: string; parentId: string; type: RelationshipType }>;
  };
}

export interface AssetFilter {
  type?: AssetType;
  tag?: string;
  q?: string;        // free-text on name/description
  serverId?: string; // exact match
}

export class AssetStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info('[AssetStore] opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        metadata    TEXT NOT NULL DEFAULT '{}',
        server_id   TEXT,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_asset_type      ON assets(type);
      CREATE INDEX IF NOT EXISTS idx_asset_server_id ON assets(server_id);

      CREATE TABLE IF NOT EXISTS asset_relationships (
        id         TEXT PRIMARY KEY,
        parent_id  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        child_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (parent_id, child_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_parent ON asset_relationships(parent_id);
      CREATE INDEX IF NOT EXISTS idx_rel_child  ON asset_relationships(child_id);
    `);
    // Multi-tenancy: idempotently add tenant_id to assets + relationships.
    // Existing rows belong to the system tenant; tenant-scoped queries
    // filter on this column. Index lives in addTenantColumnSqlite.
    addTenantColumnSqlite(this.db, 'assets');
    addTenantColumnSqlite(this.db, 'asset_relationships');
  }

  // ── Asset CRUD ─────────────────────────────────────────────────────

  create(input: {
    type: AssetType;
    name: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
    serverId?: string | null;
    tags?: string[];
  }): Asset {
    if (!input.name?.trim()) throw new Error('name is required');
    const id = newAssetId();
    const now = new Date().toISOString();
    const row = {
      id,
      type: input.type,
      name: input.name.trim(),
      description: input.description ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
      server_id: input.serverId ?? null,
      tags: JSON.stringify(input.tags ?? []),
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO assets (id, type, name, description, metadata, server_id, tags, created_at, updated_at)
      VALUES (@id, @type, @name, @description, @metadata, @server_id, @tags, @created_at, @updated_at)
    `).run(row);
    return this.toAsset(row);
  }

  /** Idempotent upsert keyed on (type, server_id) when server_id is
   *  set, otherwise (type, name). Used by the auto-discovery loop
   *  that mirrors ServerRegistry rows into the asset graph — re-
   *  running boot for the Nth time must not duplicate rows. */
  upsertByServerId(input: {
    name: string;
    serverId: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Asset {
    const existing = this.db.prepare('SELECT * FROM assets WHERE type = ? AND server_id = ?').get('server', input.serverId) as any;
    const now = new Date().toISOString();
    if (existing) {
      // Refresh metadata + name on every upsert so a ServerRegistry
      // rename or tag change flows through. Don't touch created_at.
      const merged = {
        ...JSON.parse(existing.metadata || '{}'),
        ...(input.metadata ?? {}),
      };
      this.db.prepare(`
        UPDATE assets SET name = ?, description = ?, metadata = ?, tags = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name,
        input.description ?? existing.description ?? null,
        JSON.stringify(merged),
        JSON.stringify(input.tags ?? JSON.parse(existing.tags || '[]')),
        now,
        existing.id,
      );
      return this.get(existing.id)!;
    }
    return this.create({
      type: 'server',
      name: input.name,
      description: input.description ?? null,
      metadata: input.metadata,
      serverId: input.serverId,
      tags: input.tags,
    });
  }

  get(id: string): Asset | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    return row ? this.toAsset(row) : null;
  }

  /** Returns the asset linked to a ServerRegistry row, or null when
   *  the auto-discovery loop hasn't run yet. */
  getByServerId(serverId: string): Asset | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE type = ? AND server_id = ?').get('server', serverId) as any;
    return row ? this.toAsset(row) : null;
  }

  list(filter: AssetFilter = {}): Asset[] {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.type)     { where.push('type = ?');      params.push(filter.type); }
    if (filter.serverId) { where.push('server_id = ?'); params.push(filter.serverId); }
    if (filter.q) {
      where.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${filter.q}%`, `%${filter.q}%`);
    }
    const sql = `SELECT * FROM assets${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY name ASC`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    const assets = rows.map(r => this.toAsset(r));
    // Tag filter — JSON column, easier to filter in JS than SQL.
    if (filter.tag) return assets.filter(a => a.tags.includes(filter.tag!));
    return assets;
  }

  update(id: string, patch: {
    name?: string;
    description?: string | null;
    type?: AssetType;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): Asset | null {
    const existing = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
    if (!existing) return null;
    const now = new Date().toISOString();
    const merged = patch.metadata !== undefined
      ? { ...JSON.parse(existing.metadata || '{}'), ...patch.metadata }
      : JSON.parse(existing.metadata || '{}');
    this.db.prepare(`
      UPDATE assets SET
        name = ?, description = ?, type = ?, metadata = ?, tags = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      patch.description !== undefined ? patch.description : existing.description,
      patch.type ?? existing.type,
      JSON.stringify(merged),
      patch.tags !== undefined ? JSON.stringify(patch.tags) : existing.tags,
      now,
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    // Relationships cascade via ON DELETE CASCADE.
    return this.db.prepare('DELETE FROM assets WHERE id = ?').run(id).changes > 0;
  }

  // ── Relationships ─────────────────────────────────────────────────

  addRelationship(parentId: string, childId: string, type: RelationshipType): Relationship {
    if (parentId === childId) throw new Error('an asset cannot relate to itself');
    if (!this.get(parentId)) throw new Error(`unknown parent asset: ${parentId}`);
    if (!this.get(childId))  throw new Error(`unknown child asset: ${childId}`);
    const id = 'REL-' + randomBytes(4).toString('hex').toUpperCase();
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO asset_relationships (id, parent_id, child_id, type, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, parentId, childId, type, now);
      return { id, parentId, childId, type, createdAt: now };
    } catch (e: any) {
      if (String(e?.message || '').includes('UNIQUE')) {
        // Idempotent: return the existing row so callers don't need
        // to wrap every create in a try/catch.
        const existing = this.db.prepare(
          'SELECT * FROM asset_relationships WHERE parent_id = ? AND child_id = ? AND type = ?'
        ).get(parentId, childId, type) as any;
        return this.toRel(existing);
      }
      throw e;
    }
  }

  removeRelationship(relationshipId: string): boolean {
    return this.db.prepare('DELETE FROM asset_relationships WHERE id = ?').run(relationshipId).changes > 0;
  }

  /** Downstream = "this asset has outgoing edges to these children".
   *  Used by ImpactAnalyzer to walk the dependency graph. */
  listDownstream(assetId: string): Array<{ id: string; childId: string; type: RelationshipType }> {
    return (this.db.prepare(
      'SELECT id, child_id, type FROM asset_relationships WHERE parent_id = ? ORDER BY type, child_id'
    ).all(assetId) as any[]).map(r => ({ id: r.id, childId: r.child_id, type: r.type }));
  }

  /** Upstream = "these parents have outgoing edges to this asset". */
  listUpstream(assetId: string): Array<{ id: string; parentId: string; type: RelationshipType }> {
    return (this.db.prepare(
      'SELECT id, parent_id, type FROM asset_relationships WHERE child_id = ? ORDER BY type, parent_id'
    ).all(assetId) as any[]).map(r => ({ id: r.id, parentId: r.parent_id, type: r.type }));
  }

  getWithRelationships(id: string): AssetWithRelationships | null {
    const a = this.get(id);
    if (!a) return null;
    return {
      ...a,
      relationships: {
        downstream: this.listDownstream(id),
        upstream:   this.listUpstream(id),
      },
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────

  stats(): { total: number; byType: Record<AssetType, number>; relationships: number } {
    const rows = this.db.prepare('SELECT type, COUNT(*) AS n FROM assets GROUP BY type').all() as Array<{ type: AssetType; n: number }>;
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.type] = r.n;
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n;
    const rels  = (this.db.prepare('SELECT COUNT(*) AS n FROM asset_relationships').get() as { n: number }).n;
    return { total, byType: byType as Record<AssetType, number>, relationships: rels };
  }

  close(): void { try { this.db.close(); } catch { /* idempotent */ } }

  // ── Internals ─────────────────────────────────────────────────────

  private toAsset(r: any): Asset {
    return {
      id: r.id,
      type: r.type as AssetType,
      name: r.name,
      description: r.description ?? null,
      metadata: safeJsonParse(r.metadata, {}),
      serverId: r.server_id ?? null,
      tags: safeJsonParse(r.tags, []),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private toRel(r: any): Relationship {
    return { id: r.id, parentId: r.parent_id, childId: r.child_id, type: r.type, createdAt: r.created_at };
  }
}

function newAssetId(): string {
  return 'AST-' + randomBytes(4).toString('hex').toUpperCase();
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

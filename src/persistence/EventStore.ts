// Append-only event store — durable record of every meaningful state
// change in the system, indexed for replay + projection.
//
// Design choices that mattered:
//   - Single immutable table. Events are facts; once appended, never
//     mutated. Read endpoints filter by aggregate / type / time range.
//   - Stable ids (event id) — hex-encoded random + monotonic millisecond
//     so naive sorting by id matches insertion order during a single
//     process. Persisted timestamp is the authority for cross-process
//     ordering.
//   - Aggregate-shaped event metadata (aggregateType + aggregateId) so the
//     same store powers per-task, per-workflow, per-credential audit
//     trails without separate tables.
//   - Correlation + causation ids let a downstream system (or a debugger)
//     thread together every event triggered by one task / workflow run.
//
// SQLite backend stores `data` as TEXT (JSON.stringify); Postgres uses
// JSONB so projections can do server-side filtering. Both share the
// EventStore interface in interfaces.ts.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { SYSTEM_TENANT_ID } from '../tenancy/index.js';

export type EventStreamFilter = {
  /** When set, only events for this tenant are returned. The store does
   *  NOT default this from the AsyncLocalStorage tenant — the higher-
   *  level TenantScopedEventBus is the right place to enforce that, so
   *  the raw store remains usable for cross-tenant reads (admin UI). */
  tenantId?: string;
  aggregateType?: string;
  aggregateId?: string;
  type?: string;
  /** ISO timestamp lower bound (>=). */
  since?: string;
  /** ISO timestamp upper bound (<). */
  until?: string;
  /** Max rows to return. Default 1000. */
  limit?: number;
  /** Page offset for pagination. Default 0. */
  offset?: number;
};

export interface AppendedEvent {
  id: string;
  timestamp: string;
  /** Owning tenant. SYSTEM_TENANT_ID for events emitted before a tenant
   *  scope was active (system bootstrap, background sweeps). */
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  actor: string;
  correlationId?: string;
  causationId?: string;
  data: unknown;
}

export interface EventInput {
  /** Optional override; otherwise generated. */
  id?: string;
  /** Optional override; otherwise the store fills with NOW(). */
  timestamp?: string;
  /** Optional override; otherwise SYSTEM_TENANT_ID. The
   *  TenantScopedEventBus injects the active tenant here so callers in
   *  request scope don't have to remember. */
  tenantId?: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  actor: string;
  correlationId?: string;
  causationId?: string;
  data?: unknown;
}

export interface EventStore {
  append(event: EventInput): AppendedEvent | Promise<AppendedEvent>;
  read(filter?: EventStreamFilter): AppendedEvent[] | Promise<AppendedEvent[]>;
  count(filter?: EventStreamFilter): number | Promise<number>;
  /** Delete events older than the given ISO timestamp. Returns row count. */
  purge(olderThan: string, dryRun?: boolean): number | Promise<number>;
  close(): void | Promise<void>;
}

// ─── SQLite implementation ───────────────────────────────────────────────

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[SqliteEventStore] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id              TEXT PRIMARY KEY,
        timestamp       TEXT NOT NULL,
        tenant_id       TEXT NOT NULL DEFAULT '${SYSTEM_TENANT_ID}',
        aggregate_type  TEXT NOT NULL,
        aggregate_id    TEXT NOT NULL,
        type            TEXT NOT NULL,
        actor           TEXT NOT NULL,
        correlation_id  TEXT,
        causation_id    TEXT,
        data            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id);
      CREATE INDEX IF NOT EXISTS idx_events_type      ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_corr      ON events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_events_tenant    ON events(tenant_id);
    `);
    // Tenant-id column may be missing on databases created before this
    // migration. SQLite ALTER TABLE ADD COLUMN is idempotent only via
    // table_info inspection — try it, ignore the "duplicate column" error.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(events)`).all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'tenant_id')) {
        this.db.exec(`ALTER TABLE events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${SYSTEM_TENANT_ID}'`);
      }
    } catch { /* already migrated */ }
  }

  append(event: EventInput): AppendedEvent {
    const id        = event.id        ?? generateEventId();
    const timestamp = event.timestamp ?? new Date().toISOString();
    const tenantId  = event.tenantId  ?? SYSTEM_TENANT_ID;
    const data      = event.data      ?? null;
    this.db.prepare(`
      INSERT INTO events (id, timestamp, tenant_id, aggregate_type, aggregate_id, type, actor, correlation_id, causation_id, data)
      VALUES (@id, @timestamp, @tenant_id, @aggregate_type, @aggregate_id, @type, @actor, @correlation_id, @causation_id, @data)
    `).run({
      id,
      timestamp,
      tenant_id:      tenantId,
      aggregate_type: event.aggregateType,
      aggregate_id:   event.aggregateId,
      type:           event.type,
      actor:          event.actor,
      correlation_id: event.correlationId ?? null,
      causation_id:   event.causationId   ?? null,
      data:           JSON.stringify(data),
    });
    return {
      id, timestamp, tenantId,
      aggregateType: event.aggregateType,
      aggregateId:   event.aggregateId,
      type:          event.type,
      actor:         event.actor,
      correlationId: event.correlationId,
      causationId:   event.causationId,
      data,
    };
  }

  read(filter: EventStreamFilter = {}): AppendedEvent[] {
    const { sql, params } = this.buildQuery(filter, /*count=*/false);
    const rows = this.db.prepare(sql).all(...params) as RawRow[];
    return rows.map(rowToEvent);
  }

  count(filter: EventStreamFilter = {}): number {
    const { sql, params } = this.buildQuery(filter, /*count=*/true);
    const row = this.db.prepare(sql).get(...params) as { n: number };
    return row?.n ?? 0;
  }

  purge(olderThan: string, dryRun = false): number {
    if (dryRun) return (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE timestamp < ?').get(olderThan) as { n: number }).n;
    return this.db.prepare('DELETE FROM events WHERE timestamp < ?').run(olderThan).changes;
  }

  close(): void { this.db.close(); }

  private buildQuery(filter: EventStreamFilter, count: boolean): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.tenantId)      { where.push('tenant_id = ?');      params.push(filter.tenantId); }
    if (filter.aggregateType) { where.push('aggregate_type = ?'); params.push(filter.aggregateType); }
    if (filter.aggregateId)   { where.push('aggregate_id = ?');   params.push(filter.aggregateId); }
    if (filter.type)          { where.push('type = ?');           params.push(filter.type); }
    if (filter.since)         { where.push('timestamp >= ?');     params.push(filter.since); }
    if (filter.until)         { where.push('timestamp < ?');      params.push(filter.until); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    if (count) {
      return { sql: `SELECT COUNT(*) AS n FROM events ${whereClause}`, params };
    }
    const limit  = Math.min(Math.max(filter.limit  ?? 1000, 1), 10_000);
    const offset = Math.max(filter.offset ?? 0, 0);
    return {
      sql: `SELECT * FROM events ${whereClause} ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?`,
      params: [...params, limit, offset],
    };
  }
}

// ─── Postgres implementation ─────────────────────────────────────────────

export class PostgresEventStore implements EventStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    void this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS events (
          id              TEXT PRIMARY KEY,
          timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          tenant_id       TEXT NOT NULL DEFAULT '${SYSTEM_TENANT_ID}',
          aggregate_type  TEXT NOT NULL,
          aggregate_id    TEXT NOT NULL,
          type            TEXT NOT NULL,
          actor           TEXT NOT NULL,
          correlation_id  TEXT,
          causation_id    TEXT,
          data            JSONB NOT NULL DEFAULT 'null'::jsonb
        );
        ALTER TABLE events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${SYSTEM_TENANT_ID}';
        CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_type, aggregate_id);
        CREATE INDEX IF NOT EXISTS idx_events_type      ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_corr      ON events(correlation_id);
        CREATE INDEX IF NOT EXISTS idx_events_tenant    ON events(tenant_id);
      `);
    } catch (e: any) {
      logger.error('[PostgresEventStore] schema migration failed', { err: e?.message });
    } finally {
      client.release();
    }
  }

  async append(event: EventInput): Promise<AppendedEvent> {
    const id        = event.id        ?? generateEventId();
    const timestamp = event.timestamp ?? new Date().toISOString();
    const tenantId  = event.tenantId  ?? SYSTEM_TENANT_ID;
    const data      = event.data      ?? null;
    await this.pool.query(
      `INSERT INTO events (id, timestamp, tenant_id, aggregate_type, aggregate_id, type, actor, correlation_id, causation_id, data)
       VALUES ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        id, timestamp, tenantId,
        event.aggregateType, event.aggregateId, event.type, event.actor,
        event.correlationId ?? null, event.causationId ?? null,
        JSON.stringify(data),
      ],
    );
    return {
      id, timestamp, tenantId,
      aggregateType: event.aggregateType,
      aggregateId:   event.aggregateId,
      type:          event.type,
      actor:         event.actor,
      correlationId: event.correlationId,
      causationId:   event.causationId,
      data,
    };
  }

  async read(filter: EventStreamFilter = {}): Promise<AppendedEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (filter.tenantId)      { where.push(`tenant_id      = $${i++}`); params.push(filter.tenantId); }
    if (filter.aggregateType) { where.push(`aggregate_type = $${i++}`); params.push(filter.aggregateType); }
    if (filter.aggregateId)   { where.push(`aggregate_id   = $${i++}`); params.push(filter.aggregateId); }
    if (filter.type)          { where.push(`type           = $${i++}`); params.push(filter.type); }
    if (filter.since)         { where.push(`timestamp     >= $${i++}::timestamptz`); params.push(filter.since); }
    if (filter.until)         { where.push(`timestamp      < $${i++}::timestamptz`); params.push(filter.until); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit  = Math.min(Math.max(filter.limit  ?? 1000, 1), 10_000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const sql = `SELECT * FROM events ${whereClause} ORDER BY timestamp ASC, id ASC LIMIT $${i++} OFFSET $${i++}`;
    params.push(limit, offset);
    const res = await this.pool.query(sql, params);
    return res.rows.map(rowToEventPg);
  }

  async count(filter: EventStreamFilter = {}): Promise<number> {
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (filter.tenantId)      { where.push(`tenant_id      = $${i++}`); params.push(filter.tenantId); }
    if (filter.aggregateType) { where.push(`aggregate_type = $${i++}`); params.push(filter.aggregateType); }
    if (filter.aggregateId)   { where.push(`aggregate_id   = $${i++}`); params.push(filter.aggregateId); }
    if (filter.type)          { where.push(`type           = $${i++}`); params.push(filter.type); }
    if (filter.since)         { where.push(`timestamp     >= $${i++}::timestamptz`); params.push(filter.since); }
    if (filter.until)         { where.push(`timestamp      < $${i++}::timestamptz`); params.push(filter.until); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query(`SELECT COUNT(*)::int AS n FROM events ${whereClause}`, params);
    return res.rows[0]?.n ?? 0;
  }

  async purge(olderThan: string, dryRun = false): Promise<number> {
    if (dryRun) {
      const counted = await this.pool.query(
        `SELECT COUNT(*)::int AS n FROM events WHERE timestamp < $1::timestamptz`,
        [olderThan],
      );
      return counted.rows[0]?.n ?? 0;
    }
    const res = await this.pool.query(
      `DELETE FROM events WHERE timestamp < $1::timestamptz`,
      [olderThan],
    );
    return res.rowCount ?? 0;
  }

  async close(): Promise<void> {
    // Pool is shared; closeSharedPool() in PostgresStore drains it during
    // shutdown. Nothing per-store to release.
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  timestamp: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  type: string;
  actor: string;
  correlation_id: string | null;
  causation_id: string | null;
  data: string;
}

function rowToEvent(row: RawRow): AppendedEvent {
  let data: unknown = null;
  try { data = JSON.parse(row.data); } catch { data = row.data; }
  return {
    id: row.id,
    timestamp: row.timestamp,
    tenantId:      row.tenant_id ?? SYSTEM_TENANT_ID,
    aggregateType: row.aggregate_type,
    aggregateId:   row.aggregate_id,
    type:          row.type,
    actor:         row.actor,
    correlationId: row.correlation_id ?? undefined,
    causationId:   row.causation_id   ?? undefined,
    data,
  };
}

function rowToEventPg(row: Record<string, unknown>): AppendedEvent {
  return {
    id: row.id as string,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    tenantId:      (row.tenant_id as string | null) ?? SYSTEM_TENANT_ID,
    aggregateType: row.aggregate_type as string,
    aggregateId:   row.aggregate_id as string,
    type:          row.type as string,
    actor:         row.actor as string,
    correlationId: (row.correlation_id as string | null) ?? undefined,
    causationId:   (row.causation_id as string | null)   ?? undefined,
    data:          row.data,
  };
}

/** Generate a sortable event id: <millisecond-hex>-<seq-hex>-<rand>.
 *  The per-process sequence counter guarantees insertion order even when
 *  multiple events share a millisecond — the read query orders by
 *  (timestamp ASC, id ASC), so the seq segment becomes the tiebreaker. */
let _seqCounter = 0;
function generateEventId(): string {
  const ms  = Date.now().toString(16).padStart(12, '0');
  const seq = (++_seqCounter & 0xFFFFFF).toString(16).padStart(6, '0');
  const r   = Math.floor(Math.random() * 0xFFFF).toString(36);
  return `evt-${ms}-${seq}-${r}`;
}

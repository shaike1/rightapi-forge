// MetricsHistoryStore — time-series of per-server health metrics.
//
// The dashboard's "memory % over time" / "disk % over time" charts read
// from this table. The health-monitor loop records a sample for every
// enabled server on every tick (default 5min cadence), so a week of
// retention is roughly (12 samples/hour × 24 × 7) × N servers ≈ a few
// thousand rows per server — small enough that a single SQLite file
// handles it without breaking a sweat.
//
// Retention is opportunistic: cleanup() deletes rows older than the
// configured window. Server.ts arms a hourly setInterval to call it; if
// the server's down for an extended period, the next boot's cleanup
// catches up.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';

export type MetricType = 'cpu' | 'memory' | 'disk' | 'load1' | 'load5';

export interface MetricSample {
  /** ISO-8601 timestamp. */
  timestamp: string;
  serverId: string;
  metricType: MetricType;
  /** Percentage (0..100) for cpu/memory/disk; raw load average for load1/load5. */
  value: number;
  /** Optional disk mount or other dimension that distinguishes samples
   *  of the same metricType (e.g. disk:/ vs disk:/data). Used as a
   *  tiebreaker in the latest() lookup so chart rendering can show one
   *  line per mount. */
  dimension?: string | null;
}

export interface MetricSeriesPoint {
  ts: number;        // epoch ms
  value: number;
}

export interface MetricSeries {
  serverId: string;
  metricType: MetricType;
  dimension: string | null;
  points: MetricSeriesPoint[];
}

export interface MetricsHistoryOpts {
  /** Days to retain. Default 7. */
  retentionDays?: number;
}

export class MetricsHistoryStore {
  private db: Database.Database;
  private readonly retentionDays: number;

  constructor(dbPath: string, opts: MetricsHistoryOpts = {}) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.retentionDays = Math.max(1, opts.retentionDays ?? 7);
    this.migrate();
    logger.info(`[MetricsHistoryStore] Opened ${dbPath}`, { retentionDays: this.retentionDays });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT NOT NULL,
        server_id   TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value       REAL NOT NULL,
        dimension   TEXT
      );
      -- Composite index supports the dashboard's main query shape:
      -- "give me <metric> for <server> over the last <window>".
      CREATE INDEX IF NOT EXISTS idx_metrics_server_type_ts
        ON metrics_history(server_id, metric_type, timestamp);
      -- Plain timestamp index for the retention cleanup pass.
      CREATE INDEX IF NOT EXISTS idx_metrics_ts
        ON metrics_history(timestamp);
    `);
  }

  /** Record one or more samples in a single transaction. Used by the
   *  health-monitor loop which collects CPU + memory + N disk mounts
   *  per server per tick and writes them all together. */
  record(samples: MetricSample[]): void {
    if (samples.length === 0) return;
    const stmt = this.db.prepare(
      'INSERT INTO metrics_history (timestamp, server_id, metric_type, value, dimension) VALUES (?, ?, ?, ?, ?)'
    );
    const tx = this.db.transaction((rows: MetricSample[]) => {
      for (const r of rows) {
        stmt.run(r.timestamp, r.serverId, r.metricType, r.value, r.dimension ?? null);
      }
    });
    tx(samples);
  }

  /** Fetch a per-server time series for one metric type. Default window
   *  is 24h, capped at 30d to keep payloads bounded. `dimension` is the
   *  disk-mount style filter — null/undefined returns the un-dimensioned
   *  rows (memory/cpu/load) and rows with NULL dimension. */
  series(args: {
    serverId: string;
    metricType: MetricType;
    sinceMs?: number;
    dimension?: string | null;
    limit?: number;
  }): MetricSeries {
    const limit = Math.min(Math.max(1, args.limit ?? 1000), 10_000);
    const sinceMs = args.sinceMs ?? Date.now() - 24 * 3600 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();
    let sql = `
      SELECT timestamp, value FROM metrics_history
      WHERE server_id = ? AND metric_type = ? AND timestamp >= ?
    `;
    const params: any[] = [args.serverId, args.metricType, sinceIso];
    if (args.dimension !== undefined) {
      if (args.dimension === null) {
        sql += ' AND dimension IS NULL';
      } else {
        sql += ' AND dimension = ?';
        params.push(args.dimension);
      }
    }
    sql += ' ORDER BY timestamp ASC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{ timestamp: string; value: number }>;
    return {
      serverId: args.serverId,
      metricType: args.metricType,
      dimension: args.dimension ?? null,
      points: rows.map(r => ({ ts: Date.parse(r.timestamp), value: r.value })),
    };
  }

  /** Latest sample per (serverId, metricType, dimension). Used by the
   *  /api/servers payload to attach current % values without a separate
   *  probe round-trip per request. */
  latest(serverId: string): MetricSample[] {
    const rows = this.db.prepare(`
      SELECT m.timestamp, m.server_id AS serverId, m.metric_type AS metricType, m.value, m.dimension
      FROM metrics_history m
      JOIN (
        SELECT server_id, metric_type, dimension, MAX(timestamp) AS max_ts
        FROM metrics_history
        WHERE server_id = ?
        GROUP BY server_id, metric_type, dimension
      ) latest
      ON m.server_id = latest.server_id
         AND m.metric_type = latest.metric_type
         AND COALESCE(m.dimension, '') = COALESCE(latest.dimension, '')
         AND m.timestamp = latest.max_ts
    `).all(serverId) as MetricSample[];
    return rows;
  }

  /** Drop rows older than the configured retention window. Returns the
   *  count of deleted rows (cheap; SQLite reports it from the DELETE
   *  result). Safe to call on a fresh DB. */
  cleanup(): number {
    const cutoff = new Date(Date.now() - this.retentionDays * 86400 * 1000).toISOString();
    const r = this.db.prepare('DELETE FROM metrics_history WHERE timestamp < ?').run(cutoff);
    return Number(r.changes || 0);
  }

  /** Row count — used by the /api/metrics/stats debug endpoint and tests. */
  count(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM metrics_history').get() as { n: number };
    return r.n;
  }

  close(): void { this.db.close(); }
}

// Anomaly Detector — statistical baseline anomaly detection using SQLite

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

export interface MetricSample {
  serverId: string;
  metric: 'cpu' | 'memory' | 'disk';
  value: number;
  timestamp: Date;
}

export interface AnomalyRecord {
  id: string;
  serverId: string;
  metric: string;
  currentValue: number;
  baseline: number;
  stddev: number;
  sigmaDeviation: number; // standard deviations from mean
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: Date;
  resolved: boolean;
}

export class AnomalyDetector {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[AnomalyDetector] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metric_samples (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        metric    TEXT NOT NULL,
        value     REAL NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_samples_srv_metric
        ON metric_samples(server_id, metric, id DESC);

      CREATE TABLE IF NOT EXISTS anomalies (
        id              TEXT PRIMARY KEY,
        server_id       TEXT NOT NULL,
        metric          TEXT NOT NULL,
        current_value   REAL NOT NULL,
        baseline        REAL NOT NULL,
        stddev          REAL NOT NULL,
        sigma_deviation REAL NOT NULL,
        severity        TEXT NOT NULL,
        detected_at     TEXT NOT NULL,
        resolved        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_anomalies_srv
        ON anomalies(server_id, resolved);
    `);
  }

  /** Insert a metric sample and prune to last 1440 per server+metric. */
  addSample(serverId: string, metric: string, value: number): void {
    this.db.prepare(`
      INSERT INTO metric_samples (server_id, metric, value, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(serverId, metric, value, new Date().toISOString());

    // Keep last 1440 samples (24h at 1-min poll interval)
    this.db.prepare(`
      DELETE FROM metric_samples
      WHERE server_id = ? AND metric = ?
        AND id NOT IN (
          SELECT id FROM metric_samples
          WHERE server_id = ? AND metric = ?
          ORDER BY id DESC
          LIMIT 1440
        )
    `).run(serverId, metric, serverId, metric);
  }

  /** Compute moving average and stddev from last 60 samples. */
  computeBaseline(serverId: string, metric: string): { mean: number; stddev: number } | null {
    const rows = this.db.prepare(`
      SELECT value FROM metric_samples
      WHERE server_id = ? AND metric = ?
      ORDER BY id DESC
      LIMIT 60
    `).all(serverId, metric) as { value: number }[];

    if (rows.length < 10) return null; // need at least 10 samples

    const values = rows.map(r => r.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    return { mean, stddev };
  }

  /**
   * Compare value against baseline.
   * >2σ = anomaly (medium); >2.5σ = high; >=3σ = critical.
   * Returns null if insufficient data or no anomaly.
   */
  detectAnomaly(serverId: string, metric: string, value: number): AnomalyRecord | null {
    const baseline = this.computeBaseline(serverId, metric);
    if (!baseline) return null;

    const { mean, stddev } = baseline;
    if (stddev === 0) return null;

    const sigma = Math.abs(value - mean) / stddev;
    if (sigma < 2) return null;

    const severity: AnomalyRecord['severity'] =
      sigma >= 3   ? 'critical' :
      sigma >= 2.5 ? 'high'     : 'medium';

    const record: AnomalyRecord = {
      id: randomUUID(),
      serverId,
      metric,
      currentValue: value,
      baseline: mean,
      stddev,
      sigmaDeviation: sigma,
      severity,
      detectedAt: new Date(),
      resolved: false,
    };

    this.db.prepare(`
      INSERT INTO anomalies
        (id, server_id, metric, current_value, baseline, stddev, sigma_deviation, severity, detected_at, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(record.id, serverId, metric, value, mean, stddev, sigma, severity, record.detectedAt.toISOString());

    return record;
  }

  /** Return unresolved anomalies, optionally filtered by server. */
  getAnomalies(serverId?: string): AnomalyRecord[] {
    const rows: unknown[] = serverId
      ? this.db.prepare('SELECT * FROM anomalies WHERE server_id = ? AND resolved = 0 ORDER BY detected_at DESC').all(serverId)
      : this.db.prepare('SELECT * FROM anomalies WHERE resolved = 0 ORDER BY detected_at DESC').all();
    return (rows as Record<string, unknown>[]).map(r => this.rowToRecord(r));
  }

  resolveAnomaly(id: string): boolean {
    const result = this.db.prepare('UPDATE anomalies SET resolved = 1 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private rowToRecord(r: Record<string, unknown>): AnomalyRecord {
    return {
      id: r.id as string,
      serverId: r.server_id as string,
      metric: r.metric as string,
      currentValue: r.current_value as number,
      baseline: r.baseline as number,
      stddev: r.stddev as number,
      sigmaDeviation: r.sigma_deviation as number,
      severity: r.severity as AnomalyRecord['severity'],
      detectedAt: new Date(r.detected_at as string),
      resolved: (r.resolved as number) === 1,
    };
  }

  close(): void { this.db.close(); }
}

export const anomalyDetector = new AnomalyDetector(
  process.env.ANOMALY_DB_PATH || '/data/itops-agents/anomalies.db'
);

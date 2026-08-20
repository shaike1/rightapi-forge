// SqliteVacuumRunner — weekly VACUUM + incremental WAL checkpoint of
// every registered SQLite file.
//
// Why both:
//   • VACUUM rebuilds the DB file so deleted rows release disk; it
//     defragments and rewrites pages contiguously. Without it, files
//     keep growing as `events`/`incident_timeline`/`metrics_history`
//     prune old rows and free pages stay free-but-uncompacted.
//   • A TRUNCATE-mode checkpoint shrinks the WAL alongside, so the
//     `.db-wal` companion doesn't grow forever for hot tables.
//
// Caveat:
//   • VACUUM takes an EXCLUSIVE lock. better-sqlite3's busy_timeout
//     handles short contention but the schedule should run during a
//     quiet window. Default cron is `0 4 * * 0` (Sunday 04:00) —
//     overridable via VACUUM_CRON.
//   • Per-DB failures don't abort the run; they're collected on the
//     report so the dashboard can surface them.
//   • The runner opens its own short-lived writable connection per
//     target. The live store's busy_timeout (set via SqlitePragmas)
//     lets the two connections coexist without exploding under load.

import fs from 'fs';
import Database from 'better-sqlite3';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'sqlite-vacuum' });

export interface VacuumTarget {
  name: string;
  /** Filesystem path of the source DB. */
  sourcePath: string;
  /** Optional pre-opened DB for tests. */
  db?: {
    exec: (sql: string) => unknown;
    pragma?: (sql: string, opts?: any) => unknown;
    close?: () => void;
  };
}

export interface VacuumResult {
  name: string;
  ok: boolean;
  durationMs: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reclaimedBytes?: number;
  error?: string;
}

export interface VacuumReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: VacuumResult[];
  successCount: number;
  failureCount: number;
  totalReclaimedBytes: number;
}

export class SqliteVacuumRunner {
  private targets: VacuumTarget[] = [];

  register(t: VacuumTarget): void {
    this.targets = this.targets.filter(x => x.name !== t.name);
    this.targets.push(t);
  }

  list(): VacuumTarget[] { return [...this.targets]; }

  async runOnce(): Promise<VacuumReport> {
    const startedAt = new Date();
    const results: VacuumResult[] = [];
    for (const t of this.targets) {
      const probeStart = Date.now();
      try {
        const bytesBefore = fileSize(t.sourcePath);
        if (t.db) {
          this.vacuumOnConnection(t.db);
        } else {
          if (!fs.existsSync(t.sourcePath)) {
            throw new Error(`source DB does not exist: ${t.sourcePath}`);
          }
          const db = new Database(t.sourcePath);
          try {
            // Match the store's busy_timeout so the new connection
            // waits gracefully instead of throwing if a writer is mid-tx.
            try { db.pragma('busy_timeout = 30000'); } catch { /* ignore */ }
            this.vacuumOnConnection(db);
          } finally {
            db.close();
          }
        }
        const bytesAfter = fileSize(t.sourcePath);
        results.push({
          name: t.name,
          ok: true,
          durationMs: Date.now() - probeStart,
          bytesBefore,
          bytesAfter,
          reclaimedBytes: Math.max(0, bytesBefore - bytesAfter),
        });
      } catch (e) {
        log.error('vacuum target failed', { name: t.name, err: e instanceof Error ? e.message : String(e) });
        results.push({
          name: t.name,
          ok: false,
          durationMs: Date.now() - probeStart,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    const finishedAt = new Date();
    const report: VacuumReport = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      results,
      successCount: results.filter(r => r.ok).length,
      failureCount: results.filter(r => !r.ok).length,
      totalReclaimedBytes: results.reduce((acc, r) => acc + (r.reclaimedBytes ?? 0), 0),
    };
    log.info('vacuum run finished', {
      successCount: report.successCount,
      failureCount: report.failureCount,
      reclaimedMB: (report.totalReclaimedBytes / 1024 / 1024).toFixed(2),
      durationMs: report.durationMs,
    });
    return report;
  }

  private vacuumOnConnection(db: VacuumTarget['db']): void {
    if (!db) return;
    // Checkpoint first so VACUUM doesn't fight the WAL.
    try { db.pragma?.('wal_checkpoint(TRUNCATE)'); } catch { /* not WAL — skip */ }
    db.exec('VACUUM');
  }
}

function fileSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

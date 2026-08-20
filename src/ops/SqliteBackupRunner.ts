// SqliteBackupRunner — daily online backup of every registered SQLite
// file using better-sqlite3's `.backup()` API.
//
// Why `.backup()` instead of plain `fs.copyFile`:
//
//   • WAL-mode databases have uncheckpointed pages sitting in a separate
//     `-wal` file. A naive copy of the main `.db` would miss those pages
//     unless we first checkpointed AND held a read lock for the whole
//     copy. The C-level `sqlite3_backup_*` API does the right thing
//     internally: it reads pages from a live connection and copies them
//     to a destination DB while letting writers continue. Output is a
//     complete, integrity-checked database — no WAL companion needed.
//
//   • Targets register a *path* rather than a live connection so the
//     runner stays decoupled from store wiring. Each backup opens its
//     own short-lived connection (or accepts an injected one from a
//     test). The live store keeps running.
//
// Output format:
//   <destRoot>/<isoDate>/<dbName>.db
//
// Retention is by dated-folder mtime — keep the N most-recent dated
// folders and prune older ones. Default keeps 14 days.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'sqlite-backup' });

export interface SqliteBackupTarget {
  /** Stable name used for the destination filename and log entries. */
  name: string;
  /** Filesystem path of the source DB. */
  sourcePath: string;
  /** Optional pre-opened DB. When supplied the runner calls `.backup()`
   *  on it directly; when omitted, a fresh connection is opened for the
   *  duration of the backup. Tests inject this for fake connections. */
  db?: { backup: (destPath: string) => Promise<unknown> };
}

export interface SqliteBackupRunnerOptions {
  /** Root directory where dated subdirectories are created. */
  destRoot: string;
  /** How many dated subdirectories to retain. Default 14. */
  retentionDays?: number;
  /** Optional clock override for tests. */
  now?: () => Date;
}

export interface SqliteBackupResult {
  name: string;
  ok: boolean;
  bytes?: number;
  durationMs: number;
  destPath?: string;
  error?: string;
}

export interface SqliteBackupReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  destDir: string;
  results: SqliteBackupResult[];
  successCount: number;
  failureCount: number;
  prunedDirs: string[];
}

export class SqliteBackupRunner {
  private targets: SqliteBackupTarget[] = [];
  private destRoot: string;
  private retentionDays: number;
  private now: () => Date;

  constructor(opts: SqliteBackupRunnerOptions) {
    this.destRoot = opts.destRoot;
    this.retentionDays = Math.max(1, Math.floor(opts.retentionDays ?? 14));
    this.now = opts.now ?? (() => new Date());
  }

  register(target: SqliteBackupTarget): void {
    // Allow re-registration during reload — replace by name.
    this.targets = this.targets.filter(t => t.name !== target.name);
    this.targets.push(target);
  }

  list(): SqliteBackupTarget[] {
    return [...this.targets];
  }

  async runOnce(): Promise<SqliteBackupReport> {
    const startedAt = this.now();
    const isoDate = startedAt.toISOString().slice(0, 10);
    const destDir = path.join(this.destRoot, isoDate);
    fs.mkdirSync(destDir, { recursive: true });

    const results: SqliteBackupResult[] = [];
    for (const t of this.targets) {
      const probeStart = Date.now();
      const destPath = path.join(destDir, `${t.name}.db`);
      try {
        if (t.db) {
          await t.db.backup(destPath);
        } else {
          if (!fs.existsSync(t.sourcePath)) {
            throw new Error(`source DB does not exist: ${t.sourcePath}`);
          }
          // readonly so a backup can't accidentally write to the source.
          // .backup() is a read-side operation; SQLite handles the WAL
          // pages correctly through a readonly connection.
          const src = new Database(t.sourcePath, { readonly: true, fileMustExist: true });
          try {
            await src.backup(destPath);
          } finally {
            src.close();
          }
        }
        const bytes = safeSize(destPath);
        results.push({
          name: t.name,
          ok: true,
          bytes,
          durationMs: Date.now() - probeStart,
          destPath,
        });
      } catch (e) {
        log.error('backup target failed', {
          name: t.name,
          err: e instanceof Error ? e.message : String(e),
        });
        results.push({
          name: t.name,
          ok: false,
          durationMs: Date.now() - probeStart,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const prunedDirs = this.prune();
    const finishedAt = this.now();

    const report: SqliteBackupReport = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      destDir,
      results,
      successCount: results.filter(r => r.ok).length,
      failureCount: results.filter(r => !r.ok).length,
      prunedDirs,
    };
    log.info('backup run finished', {
      successCount: report.successCount,
      failureCount: report.failureCount,
      durationMs: report.durationMs,
      destDir,
      pruned: prunedDirs.length,
    });
    return report;
  }

  /** Delete dated subdirectories older than `retentionDays`. */
  private prune(): string[] {
    if (!fs.existsSync(this.destRoot)) return [];
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
    const removed: string[] = [];
    for (const entry of fs.readdirSync(this.destRoot)) {
      const full = path.join(this.destRoot, entry);
      try {
        const stat = fs.statSync(full);
        if (!stat.isDirectory()) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
        if (stat.mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch (e) {
        log.warn('prune skipped', { path: full, err: e instanceof Error ? e.message : String(e) });
      }
    }
    return removed;
  }

  /** List the dated subdirectories currently on disk, newest first.
   *  Used by the system API to surface a status summary. */
  listSnapshots(): Array<{ date: string; bytes: number; files: number; path: string }> {
    if (!fs.existsSync(this.destRoot)) return [];
    const out: Array<{ date: string; bytes: number; files: number; path: string }> = [];
    for (const entry of fs.readdirSync(this.destRoot)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
      const full = path.join(this.destRoot, entry);
      try {
        let bytes = 0;
        let files = 0;
        for (const name of fs.readdirSync(full)) {
          if (!name.endsWith('.db')) continue;
          bytes += safeSize(path.join(full, name));
          files++;
        }
        out.push({ date: entry, bytes, files, path: full });
      } catch { /* skip unreadable folder */ }
    }
    out.sort((a, b) => b.date.localeCompare(a.date));
    return out;
  }
}

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

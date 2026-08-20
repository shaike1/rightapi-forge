// DatabaseSizeMonitor — periodic check of every registered SQLite file.
// When any DB exceeds the warn or fail threshold, opens a Beacon-self
// incident so operators have a ticket instead of just a metric.
//
// Why this exists:
//   • SQLite grows quietly. The events/metrics_history tables can
//     accumulate to gigabytes before anyone notices, then a VACUUM
//     locks the DB at the worst possible moment. A daily watcher
//     gives us several days of warning instead.
//   • Incident-based delivery means existing routing (Jira / Teams /
//     SMS) handles the alert without bespoke wiring. Dedup keyed on
//     `db-size:<name>` mirrors how BeaconSelfMonitor opens tickets.
//   • Threshold is a configurable env (`DB_SIZE_WARN_MB`,
//     `DB_SIZE_FAIL_MB`) so different deployments can tune without
//     code changes. Defaults: warn 500 MB, fail 1024 MB — matches the
//     spec from the hardening doc.

import fs from 'fs';
import path from 'path';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'db-size-monitor' });

export interface DatabaseFile {
  /** Stable identifier — used in log / incident dedup. */
  name: string;
  /** Path on disk. Both the main `.db` and its `-wal`/`-shm` companions
   *  are summed for the size report. */
  path: string;
}

export interface DatabaseSizeMonitorOptions {
  /** Tick interval. Default 1 hour. */
  intervalMs?: number;
  /** Warn at this size (bytes). Default 500 MiB. */
  warnBytes?: number;
  /** Critical at this size (bytes). Default 1 GiB. */
  failBytes?: number;
  /** Don't fire incidents until this many consecutive ticks confirm
   *  the breach. Default 2 — keeps a single bad reading from paging. */
  failStreakThreshold?: number;
}

export interface DatabaseSizeReport {
  name: string;
  path: string;
  mainBytes: number;
  walBytes: number;
  shmBytes: number;
  totalBytes: number;
  status: 'ok' | 'warn' | 'fail';
}

export interface DatabaseSizeMonitorDeps {
  /** IncidentManager.create + .resolve are the only methods used. */
  incidentManager: {
    create(input: any): { id: string; severity: string };
    update(id: string, patch: any): unknown;
    resolve(id: string, note?: string): unknown;
  };
}

interface DbState {
  failStreak: number;
  passStreak: number;
  incidentId: string | null;
  lastTotalBytes: number;
}

export class DatabaseSizeMonitor {
  private files: DatabaseFile[] = [];
  private deps: DatabaseSizeMonitorDeps;
  private intervalMs: number;
  private warnBytes: number;
  private failBytes: number;
  private failStreakThreshold: number;
  private timer: NodeJS.Timeout | null = null;
  private state = new Map<string, DbState>();
  private running = false;

  constructor(deps: DatabaseSizeMonitorDeps, opts: DatabaseSizeMonitorOptions = {}) {
    this.deps = deps;
    this.intervalMs = Math.max(60_000, opts.intervalMs ?? 60 * 60 * 1000);
    this.warnBytes = Math.max(1, opts.warnBytes ?? 500 * 1024 * 1024);
    this.failBytes = Math.max(this.warnBytes, opts.failBytes ?? 1024 * 1024 * 1024);
    this.failStreakThreshold = Math.max(1, opts.failStreakThreshold ?? 2);
  }

  register(file: DatabaseFile): void {
    this.files = this.files.filter(f => f.name !== file.name);
    this.files.push(file);
  }

  list(): DatabaseFile[] {
    return [...this.files];
  }

  start(): void {
    if (this.timer) return;
    log.info('started', { intervalMs: this.intervalMs, warnMB: Math.round(this.warnBytes / 1024 / 1024), failMB: Math.round(this.failBytes / 1024 / 1024), files: this.files.length });
    this.timer = setInterval(() => this.tickSafe(), this.intervalMs);
    if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Test seam — runs a single tick and returns the report. */
  async tickOnce(): Promise<DatabaseSizeReport[]> {
    return this.tick();
  }

  private async tickSafe(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.tick(); }
    catch (e) { log.error('tick failed', { err: e instanceof Error ? e.message : String(e) }); }
    finally { this.running = false; }
  }

  private async tick(): Promise<DatabaseSizeReport[]> {
    const reports: DatabaseSizeReport[] = [];
    for (const file of this.files) {
      const report = this.measure(file);
      reports.push(report);
      const state = this.state.get(file.name) ?? { failStreak: 0, passStreak: 0, incidentId: null, lastTotalBytes: 0 };
      state.lastTotalBytes = report.totalBytes;

      if (report.status === 'fail') {
        state.failStreak++;
        state.passStreak = 0;
        if (state.failStreak >= this.failStreakThreshold) {
          this.openOrEscalate(file, report, state, 'critical');
        }
      } else if (report.status === 'warn') {
        state.failStreak++;
        state.passStreak = 0;
        if (state.failStreak >= this.failStreakThreshold) {
          this.openOrEscalate(file, report, state, 'medium');
        }
      } else {
        state.passStreak++;
        state.failStreak = 0;
        if (state.incidentId && state.passStreak >= 1) {
          this.resolveIncident(file, state, report);
        }
      }
      this.state.set(file.name, state);
    }
    return reports;
  }

  private measure(file: DatabaseFile): DatabaseSizeReport {
    const mainBytes = safeSize(file.path);
    const walBytes  = safeSize(file.path + '-wal');
    const shmBytes  = safeSize(file.path + '-shm');
    const totalBytes = mainBytes + walBytes + shmBytes;
    let status: 'ok' | 'warn' | 'fail' = 'ok';
    if (totalBytes >= this.failBytes) status = 'fail';
    else if (totalBytes >= this.warnBytes) status = 'warn';
    return { name: file.name, path: file.path, mainBytes, walBytes, shmBytes, totalBytes, status };
  }

  private openOrEscalate(file: DatabaseFile, report: DatabaseSizeReport, state: DbState, severity: 'medium' | 'critical'): void {
    try {
      const mb = (report.totalBytes / 1024 / 1024).toFixed(1);
      const inc = this.deps.incidentManager.create({
        title: `SQLite DB size threshold breached: ${file.name}`,
        description: [
          `Database "${file.name}" at ${file.path} is ${mb} MiB`,
          `(main=${(report.mainBytes/1024/1024).toFixed(1)}M, wal=${(report.walBytes/1024/1024).toFixed(1)}M, shm=${(report.shmBytes/1024/1024).toFixed(1)}M).`,
          `Warn threshold: ${(this.warnBytes/1024/1024).toFixed(0)} MiB · Fail threshold: ${(this.failBytes/1024/1024).toFixed(0)} MiB.`,
          `Consider running VACUUM, pruning old rows, or relocating the file to a larger volume.`,
        ].join('\n'),
        severity,
        source: 'agent',
        sourceRef: `db-size:${file.name}`,
        dedupBy: 'sourceRef',
        updateOnDup: true,
      }) as { id: string; severity: string };
      if (inc.severity !== severity) {
        try { this.deps.incidentManager.update(inc.id, { severity }); } catch { /* swallow */ }
      }
      state.incidentId = inc.id;
      log.warn('opened/refreshed db-size incident', { db: file.name, mb, incidentId: inc.id, severity });
    } catch (e) {
      log.error('failed to open db-size incident', { db: file.name, err: e instanceof Error ? e.message : String(e) });
    }
  }

  private resolveIncident(file: DatabaseFile, state: DbState, report: DatabaseSizeReport): void {
    if (!state.incidentId) return;
    try {
      this.deps.incidentManager.resolve(state.incidentId, `DB "${file.name}" returned to ${(report.totalBytes/1024/1024).toFixed(1)} MiB — under thresholds`);
      log.info('auto-resolved db-size incident', { db: file.name, incidentId: state.incidentId });
      state.incidentId = null;
    } catch (e) {
      log.warn('failed to auto-resolve db-size incident', { db: file.name, err: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Inspect current per-db state. Test-only / debug. */
  snapshot(): Array<DatabaseSizeReport & { incidentId: string | null }> {
    const out: Array<DatabaseSizeReport & { incidentId: string | null }> = [];
    for (const file of this.files) {
      const m = this.measure(file);
      const s = this.state.get(file.name);
      out.push({ ...m, incidentId: s?.incidentId ?? null });
    }
    return out;
  }
}

function safeSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

export function expandDbCompanions(dbPath: string): string[] {
  return [dbPath, dbPath + '-wal', dbPath + '-shm'];
}

export function totalDbBytes(dbPath: string): number {
  let total = 0;
  for (const p of expandDbCompanions(dbPath)) {
    total += safeSize(p);
  }
  return total;
}

function _ensureDirExists(p: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// MaintenanceStore — SQLite persistence for scheduled maintenance jobs
// and their run history.
//
// Two tables:
//
//   maintenance_jobs
//     One row per job. `server_ids` is a JSON array — `[]` is the
//     wildcard meaning "every enabled server in ServerRegistry at run
//     time". `last_run_*` fields summarise the most recent execution
//     across all targeted servers (worst-case status wins).
//
//   maintenance_runs
//     One row per (job, server) execution. Append-only; bounded by a
//     periodic prune that keeps the newest N rows per job (default 100).
//     The API surfaces the most recent 20 to the dashboard.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export type MaintenanceJobStatus = 'success' | 'failed' | 'skipped' | 'timeout' | 'partial' | 'never';

export interface MaintenanceJob {
  id: string;
  name: string;
  description: string;
  /** Target servers by id. `[]` (empty array) means "every enabled
   *  server" — resolved at run time against ServerRegistry. */
  serverIds: string[];
  /** Standard 5-field cron (minute hour dom month dow). */
  schedule: string;
  /** Shell command executed via RemoteExecutor.execute(). */
  command: string;
  enabled: boolean;
  /** Hard wall-clock cap per server, in ms. Default 5min — long enough
   *  for journalctl vacuum / docker prune to run on a busy host. */
  timeoutMs: number;
  /** Operator marker for boot-seeded jobs — UI shows a chip, and we
   *  keep the cron + command in sync with the seed unless the operator
   *  has manually edited them. */
  seeded: boolean;
  lastRunAt: string | null;
  lastRunStatus: MaintenanceJobStatus;
  lastRunOutput: string;
  lastRunDurationMs: number | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateJobInput {
  id?: string;
  name: string;
  description?: string;
  serverIds?: string[];
  schedule: string;
  command: string;
  enabled?: boolean;
  timeoutMs?: number;
  seeded?: boolean;
}

export interface UpdateJobInput {
  name?: string;
  description?: string;
  serverIds?: string[];
  schedule?: string;
  command?: string;
  enabled?: boolean;
  timeoutMs?: number;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: MaintenanceJobStatus;
  lastRunOutput?: string;
  lastRunDurationMs?: number | null;
}

export type MaintenanceRunStatus = 'success' | 'failed' | 'skipped' | 'timeout';

export interface MaintenanceRun {
  id: string;
  jobId: string;
  /** Target the command actually ran on. */
  serverId: string;
  serverName: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: MaintenanceRunStatus;
  exitCode: number | null;
  /** stdout/stderr each capped at OUTPUT_MAX_BYTES; longer content is
   *  truncated with a "[truncated …]" marker. */
  stdout: string;
  stderr: string;
  error: string | null;
  /** True when the run was triggered manually (POST /:id/run) rather
   *  than by the cron tick. */
  manual: boolean;
}

const KEBAB_RE = /[^a-z0-9-]+/g;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const RUN_OUTPUT_MAX_BYTES = 16 * 1024;
const MAX_RUNS_PER_JOB = 100;

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(KEBAB_RE, '-').replace(/^-+|-+$/g, '');
  return slug || `job-${Date.now()}`;
}

function safeJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function clipOutput(s: string): string {
  if (s.length <= RUN_OUTPUT_MAX_BYTES) return s;
  const head = s.slice(0, RUN_OUTPUT_MAX_BYTES - 64);
  return `${head}\n[truncated — ${s.length - head.length} more bytes]`;
}

export class MaintenanceStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info(`[MaintenanceStore] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS maintenance_jobs (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        description           TEXT NOT NULL DEFAULT '',
        server_ids            TEXT NOT NULL DEFAULT '[]',
        schedule              TEXT NOT NULL,
        command               TEXT NOT NULL,
        enabled               INTEGER NOT NULL DEFAULT 1,
        timeout_ms            INTEGER NOT NULL DEFAULT ${DEFAULT_TIMEOUT_MS},
        seeded                INTEGER NOT NULL DEFAULT 0,
        last_run_at           TEXT,
        last_run_status       TEXT NOT NULL DEFAULT 'never',
        last_run_output       TEXT NOT NULL DEFAULT '',
        last_run_duration_ms  INTEGER,
        next_run_at           TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_enabled ON maintenance_jobs(enabled);
      CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON maintenance_jobs(next_run_at);

      CREATE TABLE IF NOT EXISTS maintenance_runs (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL,
        server_id     TEXT NOT NULL,
        server_name   TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        finished_at   TEXT,
        duration_ms   INTEGER,
        status        TEXT NOT NULL,
        exit_code     INTEGER,
        stdout        TEXT NOT NULL DEFAULT '',
        stderr        TEXT NOT NULL DEFAULT '',
        error         TEXT,
        manual        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_job ON maintenance_runs(job_id, started_at DESC);
    `);
    addTenantColumnSqlite(this.db, 'maintenance_jobs');
    addTenantColumnSqlite(this.db, 'maintenance_runs');
  }

  // ── Jobs CRUD ─────────────────────────────────────────────────────────

  get(id: string): MaintenanceJob | null {
    const row = this.db.prepare('SELECT * FROM maintenance_jobs WHERE id = ?').get(id) as any;
    return row ? this.rowToJob(row) : null;
  }

  list(filter?: { enabled?: boolean }): MaintenanceJob[] {
    let q = 'SELECT * FROM maintenance_jobs';
    const params: any[] = [];
    if (filter?.enabled !== undefined) {
      q += ' WHERE enabled = ?';
      params.push(filter.enabled ? 1 : 0);
    }
    q += ' ORDER BY name ASC';
    return (this.db.prepare(q).all(...params) as any[]).map(r => this.rowToJob(r));
  }

  create(input: CreateJobInput): MaintenanceJob {
    const now = new Date().toISOString();
    const id = (input.id ?? slugify(input.name)).trim();
    if (!id) throw new Error('job id is empty after slugify');
    if (this.get(id)) throw new Error(`job "${id}" already exists`);
    const job: MaintenanceJob = {
      id,
      name: input.name.trim(),
      description: (input.description ?? '').trim(),
      serverIds: Array.isArray(input.serverIds) ? input.serverIds.slice() : [],
      schedule: input.schedule.trim(),
      command: input.command,
      enabled: input.enabled ?? true,
      timeoutMs: typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
      seeded: input.seeded ?? false,
      lastRunAt: null,
      lastRunStatus: 'never',
      lastRunOutput: '',
      lastRunDurationMs: null,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.writeRow(job);
    return job;
  }

  update(id: string, patch: UpdateJobInput): MaintenanceJob | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged: MaintenanceJob = {
      ...cur,
      name: patch.name?.trim() ?? cur.name,
      description: patch.description !== undefined ? patch.description.trim() : cur.description,
      serverIds: patch.serverIds ?? cur.serverIds,
      schedule: patch.schedule?.trim() ?? cur.schedule,
      command: patch.command ?? cur.command,
      enabled: patch.enabled ?? cur.enabled,
      timeoutMs: typeof patch.timeoutMs === 'number' && patch.timeoutMs > 0 ? patch.timeoutMs : cur.timeoutMs,
      lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : cur.lastRunAt,
      lastRunStatus: patch.lastRunStatus ?? cur.lastRunStatus,
      lastRunOutput: patch.lastRunOutput !== undefined ? clipOutput(patch.lastRunOutput) : cur.lastRunOutput,
      lastRunDurationMs: patch.lastRunDurationMs !== undefined ? patch.lastRunDurationMs : cur.lastRunDurationMs,
      nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt,
      updatedAt: new Date().toISOString(),
    };
    this.writeRow(merged);
    return merged;
  }

  delete(id: string): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM maintenance_runs WHERE job_id = ?').run(id);
      this.db.prepare('DELETE FROM maintenance_jobs WHERE id = ?').run(id);
    });
    tx();
    return true;
  }

  /** Idempotent seed — creates the job only if it doesn't exist.
   *  Returns whether it was newly created so the caller can log it. */
  ensureSeed(input: CreateJobInput): { job: MaintenanceJob; created: boolean } {
    const id = input.id ?? slugify(input.name);
    const existing = this.get(id);
    if (existing) return { job: existing, created: false };
    return { job: this.create({ ...input, id, seeded: true }), created: true };
  }

  // ── Run history ───────────────────────────────────────────────────────

  recordRun(run: Omit<MaintenanceRun, 'id'> & { id?: string }): MaintenanceRun {
    const id = run.id ?? `mrun-${uuidv4().slice(0, 8)}`;
    const persisted: MaintenanceRun = {
      ...run,
      id,
      stdout: clipOutput(run.stdout || ''),
      stderr: clipOutput(run.stderr || ''),
    };
    this.db.prepare(`
      INSERT INTO maintenance_runs (
        id, job_id, server_id, server_name, started_at, finished_at,
        duration_ms, status, exit_code, stdout, stderr, error, manual
      ) VALUES (
        @id, @job_id, @server_id, @server_name, @started_at, @finished_at,
        @duration_ms, @status, @exit_code, @stdout, @stderr, @error, @manual
      )
    `).run({
      id: persisted.id,
      job_id: persisted.jobId,
      server_id: persisted.serverId,
      server_name: persisted.serverName,
      started_at: persisted.startedAt,
      finished_at: persisted.finishedAt,
      duration_ms: persisted.durationMs,
      status: persisted.status,
      exit_code: persisted.exitCode,
      stdout: persisted.stdout,
      stderr: persisted.stderr,
      error: persisted.error,
      manual: persisted.manual ? 1 : 0,
    });
    // Cap history per job; cheap because of the (job_id, started_at) index.
    this.db.prepare(`
      DELETE FROM maintenance_runs
       WHERE job_id = ?
         AND id NOT IN (
           SELECT id FROM maintenance_runs
            WHERE job_id = ?
            ORDER BY started_at DESC
            LIMIT ${MAX_RUNS_PER_JOB}
         )
    `).run(persisted.jobId, persisted.jobId);
    return persisted;
  }

  listRuns(jobId: string, limit: number = 20): MaintenanceRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM maintenance_runs
       WHERE job_id = ?
       ORDER BY started_at DESC
       LIMIT ?
    `).all(jobId, Math.max(1, Math.min(limit, MAX_RUNS_PER_JOB))) as any[];
    return rows.map(r => this.rowToRun(r));
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private writeRow(j: MaintenanceJob): void {
    this.db.prepare(`
      INSERT INTO maintenance_jobs (
        id, name, description, server_ids, schedule, command, enabled,
        timeout_ms, seeded, last_run_at, last_run_status, last_run_output,
        last_run_duration_ms, next_run_at, created_at, updated_at
      ) VALUES (
        @id, @name, @description, @server_ids, @schedule, @command, @enabled,
        @timeout_ms, @seeded, @last_run_at, @last_run_status, @last_run_output,
        @last_run_duration_ms, @next_run_at, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        server_ids = excluded.server_ids,
        schedule = excluded.schedule,
        command = excluded.command,
        enabled = excluded.enabled,
        timeout_ms = excluded.timeout_ms,
        seeded = excluded.seeded,
        last_run_at = excluded.last_run_at,
        last_run_status = excluded.last_run_status,
        last_run_output = excluded.last_run_output,
        last_run_duration_ms = excluded.last_run_duration_ms,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `).run({
      id: j.id,
      name: j.name,
      description: j.description,
      server_ids: JSON.stringify(j.serverIds),
      schedule: j.schedule,
      command: j.command,
      enabled: j.enabled ? 1 : 0,
      timeout_ms: j.timeoutMs,
      seeded: j.seeded ? 1 : 0,
      last_run_at: j.lastRunAt,
      last_run_status: j.lastRunStatus,
      last_run_output: clipOutput(j.lastRunOutput || ''),
      last_run_duration_ms: j.lastRunDurationMs,
      next_run_at: j.nextRunAt,
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    });
  }

  private rowToJob(r: any): MaintenanceJob {
    return {
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      serverIds: safeJSON<string[]>(r.server_ids, []),
      schedule: r.schedule,
      command: r.command,
      enabled: !!r.enabled,
      timeoutMs: typeof r.timeout_ms === 'number' ? r.timeout_ms : DEFAULT_TIMEOUT_MS,
      seeded: !!r.seeded,
      lastRunAt: r.last_run_at ?? null,
      lastRunStatus: (r.last_run_status as MaintenanceJobStatus) ?? 'never',
      lastRunOutput: r.last_run_output ?? '',
      lastRunDurationMs: typeof r.last_run_duration_ms === 'number' ? r.last_run_duration_ms : null,
      nextRunAt: r.next_run_at ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private rowToRun(r: any): MaintenanceRun {
    return {
      id: r.id,
      jobId: r.job_id,
      serverId: r.server_id,
      serverName: r.server_name,
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? null,
      durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : null,
      status: r.status as MaintenanceRunStatus,
      exitCode: typeof r.exit_code === 'number' ? r.exit_code : null,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error ?? null,
      manual: !!r.manual,
    };
  }
}

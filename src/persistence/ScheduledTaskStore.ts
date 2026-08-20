// Persistence for ScheduledTask + ScheduledTaskRun records.
//
// SQLite + Postgres impls under one interface, same pattern as the
// rest of the persistence layer. Both backends keep schedules in a
// schedules table and runs in a schedule_runs table; runs are
// append-only (no UPDATE on terminal records) to make audit trails
// trustworthy.
//
// Tenant scoping piggybacks on the existing tenancy migration: every
// row carries tenant_id, and the resolveTenant() pattern from the
// other stores is reused so callers don't have to thread tenants
// explicitly.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { getCurrentTenantId } from '../tenancy/index.js';
// Type-only import — types live with the scheduling module that owns
// the engine + lifecycle semantics; the store is pure persistence.
// `import type` is erased at runtime so no edge from persistence →
// scheduling at the boundary enforcer's level.
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduleStatus,
  RunOutcome,
} from '../scheduling/ScheduledTaskTypes.js';

export interface ScheduledTaskStore {
  // Schedules
  upsert(task: ScheduledTask): void | Promise<void>;
  get(id: string, tenantId?: string): ScheduledTask | null | Promise<ScheduledTask | null>;
  list(filter?: { tenantId?: string; status?: ScheduleStatus }): ScheduledTask[] | Promise<ScheduledTask[]>;
  delete(id: string, tenantId?: string): boolean | Promise<boolean>;
  /** Atomic pause/resume that doesn't bump updated_at fields the engine
   *  uses for missed-run logic. */
  setStatus(id: string, status: ScheduleStatus, tenantId?: string): boolean | Promise<boolean>;
  /** Record the start of a run + bump runCount + lastRunAt + inFlightCount. */
  markRunStarted(id: string, when: Date, tenantId?: string): void | Promise<void>;
  /** Decrement inFlightCount when the run reaches a terminal state. */
  markRunFinished(id: string, tenantId?: string): void | Promise<void>;
  /** Compute + persist the next run time (called by the engine after
   *  a successful schedule). */
  setNextRun(id: string, nextRunAt: string | null, tenantId?: string): void | Promise<void>;

  // Runs (history)
  appendRun(run: ScheduledTaskRun): void | Promise<void>;
  /** Update an in-flight run to a terminal outcome. */
  finalizeRun(runId: string, outcome: RunOutcome, fields: { error?: string; workflowRunId?: string }): void | Promise<void>;
  listRuns(filter: { scheduleId?: string; tenantId?: string; limit?: number }): ScheduledTaskRun[] | Promise<ScheduledTaskRun[]>;

  close(): void | Promise<void>;
}

// ─── SQLite ────────────────────────────────────────────────────────────

export class SqliteScheduledTaskStore implements ScheduledTaskStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL DEFAULT 'system',
        name            TEXT NOT NULL,
        description     TEXT,
        cron            TEXT NOT NULL,
        action          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'enabled',
        last_run_at     TEXT,
        next_run_at     TEXT,
        run_count       INTEGER NOT NULL DEFAULT 0,
        in_flight_count INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);

      CREATE TABLE IF NOT EXISTS schedule_runs (
        id              TEXT PRIMARY KEY,
        schedule_id     TEXT NOT NULL,
        tenant_id       TEXT NOT NULL DEFAULT 'system',
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        outcome         TEXT NOT NULL,
        workflow_run_id TEXT,
        skip_reason     TEXT,
        error           TEXT,
        missed_run      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_tenant   ON schedule_runs(tenant_id);
    `);
    logger.info(`[SqliteScheduledTaskStore] Opened ${dbPath}`);
  }

  private resolveTenant(t?: string): string { return t ?? getCurrentTenantId(); }

  upsert(task: ScheduledTask): void {
    this.db.prepare(`
      INSERT INTO schedules
        (id, tenant_id, name, description, cron, action, status,
         last_run_at, next_run_at, run_count, in_flight_count, created_at, updated_at)
      VALUES (@id, @tenantId, @name, @description, @cron, @action, @status,
              @lastRunAt, @nextRunAt, @runCount, @inFlightCount, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        cron = excluded.cron,
        action = excluded.action,
        status = excluded.status,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        run_count = excluded.run_count,
        in_flight_count = excluded.in_flight_count,
        updated_at = excluded.updated_at
    `).run({
      ...task,
      description: task.description ?? null,
      action: JSON.stringify(task.action),
      lastRunAt: task.lastRunAt ?? null,
      nextRunAt: task.nextRunAt ?? null,
    });
  }

  get(id: string, tenantId?: string): ScheduledTask | null {
    const t = this.resolveTenant(tenantId);
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ? AND tenant_id = ?').get(id, t) as RawScheduleRow | undefined;
    return row ? rowToSchedule(row) : null;
  }

  list(filter?: { tenantId?: string; status?: ScheduleStatus }): ScheduledTask[] {
    const t = this.resolveTenant(filter?.tenantId);
    if (filter?.status) {
      const rows = this.db.prepare(
        'SELECT * FROM schedules WHERE tenant_id = ? AND status = ? ORDER BY id'
      ).all(t, filter.status) as RawScheduleRow[];
      return rows.map(rowToSchedule);
    }
    const rows = this.db.prepare('SELECT * FROM schedules WHERE tenant_id = ? ORDER BY id').all(t) as RawScheduleRow[];
    return rows.map(rowToSchedule);
  }

  delete(id: string, tenantId?: string): boolean {
    const t = this.resolveTenant(tenantId);
    return this.db.prepare('DELETE FROM schedules WHERE id = ? AND tenant_id = ?').run(id, t).changes > 0;
  }

  setStatus(id: string, status: ScheduleStatus, tenantId?: string): boolean {
    const t = this.resolveTenant(tenantId);
    return this.db.prepare(
      `UPDATE schedules SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    ).run(status, new Date().toISOString(), id, t).changes > 0;
  }

  markRunStarted(id: string, when: Date, tenantId?: string): void {
    const t = this.resolveTenant(tenantId);
    this.db.prepare(
      `UPDATE schedules
         SET last_run_at = ?, run_count = run_count + 1, in_flight_count = in_flight_count + 1,
             updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(when.toISOString(), new Date().toISOString(), id, t);
  }

  markRunFinished(id: string, tenantId?: string): void {
    const t = this.resolveTenant(tenantId);
    this.db.prepare(
      `UPDATE schedules
         SET in_flight_count = MAX(0, in_flight_count - 1), updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(new Date().toISOString(), id, t);
  }

  setNextRun(id: string, nextRunAt: string | null, tenantId?: string): void {
    const t = this.resolveTenant(tenantId);
    this.db.prepare(
      `UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    ).run(nextRunAt, new Date().toISOString(), id, t);
  }

  appendRun(run: ScheduledTaskRun): void {
    this.db.prepare(`
      INSERT INTO schedule_runs
        (id, schedule_id, tenant_id, started_at, completed_at, outcome,
         workflow_run_id, skip_reason, error, missed_run)
      VALUES (@id, @scheduleId, @tenantId, @startedAt, @completedAt, @outcome,
              @workflowRunId, @skipReason, @error, @missedRun)
    `).run({
      ...run,
      completedAt: run.completedAt ?? null,
      workflowRunId: run.workflowRunId ?? null,
      skipReason: run.skipReason ?? null,
      error: run.error ?? null,
      missedRun: run.missedRun ? 1 : 0,
    });
  }

  finalizeRun(runId: string, outcome: RunOutcome, fields: { error?: string; workflowRunId?: string }): void {
    this.db.prepare(
      `UPDATE schedule_runs
         SET completed_at = ?, outcome = ?, error = ?, workflow_run_id = COALESCE(?, workflow_run_id)
       WHERE id = ?`,
    ).run(new Date().toISOString(), outcome, fields.error ?? null, fields.workflowRunId ?? null, runId);
  }

  listRuns(filter: { scheduleId?: string; tenantId?: string; limit?: number }): ScheduledTaskRun[] {
    const t = this.resolveTenant(filter.tenantId);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    let sql = 'SELECT * FROM schedule_runs WHERE tenant_id = ?';
    const params: unknown[] = [t];
    if (filter.scheduleId) { sql += ' AND schedule_id = ?'; params.push(filter.scheduleId); }
    sql += ' ORDER BY started_at DESC LIMIT ?';
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as RawRunRow[]).map(rowToRun);
  }

  close(): void { this.db.close(); }
}

// ─── Postgres ─────────────────────────────────────────────────────────

export class PostgresScheduledTaskStore implements ScheduledTaskStore {
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
        CREATE TABLE IF NOT EXISTS schedules (
          id              TEXT PRIMARY KEY,
          tenant_id       TEXT NOT NULL DEFAULT 'system',
          name            TEXT NOT NULL,
          description     TEXT,
          cron            TEXT NOT NULL,
          action          JSONB NOT NULL,
          status          TEXT NOT NULL DEFAULT 'enabled',
          last_run_at     TIMESTAMPTZ,
          next_run_at     TIMESTAMPTZ,
          run_count       INTEGER NOT NULL DEFAULT 0,
          in_flight_count INTEGER NOT NULL DEFAULT 0,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_schedules_tenant ON schedules(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);

        CREATE TABLE IF NOT EXISTS schedule_runs (
          id              TEXT PRIMARY KEY,
          schedule_id     TEXT NOT NULL,
          tenant_id       TEXT NOT NULL DEFAULT 'system',
          started_at      TIMESTAMPTZ NOT NULL,
          completed_at    TIMESTAMPTZ,
          outcome         TEXT NOT NULL,
          workflow_run_id TEXT,
          skip_reason     TEXT,
          error           TEXT,
          missed_run      BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_schedule_runs_tenant   ON schedule_runs(tenant_id);
      `);
      this.schemaReady = true;
    } finally { client.release(); }
  }

  private resolveTenant(t?: string): string { return t ?? getCurrentTenantId(); }

  async upsert(task: ScheduledTask): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`
      INSERT INTO schedules
        (id, tenant_id, name, description, cron, action, status,
         last_run_at, next_run_at, run_count, in_flight_count, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12::timestamptz,$13::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        cron = EXCLUDED.cron, action = EXCLUDED.action,
        status = EXCLUDED.status,
        last_run_at = EXCLUDED.last_run_at, next_run_at = EXCLUDED.next_run_at,
        run_count = EXCLUDED.run_count, in_flight_count = EXCLUDED.in_flight_count,
        updated_at = EXCLUDED.updated_at
    `, [
      task.id, task.tenantId, task.name, task.description ?? null, task.cron,
      JSON.stringify(task.action), task.status,
      task.lastRunAt ?? null, task.nextRunAt ?? null,
      task.runCount, task.inFlightCount, task.createdAt, task.updatedAt,
    ]);
  }

  async get(id: string, tenantId?: string): Promise<ScheduledTask | null> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('SELECT * FROM schedules WHERE id = $1 AND tenant_id = $2', [id, t]);
    return r.rows[0] ? rowToSchedulePg(r.rows[0]) : null;
  }

  async list(filter?: { tenantId?: string; status?: ScheduleStatus }): Promise<ScheduledTask[]> {
    await this.ensureSchema();
    const t = this.resolveTenant(filter?.tenantId);
    if (filter?.status) {
      const r = await this.pool.query(
        'SELECT * FROM schedules WHERE tenant_id = $1 AND status = $2 ORDER BY id', [t, filter.status],
      );
      return r.rows.map(rowToSchedulePg);
    }
    const r = await this.pool.query('SELECT * FROM schedules WHERE tenant_id = $1 ORDER BY id', [t]);
    return r.rows.map(rowToSchedulePg);
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query('DELETE FROM schedules WHERE id = $1 AND tenant_id = $2', [id, t]);
    return (r.rowCount ?? 0) > 0;
  }

  async setStatus(id: string, status: ScheduleStatus, tenantId?: string): Promise<boolean> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    const r = await this.pool.query(
      `UPDATE schedules SET status = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
      [status, id, t],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markRunStarted(id: string, when: Date, tenantId?: string): Promise<void> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    await this.pool.query(
      `UPDATE schedules
         SET last_run_at = $1::timestamptz,
             run_count = run_count + 1,
             in_flight_count = in_flight_count + 1,
             updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [when.toISOString(), id, t],
    );
  }
  async markRunFinished(id: string, tenantId?: string): Promise<void> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    await this.pool.query(
      `UPDATE schedules
         SET in_flight_count = GREATEST(0, in_flight_count - 1), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [id, t],
    );
  }
  async setNextRun(id: string, nextRunAt: string | null, tenantId?: string): Promise<void> {
    await this.ensureSchema();
    const t = this.resolveTenant(tenantId);
    await this.pool.query(
      `UPDATE schedules SET next_run_at = $1::timestamptz, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [nextRunAt, id, t],
    );
  }

  async appendRun(run: ScheduledTaskRun): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(`
      INSERT INTO schedule_runs
        (id, schedule_id, tenant_id, started_at, completed_at, outcome,
         workflow_run_id, skip_reason, error, missed_run)
      VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8,$9,$10)
    `, [
      run.id, run.scheduleId, run.tenantId,
      run.startedAt, run.completedAt ?? null, run.outcome,
      run.workflowRunId ?? null, run.skipReason ?? null, run.error ?? null,
      run.missedRun,
    ]);
  }
  async finalizeRun(runId: string, outcome: RunOutcome, fields: { error?: string; workflowRunId?: string }): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE schedule_runs
         SET completed_at = NOW(), outcome = $1, error = $2,
             workflow_run_id = COALESCE($3, workflow_run_id)
       WHERE id = $4`,
      [outcome, fields.error ?? null, fields.workflowRunId ?? null, runId],
    );
  }
  async listRuns(filter: { scheduleId?: string; tenantId?: string; limit?: number }): Promise<ScheduledTaskRun[]> {
    await this.ensureSchema();
    const t = this.resolveTenant(filter.tenantId);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    if (filter.scheduleId) {
      const r = await this.pool.query(
        `SELECT * FROM schedule_runs WHERE tenant_id = $1 AND schedule_id = $2 ORDER BY started_at DESC LIMIT $3`,
        [t, filter.scheduleId, limit],
      );
      return r.rows.map(rowToRunPg);
    }
    const r = await this.pool.query(
      `SELECT * FROM schedule_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`, [t, limit],
    );
    return r.rows.map(rowToRunPg);
  }

  async close(): Promise<void> { /* shared pool */ }
}

// ─── helpers ──────────────────────────────────────────────────────────

interface RawScheduleRow {
  id: string; tenant_id: string; name: string; description: string | null;
  cron: string; action: string; status: ScheduleStatus;
  last_run_at: string | null; next_run_at: string | null;
  run_count: number; in_flight_count: number;
  created_at: string; updated_at: string;
}
interface RawRunRow {
  id: string; schedule_id: string; tenant_id: string;
  started_at: string; completed_at: string | null;
  outcome: RunOutcome; workflow_run_id: string | null;
  skip_reason: string | null; error: string | null;
  missed_run: number;
}

function rowToSchedule(r: RawScheduleRow): ScheduledTask {
  let action: ScheduledTask['action'];
  try { action = JSON.parse(r.action); } catch { action = { kind: 'shell', command: 'echo corrupt-action' }; }
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name,
    description: r.description ?? undefined,
    cron: r.cron, action, status: r.status,
    lastRunAt: r.last_run_at ?? undefined, nextRunAt: r.next_run_at ?? undefined,
    runCount: r.run_count, inFlightCount: r.in_flight_count,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function rowToSchedulePg(row: Record<string, unknown>): ScheduledTask {
  const action = typeof row.action === 'string'
    ? JSON.parse(row.action as string)
    : (row.action as ScheduledTask['action']);
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    cron: row.cron as string,
    action,
    status: row.status as ScheduleStatus,
    lastRunAt: row.last_run_at instanceof Date ? row.last_run_at.toISOString() : (row.last_run_at as string | null) ?? undefined,
    nextRunAt: row.next_run_at instanceof Date ? row.next_run_at.toISOString() : (row.next_run_at as string | null) ?? undefined,
    runCount: row.run_count as number,
    inFlightCount: row.in_flight_count as number,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}
function rowToRun(r: RawRunRow): ScheduledTaskRun {
  return {
    id: r.id, scheduleId: r.schedule_id, tenantId: r.tenant_id,
    startedAt: r.started_at, completedAt: r.completed_at ?? undefined,
    outcome: r.outcome,
    workflowRunId: r.workflow_run_id ?? undefined,
    skipReason: r.skip_reason ?? undefined,
    error: r.error ?? undefined,
    missedRun: !!r.missed_run,
  };
}
function rowToRunPg(row: Record<string, unknown>): ScheduledTaskRun {
  return {
    id: row.id as string,
    scheduleId: row.schedule_id as string,
    tenantId: row.tenant_id as string,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at as string | null) ?? undefined,
    outcome: row.outcome as RunOutcome,
    workflowRunId: (row.workflow_run_id as string | null) ?? undefined,
    skipReason: (row.skip_reason as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    missedRun: !!row.missed_run,
  };
}

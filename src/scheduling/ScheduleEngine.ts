// Cron-driven engine that fires registered schedules.
//
// What it does on top of node-cron:
//   - Persists schedules + every run in ScheduledTaskStore so a server
//     restart doesn't lose history or schedule state.
//   - On startup, looks at every enabled schedule's lastRunAt vs the
//     current time and synthesises a "missed-run" execution when the
//     cron should have fired while the server was down. Configurable
//     window so an operator who left a server off for a month doesn't
//     get hammered by 30 days of replays.
//   - Per-schedule concurrency lock — if a previous run is still
//     in-flight when the next tick arrives, the engine records a
//     "skipped" run rather than firing concurrently.
//   - Triggers either a workflow (via WorkflowJsonExecutor) or an
//     inline shell command (via SkillManager.execute('bash.exec'))
//     so the action surface is the same as the workflow editor.
//
// What it deliberately doesn't do:
//   - Distributed coordination. One engine per process; for HA, run
//     on a single primary and lean on the persistence layer for state.
//   - Sub-second precision. node-cron resolves to seconds, which is
//     fine for IT-Ops cadences.

import cron from 'node-cron';
import type { ScheduledTask as CronTask } from 'node-cron';
import { randomUUID } from 'crypto';
import { createLogger } from '../observability/Logger.js';
import { runWithTenant, SYSTEM_TENANT_ID } from '../tenancy/index.js';
import type { WorkflowJsonExecutor, WorkflowRegistry, WorkflowRunRecord } from '../workflows/index.js';
import type { SkillManager } from '../skills/index.js';
import type { ScheduledTaskStore } from '../persistence/index.js';
import type {
  RunOutcome,
  ScheduledTask,
  ScheduledTaskRun,
} from './ScheduledTaskTypes.js';

const log = createLogger({ component: 'schedule-engine' });

export interface ScheduleEngineDeps {
  store: ScheduledTaskStore;
  workflowExecutor: WorkflowJsonExecutor;
  workflowRegistry: WorkflowRegistry;
  skillManager: SkillManager;
  /** How far back to scan for missed runs at startup. Older misses
   *  are recorded as "skipped" with reason="missed-window-exceeded"
   *  rather than replayed. Default 24h. */
  missedRunWindowMs?: number;
  /** Inject for tests. */
  now?: () => Date;
}

export class ScheduleEngine {
  private readonly store: ScheduledTaskStore;
  private readonly workflowExecutor: WorkflowJsonExecutor;
  private readonly workflowRegistry: WorkflowRegistry;
  private readonly skillManager: SkillManager;
  private readonly missedRunWindowMs: number;
  private readonly now: () => Date;

  /** Active node-cron jobs keyed by schedule id. Recreated on every
   *  start() call so a stale cron job from a previous registration
   *  can't tick alongside the new one. */
  private readonly jobs: Map<string, CronTask> = new Map();
  private started = false;

  constructor(deps: ScheduleEngineDeps) {
    this.store            = deps.store;
    this.workflowExecutor = deps.workflowExecutor;
    this.workflowRegistry = deps.workflowRegistry;
    this.skillManager     = deps.skillManager;
    this.missedRunWindowMs = deps.missedRunWindowMs ?? 24 * 60 * 60 * 1000;
    this.now              = deps.now ?? (() => new Date());
  }

  /** Boot the engine: replay missed runs, then schedule every enabled
   *  task with node-cron. Idempotent — calling start() twice is a no-op.
   *  The opts.replayMissed=false flag is for tests that want to assert
   *  scheduling behaviour without the missed-run replay path firing. */
  async start(opts?: { replayMissed?: boolean }): Promise<void> {
    if (this.started) return;
    this.started = true;
    const tasks = await Promise.resolve(this.store.list());

    if (opts?.replayMissed !== false) {
      for (const t of tasks) {
        if (t.status === 'enabled') await this.replayMissed(t).catch((err) => {
          log.warn('missed-run replay failed', { scheduleId: t.id, err: errMsg(err) });
        });
      }
    }

    for (const t of tasks) if (t.status === 'enabled') this.scheduleOne(t);
    log.info('schedule engine started', { count: tasks.length, active: this.jobs.size });
  }

  /** Stop every node-cron job. The in-flight run's promise (if any)
   *  resolves on its own; we don't try to cancel it. */
  stop(): void {
    for (const [, job] of this.jobs) {
      try { job.stop(); } catch { /* ignore */ }
    }
    this.jobs.clear();
    this.started = false;
  }

  /** Register or update a schedule. Persists, then re-binds the cron
   *  job so callers don't have to bounce the engine. */
  async upsert(task: ScheduledTask): Promise<ScheduledTask> {
    if (!cron.validate(task.cron)) throw new Error(`invalid cron expression "${task.cron}"`);
    const next = this.computeNextRun(task);
    const merged: ScheduledTask = {
      ...task,
      nextRunAt: next ?? undefined,
      updatedAt: this.now().toISOString(),
    };
    await Promise.resolve(this.store.upsert(merged));
    if (this.started) this.rebindJob(merged);
    return merged;
  }

  async setStatus(id: string, status: 'enabled' | 'paused', tenantId?: string): Promise<boolean> {
    const ok = await Promise.resolve(this.store.setStatus(id, status, tenantId));
    if (!ok) return false;
    const refreshed = await Promise.resolve(this.store.get(id, tenantId));
    if (!refreshed) return false;
    if (status === 'paused') {
      const job = this.jobs.get(id);
      if (job) { try { job.stop(); } catch { /* ignore */ } this.jobs.delete(id); }
    } else if (this.started) {
      this.scheduleOne(refreshed);
    }
    return true;
  }

  async delete(id: string, tenantId?: string): Promise<boolean> {
    const ok = await Promise.resolve(this.store.delete(id, tenantId));
    if (ok) {
      const job = this.jobs.get(id);
      if (job) { try { job.stop(); } catch { /* ignore */ } this.jobs.delete(id); }
    }
    return ok;
  }

  /** Manually fire a schedule — used by the API "run now" endpoint
   *  and by the missed-run replay loop. Honors the in-flight lock. */
  async runNow(scheduleId: string, opts?: { missedRun?: boolean; tenantId?: string }): Promise<ScheduledTaskRun> {
    const fresh = await Promise.resolve(this.store.get(scheduleId, opts?.tenantId));
    if (!fresh) throw new Error(`schedule "${scheduleId}" not found`);
    return this.executeRun(fresh, !!opts?.missedRun);
  }

  /** Compute the next-fire timestamp for a schedule. Best-effort: if
   *  the cron expression has no next match (rare), returns null. */
  computeNextRun(task: ScheduledTask, after?: Date): string | null {
    if (!cron.validate(task.cron)) return null;
    // node-cron doesn't expose a "next" computation; we walk forward
    // one minute at a time until the parser matches. Capped at 366
    // days so a schedule with no future fires (e.g. far-future cron)
    // doesn't loop forever.
    const start = (after ?? this.now()).getTime();
    const stepMs = 60_000;
    const cap = 366 * 24 * 60 * 60 * 1000;
    for (let dt = stepMs; dt <= cap; dt += stepMs) {
      const candidate = new Date(start + dt);
      if (cronMatches(task.cron, candidate)) return candidate.toISOString();
    }
    return null;
  }

  // ─── internals ──────────────────────────────────────────────────────

  /** Bind a node-cron job that calls executeRun on every tick. */
  private scheduleOne(task: ScheduledTask): void {
    const existing = this.jobs.get(task.id);
    if (existing) { try { existing.stop(); } catch { /* ignore */ } }
    if (!cron.validate(task.cron)) {
      log.warn('skipping invalid cron expression', { scheduleId: task.id, cron: task.cron });
      return;
    }
    const job = cron.schedule(task.cron, () => {
      this.executeRun(task, false).catch((err) =>
        log.error('schedule run failed', { scheduleId: task.id, err: errMsg(err) }),
      );
    });
    this.jobs.set(task.id, job);
  }
  private rebindJob(task: ScheduledTask): void {
    if (task.status === 'paused') {
      const j = this.jobs.get(task.id);
      if (j) { try { j.stop(); } catch { /* ignore */ } this.jobs.delete(task.id); }
      return;
    }
    this.scheduleOne(task);
  }

  /** The hot path. Honors concurrency lock + records a run row + drives
   *  the action + finalizes the row. */
  private async executeRun(task: ScheduledTask, missedRun: boolean): Promise<ScheduledTaskRun> {
    const fresh = await Promise.resolve(this.store.get(task.id, task.tenantId));
    if (!fresh) {
      // Schedule was deleted between tick and our read — synthesise a
      // skipped-run row so the absence is visible, and exit.
      const row = newRunRow(task, missedRun, 'skipped', { skipReason: 'schedule-deleted' });
      await Promise.resolve(this.store.appendRun(row));
      return row;
    }
    if (fresh.status === 'paused') {
      const row = newRunRow(fresh, missedRun, 'skipped', { skipReason: 'schedule-paused' });
      await Promise.resolve(this.store.appendRun(row));
      return row;
    }
    if (fresh.inFlightCount > 0) {
      const row = newRunRow(fresh, missedRun, 'skipped', { skipReason: 'concurrent-run-in-flight' });
      await Promise.resolve(this.store.appendRun(row));
      return row;
    }

    const startedAt = this.now();
    const runId = `srun-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const runRow: ScheduledTaskRun = {
      id: runId,
      scheduleId: fresh.id,
      tenantId: fresh.tenantId,
      startedAt: startedAt.toISOString(),
      outcome: 'failed', // placeholder — finalizeRun() rewrites
      missedRun,
    };
    await Promise.resolve(this.store.markRunStarted(fresh.id, startedAt, fresh.tenantId));
    await Promise.resolve(this.store.appendRun(runRow));
    log.info('schedule run started', { scheduleId: fresh.id, runId, missedRun });

    let outcome: RunOutcome = 'failed';
    let error: string | undefined;
    let workflowRunId: string | undefined;

    try {
      // Run the action inside the schedule's tenant scope so all
      // downstream work (skill calls, workflow execution, event emits)
      // sees the right tenant.
      const tenantCtx = { tenantId: fresh.tenantId };
      const result = await runWithTenant(tenantCtx, () => this.dispatchAction(fresh));
      if (isWorkflowRecord(result)) {
        workflowRunId = result.runId;
        outcome = result.status === 'completed'        ? 'success'
                : result.status === 'pending_approval' ? 'pending_approval'
                : 'failed';
        error = result.error;
      } else {
        outcome = result.ok ? 'success' : 'failed';
        error = result.error;
      }
    } catch (e: unknown) {
      outcome = 'failed';
      error = errMsg(e);
    } finally {
      await Promise.resolve(this.store.markRunFinished(fresh.id, fresh.tenantId));
    }

    await Promise.resolve(this.store.finalizeRun(runId, outcome, { error, workflowRunId }));
    // Refresh nextRunAt now that we've fired.
    const next = this.computeNextRun(fresh, startedAt);
    await Promise.resolve(this.store.setNextRun(fresh.id, next, fresh.tenantId));

    log.info('schedule run finished', { scheduleId: fresh.id, runId, outcome });
    return { ...runRow, outcome, error, workflowRunId, completedAt: this.now().toISOString() };
  }

  /** Dispatch a schedule's action to the right execution surface. */
  private async dispatchAction(t: ScheduledTask):
    Promise<WorkflowRunRecord | { ok: boolean; error?: string }>
  {
    if (t.action.kind === 'workflow') {
      const wf = this.workflowRegistry.get(t.action.workflowId);
      if (!wf) return { ok: false, error: `workflow "${t.action.workflowId}" not registered` };
      return this.workflowExecutor.execute(wf, { inputs: t.action.inputs });
    }
    // Inline shell. Wrap the result in {ok,error} so the executeRun
    // post-processing can stay simple.
    try {
      const raw = await this.skillManager.execute('bash.exec', { command: t.action.command });
      try {
        const parsed = JSON.parse(raw);
        return { ok: parsed?.ok !== false, error: parsed?.error };
      } catch {
        return { ok: true }; // legacy prose return — treat as success
      }
    } catch (e: unknown) {
      return { ok: false, error: errMsg(e) };
    }
  }

  /** On startup, decide whether a schedule's missed cron tick(s) are
   *  recent enough to replay. Records a "skipped" history row for
   *  schedules where the gap exceeds missedRunWindowMs. */
  private async replayMissed(t: ScheduledTask): Promise<void> {
    if (!t.lastRunAt) return; // brand-new schedule; nothing to replay
    const last = new Date(t.lastRunAt).getTime();
    const now  = this.now().getTime();
    const gap = now - last;
    if (gap <= 0) return;
    if (gap > this.missedRunWindowMs) {
      const row = newRunRow(t, true, 'skipped', { skipReason: 'missed-window-exceeded' });
      await Promise.resolve(this.store.appendRun(row));
      return;
    }
    // Walk minute-by-minute through the window and find the *first*
    // missed cron match. We don't fan out one execution per missed
    // tick — for IT-Ops cadences, replaying once is the right call.
    const stepMs = 60_000;
    for (let when = last + stepMs; when <= now; when += stepMs) {
      if (cronMatches(t.cron, new Date(when))) {
        log.info('replaying missed run', { scheduleId: t.id, missedAt: new Date(when).toISOString() });
        await this.executeRun(t, true);
        return;
      }
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

function newRunRow(
  t: ScheduledTask,
  missedRun: boolean,
  outcome: RunOutcome,
  extras: { skipReason?: string; error?: string; workflowRunId?: string } = {},
): ScheduledTaskRun {
  const now = new Date().toISOString();
  return {
    id: `srun-${Date.now()}-${randomUUID().slice(0, 8)}`,
    scheduleId: t.id,
    tenantId: t.tenantId ?? SYSTEM_TENANT_ID,
    startedAt: now,
    completedAt: now,
    outcome,
    missedRun,
    ...extras,
  };
}

function isWorkflowRecord(value: unknown): value is WorkflowRunRecord {
  return !!value && typeof value === 'object'
      && 'runId' in (value as Record<string, unknown>)
      && 'status' in (value as Record<string, unknown>);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Test whether a cron expression matches a specific date. Implemented
 *  by spinning up a one-shot validate() — node-cron exposes match
 *  semantics only via running, so we recreate just enough of it here.
 *  Format is the same 5/6-field syntax node-cron accepts. */
function cronMatches(expr: string, date: Date): boolean {
  if (!cron.validate(expr)) return false;
  // node-cron parses fields in this order: [second?] minute hour day month weekday.
  // We do the same parsing locally — sufficient for the missed-run
  // replay computation. Lists, ranges, steps and "*" are supported.
  const parts = expr.trim().split(/\s+/);
  let sec: string | null = null, min: string, hr: string, dom: string, mon: string, dow: string;
  if (parts.length === 6) [sec, min, hr, dom, mon, dow] = parts;
  else                    [min, hr, dom, mon, dow] = parts;

  if (sec !== null && !fieldMatches(sec, date.getSeconds(), 0, 59)) return false;
  if (!fieldMatches(min, date.getMinutes(), 0, 59)) return false;
  if (!fieldMatches(hr,  date.getHours(),   0, 23)) return false;
  if (!fieldMatches(dom, date.getDate(),    1, 31)) return false;
  if (!fieldMatches(mon, date.getMonth() + 1, 1, 12)) return false;
  // node-cron treats both 0 and 7 as Sunday; our matcher accepts either.
  const day = date.getDay();
  if (!fieldMatches(dow, day, 0, 7) && !fieldMatches(dow, day === 0 ? 7 : day, 0, 7)) return false;
  return true;
}

function fieldMatches(expr: string, value: number, min: number, max: number): boolean {
  for (const piece of expr.split(',')) {
    if (matchPiece(piece.trim(), value, min, max)) return true;
  }
  return false;
}
function matchPiece(piece: string, value: number, min: number, max: number): boolean {
  // Step form: */N or A-B/N or A/N
  let stem = piece;
  let step = 1;
  const slash = piece.indexOf('/');
  if (slash >= 0) {
    stem = piece.slice(0, slash) || '*';
    step = Math.max(1, Number(piece.slice(slash + 1)) || 1);
  }
  let lo = min, hi = max;
  if (stem === '*' || stem === '?') {
    // any value, with optional step
  } else if (stem.includes('-')) {
    const [a, b] = stem.split('-');
    lo = Number(a); hi = Number(b);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
  } else {
    const exact = Number(stem);
    if (Number.isNaN(exact)) return false;
    return exact === value;
  }
  if (value < lo || value > hi) return false;
  return ((value - lo) % step) === 0;
}

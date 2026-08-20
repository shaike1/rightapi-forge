// MaintenanceScheduler — cron-driven runner for scheduled host maintenance.
//
// Lifecycle:
//   1. constructor — wires deps, parses env toggles, computes initial
//      `next_run_at` on each enabled job (no I/O against targets).
//   2. seedDefaults() — idempotent boot-time seeding of the three baseline
//      jobs (disk-cleanup, docker-prune, log-rotation). Existing rows are
//      preserved so operator edits survive restarts.
//   3. start() — kicks the 60s tick that scans for due jobs.
//   4. tick() — for each job whose nextRunAt has passed, dispatch via
//      RemoteExecutor against each target (resolved from serverIds; `[]`
//      → every enabled server), record one run row per target, and
//      summarise the worst outcome onto the job row.
//   5. runNow(jobId) — manual trigger from POST /api/maintenance/:id/run.
//      Bypasses cron but honours the concurrency guard.
//
// Concurrency:
//   A single in-memory Set<jobId> prevents overlapping runs of the same
//   job. If a job is still running when its next cron tick fires, we
//   record a `skipped` history row for diagnosis and move on.
//
// Failure handling:
//   Per-server failures open a low-severity incident with
//   sourceRef `maintenance:failed:<jobId>:<serverId>` and dedupBy
//   sourceRef. Successive successes don't auto-resolve here — operators
//   close it manually after the recipe is fixed. (Auto-resolving would
//   mask cron jobs that flap between success and failure.)

import { CronParser } from '../scheduling/CronParser.js';
import type { ServerRegistry, MonitoredServer } from '../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { ComponentLogger } from '../observability/Logger.js';
import {
  MaintenanceStore,
  type MaintenanceJob,
  type MaintenanceJobStatus,
  type MaintenanceRunStatus,
  type CreateJobInput,
} from './MaintenanceStore.js';

export interface MaintenanceSchedulerDeps {
  store: MaintenanceStore;
  registry: ServerRegistry;
  executor: RemoteExecutor;
  incidentManager: IncidentManager;
  log: ComponentLogger;
  /** Optional WS broadcaster — UI can update job rows in real time. */
  broadcast?: (msg: unknown) => void;
}

/** The three default jobs the spec asks for. Seeded once on first boot;
 *  operators can disable / edit / delete from the UI afterwards. */
const DEFAULT_SEEDS: CreateJobInput[] = [
  {
    id: 'disk-cleanup',
    name: 'Disk cleanup',
    description: 'Weekly disk reclamation: apt clean, /tmp + /var/tmp, rotated log archives, journal vacuum to 3 days.',
    schedule: '0 3 * * 0', // Sundays 03:00
    command: "apt-get clean; rm -rf /tmp/* /var/tmp/* /var/log/*.gz /var/log/*.1; journalctl --vacuum-time=3d",
    serverIds: [],
    timeoutMs: 10 * 60_000,
  },
  {
    id: 'docker-prune',
    name: 'Docker prune',
    description: 'Daily docker housekeeping: stopped containers, dangling images, builder cache above 2GB.',
    schedule: '0 4 * * *', // Every day 04:00
    command: 'docker container prune -f; docker image prune -f; docker builder prune -f --keep-storage=2GB',
    serverIds: [],
    timeoutMs: 10 * 60_000,
  },
  {
    id: 'log-rotation',
    name: 'Log rotation',
    description: 'Daily log truncation: any /var/log/*.log over 100MB gets cut to a 10MB tail.',
    schedule: '0 2 * * *', // Every day 02:00
    command: "find /var/log -name '*.log' -size +100M -exec truncate -s 10M {} \\;",
    serverIds: [],
    timeoutMs: 5 * 60_000,
  },
];

const TICK_INTERVAL_MS = 60_000;

export class MaintenanceScheduler {
  private readonly enabled: boolean;
  private readonly running = new Set<string>();
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MaintenanceSchedulerDeps) {
    const raw = (process.env.MAINTENANCE_ENABLED ?? 'true').toLowerCase();
    this.enabled = raw !== 'false' && raw !== '0' && raw !== 'no';
  }

  /** Boot-time seed of the default jobs. Safe to call repeatedly —
   *  ensureSeed() preserves operator edits. */
  seedDefaults(): void {
    for (const seed of DEFAULT_SEEDS) {
      try {
        const r = this.deps.store.ensureSeed(seed);
        if (r.created) {
          this.deps.log.info('seeded default maintenance job', { id: r.job.id, schedule: r.job.schedule });
        }
      } catch (e: any) {
        this.deps.log.error('seed failed', { id: seed.id, err: e.message });
      }
    }
    this.recomputeAllNextRuns();
  }

  /** Walk every enabled job and stamp `next_run_at` from the cron
   *  expression. Called after seeding and after any external mutation
   *  (create/update/delete via the API). */
  recomputeAllNextRuns(): void {
    const now = new Date();
    for (const job of this.deps.store.list()) {
      if (!job.enabled) {
        if (job.nextRunAt) this.deps.store.update(job.id, { nextRunAt: null });
        continue;
      }
      const next = this.computeNextRun(job.schedule, now);
      if (next && next.toISOString() !== job.nextRunAt) {
        this.deps.store.update(job.id, { nextRunAt: next.toISOString() });
      }
    }
  }

  private computeNextRun(expression: string, from: Date): Date | null {
    try {
      return CronParser.getNextRun(expression, from);
    } catch (e: any) {
      this.deps.log.warn('invalid cron expression', { expression, err: e.message });
      return null;
    }
  }

  start(): void {
    if (!this.enabled) {
      this.deps.log.info('maintenance scheduler disabled via MAINTENANCE_ENABLED');
      return;
    }
    if (this.interval) return;
    // Immediate tick on start — if a job's window was missed during a
    // restart, we catch it on the first pass without waiting 60s.
    this.tick().catch(e => this.deps.log.error('initial tick failed', { err: e.message }));
    this.interval = setInterval(
      () => { this.tick().catch(e => this.deps.log.error('tick failed', { err: e.message })); },
      TICK_INTERVAL_MS,
    );
    this.deps.log.info('maintenance scheduler started', { tickMs: TICK_INTERVAL_MS });
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const jobs = this.deps.store.list({ enabled: true });
    const due = jobs.filter(j => j.nextRunAt && new Date(j.nextRunAt).getTime() <= now.getTime());
    for (const job of due) {
      // Don't await — let independent jobs run in parallel. Each call
      // handles its own concurrency guard + history persistence, so
      // crossing streams here is safe.
      void this.runJob(job, { manual: false }).catch(e => {
        this.deps.log.error('job execution unexpectedly threw', { jobId: job.id, err: e.message });
      });
    }
  }

  /** Manual trigger — POST /api/maintenance/:id/run. Returns the run
   *  attempt outcome; callers can treat `skipped` as "still running". */
  async runNow(jobId: string): Promise<{ accepted: boolean; reason?: string }> {
    const job = this.deps.store.get(jobId);
    if (!job) return { accepted: false, reason: 'job not found' };
    if (!this.enabled) return { accepted: false, reason: 'maintenance scheduler disabled' };
    if (this.running.has(jobId)) return { accepted: false, reason: 'job already running' };
    // Fire-and-forget; the run rows + lastRunStatus are how the caller
    // tracks progress via GET /api/maintenance/:id/history.
    void this.runJob(job, { manual: true }).catch(e => {
      this.deps.log.error('manual run threw', { jobId: job.id, err: e.message });
    });
    return { accepted: true };
  }

  /** Resolve a job's target server list. `[]` (empty) means "every
   *  enabled server in the registry"; otherwise look up by id and skip
   *  any that vanished or got disabled since the job was saved. */
  private resolveTargets(job: MaintenanceJob): MonitoredServer[] {
    if (job.serverIds.length === 0) return this.deps.registry.enabledServers();
    const out: MonitoredServer[] = [];
    for (const id of job.serverIds) {
      const s = this.deps.registry.get(id);
      if (!s) {
        this.deps.log.warn('job references missing server', { jobId: job.id, serverId: id });
        continue;
      }
      if (!s.enabled) {
        this.deps.log.debug('job target is disabled, skipping', { jobId: job.id, serverId: id });
        continue;
      }
      out.push(s);
    }
    return out;
  }

  private async runJob(job: MaintenanceJob, opts: { manual: boolean }): Promise<void> {
    if (this.running.has(job.id)) {
      // Cron tick caught an overlapping window — record one skipped row
      // against the local server (just so the run row exists; the job's
      // lastRunStatus is left alone).
      this.deps.store.recordRun({
        jobId: job.id,
        serverId: 'scheduler',
        serverName: 'scheduler',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'skipped' as MaintenanceRunStatus,
        exitCode: null,
        stdout: '',
        stderr: '',
        error: 'previous run still in progress',
        manual: opts.manual,
      });
      return;
    }
    this.running.add(job.id);
    try {
      // Even before we touch any server, advance nextRunAt off this tick
      // so a slow run won't be re-triggered on the next 60s pass.
      const newNext = this.computeNextRun(job.schedule, new Date());
      this.deps.store.update(job.id, { nextRunAt: newNext ? newNext.toISOString() : null });

      const targets = this.resolveTargets(job);
      if (targets.length === 0) {
        this.deps.log.warn('job has no targets', { jobId: job.id, serverIds: job.serverIds });
        this.deps.store.update(job.id, {
          lastRunAt: new Date().toISOString(),
          lastRunStatus: 'failed',
          lastRunOutput: 'No enabled servers matched serverIds. Job did not run.',
          lastRunDurationMs: 0,
        });
        this.deps.broadcast?.({ type: 'maintenance_job_finished', data: { jobId: job.id, status: 'failed' } });
        return;
      }

      this.deps.broadcast?.({ type: 'maintenance_job_started', data: { jobId: job.id, manual: opts.manual, targetCount: targets.length } });

      const aggregate: { okCount: number; failedCount: number; timedOut: number; outputs: string[]; totalDurationMs: number } = {
        okCount: 0,
        failedCount: 0,
        timedOut: 0,
        outputs: [],
        totalDurationMs: 0,
      };

      for (const server of targets) {
        const startedAt = new Date();
        const startedIso = startedAt.toISOString();
        let status: MaintenanceRunStatus = 'failed';
        let exitCode: number | null = null;
        let stdout = '';
        let stderr = '';
        let error: string | null = null;
        try {
          const r = await this.deps.executor.execute(server, job.command, { timeoutMs: job.timeoutMs });
          stdout = r.stdout || '';
          stderr = r.stderr || '';
          exitCode = r.exitCode;
          if (r.exitCode === 0) {
            status = 'success';
            aggregate.okCount += 1;
          } else {
            status = 'failed';
            aggregate.failedCount += 1;
            error = `exit ${r.exitCode}`;
          }
        } catch (e: any) {
          // Timeout / spawn failure / executor exception.
          const msg = e?.message || String(e);
          if (e?.signal === 'SIGTERM' || /timed? ?out/i.test(msg)) {
            status = 'timeout';
            aggregate.timedOut += 1;
            error = `timeout after ${job.timeoutMs}ms`;
          } else {
            status = 'failed';
            aggregate.failedCount += 1;
            error = msg;
          }
        }
        const finishedAt = new Date();
        const durationMs = finishedAt.getTime() - startedAt.getTime();
        aggregate.totalDurationMs += durationMs;
        const tag = `[${server.name}] ${status}${exitCode != null ? ` (exit ${exitCode})` : ''} in ${durationMs}ms`;
        aggregate.outputs.push(tag + (stdout ? `\n${stdout.trim().slice(0, 800)}` : '') + (stderr ? `\nSTDERR: ${stderr.trim().slice(0, 800)}` : ''));

        this.deps.store.recordRun({
          jobId: job.id,
          serverId: server.id,
          serverName: server.name,
          startedAt: startedIso,
          finishedAt: finishedAt.toISOString(),
          durationMs,
          status,
          exitCode,
          stdout,
          stderr,
          error,
          manual: opts.manual,
        });

        if (status !== 'success') {
          this.openFailureIncident(job, server, status, error);
        }
      }

      const overall: MaintenanceJobStatus =
        aggregate.failedCount === 0 && aggregate.timedOut === 0
          ? 'success'
          : aggregate.okCount === 0
            ? (aggregate.timedOut > 0 && aggregate.failedCount === 0 ? 'timeout' : 'failed')
            : 'partial';

      const finishedAt = new Date();
      this.deps.store.update(job.id, {
        lastRunAt: finishedAt.toISOString(),
        lastRunStatus: overall,
        lastRunOutput: aggregate.outputs.join('\n\n---\n\n'),
        lastRunDurationMs: aggregate.totalDurationMs,
      });
      this.deps.broadcast?.({
        type: 'maintenance_job_finished',
        data: { jobId: job.id, status: overall, ok: aggregate.okCount, failed: aggregate.failedCount, timeout: aggregate.timedOut },
      });
      this.deps.log.info('maintenance job complete', {
        jobId: job.id,
        status: overall,
        manual: opts.manual,
        ok: aggregate.okCount,
        failed: aggregate.failedCount,
        timeout: aggregate.timedOut,
      });
    } finally {
      this.running.delete(job.id);
    }
  }

  private openFailureIncident(
    job: MaintenanceJob,
    server: MonitoredServer,
    status: MaintenanceRunStatus,
    error: string | null,
  ): void {
    try {
      this.deps.incidentManager.create({
        title: `Maintenance failed: ${job.name} on ${server.name}`,
        description:
          `Scheduled job "${job.name}" (${job.id}) failed on server "${server.name}" (${server.id}).\n` +
          `Status: ${status}\n` +
          `Reason: ${error ?? 'unknown'}\n` +
          `Command: ${job.command}`,
        severity: 'low',
        source: 'maintenance',
        sourceRef: `maintenance:failed:${job.id}:${server.id}`,
        dedupBy: 'sourceRef',
      });
    } catch (e: any) {
      this.deps.log.error('failed to open incident for maintenance failure', { jobId: job.id, serverId: server.id, err: e.message });
    }
  }
}

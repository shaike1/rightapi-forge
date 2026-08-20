// Centralised graceful-shutdown coordinator.
//
// On SIGTERM / SIGINT we want to:
//   1. Refuse new tasks (set a flag the orchestrator + HTTP layer check)
//   2. Wait — bounded by `drainTimeoutMs` — for in-flight tasks to finish
//   3. Run user-registered shutdown hooks (DB close, telemetry flush,
//      WebSocket close, usage-tracker save, etc.)
//   4. Exit(0)
//
// If draining doesn't finish within the deadline, we still proceed to the
// hooks (so DBs flush and telemetry exports), then exit(1) with a warning
// so an orchestrator (Docker / Kubernetes) can distinguish a clean stop
// from a timeout.

import { logger } from '../utils/logger.js';

export interface ShutdownHook {
  /** Short name surfaced in logs so the operator sees what's running. */
  name: string;
  /** Implementation. May be sync or async; a thrown / rejected error is
   *  logged and counted as a failure but does NOT abort other hooks. */
  fn: () => void | Promise<void>;
  /** Per-hook timeout in milliseconds (default 5000). Hooks that exceed
   *  this are abandoned (their promise stays in-flight) so one slow hook
   *  doesn't block the rest of shutdown. */
  timeoutMs?: number;
}

export interface ShutdownConfig {
  /** Total time we wait for in-flight tasks before running hooks anyway. */
  drainTimeoutMs?: number;
  /** Set to false to skip the actual process.exit() call — used by tests. */
  exit?: boolean;
  /** Override which signals we install handlers for. */
  signals?: NodeJS.Signals[];
}

const DEFAULT_DRAIN_TIMEOUT = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS) || 30_000;
const DEFAULT_HOOK_TIMEOUT  = 5_000;

export class GracefulShutdown {
  private hooks: ShutdownHook[] = [];
  private inFlightCounters: Array<() => number> = [];
  private shuttingDown = false;
  private installedSignals = new Set<NodeJS.Signals>();
  private drainTimeoutMs: number;

  constructor(opts: ShutdownConfig = {}) {
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT;
  }

  /** Register a teardown hook. Hooks run in registration order. */
  register(hook: ShutdownHook): void {
    this.hooks.push(hook);
  }

  /** Register a counter the drain phase polls. While any registered counter
   *  reports > 0, drain() keeps waiting (until drainTimeoutMs). */
  registerInFlightCounter(fn: () => number): void {
    this.inFlightCounters.push(fn);
  }

  isShuttingDown(): boolean { return this.shuttingDown; }

  /** Install OS signal handlers. Idempotent — repeated calls are no-ops. */
  installSignalHandlers(opts: ShutdownConfig = {}): void {
    const signals = opts.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
    for (const sig of signals) {
      if (this.installedSignals.has(sig)) continue;
      this.installedSignals.add(sig);
      process.on(sig, () => {
        logger.info(`[shutdown] received ${sig} — beginning graceful shutdown`, { signal: sig });
        this.shutdown({ signal: sig, exit: opts.exit ?? true }).catch(err =>
          logger.error('[shutdown] failed during shutdown', { err: (err as Error).message })
        );
      });
    }
  }

  /**
   * Run the full shutdown sequence:
   *   1. Mark shutting down (refuse new work)
   *   2. Drain in-flight counters (bounded by drainTimeoutMs)
   *   3. Run every registered hook in order
   *   4. exit(0) on clean stop, exit(1) on drain timeout
   */
  async shutdown(opts: { signal?: string; exit?: boolean } = {}): Promise<void> {
    if (this.shuttingDown) return; // re-entry guard
    this.shuttingDown = true;
    const startedAt = Date.now();
    let timedOut = false;

    // ─── Phase 1: drain ──────────────────────────────────────────────────
    if (this.inFlightCounters.length > 0) {
      const drainStart = Date.now();
      let outstanding = this.outstandingCount();
      logger.info('[shutdown] draining in-flight work', {
        outstanding,
        timeoutMs: this.drainTimeoutMs,
      });

      while (outstanding > 0 && (Date.now() - drainStart) < this.drainTimeoutMs) {
        await new Promise(r => setTimeout(r, 250));
        const next = this.outstandingCount();
        if (next !== outstanding) {
          logger.info('[shutdown] drain progress', { outstanding: next });
        }
        outstanding = next;
      }

      if (outstanding > 0) {
        timedOut = true;
        logger.warn('[shutdown] drain timeout — proceeding with hooks anyway', {
          outstanding,
          waitedMs: Date.now() - drainStart,
        });
      } else {
        logger.info('[shutdown] drain complete', { drainMs: Date.now() - drainStart });
      }
    }

    // ─── Phase 2: hooks ──────────────────────────────────────────────────
    let failedHooks = 0;
    for (const hook of this.hooks) {
      const hookStart = Date.now();
      const timeout = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT;
      try {
        await runWithTimeout(hook.fn(), timeout, hook.name);
        logger.info('[shutdown] hook ok', { hook: hook.name, ms: Date.now() - hookStart });
      } catch (e: any) {
        failedHooks++;
        logger.warn('[shutdown] hook failed', {
          hook: hook.name,
          ms: Date.now() - hookStart,
          err: e?.message ?? String(e),
        });
      }
    }

    const totalMs = Date.now() - startedAt;
    const exitCode = timedOut ? 1 : 0;
    logger.info('[shutdown] complete', {
      totalMs,
      drainTimedOut: timedOut,
      failedHooks,
      exitCode,
      signal: opts.signal,
    });

    if (opts.exit !== false) {
      // Small delay so log buffers can flush before exit().
      setTimeout(() => process.exit(exitCode), 50).unref?.();
    }
  }

  private outstandingCount(): number {
    let total = 0;
    for (const fn of this.inFlightCounters) {
      try { total += Math.max(0, fn() | 0); } catch { /* counter throws ⇒ ignore */ }
    }
    return total;
  }
}

/** Module-level singleton — most callers want the shared coordinator. */
export const shutdown = new GracefulShutdown();

/** Run a possibly-async function with a timeout, rejecting if it exceeds. */
async function runWithTimeout<T>(work: T | Promise<T>, ms: number, label: string): Promise<T> {
  if (!(work instanceof Promise)) return Promise.resolve(work);
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} hook timed out after ${ms}ms`)), ms).unref?.()
    ),
  ]);
}

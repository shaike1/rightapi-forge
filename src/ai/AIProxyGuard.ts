// AIProxyGuard — retry + circuit breaker for omniroute / Anthropic
// SDK calls.
//
// Why this exists:
//   * The omniroute proxy occasionally returns 429 / 5xx under load.
//     Bare callers see the request fail; a tight retry loop melts the
//     proxy further. AIProxyGuard wraps each call in:
//       1. an exponential-backoff retry (1s, 2s, 4s) for transient
//          errors (5xx, 408, 429, network);
//       2. a circuit breaker that opens after 5 consecutive failures
//          and stays open for 30s. While open we short-circuit to a
//          fallback response so the rest of the platform stays
//          responsive (chat returns a "I can't reach the AI proxy
//          right now" line instead of timing out).
//
//   * The existing CircuitBreaker class lives under src/skills/ and
//     is wired into SkillManager. Reusing it here would couple the
//     AI surface to skills — instead this module owns a thin local
//     state machine with the same semantics.
//
// Stateless wrt the calling code: any handler can wrap `await fn()`
// in `proxyGuard.run('chat', fn)` and get retry + breaker behaviour.

import { logger } from '../utils/logger.js';

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface AIProxyGuardOptions {
  /** Consecutive failures before tripping. Default 5 — matches the
   *  hardening spec. */
  failureThreshold?: number;
  /** Time the breaker stays open before allowing a probe. Default 30s. */
  openMs?: number;
  /** Max retry attempts before surrendering. Default 3 — combined
   *  with `baseDelayMs=1000` that's a worst case ~7s wall time on a
   *  fully-failing dependency. */
  maxRetries?: number;
  /** Base backoff. Doubles per attempt with full jitter. Default 1s. */
  baseDelayMs?: number;
  /** Hard cap on the per-attempt sleep so a 10th retry doesn't sleep
   *  for 10 minutes if `maxRetries` is bumped. Default 8s. */
  maxDelayMs?: number;
  /** Optional metric callback for state transitions — used by the
   *  Prometheus surface in observability/Metrics.ts. */
  onStateChange?: (state: BreakerState, reason: string) => void;
}

export class AIProxyGuard {
  private state: BreakerState = 'CLOSED';
  private failureCount = 0;
  private openedAt = 0;
  private failureThreshold: number;
  private openMs: number;
  private maxRetries: number;
  private baseDelayMs: number;
  private maxDelayMs: number;
  private onStateChange?: (state: BreakerState, reason: string) => void;

  constructor(opts: AIProxyGuardOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 5);
    // openMs floor is 1ms — tests use sub-second cool-offs to exercise
    // the HALF_OPEN path quickly. Production callers stick to seconds.
    this.openMs = Math.max(1, opts.openMs ?? 30_000);
    this.maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.baseDelayMs = Math.max(1, opts.baseDelayMs ?? 1_000);
    this.maxDelayMs = Math.max(this.baseDelayMs, opts.maxDelayMs ?? 8_000);
    this.onStateChange = opts.onStateChange;
  }

  snapshot(): { state: BreakerState; failureCount: number; openedAt: number; resetMs: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      openedAt: this.openedAt,
      resetMs: this.state === 'OPEN' ? Math.max(0, this.openMs - (Date.now() - this.openedAt)) : 0,
    };
  }

  reset(reason = 'manual reset'): void {
    this.failureCount = 0;
    this.openedAt = 0;
    this.transition('CLOSED', reason);
  }

  /** Run `fn` under the guard. When the breaker is OPEN within its
   *  cool-off window, throws AIProxyBreakerOpenError immediately so
   *  callers can fall back without waiting. When CLOSED or HALF_OPEN,
   *  applies retry-with-backoff. A successful HALF_OPEN probe closes
   *  the breaker. */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.openMs) {
        const err = new AIProxyBreakerOpenError(label, this.openMs - elapsed);
        throw err;
      }
      // Cool-off elapsed — allow one probe.
      this.transition('HALF_OPEN', `cool-off elapsed after ${elapsed}ms`);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await fn();
        this.recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt >= this.maxRetries) break;
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * Math.pow(2, attempt));
        const jittered = delay * (0.5 + Math.random() * 0.5);
        logger.warn(`[AIProxyGuard:${label}] retry`, {
          attempt: attempt + 1,
          delayMs: Math.round(jittered),
          err: errMessage(err),
        });
        await sleep(jittered);
      }
    }
    this.recordFailure(label);
    throw lastErr ?? new Error(`${label}: AI proxy call failed`);
  }

  /** Convenience: run + fall back to a synchronous canned response
   *  when the breaker is open or all retries fail. Use in chat-style
   *  paths where degraded service is preferable to a 500. */
  async runWithFallback<T>(label: string, fn: () => Promise<T>, fallback: (err: unknown) => T): Promise<T> {
    try {
      return await this.run(label, fn);
    } catch (err) {
      logger.info(`[AIProxyGuard:${label}] using fallback`, { err: errMessage(err) });
      return fallback(err);
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  private recordSuccess(): void {
    if (this.state !== 'CLOSED') {
      this.transition('CLOSED', 'probe succeeded');
    }
    this.failureCount = 0;
  }

  private recordFailure(label: string): void {
    this.failureCount += 1;
    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.transition('OPEN', `failure_count=${this.failureCount} label=${label}`);
    }
  }

  private transition(next: BreakerState, reason: string): void {
    if (this.state === next) return;
    logger.warn(`[AIProxyGuard] ${this.state} -> ${next}`, { reason });
    this.state = next;
    if (next === 'CLOSED') this.failureCount = 0;
    try { this.onStateChange?.(next, reason); } catch { /* never propagate metric errors */ }
  }
}

export class AIProxyBreakerOpenError extends Error {
  code = 'AI_PROXY_OPEN';
  constructor(public label: string, public resetMs: number) {
    super(`AI proxy breaker open for "${label}" — retry in ${Math.ceil(resetMs / 1000)}s`);
    this.name = 'AIProxyBreakerOpenError';
  }
}

/** Decides which errors are worth retrying. HTTP status hints come
 *  from the Anthropic SDK's wrapped errors (`err.status`); plain
 *  fetch errors land here via TypeError ("fetch failed") or
 *  AbortError (timeout). Auth (401/403) and validation (400) errors
 *  never retry — caller fault, not network flake. */
function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const status = (err as any)?.status ?? (err as any)?.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status === 408) return true;
    return false;
  }
  // Network-level errors (no status). TypeError("fetch failed") from
  // Node's undici, AbortError, etc.
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    if (m.includes('fetch failed') || m.includes('econnreset') || m.includes('socket hang up') || m.includes('etimedout') || m.includes('aborterror')) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Module-level singleton — wired into the AI factory + ChatBotService
 *  via dependency injection. Apps that need an isolated breaker (tests,
 *  separate AI providers) can `new AIProxyGuard(...)` themselves. */
export const aiProxyGuard = new AIProxyGuard();

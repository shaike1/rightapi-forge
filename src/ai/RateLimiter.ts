// Per-platform LLM rate limiter with retry/backoff.
//
// Caps the number of in-flight LLM calls per platform and queues the rest
// FIFO. When a call has been queued for longer than `acquireTimeoutMs` it
// rejects with a clear error rather than waiting forever — the agent's
// guardrail layer sees a normal "Error: ..." observation and can recover.
//
// Additionally wraps every chat / streamChat call with exponential-backoff
// retry on transient failures (network errors, 429, 5xx). The limiter slot
// is acquired ONCE for the entire retry sequence so retries don't queue
// behind themselves.
//
// Wraps an AIProvider so callers (Agent, SelfReflector) don't need to know
// about the limiter at all — the AIProviderFactory hands back rate-limited
// providers transparently.

import type { AIProvider, ChatParams, AIResponse } from './base.js';

export interface RateLimitConfig {
  /** Default concurrency cap for any platform without an explicit override. */
  defaultMaxConcurrent: number;
  /** Per-platform override. Use to express "Claude tier 1 = 5, OpenAI = 10". */
  perPlatform?: Record<string, number>;
  /** How long a queued request waits before rejecting with a timeout error. */
  acquireTimeoutMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  defaultMaxConcurrent: 5,
  perPlatform: {
    claude: 5,
    openai: 10,
    ollama: 4,    // local; CPU/GPU bound, lower concurrency
    moonshot: 5,
    glm: 5,
    minimax: 5,
  },
  acquireTimeoutMs: 30_000,
};

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  enqueuedAt: number;
}

interface PlatformState {
  inFlight: number;
  queue: QueueEntry[];
  /** Max concurrent calls allowed for this platform. */
  cap: number;
}

export interface RateLimiterStats {
  perPlatform: Record<string, { inFlight: number; queued: number; cap: number }>;
}

/**
 * Per-platform FIFO concurrency limiter. Acquire returns a release()
 * function the caller MUST invoke (typically in a finally) when the
 * underlying call has completed.
 */
export class RateLimiter {
  private cfg: RateLimitConfig;
  private states: Map<string, PlatformState> = new Map();

  constructor(cfg: Partial<RateLimitConfig> = {}) {
    this.cfg = {
      ...DEFAULT_RATE_LIMIT,
      ...cfg,
      perPlatform: { ...DEFAULT_RATE_LIMIT.perPlatform, ...(cfg.perPlatform || {}) },
    };
  }

  /**
   * Acquire a slot for `platform`. Resolves once a slot is free; rejects
   * after `acquireTimeoutMs` if the queue never drained.
   */
  acquire(platform: string): Promise<() => void> {
    const state = this.stateFor(platform);
    return new Promise<() => void>((resolve, reject) => {
      const onAcquired = () => {
        state.inFlight++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          state.inFlight = Math.max(0, state.inFlight - 1);
          this.drain(platform);
        });
      };

      // Fast path: a slot is available immediately.
      if (state.inFlight < state.cap) {
        onAcquired();
        return;
      }

      // Queue. Timer abandons after acquireTimeoutMs with a helpful error.
      const enqueuedAt = Date.now();
      const timer = setTimeout(() => {
        const idx = state.queue.findIndex(e => e.timer === timer);
        if (idx >= 0) state.queue.splice(idx, 1);
        const waited = Date.now() - enqueuedAt;
        reject(new Error(`LLM rate-limit acquire timeout after ${waited}ms for "${platform}" (cap=${state.cap}, queue=${state.queue.length + 1})`));
      }, this.cfg.acquireTimeoutMs);
      state.queue.push({
        resolve: onAcquired,
        reject,
        timer,
        enqueuedAt,
      });
    });
  }

  /** Release one queued waiter if there's spare capacity. */
  private drain(platform: string): void {
    const state = this.stateFor(platform);
    while (state.inFlight < state.cap && state.queue.length > 0) {
      const next = state.queue.shift()!;
      clearTimeout(next.timer);
      next.resolve();
    }
  }

  stats(): RateLimiterStats {
    const out: RateLimiterStats = { perPlatform: {} };
    for (const [platform, state] of this.states.entries()) {
      out.perPlatform[platform] = {
        inFlight: state.inFlight,
        queued: state.queue.length,
        cap: state.cap,
      };
    }
    return out;
  }

  /** Update per-platform caps at runtime (e.g. when an operator tunes them). */
  setCap(platform: string, cap: number): void {
    if (cap < 1) throw new Error(`cap must be ≥ 1 (got ${cap})`);
    const state = this.stateFor(platform);
    state.cap = cap;
    this.drain(platform);
  }

  private stateFor(platform: string): PlatformState {
    let state = this.states.get(platform);
    if (!state) {
      const cap = this.cfg.perPlatform?.[platform] ?? this.cfg.defaultMaxConcurrent;
      state = { inFlight: 0, queue: [], cap };
      this.states.set(platform, state);
    }
    return state;
  }
}

// ── Retry / backoff helpers ───────────────────────────────────────────

export interface RetryConfig {
  /** Total attempts (including the first). Default 3 = 1 initial + 2 retries. */
  maxAttempts: number;
  /** Base delay for the first backoff. Default 500ms. */
  baseDelayMs: number;
  /** Cap on per-attempt delay. Default 8s. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

const RETRYABLE = /timeout|connection|econnreset|enotfound|epipe|socket hang up|429|500|502|503|504|rate.?limit|overloaded|gateway|service unavailable|temporarily/i;

/** Heuristic: should we retry this error? Network blips + transient
 *  HTTP statuses yes; auth/argument errors no. */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  const msg = err instanceof Error ? err.message : String(err);
  return RETRYABLE.test(msg);
}

/** Exponential backoff with ±25% jitter. `attempt` is 0-indexed. */
export function backoffDelay(attempt: number, cfg: RetryConfig = DEFAULT_RETRY): number {
  const raw = Math.min(cfg.baseDelayMs * Math.pow(2, attempt), cfg.maxDelayMs);
  const jitter = raw * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Run `fn` with up to `cfg.maxAttempts` total attempts. Retries on
 * transient errors (network blips, 429, 5xx) with exponential backoff.
 * Non-retryable errors (auth, bad-request) propagate immediately on the
 * first attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  cfg: RetryConfig = DEFAULT_RETRY,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === cfg.maxAttempts - 1 || !isRetryableError(err)) throw err;
      await sleep(backoffDelay(attempt, cfg));
    }
  }
  throw lastErr;
}

/**
 * Wrap an existing AIProvider so every chat / streamChat call goes through
 * the limiter AND retries transient failures. The limiter slot is held for
 * the entire retry sequence so retries don't re-queue behind themselves.
 */
export function wrapWithRateLimit(
  inner: AIProvider,
  limiter: RateLimiter,
  platform: string,
  retry: RetryConfig = DEFAULT_RETRY,
): AIProvider {
  return {
    name: inner.name,
    initialize: () => inner.initialize(),
    isAvailable: () => inner.isAvailable(),
    chat: async (params: ChatParams): Promise<AIResponse> => {
      const release = await limiter.acquire(platform);
      try {
        return await withRetry(() => inner.chat(params), retry);
      } finally {
        release();
      }
    },
    streamChat: async (params: ChatParams, onChunk: (chunk: string) => void): Promise<AIResponse> => {
      const release = await limiter.acquire(platform);
      try {
        return await withRetry(() => inner.streamChat(params, onChunk), retry);
      } finally {
        release();
      }
    },
  };
}

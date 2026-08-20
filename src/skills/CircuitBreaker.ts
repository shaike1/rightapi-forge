// Per-skill circuit breaker.
//
// When a skill's handler fails repeatedly, opens the circuit so further calls
// short-circuit with a clear SkillResult-shaped error instead of hammering
// the failing dependency. After resetTimeMs has elapsed, the circuit
// transitions to HALF_OPEN — the next halfOpenMaxAttempts calls go through
// as test calls. If they succeed, the circuit closes; if they fail, the
// circuit re-opens with the timer reset.
//
//   CLOSED  → (failureThreshold consecutive failures) →  OPEN
//   OPEN    → (resetTimeMs elapsed)                  →  HALF_OPEN
//   HALF_OPEN ─ success ─→ CLOSED
//   HALF_OPEN ─ failure ─→ OPEN  (timer reset)
//
// SkillManager owns a CircuitBreakerRegistry, consults it before dispatching
// each skill, and reports the call outcome back. Skills themselves remain
// breaker-agnostic.

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeMs: number;
  halfOpenMaxAttempts: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeMs: 60_000,
  halfOpenMaxAttempts: 1,
};

export interface CircuitBreakerSnapshot {
  skillId: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  openedAt: string | null;
  reopensAfterMs: number; // 0 when not OPEN
  halfOpenInFlight: number;
}

interface BreakerEntry {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;   // Date.now()
  openedAt: number | null;
  halfOpenInFlight: number;
}

export class CircuitBreakerRegistry {
  private breakers: Map<string, BreakerEntry> = new Map();
  private cfg: CircuitBreakerConfig;
  private clock: () => number;

  constructor(cfg: Partial<CircuitBreakerConfig> = {}, clock: () => number = Date.now) {
    this.cfg = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...cfg };
    this.clock = clock;
  }

  /**
   * Check whether a skill is allowed to run right now.
   *   - CLOSED     → ok (no probe state change)
   *   - OPEN       → check whether reset time elapsed; if so, slip into
   *                  HALF_OPEN and allow up to halfOpenMaxAttempts probes
   *   - HALF_OPEN  → allow if a probe slot is available, otherwise reject
   */
  canRun(skillId: string): { allowed: true } | { allowed: false; reason: string; reopensAfterMs: number } {
    const e = this.entry(skillId);
    const now = this.clock();

    if (e.state === 'OPEN') {
      if (!this.advanceCooldown(e, now)) {
        const elapsed = now - (e.openedAt ?? now);
        return {
          allowed: false,
          reason: `Circuit breaker open for skill "${skillId}" — last ${e.consecutiveFailures} call(s) failed. Will retry after ${Math.ceil((this.cfg.resetTimeMs - elapsed) / 1000)}s.`,
          reopensAfterMs: this.cfg.resetTimeMs - elapsed,
        };
      }
    }

    if (e.state === 'HALF_OPEN') {
      if (e.halfOpenInFlight >= this.cfg.halfOpenMaxAttempts) {
        return {
          allowed: false,
          reason: `Circuit breaker half-open for skill "${skillId}" — ${e.halfOpenInFlight} probe call(s) already in flight, waiting for outcome.`,
          reopensAfterMs: 0,
        };
      }
      e.halfOpenInFlight++;
    }

    return { allowed: true };
  }

  /** Record a successful call — resets the failure counter and closes the
   *  circuit if it was half-open. No-op when the breaker is already healthy. */
  recordSuccess(skillId: string): void {
    const e = this.entry(skillId);
    if (e.state === 'HALF_OPEN') {
      e.state = 'CLOSED';
      e.openedAt = null;
      e.halfOpenInFlight = Math.max(0, e.halfOpenInFlight - 1);
    }
    e.consecutiveFailures = 0;
    e.lastFailureAt = null;
  }

  /** Record a failed call — bump the counter; trip the breaker if at threshold. */
  recordFailure(skillId: string): void {
    const e = this.entry(skillId);
    const now = this.clock();
    e.consecutiveFailures++;
    e.lastFailureAt = now;

    if (e.state === 'HALF_OPEN') {
      // Probe failed → re-open the breaker with timer reset.
      e.state = 'OPEN';
      e.openedAt = now;
      e.halfOpenInFlight = 0;
      return;
    }
    if (e.state === 'CLOSED' && e.consecutiveFailures >= this.cfg.failureThreshold) {
      e.state = 'OPEN';
      e.openedAt = now;
      e.halfOpenInFlight = 0;
    }
  }

  /** Public read-only view, for /api/agents/.../circuit-breakers UI etc. */
  getState(skillId: string): CircuitBreakerSnapshot {
    const e = this.entry(skillId);
    const now = this.clock();
    // Observation must reflect an elapsed cooldown even when the skill is
    // idle. This only makes the breaker probe-ready; a real successful call
    // is still required to close it.
    this.advanceCooldown(e, now);
    return {
      skillId,
      state: e.state,
      consecutiveFailures: e.consecutiveFailures,
      lastFailureAt: e.lastFailureAt ? new Date(e.lastFailureAt).toISOString() : null,
      openedAt: e.openedAt ? new Date(e.openedAt).toISOString() : null,
      reopensAfterMs: e.state === 'OPEN' && e.openedAt
        ? Math.max(0, this.cfg.resetTimeMs - (now - e.openedAt))
        : 0,
      halfOpenInFlight: e.halfOpenInFlight,
    };
  }

  /** All breakers that have non-default state — useful for dashboards. */
  listActive(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.keys())
      .map(id => this.getState(id))
      .filter(s => s.state !== 'CLOSED' || s.consecutiveFailures > 0);
  }

  /** Reset a single breaker back to CLOSED — for manual operator override. */
  reset(skillId: string): void {
    this.breakers.set(skillId, {
      state: 'CLOSED',
      consecutiveFailures: 0,
      lastFailureAt: null,
      openedAt: null,
      halfOpenInFlight: 0,
    });
  }

  /** Reset every tracked breaker. */
  resetAll(): void {
    this.breakers.clear();
  }

  private entry(skillId: string): BreakerEntry {
    let e = this.breakers.get(skillId);
    if (!e) {
      e = {
        state: 'CLOSED',
        consecutiveFailures: 0,
        lastFailureAt: null,
        openedAt: null,
        halfOpenInFlight: 0,
      };
      this.breakers.set(skillId, e);
    }
    return e;
  }

  private advanceCooldown(e: BreakerEntry, now: number): boolean {
    if (e.state !== 'OPEN') return e.state === 'HALF_OPEN';
    const elapsed = now - (e.openedAt ?? now);
    if (elapsed < this.cfg.resetTimeMs) return false;
    e.state = 'HALF_OPEN';
    e.halfOpenInFlight = 0;
    return true;
  }
}

// Per-task guardrails: token budget, wall-clock timeout, tool-call cap,
// iteration cap, delegation depth, concurrency, and an optional USD budget.
//
// The Agent loop builds a GuardrailRunner at the start of each task,
// feeds it events (LLM calls, tool calls, iterations) as they happen, and
// asks it `check()` before every iteration. When a limit trips, the loop
// stops cleanly, returns a partial result with `limitReached: true`, and
// the reason flows up to the caller — never silently drops work.
//
// Concurrency is enforced via a per-agent counter the Agent layer
// increments/decrements around executeTaskDetailed.

import type { AgentRole } from '../types/index.js';

export interface GuardrailConfig {
  /** Max ReAct iterations (action turns) per task. */
  maxIterations: number;
  /** Combined input+output LLM tokens per task. Tracked from provider.usage
   *  when available, otherwise estimated from message length. */
  maxTokensPerTask: number;
  /** Wall-clock timeout in milliseconds. The loop also injects an
   *  "URGENT: time almost up" hint into the next prompt when <10 % remains. */
  maxDurationMs: number;
  /** Total tool invocations allowed across all iterations of a task. */
  maxToolCallsPerTask: number;
  /** Maximum delegation chain depth (DelegationSkill enforces, this is the
   *  centralised setting that overrides DelegationSkill.MAX_DEPTH per agent). */
  maxDelegationDepth: number;
  /** Per-agent concurrent task limit. The Agent layer counts active tasks. */
  maxConcurrentTasks: number;
  /** Optional USD budget per task. Computed by feeding tokens through a
   *  per-platform $/1k-token rate. Hit before maxTokensPerTask if rates
   *  are configured tightly. */
  costBudgetUsd?: number;
}

/**
 * Sensible defaults per agent role. SysAdmins handle real production work
 * and need more headroom; Specialists do focused investigation and benefit
 * from tighter caps; the Director plans rather than executes and rarely
 * needs many iterations.
 */
export const DEFAULT_GUARDRAILS: Record<AgentRole, GuardrailConfig> = {
  director: {
    maxIterations: 8,
    maxTokensPerTask: 30_000,
    maxDurationMs: 5 * 60_000,
    maxToolCallsPerTask: 20,
    maxDelegationDepth: 3,
    maxConcurrentTasks: 5,
  },
  sysadmin: {
    maxIterations: 15,
    maxTokensPerTask: 60_000,
    maxDurationMs: 10 * 60_000,
    maxToolCallsPerTask: 40,
    maxDelegationDepth: 3,
    maxConcurrentTasks: 3,
  },
  specialist: {
    maxIterations: 10,
    maxTokensPerTask: 40_000,
    maxDurationMs: 7 * 60_000,
    maxToolCallsPerTask: 25,
    maxDelegationDepth: 2,
    maxConcurrentTasks: 2,
  },
  manager: {
    maxIterations: 8,
    maxTokensPerTask: 25_000,
    maxDurationMs: 5 * 60_000,
    maxToolCallsPerTask: 15,
    maxDelegationDepth: 3,
    maxConcurrentTasks: 4,
  },
  individual: {
    maxIterations: 8,
    maxTokensPerTask: 20_000,
    maxDurationMs: 5 * 60_000,
    maxToolCallsPerTask: 15,
    maxDelegationDepth: 2,
    maxConcurrentTasks: 2,
  },
};

/** Approximate USD/1k-token rate per AI platform. Override via env at startup
 *  if you want exact billing — these are only for the cost-budget check. */
const COST_PER_1K_TOKENS_USD: Record<string, number> = {
  claude:   0.015,  // Sonnet-level blended in/out estimate
  openai:   0.010,
  glm:      0.002,
  moonshot: 0.005,
  minimax:  0.003,
  ollama:   0,      // local
};

export type LimitType =
  | 'iterations'
  | 'tokens'
  | 'duration'
  | 'tool_calls'
  | 'delegation_depth'
  | 'concurrent_tasks'
  | 'cost_budget';

export interface GuardrailVerdict {
  ok: boolean;
  /** Set when ok=false. Names the specific limit that fired. */
  limitType?: LimitType;
  /** Human-readable explanation, suitable for logging or returning to the agent. */
  reason?: string;
}

/**
 * Resolve the effective guardrail config for an agent: defaults for the role,
 * overlaid with whatever overrides the agent config supplied. Missing fields
 * fall through to the role default.
 */
export function resolveGuardrails(
  role: AgentRole,
  overrides?: Partial<GuardrailConfig>
): GuardrailConfig {
  const base = DEFAULT_GUARDRAILS[role] ?? DEFAULT_GUARDRAILS.individual;
  return { ...base, ...(overrides || {}) };
}

/** Track tokens, tool calls, iterations, and elapsed time for one task run. */
export class GuardrailRunner {
  private readonly cfg: GuardrailConfig;
  private readonly aiPlatform: string;
  private readonly startedAt: number;
  private iterations = 0;
  private toolCalls = 0;
  private totalTokens = 0;

  constructor(cfg: GuardrailConfig, aiPlatform: string = 'unknown') {
    this.cfg = cfg;
    this.aiPlatform = aiPlatform;
    this.startedAt = Date.now();
  }

  /** Snapshot of current usage — useful for the partial-result payload. */
  snapshot(): {
    iterations: number;
    toolCalls: number;
    totalTokens: number;
    elapsedMs: number;
    estimatedCostUsd: number;
  } {
    return {
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      totalTokens: this.totalTokens,
      elapsedMs: Date.now() - this.startedAt,
      estimatedCostUsd: this.estimatedCost(),
    };
  }

  recordIteration(): void { this.iterations++; }
  recordToolCall(): void { this.toolCalls++; }
  recordTokens(input: number, output: number): void {
    if (Number.isFinite(input)) this.totalTokens += Math.max(0, input);
    if (Number.isFinite(output)) this.totalTokens += Math.max(0, output);
  }
  /** Estimate tokens from raw text length when the provider didn't report
   *  usage. Conservative ~4 chars / token. */
  recordTokensFromText(input: string, output: string): void {
    this.recordTokens(approxTokens(input), approxTokens(output));
  }

  remainingTimeMs(): number {
    return Math.max(0, this.cfg.maxDurationMs - (Date.now() - this.startedAt));
  }
  remainingIterations(): number {
    return Math.max(0, this.cfg.maxIterations - this.iterations);
  }
  /** True when <10 % of the time budget remains (and at least 1s left). */
  isTimeAlmostUp(): boolean {
    const remaining = this.remainingTimeMs();
    return remaining > 0 && remaining < this.cfg.maxDurationMs * 0.1;
  }

  /** Snapshot urgency hint to inject into the next ReAct prompt. */
  urgencyHint(): string | null {
    if (!this.isTimeAlmostUp()) return null;
    const seconds = Math.max(1, Math.round(this.remainingTimeMs() / 1000));
    return `URGENT: you have about ${seconds}s left before this task is force-stopped. Wrap up and emit Final Answer now.`;
  }

  /**
   * Verify all limits. Called BEFORE each ReAct iteration so the loop can
   * stop cleanly with a known reason rather than overrun.
   */
  check(): GuardrailVerdict {
    if (this.iterations >= this.cfg.maxIterations) {
      return { ok: false, limitType: 'iterations',
        reason: `iteration cap (${this.cfg.maxIterations}) reached` };
    }
    if (this.toolCalls >= this.cfg.maxToolCallsPerTask) {
      return { ok: false, limitType: 'tool_calls',
        reason: `tool-call cap (${this.cfg.maxToolCallsPerTask}) reached after ${this.toolCalls} calls` };
    }
    if (this.totalTokens >= this.cfg.maxTokensPerTask) {
      return { ok: false, limitType: 'tokens',
        reason: `token budget (${this.cfg.maxTokensPerTask}) reached at ${this.totalTokens}` };
    }
    if (this.remainingTimeMs() === 0) {
      return { ok: false, limitType: 'duration',
        reason: `duration cap (${this.cfg.maxDurationMs}ms) elapsed` };
    }
    if (typeof this.cfg.costBudgetUsd === 'number' && this.estimatedCost() >= this.cfg.costBudgetUsd) {
      return { ok: false, limitType: 'cost_budget',
        reason: `cost budget ($${this.cfg.costBudgetUsd.toFixed(4)}) reached at $${this.estimatedCost().toFixed(4)}` };
    }
    return { ok: true };
  }

  private estimatedCost(): number {
    const rate = COST_PER_1K_TOKENS_USD[this.aiPlatform] ?? 0.01;
    return (this.totalTokens / 1000) * rate;
  }
}

/**
 * Per-agent concurrency counter. The Agent layer increments before starting
 * a task, decrements (in finally) after. Refused starts produce a clear
 * verdict the caller can surface. Independent of GuardrailRunner because
 * it's enforced before the runner is even constructed.
 */
export class ConcurrencyLimiter {
  private active: Map<string, number> = new Map();

  /** Try to start a new task for `agentId`. Returns ok=true on success, with
   *  a release() function the caller MUST invoke when the task finishes. */
  acquire(agentId: string, max: number): { ok: true; release: () => void } | GuardrailVerdict {
    const current = this.active.get(agentId) ?? 0;
    if (current >= max) {
      return {
        ok: false,
        limitType: 'concurrent_tasks',
        reason: `agent already running ${current}/${max} tasks`,
      };
    }
    this.active.set(agentId, current + 1);
    return {
      ok: true,
      release: () => {
        const next = (this.active.get(agentId) ?? 1) - 1;
        if (next <= 0) this.active.delete(agentId);
        else this.active.set(agentId, next);
      },
    };
  }

  active_count(agentId: string): number {
    return this.active.get(agentId) ?? 0;
  }
}

function approxTokens(s: string): number {
  if (!s) return 0;
  // Rough heuristic: 4 characters ≈ 1 token. Close enough for guardrails;
  // exact billing should come from provider.usage when available.
  return Math.ceil(s.length / 4);
}

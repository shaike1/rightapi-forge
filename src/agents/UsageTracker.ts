// Per-agent daily usage counters.
//
// The Agent layer pushes ExecuteTaskResult.usage into the tracker after each
// task. The tracker rolls counters at midnight (local TZ) and exposes
// daily/weekly aggregates plus a "blocked?" gate the loop can consult before
// starting a new task. An optional 80%-of-budget warning threshold logs a
// notice when the agent is approaching its daily token cap.
//
// Storage is in-memory by default; an optional file path persists today's
// counters across restarts (reads existing file at startup, writes after
// every recordTask). History older than 14 days is purged.

import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface DailyUsageRecord {
  /** YYYY-MM-DD */
  date: string;
  agentId: string;
  totalTokens: number;
  totalToolCalls: number;
  totalTasks: number;
  estimatedCostUsd: number;
}

export interface UsageBudget {
  /** Daily token cap. Hitting 100 % blocks new tasks until reset. */
  dailyTokens: number;
  /** Optional cost cap. If both are set, whichever fires first wins. */
  dailyCostUsd?: number;
  /** When dailyTokens passes this fraction (0..1), log a warning. Default 0.8. */
  warnAtFraction?: number;
  /** When true, midnight local-time crossings auto-reset the day's counter.
   *  False ⇒ counter accumulates indefinitely until reset() is called. */
  autoResetDaily?: boolean;
}

export interface UsageGate {
  allowed: boolean;
  reason?: string;
  remainingTokens: number;
  remainingCostUsd: number;
  todayTokens: number;
  todayTasks: number;
  todayCostUsd: number;
}

const DEFAULT_WARN_FRACTION = 0.8;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // UTC; consistent with logger timestamps
}

export class UsageTracker {
  /** agentId → date → record */
  private byAgent: Map<string, Map<string, DailyUsageRecord>> = new Map();
  /** agentId → budget */
  private budgets: Map<string, UsageBudget> = new Map();
  /** agentId → set of dates we've already warned for, so we only log once. */
  private warned: Map<string, Set<string>> = new Map();
  private readonly persistPath: string | null;

  constructor(opts: { persistPath?: string } = {}) {
    this.persistPath = opts.persistPath ?? null;
    if (this.persistPath) this.load();
  }

  /** Set or replace the daily budget for an agent. */
  setBudget(agentId: string, budget: UsageBudget): void {
    this.budgets.set(agentId, { warnAtFraction: DEFAULT_WARN_FRACTION, autoResetDaily: true, ...budget });
  }

  getBudget(agentId: string): UsageBudget | undefined {
    return this.budgets.get(agentId);
  }

  /** Record one completed task's usage into today's counter. */
  recordTask(agentId: string, usage: { totalTokens: number; toolCalls: number; estimatedCostUsd: number }): DailyUsageRecord {
    const date = todayKey();
    const record = this.entry(agentId, date);
    record.totalTokens += Math.max(0, usage.totalTokens || 0);
    record.totalToolCalls += Math.max(0, usage.toolCalls || 0);
    record.totalTasks += 1;
    record.estimatedCostUsd += Math.max(0, usage.estimatedCostUsd || 0);

    this.maybeWarn(agentId, record);
    this.save();
    return { ...record };
  }

  /**
   * Inspect the gate before starting a new task. Returns allowed=false with
   * a reason when the agent has already burned its daily budget.
   */
  checkGate(agentId: string): UsageGate {
    const date = todayKey();
    const record = this.byAgent.get(agentId)?.get(date);
    const today = record ?? this.emptyRecord(agentId, date);
    const budget = this.budgets.get(agentId);

    if (!budget) {
      return {
        allowed: true,
        remainingTokens: Number.POSITIVE_INFINITY,
        remainingCostUsd: Number.POSITIVE_INFINITY,
        todayTokens: today.totalTokens,
        todayTasks: today.totalTasks,
        todayCostUsd: today.estimatedCostUsd,
      };
    }

    const remainingTokens = Math.max(0, budget.dailyTokens - today.totalTokens);
    const remainingCostUsd = budget.dailyCostUsd
      ? Math.max(0, budget.dailyCostUsd - today.estimatedCostUsd)
      : Number.POSITIVE_INFINITY;

    if (remainingTokens === 0) {
      return {
        allowed: false,
        reason: `daily token budget exhausted (${today.totalTokens}/${budget.dailyTokens}) — reset at next midnight UTC`,
        remainingTokens, remainingCostUsd,
        todayTokens: today.totalTokens, todayTasks: today.totalTasks, todayCostUsd: today.estimatedCostUsd,
      };
    }
    if (budget.dailyCostUsd && remainingCostUsd === 0) {
      return {
        allowed: false,
        reason: `daily cost budget exhausted ($${today.estimatedCostUsd.toFixed(4)}/$${budget.dailyCostUsd.toFixed(4)})`,
        remainingTokens, remainingCostUsd,
        todayTokens: today.totalTokens, todayTasks: today.totalTasks, todayCostUsd: today.estimatedCostUsd,
      };
    }

    return {
      allowed: true,
      remainingTokens, remainingCostUsd,
      todayTokens: today.totalTokens, todayTasks: today.totalTasks, todayCostUsd: today.estimatedCostUsd,
    };
  }

  /** Today's cumulative record. Empty record returned when nothing logged yet. */
  getToday(agentId: string): DailyUsageRecord {
    const date = todayKey();
    return { ...(this.byAgent.get(agentId)?.get(date) ?? this.emptyRecord(agentId, date)) };
  }

  /** Last 7 days of records, newest first. Days with no activity are omitted. */
  getWeek(agentId: string): DailyUsageRecord[] {
    const map = this.byAgent.get(agentId);
    if (!map) return [];
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return Array.from(map.values())
      .filter(r => r.date >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Aggregated weekly totals derived from getWeek. */
  getWeekSummary(agentId: string): { totalTokens: number; totalToolCalls: number; totalTasks: number; estimatedCostUsd: number; days: number } {
    const wk = this.getWeek(agentId);
    return {
      totalTokens: wk.reduce((n, r) => n + r.totalTokens, 0),
      totalToolCalls: wk.reduce((n, r) => n + r.totalToolCalls, 0),
      totalTasks: wk.reduce((n, r) => n + r.totalTasks, 0),
      estimatedCostUsd: wk.reduce((n, r) => n + r.estimatedCostUsd, 0),
      days: wk.length,
    };
  }

  /** Force-reset today's counter (operator override). */
  resetToday(agentId: string): void {
    const map = this.byAgent.get(agentId);
    if (!map) return;
    map.delete(todayKey());
    this.warned.get(agentId)?.delete(todayKey());
    this.save();
  }

  /** Drop everything for an agent. */
  resetAll(agentId: string): void {
    this.byAgent.delete(agentId);
    this.warned.delete(agentId);
    this.save();
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private entry(agentId: string, date: string): DailyUsageRecord {
    let map = this.byAgent.get(agentId);
    if (!map) {
      map = new Map();
      this.byAgent.set(agentId, map);
    }
    let r = map.get(date);
    if (!r) {
      r = this.emptyRecord(agentId, date);
      map.set(date, r);
    }
    return r;
  }

  private emptyRecord(agentId: string, date: string): DailyUsageRecord {
    return { agentId, date, totalTokens: 0, totalToolCalls: 0, totalTasks: 0, estimatedCostUsd: 0 };
  }

  private maybeWarn(agentId: string, record: DailyUsageRecord): void {
    const budget = this.budgets.get(agentId);
    if (!budget) return;
    const fraction = budget.warnAtFraction ?? DEFAULT_WARN_FRACTION;
    if (record.totalTokens >= budget.dailyTokens * fraction) {
      let warned = this.warned.get(agentId);
      if (!warned) {
        warned = new Set();
        this.warned.set(agentId, warned);
      }
      if (!warned.has(record.date)) {
        warned.add(record.date);
        logger.warn(`[UsageTracker] ${agentId} crossed ${(fraction * 100).toFixed(0)}% of daily token budget`, {
          agentId,
          tokens: record.totalTokens,
          cap: budget.dailyTokens,
          date: record.date,
        });
      }
    }
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as { records: DailyUsageRecord[] };
      const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (const r of data.records || []) {
        if (r.date < cutoff) continue;
        this.entry(r.agentId, r.date);
        const live = this.byAgent.get(r.agentId)!.get(r.date)!;
        live.totalTokens = r.totalTokens;
        live.totalToolCalls = r.totalToolCalls;
        live.totalTasks = r.totalTasks;
        live.estimatedCostUsd = r.estimatedCostUsd;
      }
    } catch (e) {
      logger.warn('[UsageTracker] failed to load usage file', { err: (e as Error).message });
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const records: DailyUsageRecord[] = [];
      for (const map of this.byAgent.values()) {
        for (const r of map.values()) records.push(r);
      }
      fs.writeFileSync(this.persistPath, JSON.stringify({ version: 1, records }, null, 2), 'utf8');
    } catch (e) {
      logger.warn('[UsageTracker] failed to save usage file', { err: (e as Error).message });
    }
  }
}

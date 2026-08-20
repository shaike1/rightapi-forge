// Rollback registry — tracks reversible state-changing actions skills perform
// during a task so the loop (or a human operator) can undo them on failure.
//
// Skills register entries through SkillExecutionContext.registerRollback(...)
// — the registry itself is a per-task object held by the Agent layer. After
// the task completes, list() / executeAll() let agents inspect or execute the
// stack in reverse order, the same shape the RollbackSkill exposes via
// rollback.list / rollback.execute / rollback.clear commands.

import type { SkillManager } from '../skills/SkillManager.js';

export interface RollbackAction {
  /** Stable id assigned at registration time. */
  id: string;
  taskId: string;
  agentId: string;
  /** Human-readable description of what was done — appears in the dashboard
   *  and in any "would you like to roll back?" prompt. */
  action: string;
  /** Skill / command to invoke to undo the action. Either a tool name the
   *  SkillManager can dispatch ({tool, params}) OR a free-form bash command
   *  string (executed via bash.exec when run). */
  rollback:
    | { kind: 'tool'; tool: string; params?: Record<string, unknown>; description?: string }
    | { kind: 'bash'; command: string };
  /** Skill that registered the action — used for filtering / audit. */
  skill: string;
  timestamp: string;
  /** Set true once executeAction has run for this entry. */
  executed: boolean;
  executedAt?: string;
  executionResult?: string;
  executionError?: string;
}

/** Public-facing entry shape (no functions, suitable for JSON.stringify). */
export type RollbackEntry = Omit<RollbackAction, 'id'> & { id: string };

/**
 * Per-task rollback registry. The Agent layer creates one of these per task
 * run and exposes it through SkillExecutionContext.registerRollback so any
 * skill that performs reversible work can record an undo recipe.
 */
export class RollbackRegistry {
  private actions: RollbackAction[] = [];

  /** Register a reversible action. Returns the assigned id. */
  register(input: Omit<RollbackAction, 'id' | 'timestamp' | 'executed'>): string {
    const id = `rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.actions.push({
      id,
      ...input,
      timestamp: new Date().toISOString(),
      executed: false,
    });
    return id;
  }

  /** All registered actions in registration order, most-recent last. */
  list(filter?: { taskId?: string; agentId?: string; skill?: string; executed?: boolean }): RollbackAction[] {
    return this.actions.filter(a => {
      if (filter?.taskId && a.taskId !== filter.taskId) return false;
      if (filter?.agentId && a.agentId !== filter.agentId) return false;
      if (filter?.skill && a.skill !== filter.skill) return false;
      if (typeof filter?.executed === 'boolean' && a.executed !== filter.executed) return false;
      return true;
    });
  }

  get(id: string): RollbackAction | undefined {
    return this.actions.find(a => a.id === id);
  }

  /**
   * Execute one rollback entry. Marks it as executed regardless of outcome
   * (we don't want to re-attempt a half-broken undo automatically). The
   * caller-provided skillManager is consulted for both the 'tool' and
   * 'bash' shapes; the latter is dispatched via bash.exec.
   */
  async executeAction(id: string, skillManager: SkillManager): Promise<{ ok: boolean; result?: string; error?: string }> {
    const a = this.actions.find(x => x.id === id);
    if (!a) return { ok: false, error: `rollback ${id} not found` };
    if (a.executed) return { ok: false, error: `rollback ${id} already executed at ${a.executedAt}` };

    let outcome: { ok: boolean; result?: string; error?: string };
    try {
      const observation = a.rollback.kind === 'bash'
        ? await skillManager.execute('bash.exec', { command: a.rollback.command })
        : await skillManager.execute(a.rollback.tool, a.rollback.params ?? {});

      // Try to detect failure inside a SkillResult; treat any non-ok as error.
      let parsedFailed = false;
      try {
        const parsed = JSON.parse(observation);
        if (parsed && typeof parsed.ok === 'boolean' && !parsed.ok) {
          parsedFailed = true;
          outcome = { ok: false, error: parsed.error || parsed.summary || 'rollback handler returned ok=false', result: observation };
        }
      } catch { /* non-JSON return → treat as success */ }
      if (!parsedFailed) {
        outcome = { ok: true, result: observation };
      } else {
        outcome = outcome!;
      }
    } catch (e: any) {
      outcome = { ok: false, error: e?.message ?? String(e) };
    }

    a.executed = true;
    a.executedAt = new Date().toISOString();
    a.executionResult = outcome.result;
    a.executionError = outcome.error;
    return outcome;
  }

  /**
   * Execute every un-executed rollback in REVERSE registration order — the
   * conventional way to undo a sequence of state changes. Stops on the first
   * failure unless `continueOnError` is true.
   */
  async executeAll(
    skillManager: SkillManager,
    opts: { continueOnError?: boolean } = {}
  ): Promise<{ executed: number; failed: number; results: Array<{ id: string; ok: boolean; error?: string }> }> {
    const pending = this.list({ executed: false }).slice().reverse();
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    let executed = 0;
    let failed = 0;

    for (const a of pending) {
      const r = await this.executeAction(a.id, skillManager);
      results.push({ id: a.id, ok: r.ok, error: r.error });
      executed++;
      if (!r.ok) {
        failed++;
        if (!opts.continueOnError) break;
      }
    }

    return { executed, failed, results };
  }

  /** Drop all entries (e.g. on successful task completion when undo is irrelevant). */
  clear(): void {
    this.actions.length = 0;
  }

  size(): number { return this.actions.length; }
  pendingCount(): number { return this.list({ executed: false }).length; }
}

/** Helper a SkillExecutionContext can expose to skills as registerRollback. */
export type RegisterRollbackFn = (
  input: Omit<RollbackAction, 'id' | 'timestamp' | 'executed'>
) => string;

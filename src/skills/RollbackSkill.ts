// RollbackSkill — surfaces a task's reversible-action stack to agents and
// operators. Three commands:
//
//   • rollback.list     — list registered actions for a taskId (or all
//                         active registries when no taskId given)
//   • rollback.execute  — execute one action by id, or all (in reverse) for
//                         a taskId
//   • rollback.clear    — drop the registry for a taskId without running it
//
// The skill resolves the per-task registry through Agent.activeRollbackRegistries
// (populated by Agent.executeTaskDetailed when it finishes with non-zero
// entries). Agents typically use this in a follow-up task after a failure;
// the dashboard can also call it directly via the SkillManager.

import type { Skill } from '../types/index.js';
import type { SkillManager } from './SkillManager.js';
import { Agent } from '../agents/Agent.js';
import { encode, ok, fail } from './SkillResult.js';

export class RollbackSkill {
  private skillManager: SkillManager | null = null;

  setSkillManager(sm: SkillManager): void { this.skillManager = sm; }

  getSkill(): Skill {
    return {
      id: 'rollback',
      name: 'Rollback Manager',
      description: 'List or execute reversible-action recipes that previous tasks recorded. Lets agents undo state changes after a failed run.',
      category: 'service-management',
      enabled: true,
      commands: [
        {
          name: 'rollback.list',
          description: 'List registered rollback actions. Pass { taskId } to filter to a single task; otherwise lists all active task registries.',
          handler: 'rollbackList',
          parameters: { taskId: 'string?', pendingOnly: 'boolean?' }
        },
        {
          name: 'rollback.execute',
          description: 'Execute a registered rollback. Pass { id } to run one specific action, OR { taskId } to run every pending action of that task in reverse order. Pass { continueOnError: true } to keep going past failures.',
          handler: 'rollbackExecute',
          parameters: { id: 'string?', taskId: 'string?', continueOnError: 'boolean?' }
        },
        {
          name: 'rollback.clear',
          description: 'Forget a task\'s rollback registry without executing it (e.g. after a clean post-failure recovery handled out-of-band).',
          handler: 'rollbackClear',
          parameters: { taskId: 'string' }
        },
      ]
    };
  }

  async rollbackList(params: { taskId?: string; pendingOnly?: boolean }): Promise<string> {
    const filterPending = !!params?.pendingOnly;

    if (params?.taskId) {
      const reg = Agent.activeRollbackRegistries.get(params.taskId);
      if (!reg) {
        return encode(ok({ taskId: params.taskId, actions: [], total: 0 }, `no registry for task ${params.taskId}`));
      }
      const actions = reg.list(filterPending ? { executed: false } : undefined);
      return encode(ok({ taskId: params.taskId, actions, total: actions.length }, `${actions.length} rollback action(s) for ${params.taskId}`));
    }

    // No taskId → enumerate every known registry.
    const all: Array<{ taskId: string; pending: number; total: number; actions?: unknown[] }> = [];
    let totalActions = 0;
    for (const [taskId, reg] of Agent.activeRollbackRegistries.entries()) {
      const pending = reg.pendingCount();
      const total = reg.size();
      totalActions += total;
      all.push({ taskId, pending, total });
    }
    return encode(ok({ registries: all, totalRegistries: all.length, totalActions }, `${all.length} task registry/registries, ${totalActions} rollback action(s)`));
  }

  async rollbackExecute(params: { id?: string; taskId?: string; continueOnError?: boolean }): Promise<string> {
    if (!this.skillManager) {
      return encode(fail('rollback skill manager not configured', 'unconfigured'));
    }

    if (params?.id && params?.taskId) {
      const reg = Agent.activeRollbackRegistries.get(params.taskId);
      if (!reg) return encode(fail(`no registry for task ${params.taskId}`, 'not found'));
      const out = await reg.executeAction(params.id, this.skillManager);
      return encode(out.ok
        ? ok({ id: params.id, taskId: params.taskId, result: out.result }, `rolled back ${params.id}`)
        : fail(out.error || 'rollback failed', `${params.id} failed`));
    }

    if (params?.id && !params?.taskId) {
      // Search every registry for the id.
      for (const [taskId, reg] of Agent.activeRollbackRegistries.entries()) {
        if (reg.get(params.id)) {
          const out = await reg.executeAction(params.id, this.skillManager);
          return encode(out.ok
            ? ok({ id: params.id, taskId, result: out.result }, `rolled back ${params.id}`)
            : fail(out.error || 'rollback failed', `${params.id} failed`));
        }
      }
      return encode(fail(`rollback action ${params.id} not found in any active registry`, 'not found'));
    }

    if (params?.taskId) {
      const reg = Agent.activeRollbackRegistries.get(params.taskId);
      if (!reg) return encode(fail(`no registry for task ${params.taskId}`, 'not found'));
      const out = await reg.executeAll(this.skillManager, { continueOnError: !!params.continueOnError });
      return encode(out.failed === 0
        ? ok({ taskId: params.taskId, ...out }, `executed ${out.executed} rollback(s)`)
        : fail(`${out.failed} of ${out.executed} rollback(s) failed`, `${out.executed} attempted, ${out.failed} failed`));
    }

    return encode(fail('rollback.execute requires { id } or { taskId }'));
  }

  async rollbackClear(params: { taskId: string }): Promise<string> {
    if (!params?.taskId) return encode(fail('rollback.clear requires { taskId }'));
    const existed = Agent.activeRollbackRegistries.delete(params.taskId);
    return encode(ok({ taskId: params.taskId, cleared: existed }, existed ? `cleared registry for ${params.taskId}` : `no registry for ${params.taskId}`));
  }
}

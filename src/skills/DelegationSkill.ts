// Agent-to-agent delegation skill.
//
// Lets an agent mid-ReAct hand a sub-task off to another agent and wait for
// the answer. The target agent runs its own observe→reason→act loop with the
// sub-task injected into its prompt, and DelegationSkill returns its Final
// Answer back to the calling agent as a regular Observation.
//
// The skill enforces a recursion depth cap (DelegationSkill.MAX_DEPTH) so a
// chain like alice → eve → bob → alice can't loop forever. Depth is threaded
// from each Agent.executeTaskDetailed call into SkillManager.execute as a
// SkillExecutionContext field; this skill reads that context, refuses to run
// at the cap, and increments the depth when invoking the target agent.

import { v4 as uuidv4 } from 'uuid';
import type { Skill, Task } from '../types/index.js';
import type { Agent, ExecuteTaskResult } from '../agents/Agent.js';
import type { SkillManager, SkillExecutionContext } from './SkillManager.js';
import { encode, ok, fail } from './SkillResult.js';
import { withSpan, SpanKind } from '../observability/Telemetry.js';

/**
 * Minimal contract DelegationSkill needs to find target agents. Both
 * OrganizationManager and any custom registry can satisfy this — kept abstract
 * so this skill doesn't depend on a specific org implementation.
 */
export interface AgentFinder {
  getAllAgents(): Agent[];
  getAgent?(id: string): Agent | undefined;
  getAgentsByRole?(role: string): Agent[];
}

/**
 * Optional audit hook. AgentMessageBus implements this; supplying it gives a
 * persistent record of who delegated what to whom and how it ended.
 */
export interface DelegationAuditor {
  delegateTask(input: {
    requesterAgentId: string;
    requesterAgentName?: string;
    assigneeAgentId: string;
    assigneeAgentName?: string;
    parentTaskId?: string;
    objective: string;
    context?: string;
  }): { id: string };
  recordDelegationResult(id: string, result: {
    state: 'completed' | 'rejected';
    childTaskId?: string;
    summary?: string;
    error?: string;
    durationMs?: number;
  }): void;
}

/**
 * Optional router. If set, `delegate.ask` without a targetAgent (or with a
 * role/skill hint) consults the router to pick the best fit.
 */
export interface DelegationRouter {
  pickAgent(
    task: { task: string; role?: string; skill?: string },
    candidates: Agent[]
  ): { agent: Agent; reason: string } | null;
}

export class DelegationSkill {
  /** Hard cap on chained delegation hops to prevent runaway recursion. */
  static readonly MAX_DEPTH = 3;

  private finder: AgentFinder | null = null;
  private skillManager: SkillManager | null = null;
  private auditor: DelegationAuditor | null = null;
  private router: DelegationRouter | null = null;

  /** Track active task counts per agent so smart routing can prefer idle ones. */
  private activeTaskCount: Map<string, number> = new Map();

  setFinder(finder: AgentFinder): void { this.finder = finder; }
  setSkillManager(sm: SkillManager): void { this.skillManager = sm; }
  setAuditor(a: DelegationAuditor): void { this.auditor = a; }
  setRouter(r: DelegationRouter): void { this.router = r; }

  /** Active-task counter exposed for smart routing helpers. */
  getActiveTaskCount(agentId: string): number {
    return this.activeTaskCount.get(agentId) ?? 0;
  }

  getSkill(): Skill {
    return {
      id: 'delegation',
      name: 'Agent-to-Agent Delegation',
      description: 'Delegate a sub-task to another agent and wait for their answer. Use when the current agent lacks the skill or context to make progress alone.',
      category: 'service-management',
      enabled: true,
      commands: [
        {
          name: 'delegate.ask',
          description: 'Hand a sub-task to a single agent (by name, id, or role) and wait for their final answer. Returns { answer, agent, durationMs, toolsUsed }.',
          handler: 'delegateAsk',
          parameters: { targetAgent: 'string', task: 'string', context: 'string?', timeout: 'number?' }
        },
        {
          name: 'delegate.broadcast',
          description: 'Ask the same sub-task of every agent matching a role or skill, in parallel. Returns one entry per agent with their answer or error.',
          handler: 'delegateBroadcast',
          parameters: { role: 'string?', skill: 'string?', task: 'string', timeout: 'number?' }
        },
        {
          name: 'delegate.status',
          description: 'List recent delegations the audit log knows about (or a specific id if given).',
          handler: 'delegateStatus',
          parameters: { id: 'string?' }
        },
      ]
    };
  }

  // ─── Handlers ────────────────────────────────────────────────────────────

  async delegateAsk(
    params: { targetAgent?: string; task?: string; context?: string; timeout?: number },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    const guard = this.guard(ctx);
    if (guard) return guard;
    if (!params?.task) return encode(fail('delegate.ask requires { task }'));

    let target: Agent | null = null;
    let routedReason: string | undefined;

    if (params.targetAgent) {
      target = this.lookupAgent(params.targetAgent);
      if (!target) return encode(fail(`no agent matched "${params.targetAgent}" (tried name, id, role)`, 'no match'));
    } else if (this.router && this.finder) {
      const candidates = this.eligibleCandidates(ctx);
      const picked = this.router.pickAgent({ task: params.task }, candidates);
      if (!picked) return encode(fail('targetAgent not given and router could not pick a fit', 'no route'));
      target = picked.agent;
      routedReason = picked.reason;
    } else {
      return encode(fail('delegate.ask requires { targetAgent } unless a router is configured'));
    }

    if (target.id === ctx?.callerAgentId) {
      return encode(fail(`agent ${target.name} cannot delegate to itself`, 'self-delegation'));
    }

    return this.runDelegation(target, params.task, params.context, params.timeout, ctx, routedReason);
  }

  async delegateBroadcast(
    params: { role?: string; skill?: string; task?: string; timeout?: number },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    const guard = this.guard(ctx);
    if (guard) return guard;
    if (!params?.task) return encode(fail('delegate.broadcast requires { task }'));
    if (!params.role && !params.skill) {
      return encode(fail('delegate.broadcast requires at least one of { role, skill }'));
    }
    if (!this.finder) return encode(fail('delegation finder not configured'));

    const candidates = this.eligibleCandidates(ctx).filter(a => {
      if (params.role && a.role !== params.role) return false;
      if (params.skill && !a.config.skills.includes(params.skill)) return false;
      return true;
    });
    if (candidates.length === 0) {
      return encode(fail(`no agents matched role=${params.role ?? '*'} skill=${params.skill ?? '*'}`, 'no candidates'));
    }

    const results = await Promise.all(candidates.map(async (target) => {
      const raw = await this.runDelegation(target, params.task!, undefined, params.timeout, ctx);
      try {
        const parsed = JSON.parse(raw);
        return { agent: target.name, role: target.role, ...parsed };
      } catch {
        return { agent: target.name, role: target.role, ok: false, summary: raw, error: raw };
      }
    }));

    const successes = results.filter(r => r.ok).length;
    return encode(ok({ results, total: results.length, successes }, `${successes}/${results.length} agents responded successfully`));
  }

  async delegateStatus(
    params: { id?: string } = {},
    _ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!this.auditor) {
      return encode(fail('no delegation auditor configured — status is not tracked', 'no auditor'));
    }
    const auditorAny = this.auditor as unknown as {
      listDelegations?: (filter?: { id?: string }) => unknown[];
    };
    if (typeof auditorAny.listDelegations !== 'function') {
      return encode(fail('auditor does not implement listDelegations()', 'unsupported'));
    }
    const records = auditorAny.listDelegations(params.id ? { id: params.id } : undefined);
    return encode(ok({ records, count: records.length }, `${records.length} delegation record(s)`));
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Refuse to run if depth would exceed MAX_DEPTH or required deps are missing. */
  private guard(ctx?: SkillExecutionContext): string | null {
    if (!this.finder) return encode(fail('delegation finder not configured', 'unconfigured'));
    if (!this.skillManager) return encode(fail('delegation skillManager not configured', 'unconfigured'));
    const depth = ctx?.delegationDepth ?? 0;
    if (depth >= DelegationSkill.MAX_DEPTH) {
      return encode(fail(
        `delegation depth ${depth} reached the cap of ${DelegationSkill.MAX_DEPTH} — refusing to chain further`,
        'max-depth'
      ));
    }
    return null;
  }

  /** Resolve a free-form target identifier (name, id, or role) to an agent. */
  private lookupAgent(target: string): Agent | null {
    if (!this.finder) return null;
    const all = this.finder.getAllAgents();
    if (!all.length) return null;

    // 1) exact id
    const byId = this.finder.getAgent?.(target) ?? all.find(a => a.id === target);
    if (byId) return byId;
    // 2) exact name (case-insensitive)
    const byName = all.find(a => a.name.toLowerCase() === target.toLowerCase());
    if (byName) return byName;
    // 3) role — return the least-loaded agent of that role
    const byRole = (this.finder.getAgentsByRole?.(target) ?? all.filter(a => a.role === target));
    if (byRole.length > 0) {
      return byRole.slice().sort((a, b) => this.getActiveTaskCount(a.id) - this.getActiveTaskCount(b.id))[0];
    }
    return null;
  }

  /** Candidates for routing/broadcast: every agent except the caller. */
  private eligibleCandidates(ctx?: SkillExecutionContext): Agent[] {
    if (!this.finder) return [];
    return this.finder.getAllAgents().filter(a => a.id !== ctx?.callerAgentId);
  }

  /** Build a sub-task and run the target's executeTaskDetailed loop. */
  private async runDelegation(
    target: Agent,
    objective: string,
    context: string | undefined,
    timeoutMs: number | undefined,
    ctx: SkillExecutionContext | undefined,
    routedReason?: string
  ): Promise<string> {
    const requesterId = ctx?.callerAgentId ?? 'unknown';
    const requesterName = ctx?.callerAgentName ?? 'unknown';

    // Span around the entire delegation hop. Child spans created by the
    // target agent's executeTaskDetailed (its own root + iterations + skill
    // calls) hang off this so a Jaeger view shows the full chain.
    return withSpan(
      `delegation.${target.name}`,
      async (span) => {
        span.setAttribute('delegation.requester.id', requesterId);
        span.setAttribute('delegation.requester.name', requesterName);
        span.setAttribute('delegation.assignee.id', target.id);
        span.setAttribute('delegation.assignee.name', target.name);
        span.setAttribute('delegation.assignee.role', target.role);
        span.setAttribute('delegation.depth', (ctx?.delegationDepth ?? 0) + 1);
        if (routedReason) span.setAttribute('delegation.routedReason', routedReason);
        return this._runDelegationInner(target, objective, context, timeoutMs, ctx, routedReason);
      },
      {},
      SpanKind.PRODUCER,
    );
  }

  private async _runDelegationInner(
    target: Agent,
    objective: string,
    context: string | undefined,
    timeoutMs: number | undefined,
    ctx: SkillExecutionContext | undefined,
    routedReason?: string,
  ): Promise<string> {
    const requesterId = ctx?.callerAgentId ?? 'unknown';
    const requesterName = ctx?.callerAgentName ?? 'unknown';
    const auditId = this.auditor?.delegateTask({
      requesterAgentId: requesterId,
      requesterAgentName: requesterName,
      assigneeAgentId: target.id,
      assigneeAgentName: target.name,
      parentTaskId: ctx?.taskId,
      objective,
      context,
    })?.id;

    const subtask: Task = {
      id: uuidv4(),
      title: objective.length > 80 ? objective.slice(0, 77) + '...' : objective,
      description: this.buildContextualDescription(objective, context, requesterName, target.name, routedReason),
      status: 'in_progress',
      priority: 'medium',
      ownerId: requesterId,
      assignedTo: target.id,
      category: 'general',
      tags: ['delegated', `from:${requesterName}`],
      createdAt: new Date(),
      updatedAt: new Date(),
      parentTaskId: ctx?.taskId,
    };

    const startedAt = Date.now();
    this.activeTaskCount.set(target.id, this.getActiveTaskCount(target.id) + 1);

    try {
      const detailed: ExecuteTaskResult = timeoutMs && timeoutMs > 0
        ? await Promise.race([
            target.executeTaskDetailed(subtask, this.skillManager!, { delegationDepth: (ctx?.delegationDepth ?? 0) + 1 }),
            new Promise<ExecuteTaskResult>((_, reject) =>
              setTimeout(() => reject(new Error(`delegation to ${target.name} timed out after ${timeoutMs}ms`)), timeoutMs)
            )
          ])
        : await target.executeTaskDetailed(subtask, this.skillManager!, { delegationDepth: (ctx?.delegationDepth ?? 0) + 1 });

      const toolsUsed = detailed.steps
        .map(s => s.tool)
        .filter((t): t is string => !!t)
        .filter((t, i, arr) => arr.indexOf(t) === i);

      const confidence = inferConfidence(detailed);

      if (auditId) {
        this.auditor?.recordDelegationResult(auditId, {
          state: 'completed',
          childTaskId: subtask.id,
          summary: detailed.result.slice(0, 200),
          durationMs: Date.now() - startedAt,
        });
      }

      return encode(ok({
        agent: { id: target.id, name: target.name, role: target.role },
        answer: detailed.result,
        confidence,
        toolsUsed,
        iterations: detailed.iterations,
        outcome: detailed.outcome,
        durationMs: detailed.durationMs,
        delegationId: auditId,
        routedReason,
      }, `${target.name} answered (${detailed.outcome}, ${detailed.iterations} iter, ${toolsUsed.length} tool(s))`));
    } catch (e: any) {
      if (auditId) {
        this.auditor?.recordDelegationResult(auditId, {
          state: 'rejected',
          error: e?.message ?? String(e),
          durationMs: Date.now() - startedAt,
        });
      }
      return encode(fail(`delegation to ${target.name} failed: ${e?.message ?? String(e)}`, `${target.name} failed`));
    } finally {
      const next = this.getActiveTaskCount(target.id) - 1;
      if (next <= 0) this.activeTaskCount.delete(target.id);
      else this.activeTaskCount.set(target.id, next);
    }
  }

  /** Compose the description the target sees: objective + caller's reasoning +
   *  observations they want to share, but NOT the caller's full ReAct trace. */
  private buildContextualDescription(
    objective: string,
    context: string | undefined,
    requesterName: string,
    targetName: string,
    routedReason?: string
  ): string {
    const lines = [
      `You are ${targetName}. ${requesterName} has delegated this sub-task to you.`,
      '',
      `Objective: ${objective}`
    ];
    if (context) {
      lines.push('', `Context from ${requesterName}:`, context);
    }
    if (routedReason) {
      lines.push('', `Why you were chosen: ${routedReason}`);
    }
    lines.push(
      '',
      'Respond with a focused Final Answer that summarises what you found and what you did. Be concise — your caller is waiting and will incorporate your response into their own reasoning.'
    );
    return lines.join('\n');
  }
}

/** Heuristic confidence read from the delegated result.
 *  - success without errors → high
 *  - success but some tool errors → medium
 *  - partial / failed → low */
function inferConfidence(result: ExecuteTaskResult): 'high' | 'medium' | 'low' {
  if (result.outcome === 'failed' || result.outcome === 'partial') return 'low';
  const hadStepErrors = result.steps.some(s => s.error);
  return hadStepErrors ? 'medium' : 'high';
}

// Agent-driven incident remediation, layered on top of the existing
// dispatchIncidentToAgent path.
//
// What this gives us over the "create a task and hope an orchestrator
// poll picks it up" status quo:
//
//   1. The agent's ReAct loop is invoked DIRECTLY on incident creation.
//      No waiting for a queue tick — the assigned sysadmin starts
//      diagnosing immediately, with incident context already in the
//      prompt.
//   2. The agent runs against the IncidentSkill toolkit (host.exec,
//      host.check_metric, incident.note/resolve/escalate,
//      runbook.search/execute). The prompt names them so the model
//      doesn't have to guess which tool to call when.
//   3. On agent success → incident is resolved + verifyResolution()
//      runs (auto-reopens if the metric is still bad).
//   4. On agent timeout/failure → fall back to IncidentAutoRemediator,
//      which has narrow pre-baked recipes (disk-cleanup, docker-
//      housekeeping, container-restart). The remediator's own
//      `attempted` Set keeps the fallback to one try.
//   5. If neither fixes it → escalate (severity bump + timeline note).
//
// The handler does NOT pick agents itself — that's IncidentRouter's
// job. The dispatchIncidentToAgent caller picks via pickAgentForIncident
// and then asks this handler to run ReAct against the assigned agent.
// That keeps the picker as the single source of routing truth.

import type { Agent } from '../agents/Agent.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { WorkflowEngine, WorkflowTemplate } from '../workflows/WorkflowEngine.js';
import type { IncidentManager } from './IncidentManager.js';
import type { IncidentAutoRemediator } from '../self-healing/IncidentAutoRemediator.js';
import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';
import type { TaskPriority, SkillCategory } from '../types/index.js';
import type { EscalationPipeline } from './EscalationPipeline.js';
import type { PostMortemStore, PostMortem } from '../persistence/PostMortemStore.js';
import { createLogger } from '../observability/Logger.js';
import type { AutonomyAttemptStore, AutonomyPhase } from '../ai/AutonomyAttemptStore.js';

const log = createLogger({ component: 'agent-incident-handler' });

export function selectFallbackWorkflow(templates: WorkflowTemplate[], incident: Pick<Incident, 'title' | 'description' | 'sourceRef'>): WorkflowTemplate | null {
  const context = `${incident.title} ${incident.description || ''} ${incident.sourceRef || ''}`;
  const ranked = templates.map((template, index) => {
    let score = 0;
    try {
      const trigger = new RegExp(template.trigger, 'i');
      if (trigger.test(context)) score += 100;
      if (trigger.test('incident')) score += 10;
    } catch { return { template, index, score: -1 }; }
    const words = `${template.id} ${template.name}`.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 4);
    score += words.filter(word => context.toLowerCase().includes(word)).length;
    return { template, index, score };
  }).filter(candidate => candidate.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0]?.template || null;
}

export type AgentIncidentOutcome =
  | 'resolved'           // agent called incident.resolve OR loop ended success and we resolved on its behalf
  | 'resolved_pending_verify' // resolved synchronously, verifier still running in background
  | 'fallback_remediator' // agent failed; AutoRemediator picked up a recipe
  | 'fallback_workflow'  // agent failed and no remediator pattern matched; started a workflow
  | 'escalated'          // agent failed AND nothing else applied — severity bumped, operator owns it
  | 'skipped';           // gated out (severity filter, missing agent, missing handler dependency)

export interface AgentIncidentRunResult {
  incidentId: string;
  agentId?: string;
  agentName?: string;
  outcome: AgentIncidentOutcome;
  iterations: number;
  durationMs: number;
  taskId?: string;
  finalAnswer?: string;
}

export interface AgentIncidentHandlerOpts {
  /** ReAct iterations the agent gets before forced termination. Defaults to 10. */
  maxIterations?: number;
  /** Severities the agent should try to handle. Defaults to all. */
  handleSeverities?: IncidentSeverity[];
  /** Skip the workflow fallback (only IncidentAutoRemediator + escalate).
   *  Useful while we're tuning the agent path. */
  disableWorkflowFallback?: boolean;
  /** Skip the auto-remediator fallback. Mostly for tests. */
  disableRemediatorFallback?: boolean;
  /** Optional websocket broadcaster — used to push agent_incident_done
   *  events that the UI listens for. */
  broadcast?: (event: { type: string; data: unknown }) => void;
  /** Optional escalation pipeline. When wired, the handler reports
   *  L1/L2/L3 transitions to it so OpenClaw alerts + L4 promotion can
   *  happen for incidents automation can't close. Pre-existing
   *  `escalate()` fallback still fires when the pipeline is absent. */
  escalation?: EscalationPipeline;
  /** Knowledge-base store. When wired, the handler queries the top-3
   *  most-similar past post-mortems before the ReAct loop starts and
   *  prepends them to the prompt — so the agent literally walks in
   *  with prior playbooks for similar incidents in front of it. */
  postMortems?: PostMortemStore;
  /** How many post-mortems to inject. Defaults to 3 (per the task brief);
   *  the prompt token cost is small enough that more rarely helps. */
  knowledgeBaseTopK?: number;
  /** Durable per-incident attempt ledger used by autonomy metrics. */
  attemptStore?: AutonomyAttemptStore;
}

export class AgentIncidentHandler {
  private readonly maxIterations: number;
  private readonly handleSeverities: Set<IncidentSeverity>;
  private readonly disableWorkflowFallback: boolean;
  private readonly disableRemediatorFallback: boolean;
  private readonly broadcast?: (event: { type: string; data: unknown }) => void;
  private readonly escalation?: EscalationPipeline;
  private readonly postMortems?: PostMortemStore;
  private readonly knowledgeBaseTopK: number;
  private readonly attemptStore?: AutonomyAttemptStore;

  /** In-flight ReAct runs by incident id. Prevents a re-dispatch (e.g.
   *  escalate) from spawning a second ReAct loop on top of the first. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly skillManager: SkillManager,
    private readonly incidents: IncidentManager,
    private readonly taskManager: TaskManager,
    private readonly autoRemediator: IncidentAutoRemediator | null,
    private readonly workflowEngine: WorkflowEngine | null,
    opts: AgentIncidentHandlerOpts = {},
  ) {
    this.maxIterations = opts.maxIterations ?? 10;
    this.handleSeverities = new Set<IncidentSeverity>(
      opts.handleSeverities ?? ['low', 'medium', 'high', 'critical'],
    );
    this.disableWorkflowFallback = opts.disableWorkflowFallback ?? false;
    this.disableRemediatorFallback = opts.disableRemediatorFallback ?? false;
    this.broadcast = opts.broadcast;
    this.escalation = opts.escalation;
    this.postMortems = opts.postMortems;
    this.knowledgeBaseTopK = Math.max(0, opts.knowledgeBaseTopK ?? 3);
    this.attemptStore = opts.attemptStore;
  }

  /** Run the ReAct loop against an already-assigned agent. Caller is
   *  responsible for the pick + assignAgent() — typically that's
   *  dispatchIncidentToAgent in server.ts. The taskId lets us tie the
   *  ReAct run to the investigation task the dispatcher created. */
  runFor(
    incident: Incident,
    agent: Agent,
    investigationTaskId?: string,
  ): Promise<AgentIncidentRunResult> {
    return this.runInternal(incident, agent, investigationTaskId).catch(err => {
      log.error('agent incident handler crashed', {
        incidentId: incident.id,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      this.inFlight.delete(incident.id);
      return {
        incidentId: incident.id,
        agentId: agent.id,
        agentName: agent.name,
        outcome: 'escalated' as AgentIncidentOutcome,
        iterations: 0,
        durationMs: 0,
      };
    });
  }

  private async runInternal(
    incident: Incident,
    agent: Agent,
    investigationTaskId?: string,
  ): Promise<AgentIncidentRunResult> {
    if (!this.handleSeverities.has(incident.severity)) {
      log.info('skipping incident — severity not in handleSeverities', {
        incidentId: incident.id, severity: incident.severity,
      });
      return { incidentId: incident.id, outcome: 'skipped', iterations: 0, durationMs: 0 };
    }
    if (this.inFlight.has(incident.id)) {
      log.info('skipping incident — ReAct loop already in flight', { incidentId: incident.id });
      return { incidentId: incident.id, outcome: 'skipped', iterations: 0, durationMs: 0 };
    }
    this.inFlight.add(incident.id);

    this.incidents.addNote(
      incident.id,
      'agent-incident-handler',
      `Agent ${agent.name} starting autonomous ReAct loop (≤${this.maxIterations} iterations).`,
    );

    // Pipeline L1 — agent has the ball. Driven from here (rather than
    // server.ts) so the level reflects the *actual* ReAct start, not just
    // the dispatch picker selecting an agent.
    try { this.escalation?.recordLevel1(incident, agent.name); } catch (e) {
      log.warn('escalation.recordLevel1 threw', {
        incidentId: incident.id,
        err: e instanceof Error ? e.message : String(e),
      });
    }

    // Either re-use the investigation task the dispatcher just created (so
    // the agent's ReAct run shows up under the same task in the UI) or
    // synthesise a fresh one when called outside the dispatcher path.
    const task = investigationTaskId
      ? this.taskManager.getTask(investigationTaskId) ?? this.synthesizeTask(incident, agent)
      : this.synthesizeTask(incident, agent);

    // Override the task description with the full incident-aware prompt.
    // The dispatcher's vanilla "Investigate ..." prompt doesn't name the
    // incident toolkit; we replace it so the agent sees the right tools.
    task.description = this.buildPrompt(incident);

    const startedAt = Date.now();
    const attempt = this.attemptStore?.start({
      incidentId: incident.id, taskId: task.id, agentId: agent.id, agentName: agent.name,
    });
    const attemptId = attempt?.id;
    this.trace(attemptId, 'agent_execution', 'started', { maxIterations: this.maxIterations });
    let outcome: AgentIncidentOutcome = 'escalated';
    let iterations = 0;
    let finalAnswer: string | undefined;

    try {
      const result = await agent.executeTaskDetailed(task, this.skillManager, {
        maxIterations: this.maxIterations,
      });
      iterations = result.iterations;
      finalAnswer = result.result;

      log.info('agent finished incident', {
        incidentId: incident.id,
        agentId: agent.id,
        outcome: result.outcome,
        iterations,
        limitReached: result.limitReached,
        limitType: result.limitType,
      });

      const post = this.incidents.get(incident.id);
      const toolSteps = result.steps.filter(s => s.tool && !s.error).length;
      const failedToolSteps = result.steps.filter(s => s.tool && s.error).length;
      this.trace(attemptId, 'agent_execution', result.outcome === 'success' ? 'success' : 'failed', {
        iterations, limitReached: result.limitReached, limitType: result.limitType || null,
      });
      this.trace(attemptId, 'tool_execution', failedToolSteps > 0 ? 'failed' : 'success', {
        successful: toolSteps, failed: failedToolSteps,
      });
      if (post?.status === 'resolved') {
        // Agent called incident.resolve directly during the loop. Kick off
        // verifyResolution in the background — IncidentManager re-opens
        // on metric failure, so we don't have to handle that case here.
        this.trace(attemptId, 'resolution_claimed', 'pending', { source: 'agent_tool' });
        this.runVerifierAsync(incident.id, attemptId);
        outcome = 'resolved_pending_verify';
      } else if (post?.status === 'closed') {
        this.trace(attemptId, 'resolution_claimed', 'pending', { source: 'agent_close' });
        this.runVerifierAsync(incident.id, attemptId);
        outcome = 'resolved_pending_verify';
      } else if (result.outcome === 'success' && !result.limitReached && toolSteps > 0) {
        // Loop ended cleanly but the agent didn't call incident.resolve.
        // Trust its final answer and resolve on its behalf — operators
        // can re-open if the resolution claim turns out to be hollow,
        // and verifyResolution will already do the metric re-check.
        this.trace(attemptId, 'resolution_claimed', 'pending', { source: 'handler', toolSteps });
        this.incidents.resolve(
          incident.id,
          `Agent ${agent.name}: ${(finalAnswer ?? '').slice(0, 400)}`,
        );
        this.runVerifierAsync(incident.id, attemptId);
        outcome = 'resolved_pending_verify';
      } else if (result.outcome === 'success' && !result.limitReached) {
        this.incidents.addNote(
          incident.id,
          'agent-incident-handler',
          'Agent returned success without executing any tools. Falling back instead of resolving blindly.',
        );
        outcome = await this.runFallback(incident, 'agent returned success with zero tool steps', attemptId);
      } else if (result.limitReached && toolSteps > 0 && failedToolSteps === 0) {
        const verdict = await this.incidents.verifyResolution(incident.id, { reopenOnFailure: false });
        this.trace(attemptId, 'verification', verdict.ok ? 'success' : verdict.conclusive === false ? 'pending' : 'failed', {
          details: verdict.details || null,
          afterLimit: result.limitType || null,
        });
        if (verdict.ok) {
          this.incidents.resolve(
            incident.id,
            `Agent ${agent.name}: health verified after ${result.limitType || 'execution'} limit`,
          );
          if (attemptId) {
            this.attemptStore?.conclude(attemptId, 'verified_autonomous', 'verification_passed_after_limit', {
              verification: 'passed', details: { verifierDetails: verdict.details || null, limitType: result.limitType || null },
            });
          }
          outcome = 'resolved';
        } else {
          this.incidents.addNote(
            incident.id,
            'agent-incident-handler',
            verdict.conclusive === false
              ? `Agent stopped early and recovery could not be verified. Handing off safely.`
              : `Agent stopped early and the recovery check still fails. Falling back.`,
          );
          outcome = await this.runFallback(incident, `agent limit ${result.limitType}; ${verdict.details || 'verification failed'}`, attemptId);
        }
      } else if (result.limitReached) {
        this.incidents.addNote(
          incident.id,
          'agent-incident-handler',
          `Agent stopped early (${result.limitType}: ${result.limitReason}). Falling back to remediator.`,
        );
        outcome = await this.runFallback(incident, `agent limit ${result.limitType}`, attemptId);
      } else {
        this.incidents.addNote(
          incident.id,
          'agent-incident-handler',
          `Agent loop ended without resolution. Falling back to remediator.`,
        );
        outcome = await this.runFallback(incident, 'agent returned without resolution', attemptId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('agent.executeTaskDetailed threw', { incidentId: incident.id, err: msg });
      this.trace(attemptId, 'agent_execution', 'failed', { error: msg.slice(0, 200) });
      this.incidents.addNote(
        incident.id,
        'agent-incident-handler',
        `Agent execution crashed: ${msg.slice(0, 200)}. Falling back to remediator.`,
      );
      outcome = await this.runFallback(incident, `agent threw: ${msg.slice(0, 80)}`, attemptId);
    } finally {
      this.inFlight.delete(incident.id);
      // Release the workload-tracker lock if the incident reached a
      // terminal state. assignAgent/releaseAgent on IncidentManager
      // already drive the tracker — call releaseAgent on resolved
      // states so "Active Agents" reflects the real workload.
      const finalState = this.incidents.get(incident.id);
      if (finalState && (finalState.status === 'resolved' || finalState.status === 'closed')) {
        this.incidents.releaseAgent(incident.id, 'agent ReAct loop concluded');
        // Tell the pipeline so an L3+ incident gets a "resolved" notice
        // sent to the channel that was paged, and the level resets.
        try { this.escalation?.recordResolution(finalState); } catch (e) {
          log.warn('escalation.recordResolution threw', {
            incidentId: incident.id,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    this.broadcast?.({
      type: 'incident_agent_done',
      data: {
        incidentId: incident.id,
        agentId: agent.id,
        agentName: agent.name,
        outcome,
        iterations,
        durationMs,
      },
    });

    return {
      incidentId: incident.id,
      agentId: agent.id,
      agentName: agent.name,
      outcome,
      iterations,
      durationMs,
      taskId: task.id,
      finalAnswer,
    };
  }

  // ── Fallback chain ───────────────────────────────────────────────────────
  //
  // Order: AutoRemediator (pattern-matched, fast, one-try-per-incident) →
  // matching WorkflowEngine template → escalate (severity bump). Each
  // step is best-effort; we always end with at least an escalation so
  // the operator sees something happened.

  private async runFallback(incident: Incident, reason: string, attemptId?: string): Promise<AgentIncidentOutcome> {
    let remediatorKind: string | null = null;
    let remediatorActions: string[] = [];
    let workflowSummary: string | undefined;
    let outcome: AgentIncidentOutcome = 'escalated';

    // 1. Try the auto-remediator and await its evidence. A deterministic
    //    fallback counts as assisted only after an independent verifier
    //    confirms that the underlying condition cleared.
    if (!this.disableRemediatorFallback && this.autoRemediator) {
      const plan = this.autoRemediator.matchPlan(incident);
      if (plan) {
        this.trace(attemptId, 'fallback_remediator', 'pending', { reason, kind: plan.kind, actions: plan.actions.length });
        this.incidents.addNote(
          incident.id,
          'agent-incident-handler',
          `Auto-remediator fallback engaged: ${plan.kind} (${plan.actions.length} action(s)).`,
        );
        remediatorKind = plan.kind;
        remediatorActions = plan.actions.map((a: any) => {
          if (a?.mode === 'argv' && Array.isArray(a.args)) {
            return `${a.file} ${a.args.join(' ')}`;
          }
          if (typeof a?.command === 'string') {
            return a.mode === 'host-shell' ? `host: ${a.command}` : a.command;
          }
          return 'action';
        });
        const remediation = await this.autoRemediator.remediate(incident);
        const allActionsPassed = !!remediation && remediation.actions.length > 0
          && remediation.actions.every(action => action.status === 'success');
        this.trace(attemptId, 'fallback_remediator', allActionsPassed ? 'success' : 'failed', {
          reason,
          kind: plan.kind,
          successful: remediation?.actions.filter(action => action.status === 'success').length || 0,
          failed: remediation?.actions.filter(action => action.status === 'failed').length || 0,
        });
        if (allActionsPassed) {
          const verdict = await this.incidents.verifyResolution(incident.id, { reopenOnFailure: false });
          this.trace(attemptId, 'verification', verdict.ok ? 'success' : verdict.conclusive === false ? 'pending' : 'failed', {
            details: verdict.details || null,
            afterFallback: plan.kind,
          });
          if (verdict.ok) {
            this.incidents.resolve(incident.id, `Verified auto-remediator recovery: ${plan.kind}`);
            this.attemptStore?.conclude(attemptId || '', 'assisted', 'fallback_remediator_verified', {
              verification: 'passed', details: { kind: plan.kind, verifierDetails: verdict.details || null },
            });
            return 'resolved';
          }
          this.incidents.addNote(
            incident.id,
            'agent-incident-handler',
            verdict.conclusive === false
              ? `Auto-remediator completed, but verification is unavailable. Continuing to human-safe fallback.`
              : `Auto-remediator completed, but verification still fails. Continuing fallback.`,
          );
        }
      }
    }

    // 2. Try a matching workflow template — only when no remediator recipe
    //    applied. If a remediator is in flight, a parallel workflow run on
    //    the same incident churns the timeline without adding value.
    if (outcome === 'escalated' && !this.disableWorkflowFallback && this.workflowEngine) {
      try {
        const tpl = selectFallbackWorkflow(this.workflowEngine.listTemplates(), incident);
        if (tpl) {
          const run = this.workflowEngine.startRun({
            templateId: tpl.id,
            taskId: `inc-${incident.id}`,
            title: `[FALLBACK ${incident.severity.toUpperCase()}] ${incident.title}`,
          });
          this.incidents.addNote(
            incident.id,
            'agent-incident-handler',
            `Workflow fallback started: run ${run.id} from template ${tpl.id}.`,
          );
          workflowSummary = `workflow run ${run.id} (template ${tpl.id})`;
          outcome = 'fallback_workflow';
          this.trace(attemptId, 'fallback_workflow', 'pending', { reason, runId: run.id, templateId: tpl.id });
          this.attemptStore?.conclude(attemptId || '', 'human_handoff', 'fallback_workflow_handoff', {
            verification: 'not_applicable', details: { workflowRunId: run.id, templateId: tpl.id },
          });
        }
      } catch (err) {
        log.error('fallback workflow start failed', {
          incidentId: incident.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 3. Hand off to the escalation pipeline. The pipeline owns the L3
    //    delay (giving the remediator time to actually fix things before
    //    we wake a human) and the L3→L4 timeout (severity bump + urgent
    //    follow-up if still stuck). If no pipeline is wired, fall back to
    //    the legacy single-shot severity bump so nothing silently drops.
    if (this.escalation) {
      this.escalation.handleFallback(incident, {
        reason,
        remediatorKind,
        remediatorActions,
        currentMetrics: workflowSummary,
      });
      if (outcome === 'escalated') {
        this.trace(attemptId, 'escalation', 'success', { reason, pipeline: true });
        this.attemptStore?.conclude(attemptId || '', 'human_handoff', 'escalated_to_operator');
      }
      return outcome;
    }

    // Legacy path — no pipeline wired. Only bump severity when neither a
    // remediator nor a coordination workflow accepted the incident.
    if (outcome === 'escalated') {
      this.incidents.escalate(incident.id, `Agent remediation failed (${reason}); no fallback applied.`);
      this.trace(attemptId, 'escalation', 'success', { reason, pipeline: false });
      this.attemptStore?.conclude(attemptId || '', 'human_handoff', 'escalated_to_operator');
    }
    return outcome;
  }

  /** Kick verifyResolution in the background. IncidentManager handles
   *  the re-open on failure, so we just fire it and forget. */
  private runVerifierAsync(incidentId: string, attemptId?: string): void {
    void this.incidents.verifyResolution(incidentId, { reopenOnFailure: true })
      .then(verdict => {
        this.trace(
          attemptId,
          'verification',
          verdict.ok ? 'success' : verdict.conclusive === false ? 'pending' : 'failed',
          { details: verdict.details || null },
        );
        if (attemptId) {
          const classification = verdict.ok
            ? 'verified_autonomous'
            : verdict.conclusive === false ? 'human_handoff' : 'false_resolution';
          this.attemptStore?.conclude(
            attemptId,
            classification,
            verdict.ok ? 'verification_passed' : verdict.conclusive === false ? 'verification_unavailable' : 'verification_failed',
            { verification: verdict.ok ? 'passed' : verdict.conclusive === false ? 'not_applicable' : 'failed', details: { verifierDetails: verdict.details || null } },
          );
        }
        log.info('verification finished', { incidentId, ok: verdict.ok, details: verdict.details });
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        this.trace(attemptId, 'verification', 'failed', { error: message });
        if (attemptId) this.attemptStore?.conclude(attemptId, 'human_handoff', 'verification_error', { verification: 'not_applicable', details: { error: message } });
        log.error('verifyResolution threw', { incidentId, err: message });
      });
  }

  private trace(attemptId: string | undefined, kind: AutonomyPhase['kind'], status: AutonomyPhase['status'], details?: Record<string, unknown>): void {
    if (!attemptId) return;
    try { this.attemptStore?.addPhase(attemptId, { kind, status, details }); }
    catch (error) { log.warn('attempt trace write failed', { attemptId, kind, error: error instanceof Error ? error.message : String(error) }); }
  }

  private synthesizeTask(incident: Incident, agent: Agent) {
    return this.taskManager.createTask({
      title: `Remediate: [${incident.severity.toUpperCase()}] ${incident.title}`,
      description: '', // overwritten by caller
      category: 'service-management' as SkillCategory,
      priority: this.priorityForSeverity(incident.severity),
      ownerId: 'agent-incident-handler',
      assignedTo: agent.id,
    });
  }

  private priorityForSeverity(sev: IncidentSeverity): TaskPriority {
    switch (sev) {
      case 'critical': return 'critical';
      case 'high':     return 'high';
      case 'medium':   return 'medium';
      default:         return 'low';
    }
  }

  private buildPrompt(incident: Incident): string {
    const desc = (incident.description || '').slice(0, 800);
    const kbBlock = this.buildKnowledgeBaseBlock(incident);
    return [
      `You are on-call. INCIDENT ${incident.id} has been assigned to you for autonomous remediation.`,
      incident.serverId ? `  TARGET SERVER: ${incident.serverId} (always pass serverId: "${incident.serverId}" to host tools)` : '',
      ``,
      `INCIDENT CONTEXT`,
      `  id:         ${incident.id}`,
      `  title:      ${incident.title}`,
      `  severity:   ${incident.severity}`,
      `  status:     ${incident.status}`,
      `  source:     ${incident.source}${incident.sourceRef ? ` (${incident.sourceRef})` : ''}`,
      `  serverId:   ${incident.serverId ?? 'local'}`,
      `  created:    ${incident.createdAt}`,
      `  sla:        ${incident.slaMinutes} minutes`,
      desc ? `  details:    ${desc}` : '',
      kbBlock,
      ``,
      `WORKFLOW — call these tools in this order; cite concrete numbers, never guess.`,
      `  1. DIAGNOSE — pass serverId "${incident.serverId ?? 'local'}" to every host.check_metric and host.exec call.`,
      `     Use a metric (disk|cpu|memory|load|docker|services|network) or a targeted command.`,
      `  2. SEARCH — runbook.search with keywords from the incident title to find a matching runbook.`,
      `  3. ACT — either:`,
      `         (a) run a targeted host.exec command (allowlisted binaries only — destructive ops are blocked), or`,
      `         (b) call runbook.execute with the templateId from step 2.`,
      `     Call incident.note after each meaningful action so operators can see your reasoning.`,
      `  4. VERIFY — re-run the relevant host.check_metric to confirm the issue is resolved.`,
      `  5. CLOSE — call incident.resolve with a one-paragraph resolution summary. If you cannot fix it,`,
      `     call incident.escalate with a clear reason; do not loop pointlessly — the auto-remediator and`,
      `     a backup workflow will pick up after you escalate.`,
      ``,
      `LIMITS`,
      `  - You have at most ${this.maxIterations} ReAct iterations.`,
      `  - Destructive commands (rm -rf, shutdown, mkfs, dd if=, reboot, etc.) are blocked by host.exec.`,
      `    Do not waste turns trying to bypass — pick a runbook instead.`,
      `  - Every host.exec call is timeout-capped (default 30s, max 2min). No interactive commands.`,
      ``,
      `Begin.`,
    ].filter(Boolean).join('\n');
  }

  /** Look up the top-K most similar past post-mortems and format them
   *  as a "PRIOR INCIDENTS" block the agent can reason over before
   *  calling any tools. Returns an empty string when no KB is wired or
   *  no relevant past incidents exist — the rest of the prompt is then
   *  unchanged, so this is safe to ship even before the KB is populated. */
  private buildKnowledgeBaseBlock(incident: Incident): string {
    if (!this.postMortems || this.knowledgeBaseTopK <= 0) return '';
    let matches: PostMortem[] = [];
    try {
      matches = this.postMortems.findSimilar(
        {
          id: incident.id,
          title: incident.title,
          description: incident.description,
          serverId: incident.serverId ?? null,
          sourceRef: incident.sourceRef ?? null,
        },
        this.knowledgeBaseTopK,
      );
    } catch (e) {
      log.warn('post-mortem lookup failed; continuing without KB context', {
        incidentId: incident.id,
        err: e instanceof Error ? e.message : String(e),
      });
      return '';
    }
    if (matches.length === 0) return '';

    const lines: string[] = [
      ``,
      `PRIOR INCIDENTS (most similar — use these as a playbook, not a script):`,
    ];
    for (let i = 0; i < matches.length; i++) {
      const pm = matches[i];
      lines.push(`  ${i + 1}. [${pm.severity}] ${pm.title} (resolved in ${pm.durationMinutes}m)`);
      if (pm.rootCause) lines.push(`     root cause: ${truncate(pm.rootCause, 240)}`);
      if (pm.resolution) lines.push(`     fix:        ${truncate(pm.resolution, 240)}`);
      if (pm.lessons.length > 0) {
        lines.push(`     lessons:    ${pm.lessons.slice(0, 2).map(l => truncate(l, 160)).join(' | ')}`);
      }
    }
    return lines.join('\n');
  }
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

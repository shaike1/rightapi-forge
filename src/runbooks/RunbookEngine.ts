// RunbookEngine — operator-facing runbook execution.
//
// Step types fall into two categories:
//
//   Platform steps (dispatch via SkillManager):
//     action, notification
//
//   Infra steps (dispatched directly by this engine):
//     command       — RemoteExecutor.execute on a MonitoredServer
//     check_metric  — MetricsHistoryStore.latest()
//     wait          — sleep N seconds
//     escalate      — IncidentManager.escalate (needs context.incidentId)
//     resolve       — IncidentManager.resolve   (needs context.incidentId)
//
// Cross-cutting:
//     condition     — branches on prior step output / exit code / metric
//     approval      — explicit pause-for-approval step type
//
// Approval gates fire when ANY of:
//   1. Step.type === 'approval'
//   2. Step.requiresApproval === true (works on any step type)
//   3. DestructiveGuard matches the shell text of a `command` step
//
// Approvals are persisted to RunbookApprovalStore. Decisions resume the
// run from the same step (re-entry uses stepResult.approvedBy to skip
// the gate the second time around).
//
// Runs are persisted to RunbookRunStore (SQLite). The legacy 500-row
// JSON ring buffer is imported once on first boot and then ignored.

import fs from 'fs';
import path from 'path';
import {
  RunbookTemplate, RunbookRun, RunbookStatus, RunbookStep, RunbookStepResult, StepStatus,
  RunbookRunContext,
} from './RunbookTypes.js';
import { RunbookConverter, type ConvertOptions, type ConvertResult } from './RunbookConverter.js';
import { RunbookRunStore } from './RunbookRunStore.js';
import { RunbookApprovalStore } from './RunbookApprovalStore.js';
import { inspect as inspectDestructive } from './DestructiveGuard.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';
import type { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import { logger } from '../utils/logger.js';

// Built-in templates — preserved from the legacy engine so existing
// installations don't lose recipes after upgrade. The three new SPEC seed
// runbooks (disk-cleanup, service-recovery, high-CPU) get IDs prefixed
// `seed-` so they're identifiable but never collide with operator runbooks.
const DEFAULT_TEMPLATES: RunbookTemplate[] = [
  {
    id: 'server-health-check',
    name: 'Server Health Check',
    description: 'Check CPU, memory, and disk health on a server',
    category: 'monitoring',
    tags: ['health', 'monitoring'],
    triggerType: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 's1', type: 'action', description: 'Check CPU usage', command: 'monitor.cpu', params: {} },
      { id: 's2', type: 'action', description: 'Check memory usage', command: 'monitor.memory', params: {} },
      { id: 's3', type: 'action', description: 'Check disk usage', command: 'monitor.disk', params: {} },
      { id: 's4', type: 'notification', description: 'Report health check complete', command: 'alert.send', params: { message: 'Server health check completed', severity: 'info' } },
    ],
  },
  {
    id: 'service-restart',
    name: 'Service Restart',
    description: 'Safely restart a Docker service with approval gate',
    category: 'infrastructure',
    tags: ['docker', 'restart'],
    triggerType: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 's1', type: 'approval', description: 'Approval required before restart', message: 'Approve service restart? This will cause a brief outage.' },
      { id: 's2', type: 'action', description: 'Execute service restart', command: 'bash.exec', params: { command: 'echo "Service restart simulated"' }, retryPolicy: { maxRetries: 1, backoffMs: 2000 } },
      { id: 's3', type: 'action', description: 'Wait for service to come up', command: 'bash.exec', params: { command: 'sleep 3 && echo "waited"' } },
      { id: 's4', type: 'notification', description: 'Notify restart complete', command: 'alert.send', params: { message: 'Service restart completed successfully', severity: 'info' } },
    ],
  },
  // ── Spec seed runbooks ────────────────────────────────────────────────
  {
    id: 'seed-disk-cleanup',
    name: 'Disk Cleanup (auto)',
    description: 'Auto-fires when disk > 90% on any server. Surfaces top consumers, prunes old logs + docker, verifies recovery, escalates if still high.',
    category: 'monitoring',
    tags: ['disk', 'seed', 'auto'],
    triggerType: 'metric_threshold',
    triggerConfig: { metric: 'disk', operator: '>', threshold: 90, cooldownSeconds: 600 },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 's1', type: 'command', description: 'Show top space consumers under /var/log', serverId: 'local', command: 'du -sh /var/log/* 2>/dev/null | sort -rh | head -5' },
      { id: 's2', type: 'command', description: 'Delete compressed logs older than 7 days', serverId: 'local', command: "find /var/log -name '*.gz' -mtime +7 -delete" },
      { id: 's3', type: 'command', description: 'Prune unused docker resources', serverId: 'local', command: 'docker system prune -f' },
      { id: 's4', type: 'check_metric', description: 'Recheck disk after cleanup', metric: 'disk', serverId: 'local', operator: '<', threshold: 85, onSuccess: 's6', onFailure: 's5' },
      { id: 's5', type: 'notification', description: 'Escalate — cleanup insufficient', command: 'alert.send', params: { message: 'Disk cleanup insufficient, manual intervention needed', severity: 'warning' } },
      { id: 's6', type: 'resolve', description: 'Auto-resolve incident', resolution: 'Auto-cleaned: old logs + docker prune' },
    ],
  },
  {
    id: 'seed-service-recovery',
    name: 'Service Recovery',
    description: 'Auto-fires on incidents with sourceRef LIKE service:%. Inspects state, pulls logs, restarts with approval, verifies and resolves.',
    category: 'infrastructure',
    tags: ['service', 'seed', 'auto'],
    triggerType: 'incident_match',
    triggerConfig: { sourceRef: 'service:%' },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 's1', type: 'command', description: 'Service status snapshot', serverId: 'local', command: 'systemctl status' },
      { id: 's2', type: 'command', description: 'Recent journal output', serverId: 'local', command: 'journalctl --no-pager -n 20' },
      { id: 's3', type: 'command', description: 'Restart service (approval required)', serverId: 'local', command: 'systemctl restart', requiresApproval: true },
      { id: 's4', type: 'wait', description: 'Wait for service to settle', seconds: 10 },
      { id: 's5', type: 'command', description: 'Verify service back', serverId: 'local', command: 'systemctl is-active', onSuccess: 's6', onFailure: 's7' },
      { id: 's6', type: 'resolve', description: 'Auto-resolve incident', resolution: 'Service restarted successfully' },
      { id: 's7', type: 'escalate', description: 'Escalate — restart did not recover service', reason: 'Service still not active after restart' },
    ],
  },
  {
    id: 'seed-high-cpu',
    name: 'High CPU Investigation',
    description: 'Auto-fires when cpu > 95%. Surfaces top processes, notifies, branches on suspect process type, optionally restarts (with approval).',
    category: 'monitoring',
    tags: ['cpu', 'seed', 'auto'],
    triggerType: 'metric_threshold',
    triggerConfig: { metric: 'cpu', operator: '>', threshold: 95, cooldownSeconds: 600 },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [
      { id: 's1', type: 'command', description: 'Top processes by %CPU', serverId: 'local', command: 'ps aux --sort=-%cpu | head -10' },
      { id: 's2', type: 'command', description: 'Top live activity (top -bn1)', serverId: 'local', command: 'top -bn1 | head -20' },
      { id: 's3', type: 'notification', description: 'Notify operators with investigation output', command: 'alert.send', params: { message: 'High-CPU investigation complete — see runbook run for top-N lists', severity: 'warning' } },
      { id: 's4', type: 'condition', description: 'Suspect a runtime we can restart?', check: 'last_output_contains', operator: '==', value: 'java', onTrue: 's5', onFalse: 's6' },
      { id: 's5', type: 'command', description: 'Restart matched service (approval required)', serverId: 'local', command: 'systemctl restart', requiresApproval: true, onSuccess: 'end', onFailure: 's6' },
      { id: 's6', type: 'escalate', description: 'Escalate to humans', reason: 'High CPU from unknown process, needs manual review' },
    ],
  },
];

const MAX_STEPS_PER_RUN = 50;
const MAX_RUN_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

export interface RunbookEngineDeps {
  /** Required for `action` + `notification` step dispatch. */
  skillManager?: { execute(command: string, params?: Record<string, unknown>): Promise<string> };
  /** Required for `command` steps. */
  remoteExecutor?: RemoteExecutor;
  /** Required for `command` step server lookup + per-server connection details. */
  serverRegistry?: ServerRegistry;
  /** Required for `check_metric` steps. */
  metricsHistory?: MetricsHistoryStore;
  /** Required for `escalate` / `resolve` steps. Gated on `context.incidentId`. */
  incidentManager?: IncidentManager;
  /** Required for approval gates. Without it, `requiresApproval` is treated
   *  as a no-op so the engine still works in tests/legacy installations. */
  approvalStore?: RunbookApprovalStore;
  /** Required for run persistence. Without it, falls back to legacy JSON. */
  runStore?: RunbookRunStore;
  /** WebSocket broadcast hook — emits runbook_started / runbook_step_complete
   *  / approval:request / etc. */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

export class RunbookEngine {
  private static instance: RunbookEngine;

  private templates: Map<string, RunbookTemplate> = new Map();
  /** In-memory mirror of runStore. We keep an in-memory copy so the
   *  per-step status mutations don't touch SQLite on every line of the
   *  loop; we flush to disk at meaningful boundaries (start, step
   *  complete, terminal state). */
  private runs: Map<string, RunbookRun> = new Map();
  private readonly templatesPath: string;
  /** Legacy JSON-backed runs path. Read once at construction so we can
   *  hand it to the SQLite store for one-shot migration. */
  private readonly runsPath: string;

  private deps: RunbookEngineDeps = {};
  private DEFAULT_TEMPLATE_IDS: Set<string>;
  /** Per-(template, server) cooldown for metric_threshold matcher
   *  re-firing the same runbook. Memory-only — a restart resets it. */
  private metricCooldown: Map<string, number> = new Map();

  static getInstance(): RunbookEngine {
    if (!RunbookEngine.instance) {
      RunbookEngine.instance = new RunbookEngine();
    }
    return RunbookEngine.instance;
  }

  private constructor() {
    this.templatesPath = process.env.RUNBOOK_TEMPLATES_PATH || '/data/itops-agents/runbook-templates.json';
    this.runsPath = process.env.RUNBOOK_RUNS_PATH || '/data/itops-agents/runbook-runs.json';
    this.DEFAULT_TEMPLATE_IDS = new Set(DEFAULT_TEMPLATES.map(t => t.id));
    this._loadTemplates();
  }

  // ─── Injection ────────────────────────────────────────────────────────

  setSkillManager(sm: NonNullable<RunbookEngineDeps['skillManager']>): void { this.deps.skillManager = sm; }
  setBroadcast(cb: NonNullable<RunbookEngineDeps['broadcast']>): void { this.deps.broadcast = cb; }

  /** Single entry point for the new infra deps. Call once at boot after
   *  IncidentManager, ServerRegistry, RemoteExecutor, MetricsHistory,
   *  RunbookRunStore, and RunbookApprovalStore are all available. */
  wireInfraDeps(deps: Pick<RunbookEngineDeps, 'remoteExecutor' | 'serverRegistry' | 'metricsHistory' | 'incidentManager' | 'approvalStore' | 'runStore'>): void {
    Object.assign(this.deps, deps);
    if (deps.runStore) {
      // Bring the in-memory run cache in line with SQLite — active runs
      // (running / waiting_approval) need to be re-hydrated for the
      // approve route to find them on a restart.
      for (const run of deps.runStore.listActive()) {
        this.runs.set(run.id, run);
      }
      logger.info('[RunbookEngine] re-hydrated active runs from store', { count: this.runs.size });
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  private _loadTemplates(): void {
    for (const t of DEFAULT_TEMPLATES) {
      this.templates.set(t.id, t);
    }
    try {
      const raw = fs.readFileSync(this.templatesPath, 'utf-8');
      const custom: RunbookTemplate[] = JSON.parse(raw);
      for (const t of custom) {
        this.templates.set(t.id, t);
      }
    } catch {
      // File may not exist yet; defaults are already loaded
    }
  }

  private _saveTemplates(): void {
    const custom = Array.from(this.templates.values()).filter(t => !this.DEFAULT_TEMPLATE_IDS.has(t.id));
    fs.mkdirSync(path.dirname(this.templatesPath), { recursive: true });
    fs.writeFileSync(this.templatesPath, JSON.stringify(custom, null, 2), 'utf-8');
  }

  /** Legacy JSON path — passed to RunbookRunStore once at construction so
   *  the SQLite store can import it as part of its first-boot migration. */
  legacyRunsPath(): string { return this.runsPath; }

  private _persistRun(run: RunbookRun): void {
    if (this.deps.runStore) {
      try { this.deps.runStore.upsert(run); } catch (e) {
        logger.warn('[RunbookEngine] runStore.upsert failed', { runId: run.id, err: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // ─── Template CRUD ────────────────────────────────────────────────────

  listTemplates(): RunbookTemplate[] {
    return Array.from(this.templates.values());
  }

  getTemplate(id: string): RunbookTemplate | undefined {
    return this.templates.get(id);
  }

  addTemplate(input: Omit<RunbookTemplate, 'createdAt' | 'updatedAt'>): RunbookTemplate {
    const now = new Date().toISOString();
    const template: RunbookTemplate = {
      triggerType: 'manual',
      enabled: true,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(template.id, template);
    this._saveTemplates();
    return template;
  }

  importFromText(source: string, format: 'markdown' | 'yaml' | 'auto' = 'auto', opts: ConvertOptions = {}): ConvertResult & { template: RunbookTemplate } {
    const result =
      format === 'markdown' ? RunbookConverter.fromMarkdown(source, opts) :
      format === 'yaml'     ? RunbookConverter.fromYaml(source, opts) :
                              RunbookConverter.fromText(source, opts);
    if (this.DEFAULT_TEMPLATE_IDS.has(result.template.id)) {
      const suffixed = `${result.template.id}-imported-${Date.now()}`;
      result.template = { ...result.template, id: suffixed };
    }
    this.templates.set(result.template.id, result.template);
    this._saveTemplates();
    return result;
  }

  updateTemplate(
    id: string,
    patch: Partial<Pick<RunbookTemplate, 'name' | 'description' | 'category' | 'steps' | 'tags' | 'triggerType' | 'triggerConfig' | 'enabled'>>,
  ): RunbookTemplate {
    const existing = this.templates.get(id);
    if (!existing) throw new Error(`Template "${id}" not found`);
    const updated: RunbookTemplate = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.templates.set(id, updated);
    this._saveTemplates();
    return updated;
  }

  deleteTemplate(id: string): void {
    if (this.DEFAULT_TEMPLATE_IDS.has(id)) {
      throw new Error(`Cannot delete built-in template "${id}"`);
    }
    if (!this.templates.has(id)) throw new Error(`Template "${id}" not found`);
    const activeRun = Array.from(this.runs.values()).find(
      r => r.templateId === id && (r.status === 'running' || r.status === 'waiting_approval'),
    );
    if (activeRun) {
      throw new Error(`Cannot delete template "${id}": active run "${activeRun.id}" exists`);
    }
    this.templates.delete(id);
    this._saveTemplates();
  }

  // ─── Run management ───────────────────────────────────────────────────

  listRuns(status?: RunbookStatus, opts: { limit?: number; offset?: number; templateId?: string } = {}): RunbookRun[] {
    if (this.deps.runStore) return this.deps.runStore.list({ status, ...opts });
    // Fallback to memory (mainly for tests).
    const all = Array.from(this.runs.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return status ? all.filter(r => r.status === status) : all;
  }

  getRun(id: string): RunbookRun | undefined {
    const cached = this.runs.get(id);
    if (cached) return cached;
    if (this.deps.runStore) {
      const stored = this.deps.runStore.get(id);
      return stored ?? undefined;
    }
    return undefined;
  }

  cancelRun(runId: string, reason?: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run "${runId}" not found`);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(`Run "${runId}" is already in terminal state "${run.status}"`);
    }
    run.status = 'cancelled';
    run.error = reason ?? 'Cancelled by user';
    run.completedAt = new Date().toISOString();
    this._persistRun(run);
    this._emit('runbook_cancelled', { runId, reason });
  }

  approveStep(runId: string, approverId: string, decisionReason?: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run "${runId}" not found`);
    if (run.status !== 'waiting_approval') {
      throw new Error(`Run "${runId}" is not waiting for approval (status: ${run.status})`);
    }
    const template = this.templates.get(run.templateId);
    if (!template) throw new Error(`Template "${run.templateId}" not found`);
    const step = template.steps[run.currentStepIndex];
    const stepResult = run.stepResults[run.currentStepIndex];
    if (!stepResult || stepResult.status !== 'waiting_approval') {
      throw new Error(`Step at index ${run.currentStepIndex} is not waiting for approval`);
    }
    // Resolve any pending approval row for audit visibility.
    if (this.deps.approvalStore) {
      const pending = this.deps.approvalStore.findPendingForStep(run.id, step.id);
      if (pending) this.deps.approvalStore.decide(pending.id, { status: 'approved', decidedBy: approverId, reason: decisionReason });
    }
    stepResult.approvedBy = approverId;
    if (step.type === 'approval') {
      // Pure approval step — done.
      stepResult.status = 'success';
      stepResult.completedAt = new Date().toISOString();
      run.currentStepIndex++;
    } else {
      // Approval gate before a body step — reset so the loop runs the
      // body. approvedBy persists in the result so the gate doesn't
      // re-fire on re-entry.
      stepResult.status = 'pending';
    }
    run.status = 'running';
    this._persistRun(run);
    this._emit('runbook_step_approved', { runId, approverId, stepIndex: run.currentStepIndex });
    this._executeSteps(run, template).catch(e =>
      logger.error(`[RunbookEngine] _executeSteps error after approval for run ${run.id}:`, { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }),
    );
  }

  rejectStep(runId: string, decidedBy: string, decisionReason: string): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run "${runId}" not found`);
    if (run.status !== 'waiting_approval') {
      throw new Error(`Run "${runId}" is not waiting for approval (status: ${run.status})`);
    }
    const template = this.templates.get(run.templateId);
    if (!template) throw new Error(`Template "${run.templateId}" not found`);
    const step = template.steps[run.currentStepIndex];
    const stepResult = run.stepResults[run.currentStepIndex];
    if (this.deps.approvalStore) {
      const pending = this.deps.approvalStore.findPendingForStep(run.id, step.id);
      if (pending) this.deps.approvalStore.decide(pending.id, { status: 'rejected', decidedBy, reason: decisionReason });
    }
    stepResult.status = 'rejected';
    stepResult.rejectedBy = decidedBy;
    stepResult.completedAt = new Date().toISOString();
    stepResult.error = decisionReason || 'Rejected by approver';
    // If the step has an onFailure branch, take it. Otherwise mark run rejected.
    if (step.onFailure && step.onFailure !== 'end') {
      const nextIdx = template.steps.findIndex(s => s.id === step.onFailure);
      if (nextIdx !== -1) {
        run.currentStepIndex = nextIdx;
        run.status = 'running';
        this._persistRun(run);
        this._emit('runbook_step_rejected', { runId, decidedBy, reason: decisionReason });
        this._executeSteps(run, template).catch(e =>
          logger.error(`[RunbookEngine] _executeSteps error after reject for run ${run.id}:`, { err: e instanceof Error ? e.message : String(e) }),
        );
        return;
      }
    }
    run.status = 'rejected';
    run.error = decisionReason || 'Rejected by approver';
    run.completedAt = new Date().toISOString();
    this._persistRun(run);
    this._emit('runbook_rejected', { runId, decidedBy, reason: decisionReason });
  }

  // ─── Core execution ───────────────────────────────────────────────────

  async executeRun(
    templateId: string,
    triggeredBy: string,
    opts: { context?: RunbookRunContext } = {},
  ): Promise<RunbookRun> {
    const template = this.templates.get(templateId);
    if (!template) throw new Error(`Template "${templateId}" not found`);

    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const stepResults: RunbookStepResult[] = template.steps.map((step, index) => ({
      stepId: step.id,
      stepIndex: index,
      type: step.type,
      description: step.description,
      status: 'pending' as StepStatus,
    }));

    const run: RunbookRun = {
      id: runId,
      templateId,
      templateName: template.name,
      triggeredBy,
      status: 'running',
      currentStepIndex: 0,
      stepResults,
      context: opts.context,
      startedAt: new Date().toISOString(),
    };
    this.runs.set(runId, run);
    this._persistRun(run);
    this._emit('runbook_started', { runId, templateId, triggeredBy, context: opts.context });

    this._executeSteps(run, template).catch(e =>
      logger.error(`[RunbookEngine] _executeSteps error for run ${run.id}:`, { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }),
    );
    return run;
  }

  private async _executeSteps(run: RunbookRun, template: RunbookTemplate): Promise<void> {
    const runStartedMs = new Date(run.startedAt).getTime();
    let stepIndex = run.currentStepIndex;
    let stepCount = 0;
    let lastOutput = '';
    let lastExitCode = 0;
    let lastMetricValue: number | undefined;

    while (stepIndex < template.steps.length) {
      // Safety bounds — prevent infinite loops + runaway durations.
      if (++stepCount > MAX_STEPS_PER_RUN) {
        this._failRun(run, `Exceeded max steps per run (${MAX_STEPS_PER_RUN}) — possible loop in onSuccess/onFailure chain`);
        return;
      }
      if (Date.now() - runStartedMs > MAX_RUN_DURATION_MS) {
        this._failRun(run, `Exceeded max run duration (${MAX_RUN_DURATION_MS / 1000}s)`);
        return;
      }

      const step = template.steps[stepIndex];
      const stepResult = run.stepResults[stepIndex];
      if (run.status === 'cancelled' || run.status === 'rejected') return;

      // ── Approval gate ──────────────────────────────────────────────
      // Three triggers: explicit type, opt-in flag, destructive guard.
      // We pause only when not yet approved (stepResult.approvedBy unset).
      const alreadyApproved = !!stepResult.approvedBy;
      let approvalReason: string | null = null;
      if (!alreadyApproved) {
        if (step.type === 'approval') {
          approvalReason = 'explicit approval step';
        } else if (step.requiresApproval) {
          approvalReason = 'requires_approval flag';
        } else if (step.type === 'command') {
          const guard = inspectDestructive(step.command);
          if (guard) approvalReason = `destructive command pattern: ${guard.pattern} (${guard.description})`;
        }
      }
      if (approvalReason && !alreadyApproved) {
        stepResult.status = 'waiting_approval';
        run.status = 'waiting_approval';
        run.currentStepIndex = stepIndex;
        if (this.deps.approvalStore) {
          try {
            const approval = this.deps.approvalStore.create({
              runId: run.id, stepId: step.id, stepDescription: step.description,
              reason: approvalReason, requestedBy: run.triggeredBy,
            });
            this._emit('approval:request', {
              id: approval.id, runbookName: template.name, runId: run.id,
              stepId: step.id, stepDescription: step.description, reason: approvalReason,
              requestedBy: run.triggeredBy, requestedAt: approval.requestedAt,
            });
          } catch (e) {
            logger.warn('[RunbookEngine] approval create failed', { runId: run.id, err: e instanceof Error ? e.message : String(e) });
          }
        }
        this._persistRun(run);
        this._emit('runbook_waiting_approval', { runId: run.id, stepIndex, reason: approvalReason });
        return; // resumed via approveStep / rejectStep
      }

      stepResult.status = 'running';
      stepResult.startedAt = new Date().toISOString();
      run.currentStepIndex = stepIndex;
      this._persistRun(run);
      this._emit('runbook_step_start', { runId: run.id, stepIndex, step: stepResult });

      let outcome: { ok: boolean; goto?: string };
      try {
        switch (step.type) {
          case 'approval':
            // Reached here only on re-entry after approval — mark done.
            stepResult.status = 'success';
            outcome = { ok: true };
            break;
          case 'action':
            outcome = await this.execAction(step, stepResult);
            if (stepResult.output) lastOutput = stepResult.output;
            break;
          case 'command':
            outcome = await this.execCommand(step, stepResult);
            if (stepResult.output) lastOutput = stepResult.output;
            if (typeof stepResult.exitCode === 'number') lastExitCode = stepResult.exitCode;
            break;
          case 'check_metric': {
            const r = await this.execCheckMetric(step, stepResult);
            outcome = r.outcome;
            if (typeof r.value === 'number') lastMetricValue = r.value;
            break;
          }
          case 'wait':
            outcome = await this.execWait(step, stepResult);
            break;
          case 'escalate':
            outcome = await this.execEscalate(step, stepResult, run);
            break;
          case 'resolve':
            outcome = await this.execResolve(step, stepResult, run);
            break;
          case 'condition':
            outcome = this.execCondition(step, stepResult, lastOutput, lastExitCode, lastMetricValue);
            break;
          case 'notification':
            outcome = await this.execNotification(step, stepResult);
            break;
          default: {
            const _: never = step;
            void _;
            outcome = { ok: false };
            stepResult.error = 'Unknown step type';
          }
        }
      } catch (e) {
        outcome = { ok: false };
        stepResult.error = e instanceof Error ? e.message : String(e);
        stepResult.status = 'failed';
      }

      stepResult.completedAt = new Date().toISOString();
      if (outcome.ok && stepResult.status === 'running') stepResult.status = 'success';
      if (!outcome.ok && stepResult.status === 'running') stepResult.status = 'failed';
      this._persistRun(run);
      this._emit('runbook_step_complete', { runId: run.id, stepIndex, result: stepResult });

      // Routing.
      const next = outcome.goto
        ?? (outcome.ok ? step.onSuccess : step.onFailure)
        ?? undefined;
      if (next === 'end') break;
      if (!outcome.ok && next === undefined) {
        this._failRun(run, stepResult.error || `Step "${step.id}" failed`);
        return;
      }
      if (next) {
        const idx = template.steps.findIndex(s => s.id === next);
        if (idx === -1) {
          this._failRun(run, `Step "${step.id}" targets unknown next step "${next}"`);
          return;
        }
        stepIndex = idx;
      } else {
        stepIndex++;
      }
    }

    run.status = 'completed';
    run.completedAt = new Date().toISOString();
    this._persistRun(run);
    this._emit('runbook_completed', { runId: run.id, run });
  }

  // ─── Step executors ───────────────────────────────────────────────────

  private async execAction(step: Extract<RunbookStep, { type: 'action' }>, stepResult: RunbookStepResult): Promise<{ ok: boolean }> {
    if (!this.deps.skillManager) {
      stepResult.error = 'No skillManager configured';
      return { ok: false };
    }
    let attempts = 0;
    const maxRetries = step.retryPolicy?.maxRetries ?? 0;
    while (attempts <= maxRetries) {
      try {
        const output = await this.deps.skillManager.execute(step.command, step.params);
        stepResult.output = output;
        return { ok: true };
      } catch (e) {
        attempts++;
        stepResult.retryCount = attempts;
        if (attempts <= maxRetries) {
          const delay = (step.retryPolicy?.backoffMs ?? 1000) * Math.pow(step.retryPolicy?.backoffMultiplier ?? 1, attempts - 1);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        stepResult.error = e instanceof Error ? e.message : String(e);
        return { ok: false };
      }
    }
    stepResult.error = 'Action exhausted retries';
    return { ok: false };
  }

  private async execCommand(step: Extract<RunbookStep, { type: 'command' }>, stepResult: RunbookStepResult): Promise<{ ok: boolean }> {
    if (!this.deps.remoteExecutor || !this.deps.serverRegistry) {
      stepResult.error = 'No RemoteExecutor or ServerRegistry configured';
      return { ok: false };
    }
    const server = this.deps.serverRegistry.get(step.serverId);
    if (!server) {
      stepResult.error = `Unknown server "${step.serverId}"`;
      return { ok: false };
    }
    try {
      const result = await this.deps.remoteExecutor.execute(server, step.command, { timeoutMs: step.timeoutMs });
      stepResult.output = [result.stdout, result.stderr ? `[stderr] ${result.stderr}` : ''].filter(Boolean).join('\n').trim();
      stepResult.exitCode = result.exitCode;
      return { ok: result.exitCode === 0 };
    } catch (e) {
      stepResult.error = e instanceof Error ? e.message : String(e);
      return { ok: false };
    }
  }

  private async execCheckMetric(step: Extract<RunbookStep, { type: 'check_metric' }>, stepResult: RunbookStepResult): Promise<{ outcome: { ok: boolean }; value?: number }> {
    if (!this.deps.metricsHistory) {
      stepResult.error = 'No MetricsHistoryStore configured';
      return { outcome: { ok: false } };
    }
    const samples = this.deps.metricsHistory.latest(step.serverId);
    let value: number | undefined;
    if (step.metric === 'disk') {
      // Use the worst (highest) reading across mounts.
      const disks = samples.filter(s => s.metricType === 'disk').map(s => s.value);
      if (disks.length) value = Math.max(...disks);
    } else {
      const s = samples.find(s => s.metricType === step.metric);
      value = s?.value;
    }
    if (value === undefined) {
      stepResult.error = `No recent ${step.metric} reading for server ${step.serverId}`;
      return { outcome: { ok: false } };
    }
    const passed = compare(value, step.operator, step.threshold);
    stepResult.output = `${step.metric}=${value.toFixed(1)} ${step.operator} ${step.threshold} → ${passed}`;
    return { outcome: { ok: passed }, value };
  }

  private async execWait(step: Extract<RunbookStep, { type: 'wait' }>, stepResult: RunbookStepResult): Promise<{ ok: boolean }> {
    const seconds = Math.max(0, Math.min(step.seconds, 600));
    stepResult.output = `Waiting ${seconds}s`;
    await new Promise(r => setTimeout(r, seconds * 1000));
    return { ok: true };
  }

  private async execEscalate(step: Extract<RunbookStep, { type: 'escalate' }>, stepResult: RunbookStepResult, run: RunbookRun): Promise<{ ok: boolean }> {
    if (!this.deps.incidentManager) {
      stepResult.error = 'No IncidentManager configured';
      return { ok: false };
    }
    const incidentId = run.context?.incidentId;
    if (!incidentId) {
      stepResult.error = 'escalate step requires context.incidentId';
      return { ok: false };
    }
    const updated = this.deps.incidentManager.escalate(incidentId, step.reason);
    if (!updated) {
      stepResult.error = `Could not escalate ${incidentId} (incident not found?)`;
      return { ok: false };
    }
    stepResult.output = `Escalated ${updated.id} → severity ${updated.severity}, status ${updated.status}`;
    return { ok: true };
  }

  private async execResolve(step: Extract<RunbookStep, { type: 'resolve' }>, stepResult: RunbookStepResult, run: RunbookRun): Promise<{ ok: boolean }> {
    if (!this.deps.incidentManager) {
      stepResult.error = 'No IncidentManager configured';
      return { ok: false };
    }
    const incidentId = run.context?.incidentId;
    if (!incidentId) {
      stepResult.error = 'resolve step requires context.incidentId';
      return { ok: false };
    }
    const updated = this.deps.incidentManager.resolve(incidentId, step.resolution);
    if (!updated) {
      stepResult.error = `Could not resolve ${incidentId} (incident not found?)`;
      return { ok: false };
    }
    stepResult.output = `Resolved ${updated.id}`;
    return { ok: true };
  }

  private execCondition(
    step: Extract<RunbookStep, { type: 'condition' }>,
    stepResult: RunbookStepResult,
    lastOutput: string,
    lastExitCode: number,
    lastMetricValue: number | undefined,
  ): { ok: boolean; goto: string } {
    // Structured form takes precedence; falls back to the legacy
    // substring-match `expression` for unchanged old templates.
    let matched: boolean;
    if (step.check) {
      const op = step.operator ?? '==';
      const target = step.value;
      switch (step.check) {
        case 'last_exit_code':
          matched = compare(lastExitCode, op as any, Number(target ?? 0));
          break;
        case 'last_output_contains':
          matched = typeof target === 'string' && lastOutput.toLowerCase().includes(target.toLowerCase());
          break;
        case 'metric_value':
          matched = typeof lastMetricValue === 'number' && compare(lastMetricValue, op as any, Number(target ?? 0));
          break;
        default:
          matched = false;
      }
    } else if (step.expression) {
      matched = lastOutput.includes(step.expression);
    } else {
      matched = false;
    }
    stepResult.status = 'success';
    stepResult.output = `Condition ${matched ? 'matched' : 'did not match'} — jumping to "${matched ? step.onTrue : step.onFalse}"`;
    return { ok: true, goto: matched ? step.onTrue : step.onFalse };
  }

  private async execNotification(step: Extract<RunbookStep, { type: 'notification' }>, stepResult: RunbookStepResult): Promise<{ ok: boolean }> {
    if (!this.deps.skillManager) {
      // Notifications are best-effort — never fail the run for a missing
      // notifier. Same policy the legacy engine had.
      stepResult.output = 'No skillManager — notification skipped';
      return { ok: true };
    }
    try {
      const output = await this.deps.skillManager.execute(step.command, step.params);
      stepResult.output = output;
    } catch (e) {
      stepResult.output = `Notification skill threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { ok: true };
  }

  // ─── Private helpers ──────────────────────────────────────────────────

  /** Metric-threshold matcher uses this to debounce. Per (templateId, serverId)
   *  pair, return true if the runbook may fire again. */
  metricCooldownExpired(templateId: string, serverId: string, cooldownSeconds: number): boolean {
    const key = `${templateId}::${serverId}`;
    const last = this.metricCooldown.get(key) ?? 0;
    if (Date.now() - last >= cooldownSeconds * 1000) {
      this.metricCooldown.set(key, Date.now());
      return true;
    }
    return false;
  }

  private _failRun(run: RunbookRun, error: string): void {
    run.status = 'failed';
    run.error = error;
    run.completedAt = new Date().toISOString();
    this._persistRun(run);
    this._emit('runbook_failed', { runId: run.id, error });
  }

  private _emit(type: string, data: unknown): void {
    this.deps.broadcast?.({ type, data });
  }
}

function compare(a: number, op: '<' | '>' | '<=' | '>=' | '==' | '!=', b: number): boolean {
  switch (op) {
    case '<':  return a < b;
    case '>':  return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default:   return false;
  }
}

void DEFAULT_APPROVAL_TIMEOUT_MS;

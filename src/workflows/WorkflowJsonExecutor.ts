// Executes a validated WorkflowDef.
//
// What this gets you over the existing imperative WorkflowEngine /
// RunbookEngine:
//   - JSON file in, structured run record out.
//   - Step types map to existing infrastructure (SkillManager, fetch,
//     ApprovalTokenService) so the executor doesn't reimplement bash,
//     HTTP, or delegation — it just orchestrates.
//   - Input/output bindings: any string field in a step is template-
//     expanded before the step runs. Tokens:
//         ${inputs.<name>}     — workflow input
//         ${steps.<id>.ok}     — true when the step's SkillResult.ok was true
//         ${steps.<id>.summary} | ${steps.<id>.error}
//         ${steps.<id>.data.<dotted-path>}
//     Missing tokens render as the empty string. We don't try to be
//     clever with type coercion — params come out as strings and are
//     coerced by the consuming step.
//   - Per-step error policy (fail | continue | goto:<id>) overrides the
//     workflow-level default. This is how real workflows recover from
//     transient skill failures without aborting the whole run.

import { createLogger } from '../observability/Logger.js';
import type { ApprovalTokenService } from '../security/index.js';
import type { SkillManager } from '../skills/index.js';
import type {
  ApiCallStep,
  ApprovalGateStep,
  BashStep,
  ConditionalStep,
  DelegationStep,
  SkillStep,
  WorkflowDef,
  WorkflowOnError,
  WorkflowStep,
} from './WorkflowDef.js';

const log = createLogger({ component: 'workflow-executor' });

export type StepStatus = 'success' | 'failed' | 'skipped' | 'pending_approval';

export interface StepResult {
  id: string;
  type: WorkflowStep['type'];
  status: StepStatus;
  startedAt: string;
  completedAt: string;
  /** Parsed SkillResult when the step came from SkillManager; otherwise the
   *  raw value the step type produced. Always JSON-serialisable. */
  output?: unknown;
  error?: string;
  /** For conditional steps: which branch was chosen. */
  branch?: 'then' | 'else' | 'fallthrough';
}

export interface WorkflowRunRecord {
  /** Stable id assigned at run creation; not the workflow id. */
  runId: string;
  workflowId: string;
  workflowVersion: string;
  status: 'completed' | 'failed' | 'pending_approval';
  startedAt: string;
  completedAt: string;
  inputs: Record<string, unknown>;
  steps: StepResult[];
  /** Set when status=failed — populated from the failing step's error. */
  error?: string;
  /** Set when status=pending_approval — the approval the run is waiting on. */
  awaitingApproval?: { stepId: string; command: string; ttlSeconds: number };
}

export interface ExecuteOptions {
  /** Workflow input values (validated against WorkflowDef.inputs). */
  inputs?: Record<string, unknown>;
  /** Pre-collected approval tokens, keyed by approval-gate step id. Lets a
   *  caller resume a previously-paused workflow by passing the tokens it
   *  collected since. */
  approvals?: Record<string, string>;
  /** Caller-supplied id; the executor generates one when missing. */
  runId?: string;
  /** Used by step `delegation` to identify the workflow as the caller. */
  invokerAgentId?: string;
}

export interface WorkflowExecutorDeps {
  skillManager: SkillManager;
  approvals?: ApprovalTokenService;
  /** Inject for tests — defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Inject for tests — defaults to crypto.randomUUID(). */
  newId?: () => string;
  /** Inject for tests — defaults to () => new Date(). */
  now?: () => Date;
}

export class WorkflowJsonExecutor {
  private readonly skillManager: SkillManager;
  private readonly approvals?: ApprovalTokenService;
  private readonly fetchImpl: typeof fetch;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(deps: WorkflowExecutorDeps) {
    this.skillManager = deps.skillManager;
    this.approvals    = deps.approvals;
    this.fetchImpl    = deps.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch);
    this.newId        = deps.newId    ?? (() => `wfrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.now          = deps.now      ?? (() => new Date());
  }

  /**
   * Run a workflow from a validated WorkflowDef. The caller is responsible
   * for validating the def first (validateWorkflowDef in WorkflowDef.ts).
   * Throwing is reserved for programmer errors (unknown step.type after
   * validation, missing approvals service when required) — workflow logic
   * failures land in the run record's error field.
   */
  async execute(workflow: WorkflowDef, opts: ExecuteOptions = {}): Promise<WorkflowRunRecord> {
    const runId = opts.runId ?? this.newId();
    const startedAt = this.now().toISOString();
    const inputs = this.applyInputDefaults(workflow, opts.inputs ?? {});
    const stepIndex = new Map(workflow.steps.map(s => [s.id, s]));
    const results = new Map<string, StepResult>();

    let stepCursor: string | null = workflow.steps[0]?.id ?? null;
    let outcome: 'completed' | 'failed' | 'pending_approval' = 'completed';
    let errMsg: string | undefined;
    let awaiting: WorkflowRunRecord['awaitingApproval'];

    // When a conditional fires and picks a branch, the chosen step runs and
    // then control should jump *past* the alternative branch. We record the
    // post-branch cursor here, keyed by the branch step id, so when the
    // branch step finishes we skip the else-block instead of falling
    // through into it.
    const exitCursor = new Map<string, string | null>();

    log.info('workflow run starting', { runId, workflowId: workflow.id, version: workflow.version });

    while (stepCursor) {
      const step: WorkflowStep | undefined = stepIndex.get(stepCursor);
      if (!step) {
        outcome = 'failed';
        errMsg = `step "${stepCursor}" not found`;
        break;
      }

      // Skip steps already executed (conditional + goto cycles): record skip
      // and move on to the next sequential step instead of looping forever.
      if (results.has(step.id)) {
        log.debug('skipping previously-executed step', { runId, stepId: step.id });
        stepCursor = this.nextSequential(workflow, step.id);
        continue;
      }

      const result = await this.runStep(step, { workflow, inputs, results, opts });
      results.set(step.id, result);
      log.info('workflow step finished', { runId, stepId: step.id, status: result.status });

      if (result.status === 'pending_approval') {
        outcome = 'pending_approval';
        awaiting = {
          stepId: step.id,
          command: (step as ApprovalGateStep).command,
          ttlSeconds: (step as ApprovalGateStep).ttlSeconds ?? 600,
        };
        break;
      }

      if (result.status === 'failed') {
        const policy = step.onError ?? workflow.onError ?? 'fail';
        const recovered = this.applyErrorPolicy(policy, workflow, step.id);
        if (recovered === 'fail') {
          outcome = 'failed';
          errMsg = result.error;
          break;
        }
        // 'continue' or goto — pick the next cursor and keep going.
        stepCursor = recovered;
        continue;
      }

      // Conditional steps drive the cursor explicitly. We also stash the
      // "after both branches" cursor against the chosen branch step so the
      // chosen step doesn't fall through into its sibling.
      if (step.type === 'conditional') {
        const c = step as ConditionalStep;
        const afterBranch = this.afterBothBranches(workflow, c);
        if (result.branch === 'then') {
          exitCursor.set(c.then, afterBranch);
          stepCursor = c.then;
        } else if (result.branch === 'else' && c.else) {
          exitCursor.set(c.else, afterBranch);
          stepCursor = c.else;
        } else {
          stepCursor = afterBranch;
        }
        continue;
      }

      // After a branch-targeted step finishes, jump past the alternative
      // branch (if recorded) instead of falling through sequentially.
      if (exitCursor.has(step.id)) {
        stepCursor = exitCursor.get(step.id) ?? null;
        exitCursor.delete(step.id);
        continue;
      }

      stepCursor = this.nextSequential(workflow, step.id);
    }

    const completedAt = this.now().toISOString();
    return {
      runId,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      status: outcome,
      startedAt,
      completedAt,
      inputs,
      steps: Array.from(results.values()),
      ...(errMsg ? { error: errMsg } : {}),
      ...(awaiting ? { awaitingApproval: awaiting } : {}),
    };
  }

  // ─── Step executors ────────────────────────────────────────────────────

  private async runStep(
    step: WorkflowStep,
    ctx: { workflow: WorkflowDef; inputs: Record<string, unknown>; results: Map<string, StepResult>; opts: ExecuteOptions },
  ): Promise<StepResult> {
    const startedAt = this.now().toISOString();
    const base: Pick<StepResult, 'id' | 'type' | 'startedAt'> = {
      id: step.id, type: step.type, startedAt,
    };
    try {
      switch (step.type) {
        case 'bash':           return await this.runBash(step, ctx, base);
        case 'skill':          return await this.runSkill(step, ctx, base);
        case 'api_call':       return await this.runApiCall(step, ctx, base);
        case 'delegation':     return await this.runDelegation(step, ctx, base);
        case 'approval_gate':  return this.runApproval(step, ctx, base);
        case 'conditional':    return this.runConditional(step, ctx, base);
        default: {
          const _exhaustive: never = step;
          throw new Error(`unknown step type: ${(_exhaustive as { type: string }).type}`);
        }
      }
    } catch (err: any) {
      return {
        ...base,
        status: 'failed',
        completedAt: this.now().toISOString(),
        error: err?.message ?? String(err),
      };
    }
  }

  private async runBash(step: BashStep, ctx: ExecCtx, base: BaseRes): Promise<StepResult> {
    const command = expand(step.command, ctx);
    const params: Record<string, unknown> = { command };
    if (step.cwd     !== undefined) params.cwd     = expand(step.cwd, ctx);
    if (step.timeout !== undefined) params.timeout = step.timeout;
    const raw = await this.skillManager.execute('bash.exec', params);
    return this.fromSkillResult(raw, base);
  }

  private async runSkill(step: SkillStep, ctx: ExecCtx, base: BaseRes): Promise<StepResult> {
    const params = expandObject(step.params ?? {}, ctx) as Record<string, unknown>;
    const raw = await this.skillManager.execute(step.skill, params);
    return this.fromSkillResult(raw, base);
  }

  private async runApiCall(step: ApiCallStep, ctx: ExecCtx, base: BaseRes): Promise<StepResult> {
    const url = expand(step.url, ctx);
    const method = step.method ?? 'GET';
    const headers = step.headers
      ? Object.fromEntries(Object.entries(step.headers).map(([k, v]) => [k, expand(v, ctx)]))
      : undefined;
    const body = step.body !== undefined
      ? JSON.stringify(expandObject(step.body, ctx))
      : undefined;

    const ac = new AbortController();
    const timeoutMs = step.timeoutMs ?? 30_000;
    const t = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    const expectStatus = step.expectStatus ?? null;
    const ok = expectStatus
      ? expectStatus.includes(res.status)
      : res.status >= 200 && res.status < 300;
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }

    if (!ok) {
      return {
        ...base,
        status: 'failed',
        completedAt: this.now().toISOString(),
        output: { status: res.status, body: parsed },
        error: `HTTP ${res.status}`,
      };
    }
    return {
      ...base,
      status: 'success',
      completedAt: this.now().toISOString(),
      output: { ok: true, status: res.status, data: parsed },
    };
  }

  private async runDelegation(step: DelegationStep, ctx: ExecCtx, base: BaseRes): Promise<StepResult> {
    const params: Record<string, unknown> = {
      toAgentId: step.toAgentId,
      objective: expand(step.objective, ctx),
    };
    if (step.context !== undefined) params.context = expand(step.context, ctx);
    const raw = await this.skillManager.execute(
      'delegate.ask',
      params,
      ctx.opts.invokerAgentId ? { callerAgentId: ctx.opts.invokerAgentId } : undefined,
    );
    return this.fromSkillResult(raw, base);
  }

  private runApproval(step: ApprovalGateStep, ctx: ExecCtx, base: BaseRes): StepResult {
    const provided = ctx.opts.approvals?.[step.id];
    if (!provided) {
      // Pause the run — caller resumes by re-invoking execute() with the
      // collected token in opts.approvals.
      return {
        ...base,
        status: 'pending_approval',
        completedAt: this.now().toISOString(),
        output: { command: step.command, ttlSeconds: step.ttlSeconds ?? 600 },
      };
    }
    if (!this.approvals) {
      throw new Error('approval_gate step requires ApprovalTokenService to be wired');
    }
    const verdict = this.approvals.validate({
      token: provided,
      command: step.command,
      agentId: ctx.opts.invokerAgentId ?? 'workflow',
    });
    if (!verdict.valid) {
      return {
        ...base,
        status: 'failed',
        completedAt: this.now().toISOString(),
        error: verdict.reason ?? 'invalid approval',
      };
    }
    return {
      ...base,
      status: 'success',
      completedAt: this.now().toISOString(),
      output: { approver: verdict.payload?.approver },
    };
  }

  private runConditional(step: ConditionalStep, ctx: ExecCtx, base: BaseRes): StepResult {
    const value = resolve(step.when, ctx);
    let truthy: boolean;
    if (step.equals !== undefined) {
      // Compare strict by string for primitives; numbers + booleans coerced
      // by their string form to keep template-expanded values comparable.
      truthy = String(value ?? '') === String(step.equals);
    } else {
      truthy = isTruthy(value);
    }
    return {
      ...base,
      status: 'success',
      completedAt: this.now().toISOString(),
      output: { value, truthy },
      branch: truthy ? 'then' : (step.else ? 'else' : 'fallthrough'),
    };
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private fromSkillResult(raw: string, base: BaseRes): StepResult {
    let parsed: { ok?: boolean; summary?: string; data?: unknown; error?: string } = {};
    try { parsed = JSON.parse(raw); } catch {
      // Legacy prose returns are treated as success — same convention the
      // SkillManager circuit breaker uses for breaker bookkeeping.
      return {
        ...base,
        status: 'success',
        completedAt: this.now().toISOString(),
        output: { ok: true, summary: raw },
      };
    }
    if (parsed.ok) {
      return { ...base, status: 'success', completedAt: this.now().toISOString(), output: parsed };
    }
    return {
      ...base,
      status: 'failed',
      completedAt: this.now().toISOString(),
      output: parsed,
      error: parsed.error ?? parsed.summary ?? 'skill returned ok=false',
    };
  }

  private applyInputDefaults(workflow: WorkflowDef, inputs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...inputs };
    for (const def of workflow.inputs ?? []) {
      if (out[def.name] === undefined && def.default !== undefined) {
        out[def.name] = def.default;
      }
    }
    return out;
  }

  private nextSequential(workflow: WorkflowDef, currentId: string): string | null {
    const idx = workflow.steps.findIndex(s => s.id === currentId);
    if (idx === -1) return null;
    return workflow.steps[idx + 1]?.id ?? null;
  }

  /** Return the cursor position immediately after the later of a
   *  conditional's two branches in source order. Used so a chosen branch
   *  step doesn't accidentally fall through into the other branch. */
  private afterBothBranches(workflow: WorkflowDef, c: ConditionalStep): string | null {
    const idxOf = (id: string) => workflow.steps.findIndex(s => s.id === id);
    const indices = [idxOf(c.then), c.else ? idxOf(c.else) : -1].filter(i => i >= 0);
    const last = Math.max(...indices);
    return workflow.steps[last + 1]?.id ?? null;
  }

  /** Translate an onError policy into the next cursor value. Returns 'fail'
   *  when the run should abort. */
  private applyErrorPolicy(policy: WorkflowOnError, workflow: WorkflowDef, failedStepId: string): string | null | 'fail' {
    if (policy === 'fail')     return 'fail';
    if (policy === 'continue') return this.nextSequential(workflow, failedStepId);
    return policy.goto;
  }
}

// ─── Template expansion ─────────────────────────────────────────────────

interface ExecCtx {
  workflow: WorkflowDef;
  inputs: Record<string, unknown>;
  results: Map<string, StepResult>;
  opts: ExecuteOptions;
}
type BaseRes = Pick<StepResult, 'id' | 'type' | 'startedAt'>;

const TOKEN = /\$\{([^}]+)\}/g;

/** Substitute ${…} tokens in a string against the run state. Tokens that
 *  resolve to undefined render as the empty string — keeping a workflow
 *  authorable without forcing exhaustive default values. */
export function expand(template: string, ctx: ExecCtx): string {
  return template.replace(TOKEN, (_match, expr: string) => {
    const v = resolve(expr.trim(), ctx);
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Recursively expand strings inside an object / array. Non-string leaves
 *  pass through unchanged. */
export function expandObject(value: unknown, ctx: ExecCtx): unknown {
  if (typeof value === 'string') return expand(value, ctx);
  if (Array.isArray(value))      return value.map(v => expandObject(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandObject(v, ctx);
    return out;
  }
  return value;
}

/** Resolve a token expression against the run state. */
export function resolve(expr: string, ctx: ExecCtx): unknown {
  // Allow either `inputs.x.y` or `${inputs.x.y}` style strings.
  const cleaned = expr.replace(/^\$\{|\}$/g, '');
  const path = cleaned.split('.');
  const head = path.shift();
  switch (head) {
    case 'inputs': return get(ctx.inputs, path);
    case 'steps':  {
      const stepId = path.shift();
      if (!stepId) return undefined;
      const step = ctx.results.get(stepId);
      if (!step) return undefined;
      const second = path.shift();
      if (!second) return step;
      switch (second) {
        case 'ok':      return step.status === 'success';
        case 'status':  return step.status;
        case 'summary': return (step.output as { summary?: unknown })?.summary;
        case 'error':   return step.error;
        case 'data':    return get((step.output as { data?: unknown })?.data, path);
        default:        return get(step.output as Record<string, unknown> | undefined, [second, ...path]);
      }
    }
    default: return undefined;
  }
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  if (typeof v === 'string')  return v.length > 0 && v !== 'false' && v !== '0';
  return true;
}

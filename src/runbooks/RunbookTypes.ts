// Runbook type schema.
//
// Step types fall into two categories:
//   - "platform" steps — defined by the original engine, dispatched through
//     SkillManager: action, condition, approval, notification
//   - "infra" steps — added by the operator-editor work, dispatched directly
//     by RunbookEngine: command (RemoteExecutor), check_metric
//     (MetricsHistoryStore), wait, escalate / resolve (IncidentManager)
//
// All step types support optional `requiresApproval`. When set, the engine
// pauses the run and creates a RunbookApproval row before dispatching the
// step's effect. A separate runtime guard ALSO pauses any `command` step
// whose shell text matches the hardcoded destructive-patterns list — that
// guard runs regardless of `requiresApproval`, so an operator forgetting to
// flag `rm -rf` doesn't slip a wipe through.

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier?: number; // default 1 (linear); 2 = exponential
}

/** Fields common to every step type. */
interface StepBase {
  id: string;
  description: string;
  /** When true, the engine pauses before this step, creates an approval
   *  row, broadcasts `approval:request`, and resumes only after the
   *  operator decides. Defaults to false. */
  requiresApproval?: boolean;
  /** Approval timeout in ms — when exceeded, the approval auto-rejects
   *  and the step runs its onFailure branch. Defaults to 30 minutes. */
  approvalTimeoutMs?: number;
  /** Next step id to jump to on success. Omit to go to the next step in
   *  array order. Use 'end' to terminate the run. */
  onSuccess?: string;
  /** Next step id to jump to on failure. Omit to fail the run. Use 'end'
   *  to terminate normally even on failure. */
  onFailure?: string;
}

export interface ActionStep extends StepBase {
  type: 'action';
  command: string;
  params: Record<string, unknown>;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}

/** Run a shell command on a specific monitored server via RemoteExecutor.
 *  Distinct from `action` (which dispatches a registered skill) because the
 *  shell-on-server case has its own permission profile, its own timeout
 *  story, and goes through the destructive-pattern guard. */
export interface CommandStep extends StepBase {
  type: 'command';
  command: string;
  serverId: string;
  timeoutMs?: number;
}

export interface CheckMetricStep extends StepBase {
  type: 'check_metric';
  metric: 'cpu' | 'memory' | 'disk' | 'load1' | 'load5';
  serverId: string;
  operator: '<' | '>' | '<=' | '>=' | '==';
  threshold: number;
}

export interface WaitStep extends StepBase {
  type: 'wait';
  seconds: number;
}

export interface EscalateStep extends StepBase {
  type: 'escalate';
  reason: string;
}

export interface ResolveStep extends StepBase {
  type: 'resolve';
  resolution: string;
}

export interface ConditionStep extends StepBase {
  type: 'condition';
  /** Legacy: substring match against the prior step output. Still
   *  honoured when present so existing runbooks keep working. */
  expression?: string;
  /** New form: structured check + operator + value. Preferred for new
   *  runbooks. When both `expression` and `check` are set, `check`
   *  wins. */
  check?: 'last_exit_code' | 'last_output_contains' | 'metric_value';
  operator?: '<' | '>' | '<=' | '>=' | '==' | '!=';
  value?: number | string;
  onTrue: string;
  onFalse: string;
}

export interface ApprovalStep extends StepBase {
  type: 'approval';
  message: string;
  timeout?: number;
}

export interface NotificationStep extends StepBase {
  type: 'notification';
  command: string;
  params: Record<string, unknown>;
}

export type RunbookStep =
  | ActionStep
  | CommandStep
  | CheckMetricStep
  | WaitStep
  | EscalateStep
  | ResolveStep
  | ConditionStep
  | ApprovalStep
  | NotificationStep;

// ── Triggers ────────────────────────────────────────────────────────────

export type TriggerType = 'manual' | 'incident_match' | 'metric_threshold';

/** Match incidents on these fields. All present fields must match (AND).
 *  String fields use LIKE — `%` is a wildcard, escape literal % with `\%`. */
export interface IncidentMatchConfig {
  /** LIKE pattern against `incident.sourceRef` (e.g. `"disk:%"`). */
  sourceRef?: string;
  /** Minimum severity — match runs at this level and above. */
  severity?: 'low' | 'medium' | 'high' | 'critical';
  /** Exact match on `incident.serverId`. */
  serverId?: string;
  /** LIKE pattern against `incident.title`. */
  title?: string;
}

export interface MetricThresholdConfig {
  metric: 'cpu' | 'memory' | 'disk' | 'load1' | 'load5';
  operator: '<' | '>' | '<=' | '>=' | '==';
  threshold: number;
  /** When omitted, matches every server. */
  serverId?: string;
  /** Cooldown between consecutive auto-executions in seconds. Default 300. */
  cooldownSeconds?: number;
}

export type TriggerConfig = IncidentMatchConfig | MetricThresholdConfig | Record<string, never>;

// ── Template + run shapes ───────────────────────────────────────────────

export interface RunbookTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  steps: RunbookStep[];
  tags: string[];
  /** Defaults to 'manual'. */
  triggerType?: TriggerType;
  /** Shape depends on triggerType. */
  triggerConfig?: TriggerConfig;
  /** When false, the matcher skips this runbook even if its trigger config
   *  matches. Default true. */
  enabled?: boolean;
  /** Whose login created the template — captured for the audit trail when
   *  the API mints a runbook. Optional so legacy + library entries don't
   *  need rewrites. */
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export type RunbookStatus = 'running' | 'completed' | 'failed' | 'waiting_approval' | 'cancelled' | 'rejected' | 'timeout';
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'waiting_approval' | 'rejected';

export interface RunbookStepResult {
  stepId: string;
  stepIndex: number;
  type: RunbookStep['type'];
  description: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  retryCount?: number;
  approvedBy?: string;
  rejectedBy?: string;
  /** Captured exit code for `command` steps so the next `condition` step
   *  can branch on `check: 'last_exit_code'`. */
  exitCode?: number;
}

export interface RunbookRunContext {
  incidentId?: string;
  serverId?: string;
  /** Username of the operator who triggered the run, if interactive. */
  user?: string;
}

export interface RunbookRun {
  id: string;
  templateId: string;
  templateName: string;
  triggeredBy: string;
  status: RunbookStatus;
  currentStepIndex: number;
  stepResults: RunbookStepResult[];
  context?: RunbookRunContext;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

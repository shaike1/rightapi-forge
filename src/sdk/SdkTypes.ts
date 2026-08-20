// Type contracts for the Self-Development SDK.
//
// The SDK lets the platform extend itself: an operator (or agent)
// describes a feature, the SDK turns the description into a plan,
// generates code + tests, scans for security issues, runs the new
// code in the sandbox, optionally commits + deploys.
//
// Code generation is deterministic + template-driven. There's no LLM
// in this module — the templates are well-known shapes the existing
// skill / workflow catalogue already proved out, and a LLM-assisted
// polish pass is a follow-up that can sit in front of these types
// without changing them.

// ─── Spec inputs ──────────────────────────────────────────────────────

/** Parameter declaration for a generated skill. The shape mirrors the
 *  existing skill `Command.parameters` field but is tightened so the
 *  generator can emit typed handler signatures. */
export interface SkillParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required?: boolean;
  /** Sample value used in the auto-generated test fixture. */
  example?: unknown;
}

/** Input to generateSkill(). The caller provides a plain-language
 *  `logic` string + optional shell command(s) that describe what the
 *  skill should run. The generator wraps them in a SkillResult-shape
 *  handler with parameter validation + bash.exec invocations. */
export interface SkillSpec {
  /** Skill id; lowercased dotted (e.g. "monitor.diskInspect"). */
  id: string;
  name: string;
  description: string;
  category?: 'infrastructure' | 'monitoring' | 'deployment' | 'security' | 'service-management' | 'general';
  tags?: string[];
  parameters: SkillParam[];
  /** One or more shell commands the handler will execute, in order.
   *  Tokens like {{paramName}} are substituted with shellEscape()d
   *  parameter values at runtime. */
  commands: string[];
  /** Optional natural-language explanation of intended behaviour.
   *  Lands in the file header comment for future readers. */
  logic?: string;
}

/** Spec for a generated WorkflowDef. Mirrors the existing
 *  WorkflowDef shape but pre-typed so the SDK doesn't import the
 *  workflows module at this seam (avoids circular module deps). */
export interface WorkflowSpec {
  id: string;
  name: string;
  description?: string;
  version?: string;
  tags?: string[];
  inputs?: SkillParam[];
  /** Steps in the same shape WorkflowDef accepts. We keep them as
   *  plain records here; the validator runs at registration time. */
  steps: Array<Record<string, unknown>>;
}

// ─── Test fixtures ────────────────────────────────────────────────────

/** A self-test the SDK runs against generated code in the sandbox.
 *  `params` is the inputs object, `expect.ok` asserts the SkillResult
 *  outcome, `expect.summaryIncludes` is a substring match against the
 *  result summary. Both expectations are optional — if neither is
 *  provided the test only asserts the handler doesn't throw. */
export interface TestCase {
  name: string;
  command: string;
  params?: Record<string, unknown>;
  expect?: {
    ok?: boolean;
    summaryIncludes?: string;
  };
}

export interface TestResult {
  name: string;
  passed: boolean;
  duration_ms: number;
  output?: string;
  error?: string;
}

// ─── Plan / execution ────────────────────────────────────────────────

/** Atomic change the SDK proposes against the source tree. Files are
 *  always written under src/ to keep the radius bounded; absolute
 *  paths are rejected by the writer. */
export interface FileChange {
  /** Path relative to the repo root. Must start with "src/". */
  path: string;
  contents: string;
  /** "add" creates the file (errors if it exists), "overwrite" replaces
   *  in place. We never expose "delete" through this interface — the
   *  SDK's job is to grow the platform, not prune it. */
  mode: 'add' | 'overwrite';
}

export type FeatureKind = 'skill' | 'workflow' | 'plugin';

export interface FeaturePlan {
  /** Stable id for the plan; persisted into history rows. */
  id: string;
  /** Operator-supplied description that started the request. */
  description: string;
  /** Kind of feature the SDK decided to build. Affects which template
   *  the generator runs. */
  kind: FeatureKind;
  /** What the generator will actually emit. */
  files: FileChange[];
  /** Self-tests the SDK will run against the generated code. */
  tests: TestCase[];
  /** Security scanner verdict + the code spans that triggered it. */
  scanFindings: SecurityFinding[];
  /** Per-step list — populated as the plan is executed. Stays empty on
   *  a `plan-only` call. */
  steps: PlanStepLog[];
  createdAt: string;
}

/** Each high-level step of an execution. Keeps a paper trail of what
 *  fired + what came out, so the dashboard can stream progress + the
 *  history endpoint shows what happened. */
export interface PlanStepLog {
  /** "analyze" | "generate" | "scan" | "write" | "test" | "commit" | "deploy" */
  step: string;
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
  startedAt: string;
  completedAt: string;
  details?: unknown;
}

/** Verdict from the security scanner. severity: 'block' refuses to
 *  proceed; 'warn' is logged but does not gate. */
export interface SecurityFinding {
  severity: 'warn' | 'block';
  pattern: string;
  message: string;
  file?: string;
  line?: number;
  snippet?: string;
}

// ─── History ──────────────────────────────────────────────────────────

/** What the GET /api/sdk/history endpoint returns. Sourced from the
 *  EventStore — every plan and execution emits a self-development.*
 *  event. */
export interface DevelopmentAction {
  id: string;
  at: string;
  actor: string;
  description: string;
  kind: FeatureKind;
  outcome: 'planned' | 'completed' | 'failed' | 'rejected';
  /** Optional pointers — branch + workflow run id for committed +
   *  deployed actions. */
  branch?: string;
  workflowRunId?: number;
  durationMs?: number;
  /** Number of files written in this action. */
  files?: number;
  testsPassed?: number;
  testsFailed?: number;
}

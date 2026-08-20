// JSON workflow definition + JSON Schema validation.
//
// A workflow is an ordered list of steps — each step is one of the typed
// variants below. Steps can read prior step outputs via ${steps.<id>.…}
// template tokens, branch on conditions, and pause at approval gates.
//
// Why a fresh module instead of extending RunbookEngine: RunbookEngine has
// a TS-typed step catalogue but no JSON schema, no input/output bindings,
// no api_call step, no conditional with expression evaluation, and no
// validation pipeline at load time. This module is positioned as the
// declarative-JSON layer; RunbookEngine remains for the older imperative
// runbook flow.
//
// The schema lives next to the types and is consumed by Ajv at load time
// so a malformed workflow file is rejected with a precise error before
// any step runs.

export type WorkflowStepType =
  | 'bash'
  | 'skill'
  | 'api_call'
  | 'delegation'
  | 'approval_gate'
  | 'conditional';

/** What to do if this individual step fails. fail = whole workflow fails;
 *  continue = log + move on; goto:<id> = jump to a recovery step. */
export type WorkflowOnError =
  | 'fail'
  | 'continue'
  | { goto: string };

interface WorkflowStepBase {
  /** Unique within the workflow. Lets later steps reference output. */
  id: string;
  type: WorkflowStepType;
  /** Optional — surfaces in logs + the run's step result. */
  description?: string;
  /** Per-step error policy. Falls back to workflow.onError. */
  onError?: WorkflowOnError;
  /** Hard timeout for the step (ms). The workflow-wide default is 60s. */
  timeoutMs?: number;
}

/** Run a shell command via skill `bash.exec`. */
export interface BashStep extends WorkflowStepBase {
  type: 'bash';
  command: string;          // template-expanded
  cwd?: string;
  timeout?: number;         // legacy alias forwarded to bash.exec
}

/** Invoke any registered skill command. */
export interface SkillStep extends WorkflowStepBase {
  type: 'skill';
  skill: string;            // dot-notation, e.g. "monitor.systemHealth"
  params?: Record<string, unknown>;
}

/** Call an HTTP endpoint. Body / headers go through template expansion. */
export interface ApiCallStep extends WorkflowStepBase {
  type: 'api_call';
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;           // serialised as JSON when set
  /** Status codes considered success. Default: 2xx. */
  expectStatus?: number[];
}

/** Delegate the task to another agent and (optionally) wait for the answer. */
export interface DelegationStep extends WorkflowStepBase {
  type: 'delegation';
  toAgentId: string;
  objective: string;        // template-expanded
  context?: string;
}

/** Pauses execution until an approval token is presented for `command`. */
export interface ApprovalGateStep extends WorkflowStepBase {
  type: 'approval_gate';
  command: string;          // logical command the approval covers
  ttlSeconds?: number;
}

/** Branch on a JSON-pointer-ish expression evaluated against the run state. */
export interface ConditionalStep extends WorkflowStepBase {
  type: 'conditional';
  /** Reference: "${steps.foo.ok}" or "${inputs.severity}". When the value is
   *  a string, comparison uses substring match; otherwise strict equality. */
  when: string;
  equals?: string | number | boolean;
  /** Step id to run when the condition is true. */
  then: string;
  /** Step id to run when the condition is false (optional — falls through). */
  else?: string;
}

export type WorkflowStep =
  | BashStep
  | SkillStep
  | ApiCallStep
  | DelegationStep
  | ApprovalGateStep
  | ConditionalStep;

export interface WorkflowInputDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface WorkflowDef {
  /** Schema version this file was authored against. Bump when breaking. */
  schemaVersion: 1;
  /** User-visible workflow id — must be unique in the registry. */
  id: string;
  name: string;
  description?: string;
  /** Author-defined version label, e.g. "1.2.0". Free-form; the executor
   *  doesn't interpret it but stores it on each run for traceability. */
  version: string;
  inputs?: WorkflowInputDef[];
  steps: WorkflowStep[];
  /** Default error policy used when a step doesn't set its own. */
  onError?: WorkflowOnError;
  /** Workflow-level hard timeout (ms). Run aborts when exceeded. */
  timeoutMs?: number;
  /** Optional metadata for ops dashboards. */
  tags?: string[];
}

// ─── JSON Schema ──────────────────────────────────────────────────────────
//
// Hand-rolled to avoid pulling Ajv (we don't have it in dependencies and
// JSON Schema → JS is straightforward for our shape). Validation is done
// by validateWorkflowDef() below: it returns a list of human-readable
// errors with JSON-pointer paths, suitable for surfacing through the API
// or printing to a file-load log.
//
// We export the schema as a JSON object too so a future commit can hand
// it to a JSON Schema-aware editor (VS Code "json.schemas" config) for
// in-editor validation + completion — that integration costs nothing now.

export const WORKFLOW_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://itops-agents/workflow.schema.json',
  title: 'WorkflowDef',
  type: 'object',
  required: ['schemaVersion', 'id', 'name', 'version', 'steps'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id:            { type: 'string', minLength: 1 },
    name:          { type: 'string', minLength: 1 },
    description:   { type: 'string' },
    version:       { type: 'string', minLength: 1 },
    inputs:        { type: 'array', items: { $ref: '#/definitions/input' } },
    steps:         { type: 'array', minItems: 1, items: { $ref: '#/definitions/step' } },
    onError:       { $ref: '#/definitions/onError' },
    timeoutMs:     { type: 'number', exclusiveMinimum: 0 },
    tags:          { type: 'array', items: { type: 'string' } },
  },
  definitions: {
    onError: {
      oneOf: [
        { enum: ['fail', 'continue'] },
        { type: 'object', required: ['goto'], properties: { goto: { type: 'string' } }, additionalProperties: false },
      ],
    },
    input: {
      type: 'object',
      required: ['name', 'type'],
      additionalProperties: false,
      properties: {
        name:        { type: 'string', minLength: 1 },
        type:        { enum: ['string', 'number', 'boolean'] },
        description: { type: 'string' },
        required:    { type: 'boolean' },
        default:     {},
      },
    },
    step: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id:          { type: 'string', minLength: 1 },
        type:        { enum: ['bash', 'skill', 'api_call', 'delegation', 'approval_gate', 'conditional'] },
        description: { type: 'string' },
        onError:     { $ref: '#/definitions/onError' },
        timeoutMs:   { type: 'number', exclusiveMinimum: 0 },
      },
      // Per-type required fields are enforced in validator below; JSON Schema's
      // `if/then/else` would also work but the explicit checks give clearer
      // error messages on the workflow load path.
    },
  },
} as const;

// ─── Validator ────────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  /** When ok=true, this is the typed workflow ready for the executor. */
  workflow?: WorkflowDef;
}

/**
 * Validate a parsed JSON value against the workflow schema. Returns a list
 * of human-readable errors keyed by JSON pointer paths. The shape checks
 * here are deliberately strict — the executor downstream assumes a valid
 * input and skips defensive defaulting.
 */
export function validateWorkflowDef(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '/', message: 'workflow must be an object' }] };
  }

  // Top-level required.
  if (input.schemaVersion !== 1) {
    errors.push({ path: '/schemaVersion', message: 'must be 1' });
  }
  for (const f of ['id', 'name', 'version']) {
    if (typeof input[f] !== 'string' || (input[f] as string).length === 0) {
      errors.push({ path: `/${f}`, message: 'must be a non-empty string' });
    }
  }

  // Inputs.
  if (input.inputs !== undefined) {
    if (!Array.isArray(input.inputs)) {
      errors.push({ path: '/inputs', message: 'must be an array' });
    } else {
      const seen = new Set<string>();
      input.inputs.forEach((inp, i) => {
        if (!isObj(inp)) { errors.push({ path: `/inputs/${i}`, message: 'must be an object' }); return; }
        if (typeof inp.name !== 'string' || !inp.name) {
          errors.push({ path: `/inputs/${i}/name`, message: 'must be a non-empty string' });
        } else if (seen.has(inp.name)) {
          errors.push({ path: `/inputs/${i}/name`, message: `duplicate input "${inp.name}"` });
        } else {
          seen.add(inp.name);
        }
        if (!['string', 'number', 'boolean'].includes(inp.type as string)) {
          errors.push({ path: `/inputs/${i}/type`, message: 'must be "string" | "number" | "boolean"' });
        }
      });
    }
  }

  // Steps — required + non-empty + unique ids + per-type required fields.
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push({ path: '/steps', message: 'must be a non-empty array' });
  } else {
    const seenIds = new Set<string>();
    input.steps.forEach((step, i) => {
      if (!isObj(step)) {
        errors.push({ path: `/steps/${i}`, message: 'must be an object' });
        return;
      }
      if (typeof step.id !== 'string' || !step.id) {
        errors.push({ path: `/steps/${i}/id`, message: 'must be a non-empty string' });
      } else if (seenIds.has(step.id)) {
        errors.push({ path: `/steps/${i}/id`, message: `duplicate step id "${step.id}"` });
      } else {
        seenIds.add(step.id);
      }
      validateStep(step, `/steps/${i}`, errors);
    });

    // Cross-step references (goto, conditional then/else) point to existing ids.
    input.steps.forEach((step, i) => {
      if (!isObj(step)) return;
      const refs = collectRefs(step);
      for (const ref of refs) {
        if (!seenIds.has(ref.id)) {
          errors.push({ path: `/steps/${i}${ref.subpath}`, message: `references unknown step id "${ref.id}"` });
        }
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], workflow: input as unknown as WorkflowDef };
}

function validateStep(step: Record<string, unknown>, basePath: string, errors: ValidationError[]): void {
  const must = (cond: boolean, sub: string, msg: string) => {
    if (!cond) errors.push({ path: `${basePath}${sub}`, message: msg });
  };
  switch (step.type) {
    case 'bash':
      must(typeof step.command === 'string' && (step.command as string).length > 0,
           '/command', 'must be a non-empty string');
      break;
    case 'skill':
      must(typeof step.skill === 'string' && (step.skill as string).length > 0,
           '/skill', 'must be a non-empty string');
      break;
    case 'api_call':
      must(typeof step.url === 'string' && (step.url as string).length > 0,
           '/url', 'must be a non-empty string');
      if (step.method !== undefined) {
        must(['GET','POST','PUT','PATCH','DELETE'].includes(step.method as string),
             '/method', 'must be one of GET/POST/PUT/PATCH/DELETE');
      }
      break;
    case 'delegation':
      must(typeof step.toAgentId === 'string' && (step.toAgentId as string).length > 0,
           '/toAgentId', 'must be a non-empty string');
      must(typeof step.objective === 'string' && (step.objective as string).length > 0,
           '/objective', 'must be a non-empty string');
      break;
    case 'approval_gate':
      must(typeof step.command === 'string' && (step.command as string).length > 0,
           '/command', 'must be a non-empty string');
      break;
    case 'conditional':
      must(typeof step.when === 'string' && (step.when as string).length > 0,
           '/when', 'must be a non-empty string');
      must(typeof step.then === 'string' && (step.then as string).length > 0,
           '/then', 'must be a non-empty string');
      break;
    default:
      errors.push({ path: `${basePath}/type`,
        message: `must be one of bash|skill|api_call|delegation|approval_gate|conditional` });
  }
}

/** Collect every step-id reference inside a step so we can verify they
 *  point to real steps. */
function collectRefs(step: Record<string, unknown>): Array<{ id: string; subpath: string }> {
  const out: Array<{ id: string; subpath: string }> = [];
  if (step.type === 'conditional') {
    if (typeof step.then === 'string') out.push({ id: step.then as string, subpath: '/then' });
    if (typeof step.else === 'string') out.push({ id: step.else as string, subpath: '/else' });
  }
  const oe = step.onError;
  if (oe && typeof oe === 'object' && !Array.isArray(oe) && typeof (oe as { goto?: unknown }).goto === 'string') {
    out.push({ id: (oe as { goto: string }).goto, subpath: '/onError/goto' });
  }
  return out;
}

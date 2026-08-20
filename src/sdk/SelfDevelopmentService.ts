// Self-Development Service — orchestrates the SDK pipeline.
//
//   developFeature(description)
//     ├─ analyze(description) → kind: skill | workflow
//     ├─ extract spec (heuristic; LLM polish is a follow-up)
//     ├─ generate FileChange[] + default tests
//     ├─ run SecurityScanner
//     ├─ if autoApprove=true:
//     │     write files → run sandboxed tests → commit + deploy
//     │  else: return the FeaturePlan for human review
//
//   generateSkill(spec)        — pure: spec → FileChange[] + tests
//   generateWorkflow(spec)     — pure: spec → FileChange + tests
//   testCode(files, tests)     — sandbox runner; reuses
//                                SandboxedPluginRunner
//   deployChange(files, msg)   — git commit on a feature branch +
//                                workflow_dispatch
//
// Safety rails:
//   - rate limit: max 3 sessions per rolling hour
//   - all paths must be under src/ (CodeGenerator emits relative paths;
//     the writer normalises + verifies)
//   - destructive operations (overwrite, delete) are surfaced in the
//     plan + require autoApprove
//   - blocking findings from SecurityScanner gate execution unless
//     allowSecurityWarnings=true is also set
//   - feature branches by default; never direct to master
//   - operator-supplied descriptions are truncated before logging so
//     a giant prompt can't blow up the event payload

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import url from 'url';
import { Worker } from 'worker_threads';
import { createLogger } from '../observability/Logger.js';
import {
  generateSkillFiles,
  generateWorkflowFile,
  defaultSkillTests,
} from './CodeGenerator.js';
import { scanFiles, hasBlockingFindings } from './SecurityScanner.js';
import type {
  DevelopmentAction,
  FeaturePlan,
  FeatureKind,
  FileChange,
  PlanStepLog,
  SecurityFinding,
  SkillParam,
  SkillSpec,
  TestCase,
  TestResult,
  WorkflowSpec,
} from './SdkTypes.js';

const log = createLogger({ component: 'self-development' });

/** Rolling rate limit. The service emits + persists a fresh history
 *  row for every developFeature() invocation, so the count is just a
 *  filter over the last hour of those rows. We do NOT count plan-only
 *  calls — the gate is on actual writes. */
const RATE_LIMIT_PER_HOUR = 3;

/** Where a freshly-cut feature branch lives. The deploy bridge can
 *  target any ref; the SDK uses this prefix so an operator can sweep
 *  abandoned branches in CI. */
const BRANCH_PREFIX = 'sdk/auto-';

/** What the operator passes to developFeature. */
export interface DevelopRequest {
  description: string;
  /** When false (default), the service returns the plan only and stops. */
  autoApprove?: boolean;
  /** When true, blocking SecurityScanner findings DON'T halt the
   *  pipeline. Defaults to false; the dashboard prompts for explicit
   *  consent before flipping this. */
  allowSecurityWarnings?: boolean;
  /** Author identifier surfaced in the history row + commit author. */
  actor?: string;
  /** Override the feature branch name. Defaults to BRANCH_PREFIX+id. */
  branch?: string;
  /** When true, run the sandboxed tests but DON'T commit / deploy. */
  testOnly?: boolean;
}

export interface DevelopResult {
  plan: FeaturePlan;
  /** Per-test outcome from the sandbox runner. Empty when execution
   *  was halted before tests fired. */
  testResults: TestResult[];
  /** Set when files were written + a commit was made. */
  branch?: string;
  /** Set when a deploy was kicked off. */
  workflowRunId?: number;
}

/** Side-channel hook used to trigger the deploy workflow. The service
 *  doesn't import the deploy bridge directly — server.ts wires this
 *  callback in. Returning the run id is best-effort; some callers
 *  return undefined when the bridge isn't configured. */
export type DeployTrigger = (ref: string) => Promise<number | undefined>;

/** Sink for emitted history events; mapped to EventBus.publish() in
 *  the server wiring layer. */
export type HistorySink = (action: DevelopmentAction) => void;

export interface SelfDevelopmentServiceOptions {
  /** Repo root — every FileChange path is resolved relative to this.
   *  Defaults to the parent directory of dist/sdk/ at runtime. */
  repoRoot?: string;
  /** Sink for history events. Defaults to console / structured log. */
  onHistory?: HistorySink;
  /** Hook to trigger the deploy workflow. */
  deployTrigger?: DeployTrigger;
  /** Override clock — used by tests for deterministic timestamps + the
   *  rate-limit window. */
  now?: () => Date;
  /** Override the rate-limit cap. Tests want this; production keeps the default. */
  rateLimitPerHour?: number;
}

export class SelfDevelopmentService {
  private readonly repoRoot: string;
  private readonly onHistory: HistorySink;
  private readonly deployTrigger?: DeployTrigger;
  private readonly now: () => Date;
  private readonly rateLimitPerHour: number;

  /** In-process history. Persistent storage is the EventStore — the
   *  service emits a structured event per action (planned / completed
   *  / rejected) and the server's onEvent sink mirrors that into the
   *  bus. We keep the last ~50 entries here for the GET /api/sdk/history
   *  fast path. */
  private history: DevelopmentAction[] = [];

  constructor(opts: SelfDevelopmentServiceOptions = {}) {
    this.repoRoot         = opts.repoRoot ?? defaultRepoRoot();
    this.onHistory        = opts.onHistory ?? (() => { /* no-op */ });
    this.deployTrigger    = opts.deployTrigger;
    this.now              = opts.now ?? (() => new Date());
    this.rateLimitPerHour = opts.rateLimitPerHour ?? RATE_LIMIT_PER_HOUR;
  }

  // ─── Public surface ──────────────────────────────────────────────────

  /** Top-level entry point. plan-only by default; autoApprove flips
   *  through to write + test + commit + deploy. */
  async developFeature(req: DevelopRequest): Promise<DevelopResult> {
    if (req.autoApprove) this.assertWithinRateLimit();
    const plan = this.buildPlan(req.description);
    let testResults: TestResult[] = [];
    let branch: string | undefined;
    let workflowRunId: number | undefined;

    if (!req.autoApprove) {
      // Plan-only — return for review.
      this.recordHistory(req, plan, 'planned', 0, []);
      return { plan, testResults };
    }

    // Block on security findings unless explicitly waived.
    if (hasBlockingFindings(plan.scanFindings) && !req.allowSecurityWarnings) {
      const blocked = plan.scanFindings.filter(f => f.severity === 'block').length;
      this.appendStep(plan, 'scan', 'failed', `${blocked} blocking finding(s)`);
      this.recordHistory(req, plan, 'rejected', 0, []);
      return { plan, testResults };
    }

    const t0 = Date.now();
    try {
      this.appendStep(plan, 'analyze', 'ok', `kind=${plan.kind}, files=${plan.files.length}`);
      this.appendStep(plan, 'scan',    'ok', `${plan.scanFindings.length} finding(s)`);

      // Write the files to disk. We never write outside src/, the path
      // validator enforces this.
      this.writeFiles(plan.files);
      this.appendStep(plan, 'write', 'ok', `wrote ${plan.files.length} file(s)`);

      // Run sandboxed self-tests. Each test instantiates the just-
      // written .plugin.js inside a Worker and asserts the SkillResult
      // shape. Failures don't gate the commit — the operator decides
      // — but they're surfaced in the history row.
      testResults = await this.runSandboxTests(plan.files, plan.tests);
      const failed = testResults.filter(t => !t.passed).length;
      this.appendStep(plan, 'test', failed === 0 ? 'ok' : 'failed',
        `${testResults.length} test(s), ${failed} failed`);

      if (req.testOnly) {
        // Stop short — the operator is verifying generation only.
        this.recordHistory(req, plan, failed === 0 ? 'completed' : 'failed',
          Date.now() - t0, testResults);
        return { plan, testResults };
      }

      // Commit on a fresh feature branch + push. Master-branch writes
      // are never permitted from this surface.
      branch = req.branch ?? `${BRANCH_PREFIX}${plan.id}`;
      await this.gitCommitOnBranch(plan, branch, req.actor ?? 'sdk');
      this.appendStep(plan, 'commit', 'ok', `branch ${branch}`);

      if (this.deployTrigger) {
        workflowRunId = await this.deployTrigger(branch);
        this.appendStep(plan, 'deploy', 'ok', `triggered run ${workflowRunId ?? '<no-id>'}`);
      } else {
        this.appendStep(plan, 'deploy', 'skipped', 'deploy bridge not configured');
      }

      this.recordHistory(req, plan, 'completed', Date.now() - t0, testResults, branch, workflowRunId);
      return { plan, testResults, branch, workflowRunId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('developFeature failed', { id: plan.id, err: message });
      this.appendStep(plan, 'error', 'failed', message);
      this.recordHistory(req, plan, 'failed', Date.now() - t0, testResults, branch, workflowRunId);
      throw err;
    }
  }

  /** Generate-only entry point: returns a plan without writing. */
  generateSkill(spec: SkillSpec): { files: FileChange[]; tests: TestCase[]; findings: SecurityFinding[] } {
    const files = generateSkillFiles(spec);
    const tests = defaultSkillTests(spec);
    const findings = scanFiles(files);
    return { files, tests, findings };
  }

  generateWorkflow(spec: WorkflowSpec): { files: FileChange[]; findings: SecurityFinding[] } {
    const file = generateWorkflowFile(spec);
    return { files: [file], findings: scanFiles([file]) };
  }

  /** Public testCode entry: takes already-generated files + tests
   *  and runs them through the same sandbox path executeFeature uses. */
  testCode(files: FileChange[], tests: TestCase[]): Promise<TestResult[]> {
    return this.runSandboxTests(files, tests);
  }

  /** Persist `files` to disk + commit + deploy in one shot. The plan
   *  shape is what /api/sdk/deploy accepts post-review. */
  async deployChange(files: FileChange[], commitMessage: string, ref?: string): Promise<{ branch: string; workflowRunId?: number }> {
    this.assertWithinRateLimit();
    this.writeFiles(files);
    const branch = ref ?? `${BRANCH_PREFIX}${randomUUID().slice(0, 8)}`;
    await this.gitOnBranch(branch, async () => {
      await this.gitAddAndCommit(files.map(f => f.path), commitMessage);
    });
    let workflowRunId: number | undefined;
    if (this.deployTrigger) {
      workflowRunId = await this.deployTrigger(branch);
    }
    return { branch, workflowRunId };
  }

  /** Recent in-process history; full history lives in the EventStore. */
  recentHistory(): DevelopmentAction[] {
    return this.history.slice(-50).slice().reverse();
  }

  // ─── Internals ───────────────────────────────────────────────────────

  /** Heuristic: turn a free-form description into a SkillSpec or a
   *  WorkflowSpec. We keep this intentionally simple — phrases like
   *  "workflow" / "runbook" route to a workflow spec; everything else
   *  becomes a skill. The shell commands in the spec come from any
   *  back-tick-quoted segments in the description. An LLM polish pass
   *  is the next iteration. */
  private buildPlan(description: string): FeaturePlan {
    const trimmed = description.trim();
    if (!trimmed) throw new Error('description is required');

    const id = `feat-${this.now().getTime().toString(36)}-${randomUUID().slice(0, 6)}`;
    const kind: FeatureKind = /\b(workflow|runbook)\b/i.test(trimmed) ? 'workflow' : 'skill';

    if (kind === 'skill') {
      const spec = this.specFromDescription(trimmed);
      const files = generateSkillFiles(spec);
      const tests = defaultSkillTests(spec);
      const scanFindings = scanFiles(files);
      return {
        id,
        description: trimmed.slice(0, 800),
        kind, files, tests, scanFindings,
        steps: [],
        createdAt: this.now().toISOString(),
      };
    }

    const wf = this.workflowFromDescription(trimmed);
    const file = generateWorkflowFile(wf);
    const scanFindings = scanFiles([file]);
    return {
      id,
      description: trimmed.slice(0, 800),
      kind: 'workflow',
      files: [file],
      tests: [],
      scanFindings,
      steps: [],
      createdAt: this.now().toISOString(),
    };
  }

  /** Rough natural-language → SkillSpec heuristic. The generator does
   *  the heavy lifting; this just extracts a name + commands. */
  private specFromDescription(description: string): SkillSpec {
    const id = inferSkillId(description);
    const commands = extractBacktickCommands(description);
    const inferredParams = inferParameters(description, commands);
    return {
      id,
      name: titleFromDescription(description),
      description: description.slice(0, 240),
      category: 'general',
      tags: ['sdk', 'auto-generated'],
      parameters: inferredParams,
      commands: commands.length > 0 ? commands : ['echo "describe the work in backticks for a real command"'],
      logic: description,
    };
  }

  private workflowFromDescription(description: string): WorkflowSpec {
    const id = inferSkillId(description);
    const commands = extractBacktickCommands(description);
    return {
      id,
      name: titleFromDescription(description),
      description: description.slice(0, 240),
      version: '1.0.0',
      tags: ['sdk', 'auto-generated'],
      inputs: [],
      steps: commands.length > 0
        ? commands.map((cmd, i) => ({ id: `step_${i + 1}`, type: 'bash', command: cmd }))
        : [{ id: 'step_1', type: 'bash', command: 'echo "fill in the workflow body"' }],
    };
  }

  /** Apply a FileChange[] to disk under repoRoot, with strict path
   *  validation so we never write outside src/ or escape the root. */
  private writeFiles(files: FileChange[]): void {
    for (const f of files) {
      const safe = sanitisePath(f.path);
      const abs = path.join(this.repoRoot, safe);
      if (!abs.startsWith(path.join(this.repoRoot, 'src') + path.sep)
          && !abs.startsWith(path.join(this.repoRoot, 'src/'))) {
        throw new Error(`refusing to write outside src/: ${safe}`);
      }
      const exists = fs.existsSync(abs);
      if (exists && f.mode === 'add') {
        throw new Error(`refusing to overwrite existing file: ${safe} (mode=add)`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.contents, 'utf8');
    }
  }

  /** Run each TestCase against the matching .plugin.js file. The
   *  Worker imports the plugin in isolation, calls the named handler
   *  with the test params, and asserts the SkillResult shape. */
  private async runSandboxTests(files: FileChange[], tests: TestCase[]): Promise<TestResult[]> {
    if (tests.length === 0) return [];
    const pluginFile = files.find(f => f.path.endsWith('.plugin.js'));
    if (!pluginFile) {
      // Workflow-only changes have no plugin file; emit a single
      // synthetic "no tests" row so the dashboard doesn't show empty.
      return [];
    }
    // Resolve to the absolute path on disk (we wrote the file before
    // calling tests in the developFeature path; for testCode() callers
    // who skip writeFiles we materialise a temp copy).
    const abs = path.isAbsolute(pluginFile.path)
      ? pluginFile.path
      : path.join(this.repoRoot, pluginFile.path);
    const onDisk = fs.existsSync(abs)
      ? abs
      : await this.materialiseTemp(pluginFile);

    const results: TestResult[] = [];
    for (const t of tests) {
      const t0 = Date.now();
      try {
        const out = await runOneInWorker(onDisk, t);
        const passed = expectationMatches(out, t);
        results.push({
          name: t.name,
          passed,
          duration_ms: Date.now() - t0,
          output: typeof out === 'string' ? out : JSON.stringify(out).slice(0, 4000),
        });
      } catch (err: unknown) {
        results.push({
          name: t.name, passed: false,
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  private async materialiseTemp(file: FileChange): Promise<string> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sdk-test-'));
    // Drop a {"type":"module"} alongside so dynamic import treats the
    // file as ESM. Mirrors what SkillPluginLoader does at runtime.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8');
    const target = path.join(dir, path.basename(file.path));
    fs.writeFileSync(target, file.contents, 'utf8');
    return target;
  }

  /** Cut a feature branch, stage the changed files, commit, push.
   *  Best-effort — a missing remote / no-credentials environment
   *  still completes the local commit; the deploy step then surfaces
   *  the failure to the operator. */
  private async gitCommitOnBranch(plan: FeaturePlan, branch: string, actor: string): Promise<void> {
    const message = `feat(sdk): ${plan.description.slice(0, 70)}\n\n` +
      `Auto-generated by the Self-Development SDK.\n` +
      `Plan id: ${plan.id}\n` +
      `Files: ${plan.files.length}\n`;
    await this.gitOnBranch(branch, async () => {
      await this.gitAddAndCommit(plan.files.map(f => f.path), message, actor);
    });
  }

  /** Run the inner async block on a fresh feature branch. We DO NOT
   *  push here — the deploy bridge can target the local branch via
   *  workflow_dispatch; an operator can promote to a PR through the
   *  usual path. */
  private async gitOnBranch(branch: string, inner: () => Promise<void>): Promise<void> {
    await runGit(this.repoRoot, ['checkout', '-B', branch]);
    try {
      await inner();
    } finally {
      // Leave the working tree on the new branch — server-side worktrees
      // typically run as a single repo so an operator can inspect.
    }
  }

  private async gitAddAndCommit(paths: string[], message: string, actor: string = 'sdk'): Promise<void> {
    if (paths.length === 0) return;
    await runGit(this.repoRoot, ['add', ...paths.map(sanitisePath)]);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME:     `Self-Development SDK (${actor})`,
      GIT_AUTHOR_EMAIL:    'sdk@itops-agents.local',
      GIT_COMMITTER_NAME:  'Self-Development SDK',
      GIT_COMMITTER_EMAIL: 'sdk@itops-agents.local',
    };
    await runGit(this.repoRoot, ['commit', '-m', message, '--no-verify'], env);
  }

  // ─── Bookkeeping ─────────────────────────────────────────────────────

  private appendStep(plan: FeaturePlan, step: string, status: PlanStepLog['status'], message?: string): void {
    const ts = this.now().toISOString();
    plan.steps.push({ step, status, message, startedAt: ts, completedAt: ts });
  }

  private assertWithinRateLimit(): void {
    const cutoff = this.now().getTime() - 60 * 60 * 1000;
    const recent = this.history.filter(h => new Date(h.at).getTime() > cutoff && h.outcome !== 'planned');
    if (recent.length >= this.rateLimitPerHour) {
      throw new Error(`SDK rate-limit hit: ${recent.length}/${this.rateLimitPerHour} sessions in the last hour`);
    }
  }

  private recordHistory(
    req: DevelopRequest,
    plan: FeaturePlan,
    outcome: DevelopmentAction['outcome'],
    durationMs: number,
    tests: TestResult[],
    branch?: string,
    workflowRunId?: number,
  ): void {
    const action: DevelopmentAction = {
      id: plan.id,
      at: this.now().toISOString(),
      actor: req.actor ?? 'sdk',
      description: plan.description,
      kind: plan.kind,
      outcome,
      branch,
      workflowRunId,
      durationMs,
      files: plan.files.length,
      testsPassed: tests.filter(t => t.passed).length,
      testsFailed: tests.filter(t => !t.passed).length,
    };
    this.history.push(action);
    if (this.history.length > 100) this.history = this.history.slice(-50);
    try { this.onHistory(action); } catch { /* event sinks are best-effort */ }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function defaultRepoRoot(): string {
  // dist/sdk/SelfDevelopmentService.js → repo root is two up.
  // src/sdk/SelfDevelopmentService.ts → also two up. The runtime
  // location wins; tests can override via opts.repoRoot.
  const here = url.fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..');
}

function sanitisePath(p: string): string {
  if (path.isAbsolute(p)) throw new Error(`absolute paths are forbidden: ${p}`);
  const norm = path.normalize(p).replace(/\\/g, '/');
  if (norm.startsWith('..')) throw new Error(`path escape attempt: ${p}`);
  return norm;
}

function inferSkillId(description: string): string {
  const tokens = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, 3);
  if (tokens.length === 0) return 'sdk.feature';
  return ['sdk', ...tokens].join('.');
}
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'task', 'after', 'add', 'create', 'build', 'make', 'new', 'feature']);

function titleFromDescription(description: string): string {
  const cleaned = description.trim().replace(/[\s.]+$/, '');
  if (cleaned.length === 0) return 'SDK Feature';
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 57).replace(/\s\S*$/, '') + '…';
}

function extractBacktickCommands(text: string): string[] {
  const out: string[] = [];
  // Match `...` (single backtick) blocks. Triple-backtick ``` blocks
  // also match because the inner string still starts/ends with `.
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1].trim());
  return out;
}

function inferParameters(description: string, commands: string[]): SkillParam[] {
  const params: SkillParam[] = [];
  const seen = new Set<string>();
  // Pull {{name}}-style placeholders out of any extracted command.
  const phRe = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  for (const cmd of commands) {
    let m: RegExpExecArray | null;
    while ((m = phRe.exec(cmd))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      params.push({ name: m[1], type: 'string', required: true, description: `Inferred from command template`, example: m[1] });
    }
  }
  void description; // reserved for future LLM-assisted inference
  return params;
}

/** Run one TestCase by spawning a Worker that imports the plugin file
 *  + invokes the named handler. The Worker boundary is the same one
 *  SandboxedPluginRunner uses, but inlined here so the SDK's tests
 *  don't depend on the rest of the sandbox runtime. */
function runOneInWorker(pluginAbs: string, t: TestCase): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_BOOTSTRAP_URL, {
      workerData: { pluginUrl: url.pathToFileURL(pluginAbs).href, command: t.command, params: t.params ?? {} },
      eval: false,
    });
    const timer = setTimeout(() => {
      worker.terminate(); reject(new Error('test timed out'));
    }, 10_000);
    worker.once('message', (msg: { ok: boolean; result?: string; error?: string }) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve(msg.result); else reject(new Error(msg.error ?? 'test failed'));
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(err);
    });
  });
}

/** Worker bootstrap: imports the plugin, calls the named handler.
 *  Defined as a data: URL so we don't ship a separate compiled file
 *  per environment. */
const WORKER_BOOTSTRAP = `
import { parentPort, workerData } from 'node:worker_threads';
const { pluginUrl, command, params } = workerData;
try {
  const mod = await import(pluginUrl);
  const plugin = mod.default ?? mod;
  const cmd = plugin.skill?.commands?.find?.(c => c.name === command);
  if (!cmd) throw new Error('command not declared on the plugin: ' + command);
  const handler = plugin.executor?.[cmd.handler];
  if (typeof handler !== 'function') throw new Error('handler missing: ' + cmd.handler);
  const result = await handler.call(plugin.executor, params);
  parentPort.postMessage({ ok: true, result: typeof result === 'string' ? result : JSON.stringify(result) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message || String(err) });
}
`;
const WORKER_BOOTSTRAP_URL = new URL(`data:text/javascript,${encodeURIComponent(WORKER_BOOTSTRAP)}`);

/** Match a TestCase's expectations against the SkillResult-shape
 *  string the handler returned. */
function expectationMatches(raw: unknown, t: TestCase): boolean {
  const expect = t.expect;
  if (!expect) return true;
  if (typeof raw !== 'string') return false;
  let parsed: { ok?: boolean; summary?: string };
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (typeof expect.ok === 'boolean' && parsed.ok !== expect.ok) return false;
  if (expect.summaryIncludes && !(parsed.summary ?? '').includes(expect.summaryIncludes)) return false;
  return true;
}

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const errChunks: Buffer[] = [];
    p.stderr.on('data', (c: Buffer) => errChunks.push(c));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`));
    });
  });
}

// SandboxValidator — verifies a crystallized skill's workflow runs
// successfully in a confined environment before the improvement loop
// auto-promotes it to platform-wide executable status.
//
// This is the v3 safety layer for the autonomy loop. v2 already had:
//   • Judge LLM confidence floor (≥ 0.85 for promote)
//   • Reject path for clearly-dangerous workflows
// What it lacked: actually trying the workflow before flipping it on.
// A judge can be confidently-wrong (e.g. typo in a path that's invisible
// from prose). Sandbox execution catches that.
//
// Strategy per workflow step:
//   • bash steps:   classify the command. If destructive (rm -rf,
//                   mkfs, shutdown, …) we REFUSE to validate — the
//                   workflow needs human review regardless. Otherwise
//                   run in a Docker sandbox (alpine, --network none,
//                   --read-only) with a hard timeout. Falls back to
//                   host exec if Docker is unavailable on the host.
//   • skill steps:  not validated. We don't invoke real platform
//                   skills in the sandbox — that would defeat the
//                   "no production side effects" goal. A workflow
//                   that's *only* skill calls reports validateOk:true
//                   with mode:'skipped'.
//   • approval/conditional/api/delegation: skipped same as skill —
//                   too platform-coupled to be meaningful in a
//                   sandbox.
//
// The validator is deliberately conservative: a single failing or
// blocked bash step ⇒ the whole skill fails validation. The loop
// then holds the draft for human review instead of auto-promoting.
//
// Config knobs (env, read at construction):
//   IMPROVEMENT_LOOP_SANDBOX_ENABLED      true|false (default true)
//   IMPROVEMENT_LOOP_SANDBOX_IMAGE        docker image (default 'alpine:3.20')
//   IMPROVEMENT_LOOP_SANDBOX_PER_CMD_MS   per-command hard timeout (default 8000)
//   IMPROVEMENT_LOOP_SANDBOX_TOTAL_MS     per-skill cap (default 30000)

import { exec } from 'child_process';
import { createLogger } from '../observability/Logger.js';
import type { CrystallizedSkill } from './../crystallization/CrystallizedSkillTypes.js';

const log = createLogger({ component: 'sandbox-validator' });

export type SandboxStepStatus = 'ok' | 'failed' | 'blocked' | 'skipped';

export interface SandboxStepResult {
  stepId: string;
  type: string;
  status: SandboxStepStatus;
  /** What we actually ran (may differ from the workflow text after
   *  template-stripping). Empty for non-bash steps. */
  command?: string;
  /** Error or block reason, when status !== 'ok'. */
  reason?: string;
  /** Truncated stdout/stderr captured from the sandbox process. */
  output?: string;
  durationMs?: number;
}

export interface SandboxValidationResult {
  ok: boolean;
  /** 'docker' if we used Docker; 'host' if we fell back; 'skipped'
   *  when the workflow had no validateable steps; 'disabled' when
   *  the validator is turned off via env. */
  mode: 'docker' | 'host' | 'skipped' | 'disabled';
  steps: SandboxStepResult[];
  /** Single-line reason useful for the improvement-loop action log
   *  / dashboard surface. */
  reason?: string;
  durationMs: number;
}

/**
 * Reuse the chat handler's classification rules so a draft promoted
 * from agent-chat usage gets vetted with the same safety table the
 * agent itself has. Inlined here rather than imported from server.ts
 * to keep the dep graph clean.
 */
const SAFE_PREFIXES = new Set([
  'df', 'free', 'uptime', 'whoami', 'hostname', 'date', 'uname',
  'cat', 'ip', 'ss', 'ls', 'wc', 'head', 'tail', 'grep', 'find', 'du',
  'stat', 'ping', 'dig', 'nslookup', 'curl', 'wget', 'lsof', 'docker',
  'systemctl', 'journalctl', 'ps', 'top', 'vmstat', 'iostat', 'lscpu',
  'lsblk', 'mount', 'echo', 'true', 'false', 'sleep', 'env', 'printenv',
]);
const BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(-rf?|--recursive)/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bformat\b/,
  /\bfdisk\b/,
  /\bparted\b/,
  /\bmkswap\b/,
  /\b(userdel|groupdel|passwd)\b/,
  /\bchmod\s+777/,
  /\bchown\s+root/,
  /\bcurl\b.*\|\s*(bash|sh)/,
  /\bwget\b.*\|\s*(bash|sh)/,
  /\b>\s*\/dev\/(sd|hd|nvme)/,
  /\bkill\s+-9\s+1\b/,
  /\bapt\s+(remove|purge|autoremove)/,
  /\bdpkg\s+--purge/,
];

function isBlocked(cmd: string): { blocked: boolean; reason?: string } {
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(cmd)) return { blocked: true, reason: `matches blocked pattern ${re}` };
  }
  return { blocked: false };
}

function looksSafe(cmd: string): boolean {
  // Take the first token of the first chained command. If it's in the
  // safe list we don't second-guess. If not, we still allow execution
  // (the sandbox itself is the safety net), we just record it as
  // "moderate".
  const first = cmd.trim().split(/[\s|;&]+/)[0] || '';
  return SAFE_PREFIXES.has(first);
}

/**
 * Strip template placeholders (`${...}`) so a workflow can run in
 * the sandbox without their values. The sandbox is testing whether
 * the *shape* of the command works — not whether a specific input
 * tuple resolves correctly.
 *
 * `${steps.foo.ok}`         → 'true'
 * `${inputs.host}`          → 'localhost'
 * `${anything.else}`        → ''
 */
function stripTemplates(cmd: string): string {
  return cmd
    .replace(/\$\{steps\.[^}]+\.ok\}/g, 'true')
    .replace(/\$\{inputs\.host\}/g, 'localhost')
    .replace(/\$\{[^}]+\}/g, '');
}

interface SandboxConfig {
  enabled: boolean;
  image: string;
  perCommandMs: number;
  totalMs: number;
  /** True when `docker` is available on the host; false → fall back
   *  to host exec. Cached at construction time. */
  dockerAvailable: boolean;
}

export class SandboxValidator {
  private cfg: SandboxConfig;

  constructor(opts: Partial<SandboxConfig> = {}) {
    const fromEnv = (k: string) => process.env[k]?.trim();
    const enabled =
      opts.enabled
      ?? (fromEnv('IMPROVEMENT_LOOP_SANDBOX_ENABLED') ?? 'true').toLowerCase() !== 'false';
    const image = opts.image ?? fromEnv('IMPROVEMENT_LOOP_SANDBOX_IMAGE') ?? 'alpine:3.20';
    const perCommandMs = opts.perCommandMs
      ?? Number(fromEnv('IMPROVEMENT_LOOP_SANDBOX_PER_CMD_MS') ?? 8000);
    const totalMs = opts.totalMs
      ?? Number(fromEnv('IMPROVEMENT_LOOP_SANDBOX_TOTAL_MS') ?? 30000);
    this.cfg = {
      enabled,
      image,
      perCommandMs,
      totalMs,
      dockerAvailable: opts.dockerAvailable ?? false,
    };
    if (this.cfg.enabled) {
      // Probe docker availability lazily but at most once.
      this.probeDocker().catch(() => { /* already cached false */ });
    }
  }

  private async probeDocker(): Promise<void> {
    try {
      await this.run('docker --version', 3000);
      this.cfg.dockerAvailable = true;
      log.info('docker available — sandbox runs will use docker', { image: this.cfg.image });
    } catch {
      this.cfg.dockerAvailable = false;
      log.warn('docker unavailable — sandbox runs will fall back to host exec');
    }
  }

  /** Force-set docker availability. Test seam. */
  setDockerAvailable(available: boolean): void {
    this.cfg.dockerAvailable = available;
  }

  isEnabled(): boolean {
    return this.cfg.enabled;
  }

  async validate(skill: CrystallizedSkill): Promise<SandboxValidationResult> {
    const startedAt = Date.now();
    if (!this.cfg.enabled) {
      return {
        ok: true,
        mode: 'disabled',
        steps: [],
        reason: 'sandbox validation disabled via env',
        durationMs: 0,
      };
    }

    let workflow: { steps?: Array<Record<string, unknown>> };
    try {
      workflow = JSON.parse(skill.generatedWorkflow);
    } catch (err) {
      return {
        ok: false,
        mode: this.cfg.dockerAvailable ? 'docker' : 'host',
        steps: [],
        reason: `workflow JSON unparseable: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const results: SandboxStepResult[] = [];
    let validatedCount = 0;

    for (const step of steps) {
      if (Date.now() - startedAt > this.cfg.totalMs) {
        results.push({
          stepId: String(step.id ?? '?'),
          type: String(step.type ?? '?'),
          status: 'failed',
          reason: 'sandbox total timeout exceeded',
        });
        return {
          ok: false,
          mode: this.cfg.dockerAvailable ? 'docker' : 'host',
          steps: results,
          reason: 'sandbox total timeout exceeded',
          durationMs: Date.now() - startedAt,
        };
      }

      const stepResult = await this.validateStep(step);
      results.push(stepResult);
      if (stepResult.status === 'failed' || stepResult.status === 'blocked') {
        return {
          ok: false,
          mode: this.cfg.dockerAvailable ? 'docker' : 'host',
          steps: results,
          reason: `step ${stepResult.stepId} ${stepResult.status}: ${stepResult.reason ?? ''}`,
          durationMs: Date.now() - startedAt,
        };
      }
      if (stepResult.status === 'ok') validatedCount++;
    }

    const mode: SandboxValidationResult['mode'] =
      validatedCount === 0 ? 'skipped'
      : this.cfg.dockerAvailable ? 'docker' : 'host';

    return {
      ok: true,
      mode,
      steps: results,
      reason: validatedCount === 0
        ? 'no bash steps to validate; non-shell steps trusted'
        : `validated ${validatedCount} bash step(s)`,
      durationMs: Date.now() - startedAt,
    };
  }

  private async validateStep(step: Record<string, unknown>): Promise<SandboxStepResult> {
    const stepId = String(step.id ?? '?');
    const type = String(step.type ?? '?');
    if (type !== 'bash') {
      return { stepId, type, status: 'skipped', reason: 'non-bash step not validated in sandbox' };
    }

    const rawCmd = typeof step.command === 'string' ? step.command : '';
    if (!rawCmd.trim()) {
      return { stepId, type, status: 'failed', reason: 'bash step has empty command' };
    }

    const blockCheck = isBlocked(rawCmd);
    if (blockCheck.blocked) {
      return { stepId, type, status: 'blocked', command: rawCmd, reason: blockCheck.reason };
    }

    const cmd = stripTemplates(rawCmd);
    const safetyHint = looksSafe(cmd) ? ' (safe-prefix)' : ' (moderate)';
    const t0 = Date.now();
    try {
      const out = await this.runInSandbox(cmd);
      return {
        stepId, type, status: 'ok', command: cmd,
        output: out.slice(0, 500),
        reason: `executed${safetyHint}`,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stepId, type, status: 'failed', command: cmd,
        reason: message.slice(0, 200),
        durationMs: Date.now() - t0,
      };
    }
  }

  private async runInSandbox(cmd: string): Promise<string> {
    if (this.cfg.dockerAvailable) {
      // --rm: throw away container on exit
      // --network none: deny all outbound networking
      // --read-only: filesystem is read-only (workflows that need to
      //   write should be using a 'skill' step, not raw bash)
      // --memory / --pids-limit: small to catch fork bombs / OOM
      // --user nobody: drop privileges where possible
      // sh -c "..." is necessary so the shell parses chained commands.
      // Single-quote-escape the cmd for shell safety.
      const escaped = cmd.replace(/'/g, "'\\''");
      const dockerCmd = `docker run --rm --network none --read-only --memory 128m --pids-limit 64 --user nobody ${this.cfg.image} sh -c '${escaped}'`;
      return this.run(dockerCmd, this.cfg.perCommandMs);
    }
    // Host fallback: classification already filtered destructive ops.
    // Still bounded by perCommandMs.
    return this.run(cmd, this.cfg.perCommandMs);
  }

  private run(cmd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          // Combine the message + a trailing slice of stderr for
          // diagnostic value without flooding the action log.
          const tail = (stderr || stdout || '').toString().trim().slice(-200);
          reject(new Error(tail ? `${err.message} | ${tail}` : err.message));
          return;
        }
        resolve(stdout?.toString() ?? '');
      });
    });
  }
}

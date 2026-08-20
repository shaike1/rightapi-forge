// GitSkill — narrow surface around `git` for use by the
// DevelopmentAgent. Only the read-only / branch-creation operations
// are exposed; merging / pushing / force-pushing is intentionally NOT
// here. Those go through the deploy bridge, which has its own
// authorization gates.
//
// The skill spawns `git` directly — it doesn't shell-pipe through
// bash, so command injection from skill params is bounded by argv
// boundaries.

import type { Skill } from '../../types/index.js';
import { encode, ok, fail } from '../SkillResult.js';
import { spawn } from 'child_process';

function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => err.push(c));
    p.on('error', (e) => resolve({ stdout: '', stderr: e.message, code: -1 }));
    p.on('close', (code) => resolve({
      stdout: Buffer.concat(out).toString().trim(),
      stderr: Buffer.concat(err).toString().trim(),
      code: code ?? -1,
    }));
  });
}

export class GitSkill {
  /** Repo root used for every git invocation. Defaults to cwd. */
  constructor(private readonly repoRoot: string = process.cwd()) {}

  getSkill(): Skill {
    return {
      id: 'sdk.git',
      name: 'SDK Git',
      description: 'Read-only + branch-creation git operations for the Self-Development SDK.',
      category: 'general',
      enabled: true,
      commands: [
        { name: 'sdk.git.status',  description: 'Show working tree status (porcelain).', handler: 'status'  },
        { name: 'sdk.git.branch',  description: 'List branches.',                          handler: 'branch'  },
        { name: 'sdk.git.current', description: 'Print the current branch name.',          handler: 'current' },
        { name: 'sdk.git.log',     description: 'Show recent commits (last 20).',          handler: 'log'     },
        { name: 'sdk.git.diff',    description: 'Show working tree diff (unified, no color).', handler: 'diff' },
        { name: 'sdk.git.checkout', description: 'Create or switch to a feature branch.',  handler: 'checkout',
          parameters: { branch: 'string', create: 'boolean' } },
      ],
    };
  }

  async status(): Promise<string> {
    const r = await runGit(this.repoRoot, ['status', '--porcelain']);
    if (r.code !== 0) return encode(fail(r.stderr || `git status exit ${r.code}`));
    const lines = r.stdout ? r.stdout.split('\n') : [];
    return encode(ok({ lines, dirty: lines.length > 0 }, lines.length === 0 ? 'clean' : `${lines.length} change(s)`));
  }

  async branch(): Promise<string> {
    const r = await runGit(this.repoRoot, ['branch', '--list', '--no-color']);
    if (r.code !== 0) return encode(fail(r.stderr || `git branch exit ${r.code}`));
    const lines = r.stdout.split('\n').filter(Boolean).map(l => l.replace(/^[*+]\s*/, '').trim());
    return encode(ok({ branches: lines }, `${lines.length} branch(es)`));
  }

  async current(): Promise<string> {
    const r = await runGit(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (r.code !== 0) return encode(fail(r.stderr || `git rev-parse exit ${r.code}`));
    return encode(ok({ branch: r.stdout }, r.stdout));
  }

  async log(): Promise<string> {
    const r = await runGit(this.repoRoot, ['log', '--oneline', '-n', '20', '--no-color']);
    if (r.code !== 0) return encode(fail(r.stderr || `git log exit ${r.code}`));
    const commits = r.stdout.split('\n').filter(Boolean);
    return encode(ok({ commits }, `${commits.length} commit(s)`));
  }

  async diff(): Promise<string> {
    const r = await runGit(this.repoRoot, ['diff', '--no-color']);
    if (r.code !== 0) return encode(fail(r.stderr || `git diff exit ${r.code}`));
    return encode(ok({ diff: r.stdout }, `${r.stdout.split('\n').length} line(s)`));
  }

  async checkout(params: { branch?: string; create?: boolean }): Promise<string> {
    if (!params?.branch || !/^[A-Za-z0-9._\/\-]+$/.test(params.branch)) {
      return encode(fail('sdk.git.checkout requires { branch } matching [A-Za-z0-9._/\\-]+'));
    }
    const args = params.create ? ['checkout', '-B', params.branch] : ['checkout', params.branch];
    const r = await runGit(this.repoRoot, args);
    if (r.code !== 0) return encode(fail(r.stderr || `git checkout exit ${r.code}`));
    return encode(ok({ branch: params.branch }, `on ${params.branch}`));
  }
}

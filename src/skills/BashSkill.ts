// Bash command execution skill

import type { Skill } from '../types/index.js';
import type { SkillExecutionContext } from './SkillManager.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { shellEscape, assertSafeIdentifier } from '../utils/shellEscape.js';
import { encode, ok, fail } from './SkillResult.js';

/** Patterns that suggest a command did something reversible. The rollback
 *  recipe captured here is the operator's own description — bashExec can't
 *  always invent the right undo, so we register a hint and let humans /
 *  agents fill in the actual rollback command. */
const REVERSIBLE_BASH_PATTERNS: Array<{ re: RegExp; describe: (cmd: string) => string }> = [
  { re: /^\s*systemctl\s+(start|restart|enable)\s+(\S+)/, describe: c => `started/restarted: ${c.trim()}` },
  { re: /^\s*systemctl\s+(stop|disable)\s+(\S+)/,         describe: c => `stopped: ${c.trim()}` },
  { re: /^\s*service\s+\S+\s+(start|restart)/,            describe: c => `service start/restart: ${c.trim()}` },
  { re: /^\s*iptables\s+-A/,                              describe: c => `firewall rule appended: ${c.trim()}` },
  { re: /^\s*ufw\s+(allow|deny)/,                         describe: c => `ufw rule added: ${c.trim()}` },
  { re: /^\s*mkdir\s+/,                                   describe: c => `directory created: ${c.trim()}` },
  { re: /^\s*touch\s+/,                                   describe: c => `file touched: ${c.trim()}` },
  { re: /^\s*ln\s+(-s|--symbolic)/,                       describe: c => `symlink created: ${c.trim()}` },
  { re: /^\s*\S+\s+>\s*\S+/,                              describe: c => `wrote file via redirect: ${c.trim()}` },
];

const execAsync = promisify(exec);

// bash.exec is by design a power-tool: the caller is allowed to run any shell
// command. We don't try to escape the command string itself (that would defeat
// the purpose); instead we surface exit code, stderr, and timeout context so
// the agent can react to failures correctly.
function describeExecError(err: any, fallback: string): { error: string; summary: string } {
  if (err?.killed && err?.signal === 'SIGTERM') {
    return { error: `command timed out — ${fallback}`, summary: 'timeout' };
  }
  const code = err?.code;
  const stderr = (err?.stderr ?? '').toString().trim();
  const message = err?.message ?? String(err);
  if (typeof code === 'number') {
    return stderr
      ? { error: `exit ${code}: ${stderr}`, summary: `exit ${code}` }
      : { error: `exit ${code}: ${message}`, summary: `exit ${code}` };
  }
  return stderr ? { error: stderr, summary: 'failed' } : { error: message, summary: 'failed' };
}

export class BashSkill {
  getSkill(): Skill {
    return {
      id: 'bash',
      name: 'Bash Command Execution',
      description: 'Execute bash commands on the local server',
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'bash.exec',
          description: 'Execute a bash command',
          handler: 'bashExec',
          parameters: {
            command: 'string',
            timeout: 'number',
            cwd: 'string'
          },
        },
        {
          name: 'bash.script',
          description: 'Execute a bash script file',
          handler: 'bashScript',
          parameters: {
            path: 'string',
            args: 'string'
          }
        },
        {
          name: 'bash.test',
          description: 'Test if a command exists',
          handler: 'bashTest',
          parameters: { command: 'string' }
        },
        {
          name: 'bash.env',
          description: 'Get environment variables',
          handler: 'bashEnv'
        },
        {
          name: 'bash.uptime',
          description: 'Get system uptime',
          handler: 'bashUptime'
        },
        {
          name: 'bash.whoami',
          description: 'Get current user',
          handler: 'bashWhoami'
        }
      ]
    };
  }

  async bashExec(
    params: { command: string; timeout?: number; cwd?: string; rollbackCommand?: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.command) return encode(fail('bash.exec requires { command }'));
    const timeout = params.timeout || 30000;
    try {
      const options = params.cwd ? { cwd: params.cwd } : {};
      const { stdout, stderr } = await execAsync(params.command, {
        timeout,
        ...options,
        maxBuffer: 10 * 1024 * 1024
      });

      // If the caller supplied an explicit rollbackCommand, register it.
      // Otherwise, sniff the command for known state-changing patterns and
      // register an action with no rollback command (a "noted change" the
      // operator can fill in later via rollback.execute with explicit args).
      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        if (params.rollbackCommand) {
          ctx.registerRollback({
            agentId: ctx.callerAgentId,
            taskId: ctx.taskId,
            action: `bash: ${params.command.slice(0, 120)}`,
            rollback: { kind: 'bash', command: params.rollbackCommand },
            skill: 'bash',
          });
        } else {
          for (const { re, describe } of REVERSIBLE_BASH_PATTERNS) {
            if (re.test(params.command)) {
              ctx.registerRollback({
                agentId: ctx.callerAgentId,
                taskId: ctx.taskId,
                action: describe(params.command),
                // No-op bash that does nothing — the operator must edit it
                // before executing. Better than silently doing the wrong undo.
                rollback: { kind: 'bash', command: `echo "TODO: define rollback for: ${params.command.replace(/"/g, "'")}" >&2; exit 1` },
                skill: 'bash',
              });
              break;
            }
          }
        }
      }

      return encode(ok(
        { stdout, stderr },
        stdout ? `${stdout.split('\n').length} lines stdout` : stderr ? 'stderr only' : 'no output'
      ));
    } catch (error: unknown) {
      const e = describeExecError(error, params.command);
      return encode(fail(e.error, e.summary));
    }
  }

  async bashScript(params: { path: string; args?: string }): Promise<string> {
    if (!params?.path) return encode(fail('bash.script requires { path }'));
    try {
      const cmd = params.args
        ? `bash ${shellEscape(params.path)} ${params.args}`
        : `bash ${shellEscape(params.path)}`;
      const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });
      return encode(ok({ stdout, stderr }, `script ${params.path} ran`));
    } catch (error: unknown) {
      const e = describeExecError(error, params.path);
      return encode(fail(e.error, e.summary));
    }
  }

  async bashTest(params: { command: string }): Promise<string> {
    if (!params?.command) return encode(fail('bash.test requires { command }'));
    try {
      assertSafeIdentifier(params.command, 'command');
    } catch (e) {
      return encode(fail((e as Error).message));
    }
    try {
      const { stdout } = await execAsync(`which ${shellEscape(params.command)}`);
      return encode(ok({ found: true, path: stdout.trim() }, `${params.command} is available`));
    } catch (error: any) {
      if (typeof error?.code === 'number' && error.code === 1) {
        return encode(ok({ found: false, path: null }, `${params.command} not found`));
      }
      const e = describeExecError(error, params.command);
      return encode(fail(e.error, e.summary));
    }
  }

  async bashEnv(): Promise<string> {
    try {
      const { stdout } = await execAsync('env | sort');
      const lines = stdout.split('\n').filter(Boolean);
      return encode(ok({ env: lines }, `${lines.length} env vars`));
    } catch (error: unknown) {
      return encode(fail((error as Error).message, 'env failed'));
    }
  }

  async bashUptime(): Promise<string> {
    try {
      const { stdout } = await execAsync('uptime');
      return encode(ok({ uptime: stdout.trim() }, stdout.trim()));
    } catch (error: unknown) {
      return encode(fail((error as Error).message, 'uptime failed'));
    }
  }

  async bashWhoami(): Promise<string> {
    try {
      const { stdout } = await execAsync('whoami');
      const user = stdout.trim();
      return encode(ok({ user }, `running as ${user}`));
    } catch (error: unknown) {
      return encode(fail((error as Error).message, 'whoami failed'));
    }
  }
}

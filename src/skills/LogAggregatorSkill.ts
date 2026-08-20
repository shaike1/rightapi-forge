// Log aggregation skill for remote and local log access

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { shellEscape, assertSafeIdentifier } from '../utils/shellEscape.js';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class LogAggregatorSkill {
  getSkill(): Skill {
    return {
      id: 'log-aggregator',
      name: 'Log Aggregator',
      description: 'Aggregate and search logs from remote servers and local Docker containers',
      category: 'monitoring',
      enabled: true,
      commands: [
        {
          name: 'logs.remote-tail',
          description: 'SSH to a host and tail a log file or journalctl unit',
          handler: 'remoteTail',
          parameters: { host: 'string', source: 'string', lines: 'number' }
        },
        {
          name: 'logs.remote-search',
          description: 'SSH to a host and grep a pattern in a log',
          handler: 'remoteSearch',
          parameters: { host: 'string', source: 'string', pattern: 'string', lines: 'number' }
        },
        {
          name: 'logs.aggregate-errors',
          description: 'SSH to ALL MONITORED_SERVERS and collect error-level journal entries from the last hour',
          handler: 'aggregateErrors'
        },
        {
          name: 'logs.aggregate-tail',
          description: 'SSH to ALL MONITORED_SERVERS and tail /var/log/syslog',
          handler: 'aggregateTail',
          parameters: { lines: 'number' }
        },
        {
          name: 'logs.docker-logs',
          description: 'Get last N lines of a Docker container log (local or remote host)',
          handler: 'dockerLogs',
          parameters: { host: 'string', container: 'string', lines: 'number' }
        }
      ]
    };
  }

  private getMonitoredServers(): string[] {
    const raw = process.env.MONITORED_SERVERS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  private ssh(host: string, cmd: string, timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
    // Caller is responsible for ensuring `host` passes assertSafeIdentifier; the
    // remote command is shell-escaped here so embedded $/`/" in `cmd` cannot
    // break out of the SSH-side quoting layer.
    return execAsync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${host} ${shellEscape(cmd)}`,
      { timeout: timeoutMs }
    );
  }

  async remoteTail(params: { host: string; source: string; lines?: number }): Promise<string> {
    if (!params.host) return encode(fail('logs.remote-tail requires { host }'));
    if (!params.source) return encode(fail('logs.remote-tail requires { source }'));
    const lines = params.lines ?? 100;
    try { assertSafeIdentifier(params.host, 'host'); } catch (e) { return encode(fail((e as Error).message)); }

    const cmd = params.source.startsWith('/')
      ? `tail -n ${lines} ${shellEscape(params.source)}`
      : `journalctl -u ${shellEscape(params.source)} -n ${lines} --no-pager`;

    try {
      const { stdout } = await this.ssh(params.host, cmd);
      return encode(ok({ host: params.host, source: params.source, lines, logs: stdout }, `${stdout.split('\n').length} lines from ${params.source} on ${params.host}`));
    } catch (error) {
      return failure(`tailing ${params.source} on ${params.host}`, error);
    }
  }

  async remoteSearch(params: { host: string; source: string; pattern: string; lines?: number }): Promise<string> {
    if (!params.host) return encode(fail('logs.remote-search requires { host }'));
    if (!params.source) return encode(fail('logs.remote-search requires { source }'));
    if (!params.pattern) return encode(fail('logs.remote-search requires { pattern }'));
    const lines = params.lines ?? 50;
    try { assertSafeIdentifier(params.host, 'host'); } catch (e) { return encode(fail((e as Error).message)); }

    const cmd = params.source.startsWith('/')
      ? `grep -n ${shellEscape(params.pattern)} ${shellEscape(params.source)} | tail -${lines}`
      : `journalctl -u ${shellEscape(params.source)} --no-pager -q | grep ${shellEscape(params.pattern)} | tail -${lines}`;

    try {
      const { stdout } = await this.ssh(params.host, cmd);
      const matches = stdout.split('\n').filter(Boolean);
      return encode(ok(
        { host: params.host, source: params.source, pattern: params.pattern, matches, count: matches.length },
        matches.length ? `${matches.length} match(es)` : 'no matches'
      ));
    } catch (error) {
      return failure(`searching ${params.source} on ${params.host}`, error);
    }
  }

  async aggregateErrors(): Promise<string> {
    const servers = this.getMonitoredServers();
    if (!servers.length) return encode(fail('No servers configured in MONITORED_SERVERS.'));

    const cmd = 'journalctl -p err --since "1 hour ago" --no-pager -q 2>/dev/null | tail -20';
    const results = await Promise.all(servers.map(async (host) => {
      try {
        const { stdout } = await this.ssh(host, cmd);
        return { host, errors: stdout.trim().split('\n').filter(Boolean), error: null as string | null };
      } catch (error) {
        return { host, errors: null, error: (error as Error).message };
      }
    }));

    const total = results.reduce((s, r) => s + (r.errors?.length ?? 0), 0);
    return encode(ok({ results }, `${total} error(s) across ${results.length} host(s)`));
  }

  async aggregateTail(params: { lines?: number } = {}): Promise<string> {
    const servers = this.getMonitoredServers();
    if (!servers.length) return encode(fail('No servers configured in MONITORED_SERVERS.'));
    const lines = params.lines ?? 20;

    const results = await Promise.all(servers.map(async (host) => {
      try {
        const { stdout } = await this.ssh(host, `tail -n ${lines} /var/log/syslog`);
        return { host, lines: stdout.trim().split('\n').filter(Boolean), error: null as string | null };
      } catch (error) {
        return { host, lines: null, error: (error as Error).message };
      }
    }));
    return encode(ok({ results, requestedLines: lines }, `aggregated syslog tail across ${results.length} host(s)`));
  }

  async dockerLogs(params: { host?: string; container: string; lines?: number }): Promise<string> {
    if (!params.container) return encode(fail('logs.docker-logs requires { container }'));
    const lines = params.lines ?? 100;
    try {
      assertSafeIdentifier(params.container, 'container');
      if (params.host) assertSafeIdentifier(params.host, 'host');
    } catch (e) { return encode(fail((e as Error).message)); }
    const cmd = `docker logs --tail ${lines} ${params.container}`;

    try {
      if (params.host) {
        const { stdout, stderr } = await this.ssh(params.host, cmd);
        return encode(ok({ host: params.host, container: params.container, lines, stdout, stderr }, `${stdout.split('\n').length} lines from ${params.container} on ${params.host}`));
      } else {
        const { stdout, stderr } = await execAsync(cmd);
        return encode(ok({ host: null, container: params.container, lines, stdout, stderr }, `${stdout.split('\n').length} lines from ${params.container} (local)`));
      }
    } catch (error) {
      return failure(`docker logs for ${params.container}${params.host ? ` on ${params.host}` : ''}`, error);
    }
  }
}

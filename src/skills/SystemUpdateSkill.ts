// System update management skill

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { shellEscape, assertSafeIdentifier } from '../utils/shellEscape.js';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class SystemUpdateSkill {
  getSkill(): Skill {
    return {
      id: 'system-update',
      name: 'System Update Manager',
      description: 'Manage system package updates locally and on remote servers',
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'update.check-local',
          description: 'Run apt list --upgradable locally, return count + list',
          handler: 'checkLocal'
        },
        {
          name: 'update.check-remote',
          description: 'SSH to each server and check upgradable package count',
          handler: 'checkRemote',
          parameters: { servers: 'string' }
        },
        {
          name: 'update.apply-local',
          description: 'Run DEBIAN_FRONTEND=noninteractive apt-get upgrade -y locally',
          handler: 'applyLocal'
        },
        {
          name: 'update.apply-remote',
          description: 'SSH to a specific host and run apt upgrade',
          handler: 'applyRemote',
          parameters: { host: 'string' }
        },
        {
          name: 'update.restart-service',
          description: 'Restart a systemd service on a host via SSH (or locally)',
          handler: 'restartService',
          parameters: { service: 'string', host: 'string' }
        },
        {
          name: 'update.os-info',
          description: 'Get OS version + kernel on local machine',
          handler: 'osInfo'
        },
        {
          name: 'update.os-info-remote',
          description: 'Get OS version + kernel on all MONITORED_SERVERS',
          handler: 'osInfoRemote'
        }
      ]
    };
  }

  private getMonitoredServers(): string[] {
    const raw = process.env.MONITORED_SERVERS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  private ssh(host: string, cmd: string, timeoutMs = 10000): Promise<{ stdout: string; stderr: string }> {
    // host is validated by callers via assertSafeIdentifier; the inner command
    // is shell-escaped so embedded shell metacharacters in `cmd` cannot break
    // out of the SSH-side quoting.
    return execAsync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${host} ${shellEscape(cmd)}`,
      { timeout: timeoutMs }
    );
  }

  async checkLocal(): Promise<string> {
    try {
      const { stdout } = await execAsync('apt list --upgradable 2>/dev/null');
      const lines = stdout.trim().split('\n').filter(l => l && !l.startsWith('Listing...'));
      return encode(ok({ packages: lines, count: lines.length }, `${lines.length} upgradable package(s)`));
    } catch (error) {
      return failure('checking local updates', error);
    }
  }

  async checkRemote(params: { servers?: string } = {}): Promise<string> {
    const serverList = params.servers
      ? params.servers.split(',').map(s => s.trim()).filter(Boolean)
      : this.getMonitoredServers();

    if (!serverList.length) return encode(fail('No servers configured. Set MONITORED_SERVERS or pass servers param.'));

    const results = await Promise.all(serverList.map(async (host) => {
      try {
        assertSafeIdentifier(host, 'host');
        const { stdout } = await this.ssh(host, 'apt list --upgradable 2>/dev/null | wc -l');
        const count = Math.max(0, parseInt(stdout.trim(), 10) - 1);
        return { host, count, error: null as string | null };
      } catch (error) {
        return { host, count: null, error: (error as Error).message };
      }
    }));

    const totalUpgrades = results.reduce((s, r) => s + (r.count ?? 0), 0);
    return encode(ok({ results }, `${totalUpgrades} upgradable package(s) across ${results.length} host(s)`));
  }

  async applyLocal(): Promise<string> {
    const timeoutMs = Number(process.env.APT_UPGRADE_TIMEOUT_MS) || 30 * 60 * 1000;
    try {
      const { stdout, stderr } = await execAsync(
        'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y',
        { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }
      );
      return encode(ok({ stdout, stderr }, 'apt upgrade complete'));
    } catch (error: any) {
      if (error?.killed && error?.signal === 'SIGTERM') {
        return encode(fail(
          `apt upgrade timed out after ${Math.round(timeoutMs / 1000)}s — set APT_UPGRADE_TIMEOUT_MS to extend.`,
          'timeout'
        ));
      }
      return failure('applying local updates', error);
    }
  }

  async applyRemote(params: { host: string }): Promise<string> {
    if (!params.host) return encode(fail('update.apply-remote requires { host }'));
    try { assertSafeIdentifier(params.host, 'host'); } catch (e) { return encode(fail((e as Error).message)); }
    const timeoutMs = Number(process.env.APT_UPGRADE_TIMEOUT_MS) || 30 * 60 * 1000;
    try {
      const { stdout, stderr } = await this.ssh(
        params.host,
        'DEBIAN_FRONTEND=noninteractive apt-get upgrade -y',
        timeoutMs
      );
      return encode(ok({ host: params.host, stdout, stderr }, `apt upgrade on ${params.host} complete`));
    } catch (error) {
      return failure(`applying remote updates on ${params.host}`, error);
    }
  }

  async restartService(params: { service: string; host?: string }): Promise<string> {
    if (!params.service) return encode(fail('update.restart-service requires { service }'));
    try {
      assertSafeIdentifier(params.service, 'service');
      if (params.host) assertSafeIdentifier(params.host, 'host');
    } catch (e) { return encode(fail((e as Error).message)); }
    const cmd = `systemctl restart ${params.service}`;
    try {
      if (params.host) {
        await this.ssh(params.host, cmd);
        return encode(ok({ service: params.service, host: params.host }, `restarted ${params.service} on ${params.host}`));
      } else {
        await execAsync(cmd);
        return encode(ok({ service: params.service, host: null }, `restarted ${params.service} locally`));
      }
    } catch (error) {
      return failure(`restarting ${params.service}${params.host ? ` on ${params.host}` : ''}`, error);
    }
  }

  async osInfo(): Promise<string> {
    try {
      const { stdout } = await execAsync('uname -r && cat /etc/os-release | grep PRETTY_NAME');
      const [kernel, prettyLine] = stdout.trim().split('\n');
      const prettyMatch = prettyLine?.match(/PRETTY_NAME="([^"]+)"/);
      return encode(ok({ kernel: kernel ?? '', osName: prettyMatch?.[1] ?? prettyLine ?? '' }, kernel || 'os info'));
    } catch (error) {
      return failure('getting local OS info', error);
    }
  }

  async osInfoRemote(): Promise<string> {
    const servers = this.getMonitoredServers();
    if (!servers.length) return encode(fail('No servers configured in MONITORED_SERVERS.'));

    const results = await Promise.all(servers.map(async (host) => {
      try {
        const { stdout } = await this.ssh(host, 'uname -r && cat /etc/os-release | grep PRETTY_NAME');
        const [kernel, prettyLine] = stdout.trim().split('\n');
        const prettyMatch = prettyLine?.match(/PRETTY_NAME="([^"]+)"/);
        return { host, kernel: kernel ?? '', osName: prettyMatch?.[1] ?? prettyLine ?? '', error: null };
      } catch (error) {
        return { host, kernel: null, osName: null, error: (error as Error).message };
      }
    }));

    return encode(ok({ results }, `${results.length} host(s) probed`));
  }
}

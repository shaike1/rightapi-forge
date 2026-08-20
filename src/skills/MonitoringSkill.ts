// Monitoring and alerting skills

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  const stderr = (e?.stderr ?? '').toString().trim();
  const code = e?.code ?? e?.errno ?? '';
  const msg = stderr || e?.message || String(e);
  return encode(fail(`${action}: ${msg}${code ? ` (${code})` : ''}`, action));
}

export class MonitoringSkill {
  private alerts: Array<{
    id: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    source: string;
    message: string;
    timestamp: Date;
    resolved: boolean;
  }> = [];

  getSkill(): Skill {
    return {
      id: 'monitoring',
      name: 'Monitoring & Alerting',
      description: 'System monitoring, log analysis, and alert management',
      category: 'monitoring',
      enabled: true,
      commands: [
        {
          name: 'monitor.cpu',
          description: 'Monitor CPU usage',
          handler: 'monitorCpu'
        },
        {
          name: 'monitor.memory',
          description: 'Monitor memory usage',
          handler: 'monitorMemory'
        },
        {
          name: 'monitor.disk',
          description: 'Monitor disk usage',
          handler: 'monitorDisk'
        },
        {
          name: 'monitor.network',
          description: 'Monitor network connections',
          handler: 'monitorNetwork'
        },
        {
          name: 'logs.tail',
          description: 'Tail log files',
          handler: 'logsTail',
          parameters: { file: 'string', lines: 'number' }
        },
        {
          name: 'logs.search',
          description: 'Search log files for patterns',
          handler: 'logsSearch',
          parameters: { file: 'string', pattern: 'string' }
        },
        {
          name: 'logs.journalctl',
          description: 'Query systemd journal',
          handler: 'logsJournalctl',
          parameters: { unit: 'string', lines: 'number' }
        },
        {
          name: 'alert.create',
          description: 'Create a monitoring alert',
          handler: 'alertCreate',
          parameters: { severity: 'string', source: 'string', message: 'string' }
        },
        {
          name: 'alert.list',
          description: 'List all alerts',
          handler: 'alertList'
        },
        {
          name: 'alert.resolve',
          description: 'Resolve an alert',
          handler: 'alertResolve',
          parameters: { alertId: 'string' }
        },
        {
          name: 'health.check',
          description: 'Run comprehensive health check',
          handler: 'healthCheck'
        },
        {
          name: 'servers.list',
          description: 'List all monitored servers from MONITORED_SERVERS env',
          handler: 'serversList'
        },
        {
          name: 'servers.ping',
          description: 'Ping all monitored servers to check reachability',
          handler: 'serversPing'
        },
        {
          name: 'servers.health',
          description: 'HTTP health check all monitored servers (hits /api/status or /health)',
          handler: 'serversHealth'
        }
      ]
    };
  }

  async monitorCpu(): Promise<string> {
    try {
      const { stdout } = await execAsync('top -bn1 | head -20');
      return encode(ok({ raw: stdout }, 'CPU snapshot'));
    } catch (error) { return failure('monitoring CPU', error); }
  }

  async monitorMemory(): Promise<string> {
    try {
      const { stdout } = await execAsync('free -m && echo "--- Swap ---" && swapon -s');
      return encode(ok({ raw: stdout }, 'memory snapshot'));
    } catch (error) { return failure('monitoring memory', error); }
  }

  async monitorDisk(): Promise<string> {
    try {
      const { stdout } = await execAsync('df -h && echo "--- Inode Usage ---" && df -i');
      return encode(ok({ raw: stdout }, 'disk snapshot'));
    } catch (error) { return failure('monitoring disk', error); }
  }

  async monitorNetwork(): Promise<string> {
    try {
      const { stdout } = await execAsync('ss -tuln && echo "--- Connection Count ---" && ss -s');
      return encode(ok({ raw: stdout }, 'network snapshot'));
    } catch (error) { return failure('monitoring network', error); }
  }

  async logsTail(params: { file: string; lines?: number }): Promise<string> {
    const file = params?.file;
    const lines = params?.lines ?? 100;
    if (!file) return encode(fail('logs.tail requires { file }'));
    try {
      const { stdout } = await execAsync(`tail -n ${lines} ${file}`);
      return encode(ok({ logs: stdout, file, lines }, `${stdout.split('\n').length} lines from ${file}`));
    } catch (error) { return failure(`tailing ${file}`, error); }
  }

  async logsSearch(params: { file: string; pattern: string }): Promise<string> {
    const file = params?.file;
    const pattern = params?.pattern;
    if (!file || !pattern) return encode(fail('logs.search requires { file, pattern }'));
    try {
      const { stdout } = await execAsync(`grep -n "${pattern}" ${file} | tail -50`);
      const matches = stdout ? stdout.split('\n').filter(Boolean) : [];
      return encode(ok(
        { matches, file, pattern, count: matches.length },
        matches.length ? `${matches.length} match(es)` : 'no matches'
      ));
    } catch (error: any) {
      // grep exit 1 = no matches, not an error
      if (typeof error?.code === 'number' && error.code === 1) {
        return encode(ok({ matches: [], file, pattern, count: 0 }, 'no matches'));
      }
      return failure(`searching ${file}`, error);
    }
  }

  async logsJournalctl(params: { unit?: string; lines?: number }): Promise<string> {
    const unit = params?.unit;
    const lines = params?.lines ?? 100;
    try {
      const cmd = unit
        ? `journalctl -u ${unit} -n ${lines} --no-pager`
        : `journalctl -n ${lines} --no-pager`;
      const { stdout } = await execAsync(cmd);
      return encode(ok({ logs: stdout, unit, lines }, unit ? `${unit} journal (${lines} lines)` : `journal (${lines} lines)`));
    } catch (error) { return failure('querying journal', error); }
  }

  alertCreate(params: { severity: string; source: string; message: string }): string {
    const { severity, source, message } = params || {} as any;
    if (!severity || !source || !message) {
      return encode(fail('alert.create requires { severity, source, message }'));
    }
    const alert = {
      id: `alert-${Date.now()}`,
      severity: severity as 'info' | 'warning' | 'error' | 'critical',
      source,
      message,
      timestamp: new Date(),
      resolved: false
    };
    this.alerts.push(alert);
    return encode(ok({ alert }, `created ${alert.id}`));
  }

  alertList(): string {
    return encode(ok(
      { alerts: this.alerts, total: this.alerts.length },
      this.alerts.length ? `${this.alerts.length} alert(s)` : 'no alerts'
    ));
  }

  alertResolve(params: { alertId: string }): string {
    const alertId = params?.alertId;
    if (!alertId) return encode(fail('alert.resolve requires { alertId }'));
    const alert = this.alerts.find(a => a.id === alertId);
    if (!alert) return encode(fail(`alert not found: ${alertId}`));
    alert.resolved = true;
    return encode(ok({ alert }, `resolved ${alertId}`));
  }

  async healthCheck(): Promise<string> {
    const checks = await Promise.all([
      execAsync('uptime').then(() => 'OK').catch(() => 'FAIL'),
      execAsync('df -h /').then(() => 'OK').catch(() => 'FAIL'),
      execAsync('free -m').then(() => 'OK').catch(() => 'FAIL'),
      execAsync('systemctl is-active sshd').then(() => 'OK').catch(() => 'FAIL'),
    ]);
    const result = {
      uptime: checks[0],
      disk: checks[1],
      memory: checks[2],
      ssh: checks[3],
      overall: checks.every(c => c === 'OK') ? 'HEALTHY' : 'WARNING'
    };
    return encode(ok(result, `health ${result.overall.toLowerCase()}`));
  }

  private getMonitoredServers(): string[] {
    const raw = process.env.MONITORED_SERVERS || '';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  async serversList(): Promise<string> {
    const servers = this.getMonitoredServers();
    if (!servers.length) return encode(fail('No servers configured. Set MONITORED_SERVERS env var (comma-separated IPs).'));
    return encode(ok({ servers, count: servers.length }, `${servers.length} monitored server(s)`));
  }

  async serversPing(): Promise<string> {
    const servers = this.getMonitoredServers();
    if (!servers.length) return encode(fail('No servers configured in MONITORED_SERVERS.'));
    const results = await Promise.all(servers.map(async (host) => {
      try {
        await execAsync(`ping -c 1 -W 2 ${host}`, { timeout: 5000 });
        return { host, reachable: true, error: null };
      } catch (e: any) {
        return { host, reachable: false, error: e?.code || e?.message || 'unreachable' };
      }
    }));
    const reachable = results.filter(r => r.reachable).length;
    return encode(ok({ results }, `${reachable}/${results.length} reachable`));
  }

  async serversHealth(): Promise<string> {
    const servers = this.getMonitoredServers();
    if (!servers.length) return encode(fail('No servers configured in MONITORED_SERVERS.'));
    const port = process.env.ITOPS_PORT || '19123';
    const results = await Promise.all(servers.map(async (host) => {
      const url = `http://${host}:${port}/api/status`;
      try {
        const res = await axios.get(url, { timeout: 5000 });
        return { host, up: true, agents: res.data?.agentCount, tasks: res.data?.taskCount, error: null };
      } catch (e: any) {
        return { host, up: false, agents: null, tasks: null, error: e?.code || e?.message };
      }
    }));
    const up = results.filter(r => r.up).length;
    return encode(ok({ results }, `${up}/${results.length} agents up`));
  }
}

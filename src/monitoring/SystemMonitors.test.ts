import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ServerRegistry, type MonitoredServer } from './ServerRegistry.js';
import { SystemMonitors } from './SystemMonitors.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

/** Stub executor: returns canned responses for a given (server.id, cmd)
 *  pair. Lets us exercise the per-server tick logic without actually
 *  running nsenter or ssh. The class normally accepts a RemoteExecutor,
 *  but its only contract is the two `execute*` methods, so a duck-typed
 *  stub is enough. */
class StubExecutor {
  /** Map keyed by `${serverId}::${file or 'shell'}::${argv-joined-or-cmd}`. */
  public responses = new Map<string, { stdout: string; stderr?: string; exitCode?: number }>();
  public calls: Array<{ serverId: string; kind: 'exec' | 'execFile'; cmd: string }> = [];

  set(serverId: string, key: string, response: { stdout: string; exitCode?: number }): void {
    this.responses.set(`${serverId}::${key}`, response);
  }

  async execute(server: MonitoredServer, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push({ serverId: server.id, kind: 'exec', cmd: command });
    const r = this.responses.get(`${server.id}::shell::${command}`)
      ?? this.responses.get(`${server.id}::shell::*`)
      ?? { stdout: '', exitCode: 1 };
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  }

  async executeFile(server: MonitoredServer, file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const key = `${file} ${args.join(' ')}`;
    this.calls.push({ serverId: server.id, kind: 'execFile', cmd: key });
    const r = this.responses.get(`${server.id}::execFile::${key}`)
      ?? this.responses.get(`${server.id}::execFile::*`)
      ?? { stdout: '', exitCode: 1 };
    return { stdout: r.stdout, stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
  }

  async testConnectivity(): Promise<{ ok: boolean; detail: string; durationMs: number }> {
    return { ok: true, detail: 'stub', durationMs: 0 };
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-srv-mon-'));
  const registry = new ServerRegistry(path.join(dir, 'servers.db'));
  registry.ensureLocal();
  registry.upsert({ name: 'production-1', host: '10.0.0.1', sshUser: 'ubuntu' });
  const incidentStore = new SqliteIncidentStore(path.join(dir, 'incidents.db'));
  const incidentManager = new IncidentManager(incidentStore);
  const executor = new StubExecutor();
  const monitors = new SystemMonitors({
    incidentManager,
    registry,
    executor: executor as any,
    notify: () => {},
    log: {
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    } as any,
  });
  return { registry, incidentManager, executor, monitors, dir };
}

test('CPU monitor uses un-suffixed sourceRef for local server (backward compat)', async () => {
  const { executor, monitors, incidentManager } = setup();
  // Local server: high load that crosses 80% on a single check —
  // but the streak threshold is 3 by default. Tick three times.
  executor.set('local', 'shell::cat /proc/loadavg; echo ---; nproc',
    { stdout: '3.20 3.10 3.00 1/100 1\n---\n2\n' });
  // production-1 stays calm.
  executor.set('production-1', 'shell::cat /proc/loadavg; echo ---; nproc',
    { stdout: '0.10 0.10 0.10 1/100 1\n---\n4\n' });
  // Provide a /proc/stat baseline + a docker-not-installed response so
  // those monitors finish without throwing.
  for (const srv of ['local', 'production-1']) {
    executor.set(srv, 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
    executor.set(srv, 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active docker', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active ssh', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active fail2ban', { stdout: 'active\n', exitCode: 0 });
  }

  await monitors.tick();
  await monitors.tick();
  await monitors.tick();

  const opened = incidentManager.list({ status: 'open' });
  const localCpuIncident = opened.find(i => i.sourceRef === 'cpu:sustained');
  assert.ok(localCpuIncident, 'local cpu incident filed with legacy sourceRef');
  assert.equal(localCpuIncident!.serverId, 'local');
  // production-1 stays quiet — no cpu:sustained:production-1 incident.
  const remoteCpuIncident = opened.find(i => i.sourceRef === 'cpu:sustained:production-1');
  assert.equal(remoteCpuIncident, undefined);
});

test('CPU monitor uses suffixed sourceRef + server_id for remote server', async () => {
  const { executor, monitors, incidentManager } = setup();
  // Both servers hot.
  for (const srv of ['local', 'production-1']) {
    executor.set(srv, 'shell::cat /proc/loadavg; echo ---; nproc',
      { stdout: '4.00 4.00 4.00 1/100 1\n---\n2\n' });
    executor.set(srv, 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
    executor.set(srv, 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active docker', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active ssh', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active fail2ban', { stdout: 'active\n', exitCode: 0 });
  }

  await monitors.tick();
  await monitors.tick();
  await monitors.tick();

  const opened = incidentManager.list({ status: 'open' });
  const local = opened.find(i => i.sourceRef === 'cpu:sustained');
  const remote = opened.find(i => i.sourceRef === 'cpu:sustained:production-1');
  assert.ok(local, 'local cpu incident filed');
  assert.ok(remote, 'remote cpu incident filed with suffixed ref');
  assert.equal(local!.serverId, 'local');
  assert.equal(remote!.serverId, 'production-1');
  assert.match(remote!.title, /^\[production-1\]/, 'remote title prefixed with server name');
});

test('docker monitor reports "not reachable" gracefully on a server without docker', async () => {
  const { executor, monitors, incidentManager } = setup();
  // CPU below threshold + minimal probes.
  for (const srv of ['local', 'production-1']) {
    executor.set(srv, 'shell::cat /proc/loadavg; echo ---; nproc',
      { stdout: '0.10 0.10 0.10 1/100 1\n---\n4\n' });
    executor.set(srv, 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
    // Services
    executor.set(srv, 'execFile::systemctl is-active docker', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active ssh', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active fail2ban', { stdout: 'active\n', exitCode: 0 });
  }
  // Docker query fails on production-1, succeeds on local.
  executor.set('local', 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 0 });
  executor.set('production-1', 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 127 });

  await monitors.tick();
  // No incidents should be filed — docker just not reachable is silent.
  const opened = incidentManager.list({ status: 'open' });
  assert.equal(opened.length, 0);
});

test('disabled server is skipped during tick', async () => {
  const { registry, executor, monitors, incidentManager } = setup();
  registry.update('production-1', { enabled: false });

  // Trigger conditions everywhere — but disabled server should not be polled.
  for (const srv of ['local', 'production-1']) {
    executor.set(srv, 'shell::cat /proc/loadavg; echo ---; nproc',
      { stdout: '4.00 4.00 4.00 1/100 1\n---\n2\n' });
    executor.set(srv, 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
    executor.set(srv, 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active docker', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active ssh', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active fail2ban', { stdout: 'active\n', exitCode: 0 });
  }

  await monitors.tick();

  // No calls for production-1.
  const calls = executor.calls.filter(c => c.serverId === 'production-1');
  assert.equal(calls.length, 0, 'disabled server received no probes');
  // Local still polled.
  const localCalls = executor.calls.filter(c => c.serverId === 'local');
  assert.ok(localCalls.length > 0, 'local server polled');
});

test('service monitor accepts an active platform alias', async () => {
  const { executor, monitors, incidentManager } = setup();
  for (const srv of ['local', 'production-1']) {
    executor.set(srv, 'shell::cat /proc/loadavg; echo ---; nproc', { stdout: '0.10 0.10 0.10 1/100 1\n---\n4\n' });
    executor.set(srv, 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
    executor.set(srv, 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active docker', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active fail2ban', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active ssh', { stdout: 'inactive\n', exitCode: 3 });
    executor.set(srv, 'execFile::systemctl is-active sshd', { stdout: 'active\n', exitCode: 0 });
  }
  await monitors.tick();
  assert.equal(incidentManager.list({ status: 'open' }).some(row => row.sourceRef?.includes('service:failed:ssh')), false);
  assert.ok(executor.calls.some(call => call.cmd === 'systemctl is-active sshd'));
});

test('iowait monitor tracks /proc/stat deltas separately per server', async () => {
  const { executor, monitors, incidentManager } = setup();
  // Tick 1: baseline /proc/stat.
  // Tick 2+: delta that puts iowait above 30% for production-1 only.
  for (const srv of ['local', 'production-1']) {
    executor.set(srv, 'shell::cat /proc/loadavg; echo ---; nproc',
      { stdout: '0.10 0.10 0.10 1/100 1\n---\n4\n' });
    executor.set(srv, 'execFile::docker ps -a --format {{.Names}}', { stdout: '', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active docker', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active ssh', { stdout: 'active\n', exitCode: 0 });
    executor.set(srv, 'execFile::systemctl is-active fail2ban', { stdout: 'active\n', exitCode: 0 });
  }
  // First tick: identical baseline on both.
  executor.set('local', 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
  executor.set('production-1', 'shell::cat /proc/stat', { stdout: 'cpu 100 0 50 800 50 0 0 0 0 0\n', exitCode: 0 });
  await monitors.tick();
  // Subsequent ticks on production-1: each tick adds 200 iowait jiffies
  // and 300 total jiffies → steady 66.7% iowait fraction (above the 30%
  // threshold). Three sustained ticks needed before the streak fires.
  // Local stays flat — same baseline every tick.
  for (let i = 1; i <= 4; i++) {
    const iowait = 50 + (i * 200);   // 250, 450, 650, 850
    const idle   = 800 + (i * 100);  // 900, 1000, 1100, 1200
    // total = 100 + 0 + 50 + idle + iowait + 0+0+0+0+0
    executor.set('production-1', 'shell::cat /proc/stat',
      { stdout: `cpu 100 0 50 ${idle} ${iowait} 0 0 0 0 0\n`, exitCode: 0 });
    await monitors.tick();
  }
  const opened = incidentManager.list({ status: 'open' });
  const remoteIowait = opened.find(i => i.sourceRef === 'iowait:sustained:production-1');
  const localIowait = opened.find(i => i.sourceRef === 'iowait:sustained');
  assert.ok(remoteIowait, 'remote iowait incident opened');
  assert.equal(localIowait, undefined, 'local stayed quiet');
});

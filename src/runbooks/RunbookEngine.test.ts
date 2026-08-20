import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookEngine } from './RunbookEngine.js';
import { RunbookRunStore } from './RunbookRunStore.js';
import { RunbookApprovalStore } from './RunbookApprovalStore.js';
import { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import { ServerRegistry } from '../monitoring/ServerRegistry.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import type { RunbookTemplate } from './RunbookTypes.js';
import type { MonitoredServer } from '../monitoring/ServerRegistry.js';
import type { ExecResult } from '../monitoring/RemoteExecutor.js';

function newStack(opts: { remoteExec?: { execute: (s: MonitoredServer, cmd: string) => Promise<ExecResult> } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rb-engine-test-'));
  const runStore = new RunbookRunStore(join(dir, 'runs.db'));
  const approvalStore = new RunbookApprovalStore(join(dir, 'approvals.db'));
  const metricsHistory = new MetricsHistoryStore(join(dir, 'metrics.db'));
  const servers = new ServerRegistry(join(dir, 'servers.db'));
  servers.upsert({ id: 'local', name: 'Local', isLocal: true });
  servers.upsert({ id: 'web01', name: 'Web 01', host: 'web01', sshUser: 'root' });
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const remoteExecutor = (opts.remoteExec ?? {
    execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
  }) as any;
  // Reset singleton state between tests (singleton is otherwise sticky).
  (RunbookEngine as any).instance = undefined;
  const engine = RunbookEngine.getInstance();
  engine.setSkillManager({ execute: async () => 'skill-output' });
  engine.wireInfraDeps({ remoteExecutor, serverRegistry: servers, metricsHistory, incidentManager: incidents, approvalStore, runStore });
  return { engine, runStore, approvalStore, metricsHistory, servers, incidents, remoteExecutor };
}

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForStatus(engine: RunbookEngine, runId: string, statuses: string[], timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = engine.getRun(runId);
    if (run && statuses.includes(run.status)) return;
    await wait(20);
  }
  throw new Error(`timeout waiting for run ${runId} to reach ${statuses.join('|')} — last was ${engine.getRun(runId)?.status}`);
}

function tplFromSteps(id: string, steps: RunbookTemplate['steps']): Omit<RunbookTemplate, 'createdAt' | 'updatedAt'> {
  return { id, name: id, description: '', category: 'test', tags: [], steps };
}

// ── command step ──────────────────────────────────────────────────────

test('command step runs through RemoteExecutor and captures stdout + exit code', async () => {
  const remote = { execute: async (_s: MonitoredServer, _cmd: string) => ({ stdout: 'hello', stderr: '', exitCode: 0 }) };
  const { engine } = newStack({ remoteExec: remote });
  engine.addTemplate(tplFromSteps('t-cmd', [
    { id: 's1', type: 'command', description: 'echo', serverId: 'local', command: 'echo hello' },
  ]));
  const run = await engine.executeRun('t-cmd', 'test');
  await waitForStatus(engine, run.id, ['completed', 'failed']);
  const final = engine.getRun(run.id)!;
  assert.equal(final.status, 'completed');
  assert.equal(final.stepResults[0].status, 'success');
  assert.equal(final.stepResults[0].exitCode, 0);
  assert.match(final.stepResults[0].output!, /hello/);
});

test('command step returns non-zero exit → step fails → run fails when no onFailure', async () => {
  const remote = { execute: async () => ({ stdout: '', stderr: 'oops', exitCode: 2 } as ExecResult) };
  const { engine } = newStack({ remoteExec: remote });
  engine.addTemplate(tplFromSteps('t-fail', [
    { id: 's1', type: 'command', description: 'fail', serverId: 'local', command: 'false' },
  ]));
  const run = await engine.executeRun('t-fail', 'test');
  await waitForStatus(engine, run.id, ['failed']);
  assert.equal(engine.getRun(run.id)!.status, 'failed');
  assert.equal(engine.getRun(run.id)!.stepResults[0].exitCode, 2);
});

test('destructive command pauses for approval regardless of requiresApproval flag', async () => {
  const remote = { execute: async () => ({ stdout: 'wiped', stderr: '', exitCode: 0 } as ExecResult) };
  const { engine, approvalStore } = newStack({ remoteExec: remote });
  engine.addTemplate(tplFromSteps('t-danger', [
    { id: 's1', type: 'command', description: 'wipe', serverId: 'local', command: 'rm -rf /var/log/foo' },
  ]));
  const run = await engine.executeRun('t-danger', 'test');
  await waitForStatus(engine, run.id, ['waiting_approval']);
  const pending = approvalStore.findPendingForStep(run.id, 's1');
  assert.ok(pending);
  assert.match(pending!.reason, /destructive command/i);
});

// ── check_metric step ─────────────────────────────────────────────────

test('check_metric reads latest sample and branches via onSuccess/onFailure', async () => {
  const { engine, metricsHistory } = newStack();
  metricsHistory.record([{ timestamp: new Date().toISOString(), serverId: 'local', metricType: 'disk', value: 92, dimension: '/' }]);
  engine.addTemplate(tplFromSteps('t-chk', [
    { id: 's1', type: 'check_metric', description: 'disk low?', metric: 'disk', serverId: 'local', operator: '<', threshold: 85, onSuccess: 'ok', onFailure: 'bad' },
    { id: 'ok', type: 'wait', description: 'ok path', seconds: 0 },
    { id: 'bad', type: 'wait', description: 'bad path', seconds: 0 },
  ]));
  const run = await engine.executeRun('t-chk', 'test');
  await waitForStatus(engine, run.id, ['completed', 'failed']);
  const final = engine.getRun(run.id)!;
  // Disk at 92 is not < 85, so onFailure ('bad') runs.
  const ranSteps = final.stepResults.filter(r => r.status === 'success').map(r => r.stepId);
  assert.ok(!ranSteps.includes('ok'));
  assert.ok(ranSteps.includes('bad'));
});

test('check_metric for disk picks the worst (highest) reading across mounts', async () => {
  const { engine, metricsHistory } = newStack();
  metricsHistory.record([
    { timestamp: new Date().toISOString(), serverId: 'local', metricType: 'disk', value: 45, dimension: '/' },
    { timestamp: new Date().toISOString(), serverId: 'local', metricType: 'disk', value: 92, dimension: '/data' },
  ]);
  engine.addTemplate(tplFromSteps('t-chk', [
    { id: 's1', type: 'check_metric', description: 'any disk full?', metric: 'disk', serverId: 'local', operator: '>', threshold: 90 },
  ]));
  const run = await engine.executeRun('t-chk', 'test');
  await waitForStatus(engine, run.id, ['completed', 'failed']);
  assert.equal(engine.getRun(run.id)!.status, 'completed', 'highest disk sample (92) > 90, so the check passes');
});

// ── wait + escalate + resolve ─────────────────────────────────────────

test('wait step pauses then succeeds; resolve step calls IncidentManager.resolve', async () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'thing', severity: 'medium', source: 'manual' });
  engine.addTemplate(tplFromSteps('t-wr', [
    { id: 's1', type: 'wait', description: 'wait', seconds: 0 },
    { id: 's2', type: 'resolve', description: 'fix it', resolution: 'auto-handled' },
  ]));
  const run = await engine.executeRun('t-wr', 'test', { context: { incidentId: inc.id } });
  await waitForStatus(engine, run.id, ['completed']);
  const after = incidents.get(inc.id)!;
  assert.equal(after.status, 'resolved');
});

test('escalate step needs context.incidentId — fails clearly without it', async () => {
  const { engine } = newStack();
  engine.addTemplate(tplFromSteps('t-esc', [
    { id: 's1', type: 'escalate', description: 'escalate', reason: 'auto' },
  ]));
  const run = await engine.executeRun('t-esc', 'test'); // no context
  await waitForStatus(engine, run.id, ['failed']);
  const final = engine.getRun(run.id)!;
  assert.match(final.stepResults[0].error!, /incidentId/);
});

// ── approval flow (flag, non-approval-type step) ───────────────────────

test('requiresApproval flag on a command step pauses, then runs body after approveStep', async () => {
  const remote = { execute: async () => ({ stdout: 'restarted', stderr: '', exitCode: 0 } as ExecResult) };
  const { engine, approvalStore } = newStack({ remoteExec: remote });
  engine.addTemplate(tplFromSteps('t-apr', [
    { id: 's1', type: 'command', description: 'restart svc', serverId: 'local', command: 'systemctl restart nginx', requiresApproval: true },
  ]));
  const run = await engine.executeRun('t-apr', 'test');
  await waitForStatus(engine, run.id, ['waiting_approval']);
  const pending = approvalStore.findPendingForStep(run.id, 's1');
  assert.ok(pending);
  assert.equal(approvalStore.listPending().length, 1);

  engine.approveStep(run.id, 'admin');
  await waitForStatus(engine, run.id, ['completed', 'failed']);
  const final = engine.getRun(run.id)!;
  assert.equal(final.status, 'completed', `expected completed, got ${final.status}: ${final.error}`);
  assert.equal(final.stepResults[0].approvedBy, 'admin');
  // Approval row was decided.
  assert.equal(approvalStore.listPending().length, 0);
});

test('rejectStep marks rejected — no body execution', async () => {
  let executed = 0;
  const remote = { execute: async () => { executed++; return { stdout: '', stderr: '', exitCode: 0 } as ExecResult; } };
  const { engine, approvalStore } = newStack({ remoteExec: remote });
  engine.addTemplate(tplFromSteps('t-rej', [
    { id: 's1', type: 'command', description: 'destroy', serverId: 'local', command: 'rm -rf /var/log' },
  ]));
  const run = await engine.executeRun('t-rej', 'test');
  await waitForStatus(engine, run.id, ['waiting_approval']);
  engine.rejectStep(run.id, 'admin', 'unsafe');
  await waitForStatus(engine, run.id, ['rejected', 'failed']);
  assert.equal(engine.getRun(run.id)!.status, 'rejected');
  assert.equal(executed, 0, 'destructive command must not run after rejection');
  const decided = approvalStore.listForRun(run.id);
  assert.equal(decided[0].status, 'rejected');
});

test('rejectStep with onFailure branch jumps instead of failing the run', async () => {
  const remote = { execute: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 } as ExecResult) };
  const { engine } = newStack({ remoteExec: remote });
  engine.addTemplate(tplFromSteps('t-rej-branch', [
    { id: 's1', type: 'command', description: 'destroy', serverId: 'local', command: 'rm -rf /var/log', onFailure: 'fallback' },
    { id: 'fallback', type: 'wait', description: 'safe fallback', seconds: 0 },
  ]));
  const run = await engine.executeRun('t-rej-branch', 'test');
  await waitForStatus(engine, run.id, ['waiting_approval']);
  engine.rejectStep(run.id, 'admin', 'no thanks');
  await waitForStatus(engine, run.id, ['completed', 'failed', 'rejected']);
  const final = engine.getRun(run.id)!;
  assert.equal(final.status, 'completed', 'fallback branch ran cleanly');
  assert.equal(final.stepResults.find(r => r.stepId === 'fallback')!.status, 'success');
});

// ── infinite-loop guard ──────────────────────────────────────────────

test('runaway onSuccess loop is caught by MAX_STEPS_PER_RUN guard', async () => {
  const { engine } = newStack();
  engine.addTemplate(tplFromSteps('t-loop', [
    { id: 'a', type: 'wait', description: 'a', seconds: 0, onSuccess: 'b' },
    { id: 'b', type: 'wait', description: 'b', seconds: 0, onSuccess: 'a' },
  ]));
  const run = await engine.executeRun('t-loop', 'test');
  await waitForStatus(engine, run.id, ['failed'], 5000);
  assert.match(engine.getRun(run.id)!.error!, /max steps/i);
});

// ── persistence via SQLite ───────────────────────────────────────────

test('runs land in SQLite and survive engine restart via runStore re-hydration', async () => {
  const { engine, runStore, approvalStore, metricsHistory, servers, incidents } = newStack();
  engine.addTemplate(tplFromSteps('t-persist', [
    { id: 's1', type: 'wait', description: 'short', seconds: 0 },
  ]));
  const run = await engine.executeRun('t-persist', 'test');
  await waitForStatus(engine, run.id, ['completed']);
  // Reset singleton state — simulates a process restart that re-uses the
  // existing on-disk store.
  (RunbookEngine as any).instance = undefined;
  const reborn = RunbookEngine.getInstance();
  reborn.wireInfraDeps({ runStore, approvalStore, metricsHistory, serverRegistry: servers, incidentManager: incidents });
  const found = reborn.getRun(run.id);
  assert.ok(found, 'completed run should still be queryable after restart');
  assert.equal(found!.status, 'completed');
});

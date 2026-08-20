import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteScheduledTaskStore } from '../persistence/index.js';
import { WorkflowRegistry, WorkflowJsonExecutor } from '../workflows/index.js';
import { SkillManager } from '../skills/index.js';
import { encode, ok, fail } from '../skills/index.js';
import { ScheduleEngine } from './ScheduleEngine.js';
import { buildSchedule, type ScheduledTask } from './ScheduledTaskTypes.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `itops-${prefix}-`));
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* race */ } },
  };
}

/** Build the minimum-viable engine with a SkillManager that has one
 *  fake skill named "ping.do" returning success. */
function newEngine(opts?: { workflowDir?: string; missedRunWindowMs?: number }) {
  const t = tempDir('schedule-engine');
  const store = new SqliteScheduledTaskStore(path.join(t.dir, 'sched.db'));
  const registry = new WorkflowRegistry({ workflowDir: opts?.workflowDir ?? t.dir });
  const sm = new SkillManager();
  const fakeSkill = {
    skill: { id: 'ping', name: 'ping', description: 'fake', category: 'general' as const,
             enabled: true, commands: [{ name: 'ping.do', description: 'p', handler: 'run' }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: { run: async (p: any) => encode(ok({ echoed: p?.message ?? '' }, 'pong')) } as any,
  };
  sm.registerWithExecutor(fakeSkill.skill, fakeSkill.executor);
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const engine = new ScheduleEngine({
    store, workflowRegistry: registry, workflowExecutor: exec, skillManager: sm,
    missedRunWindowMs: opts?.missedRunWindowMs,
  });
  return { engine, store, registry, sm, cleanup: () => { store.close(); t.cleanup(); } };
}

test('upsert validates the cron expression and computes nextRunAt', async () => {
  const { engine, store, cleanup } = newEngine();
  try {
    const task = buildSchedule({
      id: 's1', name: 'Every minute', cron: '* * * * *',
      action: { kind: 'shell', command: 'echo ok' },
    });
    const saved = await engine.upsert(task);
    assert.ok(saved.nextRunAt, 'nextRunAt should be populated');
    assert.equal(store.get('s1')?.cron, '* * * * *');
  } finally { cleanup(); }
});

test('upsert rejects invalid cron expressions', async () => {
  const { engine, cleanup } = newEngine();
  try {
    const task = buildSchedule({
      id: 'bad', name: 'bad', cron: 'not a cron',
      action: { kind: 'shell', command: 'true' },
    });
    await assert.rejects(() => engine.upsert(task), /invalid cron/);
  } finally { cleanup(); }
});

test('runNow on a workflow action drives the executor and records success', async () => {
  const { engine, store, registry, cleanup } = newEngine();
  try {
    registry.registerFromObject({
      schemaVersion: 1, id: 'wf-A', name: 'wf', version: '1',
      steps: [{ id: 's', type: 'skill', skill: 'ping.do' }],
    });
    await engine.upsert(buildSchedule({
      id: 'wf-sched', name: 'workflow schedule', cron: '0 0 * * *',
      action: { kind: 'workflow', workflowId: 'wf-A' },
    }));
    const run = await engine.runNow('wf-sched');
    assert.equal(run.outcome, 'success', JSON.stringify(run));
    assert.ok(run.workflowRunId, 'workflowRunId should be captured');
    const history = store.listRuns({ scheduleId: 'wf-sched' });
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'success');
  } finally { cleanup(); }
});

test('runNow on a shell action invokes bash.exec', async () => {
  const { engine, sm, store, cleanup } = newEngine();
  try {
    let captured = '';
    // Replace the bash skill with a recording fake.
    sm.unregister('bash');
    const bash = {
      skill: { id: 'bash', name: 'bash', description: 'fake', category: 'infrastructure' as const,
               enabled: true, commands: [{ name: 'bash.exec', description: 'b', handler: 'run' }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: { run: async (p: any) => { captured = String(p.command); return encode(ok({ stdout: 'ok' }, 'ran')); } } as any,
    };
    sm.registerWithExecutor(bash.skill, bash.executor);
    await engine.upsert(buildSchedule({
      id: 'shell-sched', name: 'shell', cron: '0 0 * * *',
      action: { kind: 'shell', command: 'echo hello-from-schedule' },
    }));
    const run = await engine.runNow('shell-sched');
    assert.equal(captured, 'echo hello-from-schedule');
    assert.equal(run.outcome, 'success');
    const history = store.listRuns({ scheduleId: 'shell-sched' });
    assert.equal(history.length, 1);
  } finally { cleanup(); }
});

test('shell action that throws is recorded as failed (not a crash)', async () => {
  const { engine, sm, store, cleanup } = newEngine();
  try {
    sm.unregister('bash');
    const bash = {
      skill: { id: 'bash', name: 'bash', description: 'fake', category: 'infrastructure' as const,
               enabled: true, commands: [{ name: 'bash.exec', description: 'b', handler: 'run' }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor: { run: async () => { throw new Error('boom'); } } as any,
    };
    sm.registerWithExecutor(bash.skill, bash.executor);
    await engine.upsert(buildSchedule({
      id: 'failsh', name: 'failing shell', cron: '0 0 * * *',
      action: { kind: 'shell', command: 'whatever' },
    }));
    const run = await engine.runNow('failsh');
    assert.equal(run.outcome, 'failed');
    assert.match(run.error ?? '', /boom/);
    const persisted = store.listRuns({ scheduleId: 'failsh' })[0];
    assert.equal(persisted.outcome, 'failed');
    assert.match(persisted.error ?? '', /boom/);
  } finally { cleanup(); }
});

test('paused schedule records a skipped run when manually triggered', async () => {
  const { engine, store, cleanup } = newEngine();
  try {
    await engine.upsert(buildSchedule({
      id: 'p', name: 'paused', cron: '0 0 * * *',
      action: { kind: 'shell', command: 'true' },
      status: 'paused',
    }));
    const run = await engine.runNow('p');
    assert.equal(run.outcome, 'skipped');
    assert.equal(run.skipReason, 'schedule-paused');
  } finally { cleanup(); }
});

test('concurrent in-flight run causes the second runNow to skip', async () => {
  const { engine, store, cleanup } = newEngine();
  try {
    // Hand-edit the persisted record to simulate an in-flight run.
    await engine.upsert(buildSchedule({
      id: 'busy', name: 'busy', cron: '0 0 * * *',
      action: { kind: 'shell', command: 'true' },
    }));
    const t = store.get('busy')!;
    store.upsert({ ...t, inFlightCount: 1 });
    const run = await engine.runNow('busy');
    assert.equal(run.outcome, 'skipped');
    assert.equal(run.skipReason, 'concurrent-run-in-flight');
  } finally { cleanup(); }
});

test('setStatus toggles the schedule + persists', async () => {
  const { engine, store, cleanup } = newEngine();
  try {
    await engine.upsert(buildSchedule({
      id: 'toggle', name: 't', cron: '0 0 * * *',
      action: { kind: 'shell', command: 'true' },
    }));
    assert.equal((await store.get('toggle'))!.status, 'enabled');
    assert.equal(await engine.setStatus('toggle', 'paused'), true);
    assert.equal((await store.get('toggle'))!.status, 'paused');
    assert.equal(await engine.setStatus('toggle', 'enabled'), true);
    assert.equal((await store.get('toggle'))!.status, 'enabled');
  } finally { cleanup(); }
});

test('delete removes the schedule and its node-cron job', async () => {
  const { engine, store, cleanup } = newEngine();
  try {
    await engine.upsert(buildSchedule({
      id: 'gone', name: 'g', cron: '0 0 * * *',
      action: { kind: 'shell', command: 'true' },
    }));
    assert.equal(await engine.delete('gone'), true);
    assert.equal(await store.get('gone'), null);
    assert.equal(await engine.delete('gone'), false, 'second delete is a no-op');
  } finally { cleanup(); }
});

test('computeNextRun returns ISO timestamp matching the cron expression', () => {
  const { engine, cleanup } = newEngine();
  try {
    const task = buildSchedule({
      id: 'n', name: 'n', cron: '*/15 * * * *',
      action: { kind: 'shell', command: 'true' },
    });
    const after = new Date('2026-05-07T00:00:00Z');
    const next = engine.computeNextRun(task, after);
    assert.ok(next, 'should compute a next time');
    const d = new Date(next!);
    assert.ok(d.getTime() > after.getTime(), 'next must be in the future');
    // 15-minute cron on UTC-aligned start should land within 15 minutes.
    assert.ok(d.getTime() - after.getTime() <= 16 * 60_000);
  } finally { cleanup(); }
});

test('missed-run replay synthesises a single run when the gap is within window', async () => {
  const { engine, store, cleanup } = newEngine({ missedRunWindowMs: 60 * 60 * 1000 });
  try {
    // Author a schedule whose last run was 10 minutes ago and cron is */1.
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const task = buildSchedule({
      id: 'replay', name: 'replay', cron: '*/1 * * * *',
      action: { kind: 'shell', command: 'true' },
    });
    task.lastRunAt = tenMinAgo;
    await store.upsert(task);
    // Stop node-cron from also ticking during this test by NOT calling
    // scheduleOne — but call replay directly via start().
    await engine.start();
    engine.stop();
    // The first run in history should be flagged missedRun=true.
    const history = store.listRuns({ scheduleId: 'replay' });
    assert.ok(history.length >= 1);
    assert.equal(history[0].missedRun, true);
  } finally { cleanup(); }
});

test('missed-run window exceeded → skipped row with reason', async () => {
  const { engine, store, cleanup } = newEngine({ missedRunWindowMs: 60_000 });
  try {
    const wayBack = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const task = buildSchedule({
      id: 'old', name: 'old', cron: '*/1 * * * *',
      action: { kind: 'shell', command: 'true' },
    });
    task.lastRunAt = wayBack;
    await store.upsert(task);
    await engine.start();
    engine.stop();
    const history = store.listRuns({ scheduleId: 'old' });
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'skipped');
    assert.equal(history[0].skipReason, 'missed-window-exceeded');
  } finally { cleanup(); }
});

test('a workflow that fails surfaces outcome=failed in run history', async () => {
  const { engine, registry, sm, store, cleanup } = newEngine();
  try {
    sm.registerWithExecutor(
      { id: 'flop', name: 'flop', description: 'fail', category: 'general' as const,
        enabled: true, commands: [{ name: 'flop.do', description: 'd', handler: 'run' }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { run: async () => encode(fail('intentional')) } as any,
    );
    registry.registerFromObject({
      schemaVersion: 1, id: 'wf-flop', name: 'flopwf', version: '1',
      steps: [{ id: 's', type: 'skill', skill: 'flop.do' }],
    });
    await engine.upsert(buildSchedule({
      id: 'fail-sched', name: 'fail', cron: '0 0 * * *',
      action: { kind: 'workflow', workflowId: 'wf-flop' },
    }));
    const run = await engine.runNow('fail-sched');
    assert.equal(run.outcome, 'failed');
    assert.match(run.error ?? '', /intentional/);
    const history = store.listRuns({ scheduleId: 'fail-sched' });
    assert.equal(history[0].outcome, 'failed');
  } finally { cleanup(); }
});

test('reference to an unregistered workflow id surfaces as a failed run', async () => {
  const { engine, store, cleanup } = newEngine();
  try {
    await engine.upsert(buildSchedule({
      id: 'nowf', name: 'nowf', cron: '0 0 * * *',
      action: { kind: 'workflow', workflowId: 'does-not-exist' },
    }));
    const run = await engine.runNow('nowf');
    assert.equal(run.outcome, 'failed');
    assert.match(run.error ?? '', /not registered/);
  } finally { cleanup(); }
});

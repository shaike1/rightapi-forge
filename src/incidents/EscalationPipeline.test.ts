import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteIncidentStore, type Incident } from '../persistence/SqliteStore.js';
import { IncidentManager } from './IncidentManager.js';
import { EscalationPipeline } from './EscalationPipeline.js';
import { OpenClawIntegration } from '../integrations/openclaw.js';

// Stub OpenClaw — we never want real HTTP in tests; we just want to
// observe which alerts the pipeline tried to send. Casts via `as any`
// because we're substituting a private behavior into an exported class.
class StubOpenClaw extends OpenClawIntegration {
  public sentEscalations: Array<{ level: number; incidentId: string; ctx: any }> = [];
  public sentResolutions: Array<{ incidentId: string; note?: string }> = [];

  constructor() {
    // Pass a synthetic env that flips isConfigured() on without any
    // real URL/token. The send() implementation is bypassed below.
    super({
      OPENCLAW_ENABLED: 'true',
      OPENCLAW_URL: 'http://stub.local',
      OPENCLAW_GATEWAY_TOKEN: 'stub-token',
      OPENCLAW_MIN_SEVERITY: 'low',
    } as any);
  }

  override async sendEscalationAlert(level: number, incident: Incident, ctx: any): Promise<boolean> {
    this.sentEscalations.push({ level, incidentId: incident.id, ctx });
    return true;
  }

  override async sendResolutionNotice(incident: Incident, note?: string): Promise<boolean> {
    this.sentResolutions.push({ incidentId: incident.id, note });
    return true;
  }
}

function setup(opts: Parameters<typeof Reflect.ownKeys>[0] extends never ? any : any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-escalation-'));
  const store = new SqliteIncidentStore(path.join(dir, 'incidents.db'));
  const mgr = new IncidentManager(store);
  const openclaw = new StubOpenClaw();
  const pipeline = new EscalationPipeline(mgr, openclaw, {
    enabled: true,
    l3DelayMs: 0,           // make transitions synchronous in tests
    l4TimeoutMs: 60_000,
    minSeverity: 'medium',
    ...opts,
  });
  return { mgr, openclaw, pipeline, dir };
}

test('shouldHandle gates by minimum severity', () => {
  const { pipeline } = setup({ minSeverity: 'high' });
  assert.equal(pipeline.shouldHandle({ severity: 'low' }), false);
  assert.equal(pipeline.shouldHandle({ severity: 'medium' }), false);
  assert.equal(pipeline.shouldHandle({ severity: 'high' }), true);
  assert.equal(pipeline.shouldHandle({ severity: 'critical' }), true);
});

test('shouldHandle returns false when pipeline is disabled', () => {
  const { pipeline } = setup({ enabled: false });
  assert.equal(pipeline.shouldHandle({ severity: 'critical' }), false);
});

test('recordLevel1 sets escalation_level=1 + writes timeline note', () => {
  const { mgr, pipeline } = setup();
  const inc = mgr.create({ title: 'CPU overload', severity: 'high' });
  pipeline.recordLevel1(inc, 'sysadmin-1');
  const after = mgr.get(inc.id)!;
  assert.equal(after.escalationLevel, 1);
  assert.ok(after.escalatedAt, 'escalatedAt set on L1');
  const note = after.timeline.find(t => t.actor === 'escalation-pipeline');
  assert.ok(note, 'timeline note recorded');
  assert.match(note!.message, /^\[L1\]/);
  assert.match(note!.message, /sysadmin-1/);
});

test('low-severity incidents skip the pipeline entirely', () => {
  const { mgr, pipeline, openclaw } = setup({ minSeverity: 'medium' });
  const inc = mgr.create({ title: 'Audit row', severity: 'low' });
  pipeline.recordLevel1(inc, 'sysadmin-1');
  pipeline.handleFallback(inc, { reason: 'agent quit', remediatorKind: null });
  const after = mgr.get(inc.id)!;
  assert.equal(after.escalationLevel ?? 0, 0);
  assert.equal(openclaw.sentEscalations.length, 0);
});

test('handleFallback with no remediator goes straight to L3 + sends OpenClaw alert', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'Memory at 95%', severity: 'high' });
  pipeline.recordLevel1(inc, 'sysadmin-1');
  pipeline.handleFallback(inc, {
    reason: 'agent gave up',
    remediatorKind: null,
    agentName: 'sysadmin-1',
    agentIterations: 7,
    agentActions: ['ran check_metric', 'searched runbooks', 'no fix'],
  });
  // L3 escalation is async — handleFallback queues it via setTimeout 0
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const after = mgr.get(inc.id)!;
  assert.equal(after.escalationLevel, 3);
  assert.equal(openclaw.sentEscalations.length, 1);
  assert.equal(openclaw.sentEscalations[0].level, 3);
  assert.equal(openclaw.sentEscalations[0].incidentId, inc.id);
  assert.equal(openclaw.sentEscalations[0].ctx.agentName, 'sysadmin-1');
});

test('handleFallback with a remediator records L2 then escalates to L3', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'Disk Critical: /data', severity: 'high' });
  pipeline.recordLevel1(inc, 'sysadmin-1');
  pipeline.handleFallback(inc, {
    reason: 'agent failed',
    remediatorKind: 'disk-cleanup',
    remediatorActions: ['docker container prune -f', 'docker image prune -f'],
  });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const after = mgr.get(inc.id)!;
  // L2 transition was recorded before the L3 timer fired.
  const l2Note = after.timeline.find(t => /^\[L2\]/.test(t.message));
  assert.ok(l2Note, 'L2 timeline note exists');
  assert.equal(after.escalationLevel, 3, 'reached L3 after the 0-delay timer fired');
  assert.equal(openclaw.sentEscalations.length, 1);
  assert.equal(openclaw.sentEscalations[0].ctx.remediatorKind, 'disk-cleanup');
});

test('escalateToHuman is idempotent — re-fire on L3 incident is a no-op', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'X', severity: 'high' });
  await pipeline.escalateToHuman(inc.id, { reason: 'first' });
  await pipeline.escalateToHuman(inc.id, { reason: 'second — should be ignored' });
  assert.equal(openclaw.sentEscalations.length, 1, 'only one alert');
});

test('escalateToHuman skips resolved incidents', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'X', severity: 'high' });
  mgr.resolve(inc.id, 'fixed manually');
  await pipeline.escalateToHuman(inc.id, { reason: 'too late' });
  assert.equal(openclaw.sentEscalations.length, 0);
});

test('tick promotes L3 → L4 once l4TimeoutMs has passed', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0, l4TimeoutMs: 60_000 });
  const inc = mgr.create({ title: 'Stuck', severity: 'medium' });
  await pipeline.escalateToHuman(inc.id, { reason: 'paged' });
  // Simulate time travel by rewriting escalated_at backwards.
  const live = mgr.get(inc.id)!;
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  mgr.incidentStore.upsert({ ...live, escalatedAt: past });

  await pipeline.tick();
  const after = mgr.get(inc.id)!;
  assert.equal(after.escalationLevel, 4);
  // Severity bumped from medium → high.
  assert.equal(after.severity, 'high');
  // L3 alert + L4 alert both went out.
  assert.equal(openclaw.sentEscalations.length, 2);
  assert.equal(openclaw.sentEscalations[1].level, 4);
});

test('tick does not promote L3 before the timeout', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0, l4TimeoutMs: 60_000 });
  const inc = mgr.create({ title: 'Fresh L3', severity: 'high' });
  await pipeline.escalateToHuman(inc.id, { reason: 'paged' });
  // escalated_at is "now" — well within the 60s window.
  await pipeline.tick();
  const after = mgr.get(inc.id)!;
  assert.equal(after.escalationLevel, 3, 'still L3');
  assert.equal(openclaw.sentEscalations.length, 1);
});

test('tick sends resolution notice and resets level when L3+ incident resolves', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'Recovers', severity: 'high' });
  await pipeline.escalateToHuman(inc.id, { reason: 'paged' });
  assert.equal(mgr.get(inc.id)!.escalationLevel, 3);

  mgr.resolve(inc.id, 'metric cleared via auto-resolve');
  await pipeline.tick();

  const after = mgr.get(inc.id)!;
  assert.equal(after.escalationLevel, 0, 'level reset after resolution');
  assert.equal(openclaw.sentResolutions.length, 1);
  assert.equal(openclaw.sentResolutions[0].incidentId, inc.id);
});

test('tick does not send resolution notice for resolved L1 incidents', async () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'Agent fixed it', severity: 'high' });
  pipeline.recordLevel1(inc, 'sysadmin-1');
  mgr.resolve(inc.id, 'agent fixed');
  await pipeline.tick();
  assert.equal(openclaw.sentResolutions.length, 0, 'no notice — never reached L3');
});

test('recordResolution sends the resolution notice and resets level', () => {
  const { mgr, pipeline, openclaw } = setup({ l3DelayMs: 0 });
  const inc = mgr.create({ title: 'X', severity: 'high' });
  // Force the incident to L3 via the manager so recordResolution sees it.
  mgr.setEscalation(inc.id, 3);
  const live = mgr.get(inc.id)!;
  pipeline.recordResolution(live);
  // sendResolutionNotice is async + fire-and-forget; allow microtasks.
  return new Promise<void>(resolve => setImmediate(() => {
    assert.equal(mgr.get(inc.id)!.escalationLevel, 0);
    assert.equal(openclaw.sentResolutions.length, 1);
    resolve();
  }));
});

test('shutdown clears all pending L3 timers', () => {
  const { mgr, pipeline } = setup({ l3DelayMs: 10_000 });
  const inc = mgr.create({ title: 'X', severity: 'high' });
  pipeline.handleFallback(inc, { reason: 'a', remediatorKind: 'disk-cleanup' });
  pipeline.shutdown();
  // No assertion needed — if the timers weren't cleared the test process
  // wouldn't exit. node:test will hang and fail by timeout.
});

test('setEscalation is idempotent on identical level (no duplicate timeline)', () => {
  const { mgr } = setup();
  const inc = mgr.create({ title: 'X', severity: 'high' });
  mgr.setEscalation(inc.id, 3);
  mgr.setEscalation(inc.id, 3);
  mgr.setEscalation(inc.id, 3);
  const after = mgr.get(inc.id)!;
  const l3Notes = after.timeline.filter(t => /^\[L3\]/.test(t.message));
  assert.equal(l3Notes.length, 1, 'only the first transition wrote a note');
});

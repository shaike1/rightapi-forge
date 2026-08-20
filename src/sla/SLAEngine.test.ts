import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLAEngine } from './SLAEngine.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

function newStack() {
  const dir = mkdtempSync(join(tmpdir(), 'sla-test-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const engine = new SLAEngine({ dbPath: join(dir, 'sla.db'), incidentManager: incidents });
  return { dir, incidents, engine };
}

// ── Defaults ───────────────────────────────────────────────────────────

test('seeds default policies on first boot, idempotent on second open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sla-seed-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const dbPath = join(dir, 'sla.db');
  const a = new SLAEngine({ dbPath, incidentManager: incidents });
  const seeded = a.listPolicies();
  assert.equal(seeded.length, 4, 'four default policies');
  const sevs = seeded.map(p => p.severity).sort();
  assert.deepEqual(sevs, ['critical', 'high', 'low', 'medium']);
  const crit = seeded.find(p => p.severity === 'critical')!;
  assert.equal(crit.responseTimeMinutes, 15);
  assert.equal(crit.resolutionTimeMinutes, 60);
  a.close();
  // Re-open: seeding must NOT duplicate.
  const b = new SLAEngine({ dbPath, incidentManager: incidents });
  assert.equal(b.listPolicies().length, 4);
});

test('resolvePolicy returns the enabled policy for the severity', () => {
  const { engine } = newStack();
  const p = engine.resolvePolicy('high');
  assert.ok(p);
  assert.equal(p!.severity, 'high');
  assert.equal(p!.responseTimeMinutes, 60);
});

test('resolvePolicy returns null when the policy is disabled', () => {
  const { engine } = newStack();
  const high = engine.listPolicies().find(p => p.severity === 'high')!;
  engine.updatePolicy(high.id, { enabled: false });
  assert.equal(engine.resolvePolicy('high'), null);
});

// ── Policy CRUD ────────────────────────────────────────────────────────

test('createPolicy validates fields', () => {
  const { engine } = newStack();
  assert.throws(() => engine.createPolicy({ name: 'bad', severity: 'critical' as any, responseTimeMinutes: -1, resolutionTimeMinutes: 60, businessHoursOnly: false, enabled: true }), /responseTimeMinutes/);
  assert.throws(() => engine.createPolicy({ name: 'bad', severity: 'critical', responseTimeMinutes: 5, resolutionTimeMinutes: 0, businessHoursOnly: false, enabled: true }), /resolutionTimeMinutes/);
  assert.throws(() => engine.createPolicy({ name: 'bad', severity: 'oops' as any, responseTimeMinutes: 5, resolutionTimeMinutes: 10, businessHoursOnly: false, enabled: true }), /severity must be/);
});

test('updatePolicy preserves fields not in the patch', () => {
  const { engine } = newStack();
  const high = engine.listPolicies().find(p => p.severity === 'high')!;
  const updated = engine.updatePolicy(high.id, { responseTimeMinutes: 30 })!;
  assert.equal(updated.responseTimeMinutes, 30);
  assert.equal(updated.resolutionTimeMinutes, 240, 'resolution unchanged');
  assert.equal(updated.name, 'High', 'name unchanged');
});

// ── Tracking lifecycle ─────────────────────────────────────────────────

test('onIncidentCreated inserts a tracking row with computed deadlines', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'CPU spike', severity: 'high', source: 'manual' });
  const full = incidents.get(inc.id)!;
  const tracking = engine.onIncidentCreated(full)!;
  assert.ok(tracking);
  // Default high: 60min response, 240min resolution.
  const respDelta = new Date(tracking.responseDeadline).getTime() - new Date(inc.createdAt).getTime();
  const resDelta  = new Date(tracking.resolutionDeadline).getTime() - new Date(inc.createdAt).getTime();
  assert.equal(respDelta / 60_000, 60);
  assert.equal(resDelta  / 60_000, 240);
  assert.equal(tracking.responseMet, null);
  assert.equal(tracking.resolutionMet, null);
  assert.equal(tracking.breached, false);
});

test('onIncidentCreated is idempotent', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'x', severity: 'medium', source: 'manual' });
  const a = engine.onIncidentCreated(incidents.get(inc.id)!)!;
  const b = engine.onIncidentCreated(incidents.get(inc.id)!)!;
  assert.equal(a.id, b.id, 'same tracking row returned, no second insert');
});

test('onIncidentCreated returns null when no enabled policy applies', () => {
  const { engine, incidents } = newStack();
  const high = engine.listPolicies().find(p => p.severity === 'high')!;
  engine.updatePolicy(high.id, { enabled: false });
  const inc = incidents.create({ title: 'no policy', severity: 'high', source: 'manual' });
  const r = engine.onIncidentCreated(incidents.get(inc.id)!);
  assert.equal(r, null);
  assert.equal(engine.getTracking(inc.id), null);
});

test('onIncidentResolved records resolved_at and decides resolution_met', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'x', severity: 'medium', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  const resolved = incidents.resolve(inc.id, 'ok')!;
  engine.onIncidentResolved(resolved);
  const t = engine.getTracking(inc.id)!;
  assert.equal(t.resolutionMet, true, 'fast resolve should be within the medium deadline');
  assert.ok(t.resolvedAt);
});

// ── Response detection ────────────────────────────────────────────────

test('detectResponses sets responded_at from the first non-opened timeline event', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'x', severity: 'high', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  // First activity: a note. Should land as the response timestamp.
  incidents.addNote(inc.id, 'alice', 'looking');
  const r = engine.detectResponses();
  assert.equal(r.detected.length, 1);
  const t = engine.getTracking(inc.id)!;
  assert.ok(t.respondedAt, 'respondedAt should be populated from the note timestamp');
  assert.equal(t.responseMet, true, 'note arrived inside the 60min response window');
});

test('detectResponses is a no-op on a second pass with no new activity', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'x', severity: 'high', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  incidents.addNote(inc.id, 'alice', 'note');
  engine.detectResponses();
  const second = engine.detectResponses();
  assert.equal(second.detected.length, 0);
});

// ── Breach detection ──────────────────────────────────────────────────

test('checkBreaches flips breached=true when the resolution deadline passes', () => {
  const { engine, incidents } = newStack();
  // Create a Critical (60min resolution) incident, then claim "now"
  // is 90 minutes after creation.
  const inc = incidents.create({ title: 'down', severity: 'critical', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  const future = new Date(inc.createdAt).getTime() + 90 * 60_000;
  const r = engine.checkBreaches(future);
  assert.equal(r.newBreaches.length, 1, 'one new breach surfaced');
  assert.equal(r.newBreaches[0].tracking.breached, true);
  // Subsequent calls don't re-emit.
  const r2 = engine.checkBreaches(future);
  assert.equal(r2.newBreaches.length, 0);
});

test('checkBreaches emits a warning at 75% elapsed before breaching', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'down', severity: 'critical', source: 'manual' }); // 60min window
  engine.onIncidentCreated(incidents.get(inc.id)!);
  // 80% elapsed: warning fires but not breach.
  const future = new Date(inc.createdAt).getTime() + 48 * 60_000;
  const r = engine.checkBreaches(future);
  assert.equal(r.newWarnings.length, 1);
  assert.equal(r.newBreaches.length, 0);
  // Second call doesn't re-emit the warning.
  const r2 = engine.checkBreaches(future);
  assert.equal(r2.newWarnings.length, 0);
});

test('checkBreaches stamps response_met=false when response deadline passes with no activity', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'idle', severity: 'critical', source: 'manual' }); // 15min response
  engine.onIncidentCreated(incidents.get(inc.id)!);
  const future = new Date(inc.createdAt).getTime() + 30 * 60_000; // past response, before resolution
  engine.checkBreaches(future);
  const t = engine.getTracking(inc.id)!;
  assert.equal(t.responseMet, false);
});

test('checkBreaches ignores resolved incidents (clock frozen)', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'fast', severity: 'critical', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  const resolved = incidents.resolve(inc.id, 'fixed')!;
  engine.onIncidentResolved(resolved);
  // Walk into the future — already-resolved row should be skipped.
  const future = Date.now() + 24 * 60 * 60 * 1000;
  const r = engine.checkBreaches(future);
  assert.equal(r.newBreaches.length, 0);
});

// ── Metrics ───────────────────────────────────────────────────────────

test('getMetrics computes compliance %, MTTR, MTTA from tracking rows', () => {
  const { engine, incidents } = newStack();
  // Two resolved-on-time, one breached.
  const a = incidents.create({ title: 'a', severity: 'medium', source: 'manual' }); // 1440min window
  const b = incidents.create({ title: 'b', severity: 'medium', source: 'manual' });
  const c = incidents.create({ title: 'c', severity: 'medium', source: 'manual' });
  engine.onIncidentCreated(incidents.get(a.id)!);
  engine.onIncidentCreated(incidents.get(b.id)!);
  engine.onIncidentCreated(incidents.get(c.id)!);
  // Resolve a and b quickly (met). Leave c past the resolution deadline.
  engine.onIncidentResolved(incidents.resolve(a.id, 'ok')!);
  engine.onIncidentResolved(incidents.resolve(b.id, 'ok')!);
  // Simulate c being past resolution deadline.
  engine.checkBreaches(new Date(c.createdAt).getTime() + 2000 * 60_000);
  const m = engine.getMetrics('7d');
  assert.equal(m.total, 3);
  assert.equal(m.resolutionMet, 2);
  assert.equal(m.resolutionPending, 1, 'c is breached but not resolved');
  assert.equal(m.compliancePercent, 100, 'a+b resolved on time; c is pending, not missed');
  assert.equal(m.activeBreaches, 1);
  assert.ok(m.mttrMinutes !== null && m.mttrMinutes >= 0);
});

test('getMetricsBySeverity buckets by policy severity', () => {
  const { engine, incidents } = newStack();
  const hi = incidents.create({ title: 'h', severity: 'high', source: 'manual' });
  const lo = incidents.create({ title: 'l', severity: 'low',  source: 'manual' });
  engine.onIncidentCreated(incidents.get(hi.id)!);
  engine.onIncidentCreated(incidents.get(lo.id)!);
  const m = engine.getMetricsBySeverity('30d');
  assert.equal(m.high.total, 1);
  assert.equal(m.low.total,  1);
  assert.equal(m.critical.total, 0);
  assert.equal(m.medium.total, 0);
});

test('getComplianceTrend returns one bucket per day', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'x', severity: 'high', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  engine.onIncidentResolved(incidents.resolve(inc.id, 'ok')!);
  const t = engine.getComplianceTrend('7d');
  assert.equal(t.length, 7);
  // The most recent bucket should contain our incident.
  const today = t[t.length - 1];
  assert.equal(today.total, 1);
  assert.equal(today.compliancePercent, 100);
});

// ── listTracking filters ──────────────────────────────────────────────

test('listTracking filter=breached returns only breached rows', () => {
  const { engine, incidents } = newStack();
  const inc = incidents.create({ title: 'down', severity: 'critical', source: 'manual' });
  engine.onIncidentCreated(incidents.get(inc.id)!);
  engine.checkBreaches(new Date(inc.createdAt).getTime() + 90 * 60_000);
  const breached = engine.listTracking({ state: 'breached' });
  const pending = engine.listTracking({ state: 'pending' });
  assert.equal(breached.length, 1);
  assert.equal(pending.length, 0);
});

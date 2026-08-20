import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { IncidentManager } from './IncidentManager.js';
import { AgentWorkloadTracker } from '../agents/AgentWorkloadTracker.js';

function freshManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-inc-mgr-'));
  const store = new SqliteIncidentStore(path.join(dir, 'incidents.db'));
  return new IncidentManager(store);
}

function managerWithTracker(): { mgr: IncidentManager; tracker: AgentWorkloadTracker } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-inc-mgr-'));
  const store = new SqliteIncidentStore(path.join(dir, 'incidents.db'));
  const mgr = new IncidentManager(store);
  const tracker = new AgentWorkloadTracker(null);
  mgr.setWorkloadTracker(tracker);
  return { mgr, tracker };
}

test('assignAgent overwrites the "IT Director" placeholder with the picked agent name', () => {
  const { mgr, tracker } = managerWithTracker();
  // Simulate a health-monitor row with the legacy placeholder label.
  const inc = mgr.create({
    title: 'Disk Critical: /data',
    severity: 'high',
    source: 'health-monitor',
    assignedTo: 'IT Director',
  });
  assert.equal(inc.assignedTo, 'IT Director');
  // Dispatch picks Ops Bravo (not the director).
  const updated = mgr.assignAgent(inc.id, { id: 'bravo-1', name: 'Ops Bravo' });
  assert.ok(updated);
  assert.equal(updated!.assignedAgent, 'bravo-1');
  assert.equal(updated!.assignedTo, 'Ops Bravo', 'placeholder was overwritten');
  void tracker;
});

test('assignAgent preserves a non-placeholder operator-set assignedTo', () => {
  const mgr = freshManager();
  const inc = mgr.create({
    title: 'X', severity: 'high', assignedTo: 'on-call-rotation',
  });
  const updated = mgr.assignAgent(inc.id, { id: 'bravo-1', name: 'Ops Bravo' });
  assert.equal(updated!.assignedTo, 'on-call-rotation');
});

test('assignAgent keeps "IT Director" when the picker actually chose the director', () => {
  // Edge case: when the picker chooses the director itself (e.g. critical
  // incident with no body agents), the agent's name IS 'IT Director' —
  // we must NOT overwrite then.
  const mgr = freshManager();
  const inc = mgr.create({
    title: 'X', severity: 'critical', assignedTo: 'IT Director',
  });
  const updated = mgr.assignAgent(inc.id, { id: 'dir-1', name: 'IT Director' });
  assert.equal(updated!.assignedTo, 'IT Director');
});

test('rewriteStaleDirectorLabel fixes only the affected rows', () => {
  const mgr = freshManager();
  // 1) Stuck row: placeholder + a real agent assigned
  const stuck = mgr.create({ title: 'A', severity: 'high', assignedTo: 'IT Director' });
  mgr.assignAgent(stuck.id, { id: 'bravo-1', name: 'Ops Bravo' });
  // Re-set the placeholder to simulate a row written BEFORE the
  // assignAgent overwrite fix landed.
  mgr.incidentStore.upsert({ ...mgr.get(stuck.id)!, assignedTo: 'IT Director' });
  // 2) Legitimate director assignment — should stay
  const dirRow = mgr.create({ title: 'B', severity: 'critical', assignedTo: 'IT Director' });
  mgr.assignAgent(dirRow.id, { id: 'dir-1', name: 'IT Director' });
  // 3) Operator-set custom label — should stay
  const custom = mgr.create({ title: 'C', severity: 'high', assignedTo: 'on-call' });
  mgr.assignAgent(custom.id, { id: 'bravo-1', name: 'Ops Bravo' });

  const resolver = (id: string) => id === 'bravo-1' ? 'Ops Bravo' : id === 'dir-1' ? 'IT Director' : null;
  const fixed = mgr.rewriteStaleDirectorLabel(resolver);
  assert.equal(fixed, 1, 'only one row corrected');
  assert.equal(mgr.get(stuck.id)!.assignedTo, 'Ops Bravo');
  assert.equal(mgr.get(dirRow.id)!.assignedTo, 'IT Director', 'real director label preserved');
  assert.equal(mgr.get(custom.id)!.assignedTo, 'on-call', 'custom label preserved');
});

test('rewriteStaleDirectorLabel is idempotent', () => {
  const mgr = freshManager();
  const stuck = mgr.create({ title: 'A', severity: 'high', assignedTo: 'IT Director' });
  mgr.assignAgent(stuck.id, { id: 'bravo-1', name: 'Ops Bravo' });
  mgr.incidentStore.upsert({ ...mgr.get(stuck.id)!, assignedTo: 'IT Director' });
  const resolver = (id: string) => id === 'bravo-1' ? 'Ops Bravo' : null;
  assert.equal(mgr.rewriteStaleDirectorLabel(resolver), 1);
  assert.equal(mgr.rewriteStaleDirectorLabel(resolver), 0, 'second run is a no-op');
});

test('create accepts serverId and persists it on the row', () => {
  const mgr = freshManager();
  const inc = mgr.create({
    title: 'Disk full on production-1',
    severity: 'high',
    source: 'health-monitor',
    sourceRef: 'disk:/:production-1',
    serverId: 'production-1',
  });
  assert.equal(inc.serverId, 'production-1');
  const fetched = mgr.get(inc.id);
  assert.equal(fetched?.serverId, 'production-1');
});

test('serverId is null by default when not supplied', () => {
  const mgr = freshManager();
  const inc = mgr.create({ title: 'Manual incident', severity: 'medium' });
  assert.equal(inc.serverId, null);
});

test('dup-update backfills serverId on previously null rows', () => {
  const mgr = freshManager();
  // First create without serverId (simulates pre-multi-server row)
  const a = mgr.create({
    title: 'Disk full on x', severity: 'high',
    source: 'health-monitor', sourceRef: 'disk:/:x',
  });
  assert.equal(a.serverId, null);
  // Repeat call with updateOnDup + serverId — should backfill.
  const b = mgr.create({
    title: 'Disk full on x', severity: 'high',
    source: 'health-monitor', sourceRef: 'disk:/:x',
    dedupBy: 'sourceRef', updateOnDup: true,
    serverId: 'x',
  });
  assert.equal(b.id, a.id);
  assert.equal(b.serverId, 'x');
});

test('dedup: same source+title returns existing active incident', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  const b = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  assert.equal(b.id, a.id, 'second create should return same incident id');
  assert.equal(mgr.list().length, 1, 'only one row in store');
});

test('dedup: different titles produce distinct incidents', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  const b = mgr.create({ title: 'Disk full on web-02', source: 'alert-rule' });
  assert.notEqual(b.id, a.id);
  assert.equal(mgr.list().length, 2);
});

test('dedup: dedupBy=sourceRef matches on stable ref even when title changes', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Memory Critical: 91%', source: 'health-monitor', sourceRef: 'memory', dedupBy: 'sourceRef' });
  const b = mgr.create({ title: 'Memory Critical: 95%', source: 'health-monitor', sourceRef: 'memory', dedupBy: 'sourceRef' });
  assert.equal(b.id, a.id);
  assert.equal(mgr.list().length, 1);
});

test('dedup: dedupBy=sourceRef requires sourceRef — null ref skips matching', () => {
  const mgr = freshManager();
  // Both calls have null sourceRef → falls through to a real create each time
  const a = mgr.create({ title: 'X', source: 'manual', dedupBy: 'sourceRef' });
  const b = mgr.create({ title: 'X', source: 'manual', dedupBy: 'sourceRef' });
  assert.notEqual(b.id, a.id);
});

test('dedup: dedup=false always creates a new incident', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Same title', source: 'manual' });
  const b = mgr.create({ title: 'Same title', source: 'manual', dedup: false });
  assert.notEqual(b.id, a.id);
  assert.equal(mgr.list().length, 2);
});

test('dedup: resolved incidents do not block re-opening', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  mgr.resolve(a.id, 'cleared');
  const b = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  assert.notEqual(b.id, a.id, 'after resolution, a fresh trigger should open a new incident');
});

test('dedup: investigating status still suppresses duplicates', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  mgr.update(a.id, { status: 'investigating' });
  const b = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  assert.equal(b.id, a.id, 'should still dedup against investigating incidents');
  assert.equal(mgr.list().length, 1);
});

test('dedup: silent skip — no timeline note, updatedAt unchanged', async () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule', sourceRef: 'rule-42' });
  const tlBefore = mgr.getTimeline(a.id).length;
  await new Promise(r => setTimeout(r, 5));
  const b = mgr.create({ title: 'Disk full on web-01', source: 'alert-rule', sourceRef: 'rule-42' });
  assert.equal(b.id, a.id);
  assert.equal(b.updatedAt, a.updatedAt, 'updatedAt should NOT change on silent dedup');
  assert.equal(mgr.getTimeline(a.id).length, tlBefore, 'no timeline entries added');
});

test('dedup: updateOnDup=true refreshes updatedAt and description', async () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk Critical: /data at 85%', source: 'health-monitor', sourceRef: 'disk:/data', dedupBy: 'sourceRef', description: 'Disk at 85%' });
  await new Promise(r => setTimeout(r, 5));
  const b = mgr.create({ title: 'Disk Critical: /data at 95%', source: 'health-monitor', sourceRef: 'disk:/data', dedupBy: 'sourceRef', description: 'Disk at 95%', updateOnDup: true });
  assert.equal(b.id, a.id);
  assert.notEqual(b.updatedAt, a.updatedAt, 'updateOnDup=true should refresh updatedAt');
  assert.equal(b.description, 'Disk at 95%', 'description should be updated to new value');
});

test('dedup: updateOnDup=true still adds no timeline note', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'X', source: 'manual', sourceRef: 'r', dedupBy: 'sourceRef' });
  const tlBefore = mgr.getTimeline(a.id).length;
  mgr.create({ title: 'X', source: 'manual', sourceRef: 'r', dedupBy: 'sourceRef', updateOnDup: true, description: 'new' });
  assert.equal(mgr.getTimeline(a.id).length, tlBefore);
});

test('dedup: onCreated fires only for genuinely new incidents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-inc-mgr-'));
  const store = new SqliteIncidentStore(path.join(dir, 'incidents.db'));
  let created = 0;
  const mgr = new IncidentManager(store, undefined, undefined, () => { created++; });
  mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  mgr.create({ title: 'Disk full on web-01', source: 'alert-rule' });
  assert.equal(created, 1, 'onCreated should fire once for the original create only');
});

// ── assignAgent / releaseAgent / verifyResolution ────────────────────────

test('assignAgent: marks agent busy in tracker and stores agent id on incident', () => {
  const { mgr, tracker } = managerWithTracker();
  const inc = mgr.create({ title: 'Disk full', source: 'alert-rule' });
  const updated = mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' }, 'auto');
  assert.equal(updated?.assignedAgent, 'agent-1');
  assert.equal(updated?.assignedTo, 'Alice', 'assignedTo defaults to agent display name when empty');
  assert.equal(tracker.getStatus('agent-1').status, 'busy');
  assert.equal(tracker.getStatus('agent-1').currentIncidentId, inc.id);
});

test('assignAgent: re-assigning a different agent releases the previous one', () => {
  const { mgr, tracker } = managerWithTracker();
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' });
  mgr.assignAgent(inc.id, { id: 'agent-2', name: 'Bob' }, 'reassigned on escalation');
  assert.equal(tracker.getStatus('agent-1').status, 'idle');
  assert.equal(tracker.getStatus('agent-2').status, 'busy');
  assert.equal(tracker.busyCount(), 1);
});

test('assignAgent: idempotent when called twice with the same agent', () => {
  const { mgr, tracker } = managerWithTracker();
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' });
  const tlBefore = mgr.getTimeline(inc.id).length;
  mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' });
  // Tracker still busy on the same incident, no new assignment timeline.
  assert.equal(tracker.getStatus('agent-1').status, 'busy');
  assert.equal(mgr.getTimeline(inc.id).length, tlBefore, 'no extra timeline note on idempotent re-assign');
});

test('resolve: releases the assigned agent in the workload tracker', () => {
  const { mgr, tracker } = managerWithTracker();
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' });
  assert.equal(tracker.busyCount(), 1);
  mgr.resolve(inc.id, 'fixed');
  assert.equal(tracker.busyCount(), 0);
  assert.equal(tracker.getStatus('agent-1').status, 'idle');
});

test('close: releases the assigned agent in the workload tracker', () => {
  const { mgr, tracker } = managerWithTracker();
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' });
  mgr.close(inc.id);
  assert.equal(tracker.getStatus('agent-1').status, 'idle');
});

test('releaseAgent: drops the agent without resolving the incident', () => {
  const { mgr, tracker } = managerWithTracker();
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.assignAgent(inc.id, { id: 'agent-1', name: 'Alice' });
  const released = mgr.releaseAgent(inc.id, 'operator cancelled');
  assert.equal(released?.assignedAgent, null);
  assert.equal(released?.status, 'open', 'incident status unchanged');
  assert.equal(tracker.getStatus('agent-1').status, 'idle');
});

test('verifyResolution: with no verifier configured, passes by default', async () => {
  const mgr = freshManager();
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.resolve(inc.id, 'fixed');
  const result = await mgr.verifyResolution(inc.id);
  assert.equal(result.ok, true);
  assert.match(result.details ?? '', /no verifier/);
});

test('verifyResolution: failing verifier re-opens the incident', async () => {
  const mgr = freshManager();
  mgr.setVerifier(() => ({ ok: false, details: 'metric still red' }));
  const inc = mgr.create({ title: 'Disk full', source: 'alert-rule' });
  mgr.resolve(inc.id, 'cleared');
  assert.equal(mgr.get(inc.id)?.status, 'resolved');
  const result = await mgr.verifyResolution(inc.id);
  assert.equal(result.ok, false);
  const after = mgr.get(inc.id);
  assert.equal(after?.status, 'investigating', 'incident is re-opened');
  assert.equal(after?.resolvedAt, null);
});

test('verifyResolution: passing verifier leaves incident resolved', async () => {
  const mgr = freshManager();
  mgr.setVerifier(() => ({ ok: true, details: 'metric green' }));
  const inc = mgr.create({ title: 'Disk full', source: 'alert-rule' });
  mgr.resolve(inc.id, 'cleared');
  await mgr.verifyResolution(inc.id);
  assert.equal(mgr.get(inc.id)?.status, 'resolved');
});

test('verifyResolution: reopenOnFailure=false leaves resolved status alone', async () => {
  const mgr = freshManager();
  mgr.setVerifier(() => ({ ok: false, details: 'still bad' }));
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.resolve(inc.id, 'cleared');
  await mgr.verifyResolution(inc.id, { reopenOnFailure: false });
  assert.equal(mgr.get(inc.id)?.status, 'resolved', 'opt-out keeps resolved status');
});

test('verifyResolution: throwing verifier is caught and treated as failure', async () => {
  const mgr = freshManager();
  mgr.setVerifier(() => { throw new Error('verifier exploded'); });
  const inc = mgr.create({ title: 'X', source: 'manual' });
  mgr.resolve(inc.id, 'cleared');
  const result = await mgr.verifyResolution(inc.id);
  assert.equal(result.ok, false);
  assert.match(result.details ?? '', /verifier exploded/);
});

test('resolveActiveByRef: resolves only matching active incidents', () => {
  const mgr = freshManager();
  // Three active incidents covering the live ref shapes we care about:
  // a health-monitor disk incident, an alert-rule disk incident, and
  // a memory incident that must NOT be touched.
  const a = mgr.create({ title: 'Disk Critical: /', source: 'health-monitor', sourceRef: 'disk:/', dedupBy: 'sourceRef' });
  const b = mgr.create({ title: 'High Disk Usage on host', source: 'alert-rule', sourceRef: 'seed-disk-warning', dedupBy: 'sourceRef' });
  const c = mgr.create({ title: 'Memory Critical', source: 'health-monitor', sourceRef: 'memory', dedupBy: 'sourceRef' });

  const ids = mgr.resolveActiveByRef(
    inc => {
      const ref = (inc.sourceRef || '').toLowerCase();
      return ref.startsWith('disk:') || ref.startsWith('seed-disk');
    },
    'disk dropped to 70%',
    'health-monitor',
  );

  assert.equal(ids.length, 2);
  assert.ok(ids.includes(a.id));
  assert.ok(ids.includes(b.id));
  assert.equal(mgr.get(a.id)?.status, 'resolved');
  assert.equal(mgr.get(b.id)?.status, 'resolved');
  assert.equal(mgr.get(c.id)?.status, 'open', 'memory incident must stay open');

  // Timeline carries the auto-resolve note + the resolve entry on each.
  const tlA = mgr.getTimeline(a.id);
  assert.ok(tlA.some(e => e.actor === 'health-monitor' && /Auto-resolved/.test(e.message)));
  assert.ok(tlA.some(e => e.type === 'resolved'));
});

test('resolveActiveByRef: skips already-resolved incidents', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Disk Critical', source: 'health-monitor', sourceRef: 'disk:/', dedupBy: 'sourceRef' });
  mgr.resolve(a.id, 'manually closed');

  const ids = mgr.resolveActiveByRef(
    inc => (inc.sourceRef || '').startsWith('disk:'),
    'disk cleared',
    'health-monitor',
  );

  assert.equal(ids.length, 0, 'already-resolved must not be touched');
});

test('resolveActiveByRef: optionally verifies and reopens failed auto-resolves', async () => {
  const mgr = freshManager();
  mgr.setVerifier(() => ({ ok: false, details: 'metric still red' }));
  const inc = mgr.create({ title: 'Disk Critical', source: 'health-monitor', sourceRef: 'disk:/' });

  const ids = mgr.resolveActiveByRef(
    i => i.sourceRef === 'disk:/',
    'disk cleared',
    'health-monitor',
    { verifyAfterResolve: true },
  );
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(ids, [inc.id]);
  assert.equal(mgr.get(inc.id)?.status, 'investigating');
  assert.ok(mgr.getTimeline(inc.id).some(t => /Verification FAILED/.test(t.message)));
});

test('resolveActiveByRef: matches alert-rule sourceRef shapes (regression)', () => {
  // Direct check that the live alert-rule pattern (`seed-disk-warning`,
  // `seed-memory-warning`, `seed-cpu-critical`) matches the predicates
  // the health monitor uses. Catches any rename of seed rule ids that
  // would silently disable auto-resolve.
  const mgr = freshManager();
  const disk = mgr.create({ title: 'High Disk Usage on 172.31.0.1', source: 'alert-rule', sourceRef: 'seed-disk-warning', dedupBy: 'sourceRef' });
  const mem = mgr.create({ title: 'High Memory Usage on 172.31.0.1', source: 'alert-rule', sourceRef: 'seed-memory-warning', dedupBy: 'sourceRef' });
  const cpu = mgr.create({ title: 'High CPU on 172.31.0.1', source: 'alert-rule', sourceRef: 'seed-cpu-critical', dedupBy: 'sourceRef' });

  const dIds = mgr.resolveActiveByRef(i => /^seed-disk/.test(i.sourceRef || ''), 'd', 'health-monitor');
  const mIds = mgr.resolveActiveByRef(i => /^seed-memory/.test(i.sourceRef || ''), 'm', 'health-monitor');
  const cIds = mgr.resolveActiveByRef(i => /^seed-cpu/.test(i.sourceRef || ''), 'c', 'health-monitor');

  assert.deepEqual(dIds, [disk.id]);
  assert.deepEqual(mIds, [mem.id]);
  assert.deepEqual(cIds, [cpu.id]);
});

test('sweepStale: resolves only incidents older than the cutoff', () => {
  const mgr = freshManager();
  const fresh = mgr.create({ title: 'Fresh', source: 'agent' });
  const old = mgr.create({ title: 'Old', source: 'agent' });

  // Backdate the second incident's updatedAt by 5 hours via direct store write.
  const store = mgr.incidentStore;
  const row = store.get(old.id)!;
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  store.upsert({ ...row, createdAt: fiveHoursAgo, updatedAt: fiveHoursAgo });

  const ids = mgr.sweepStale(2); // 2-hour cutoff
  assert.deepEqual(ids, [old.id]);
  assert.equal(mgr.get(old.id)!.status, 'resolved');
  assert.equal(mgr.get(fresh.id)!.status, 'open');
});

test('sweepStale: leaves already-resolved incidents alone', () => {
  const mgr = freshManager();
  const a = mgr.create({ title: 'Old', source: 'agent' });
  const store = mgr.incidentStore;
  const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  store.upsert({ ...store.get(a.id)!, createdAt: fiveHoursAgo, updatedAt: fiveHoursAgo });
  mgr.resolve(a.id, 'manual');
  const ids = mgr.sweepStale(2);
  assert.deepEqual(ids, [], 'resolved incident should not be re-resolved');
});

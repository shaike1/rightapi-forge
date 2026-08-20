import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProblemStore } from './ProblemStore.js';

function newStore(): ProblemStore {
  const dir = mkdtempSync(join(tmpdir(), 'problem-store-'));
  return new ProblemStore(join(dir, 'problems.db'));
}

function tsOffset(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

test('create() returns a problem with a PRB-prefixed id + initial fields', () => {
  const s = newStore();
  const p = s.create({
    title: 'Disk fills on web01',
    description: 'Disk repeatedly reaches 90%',
    severity: 'high',
    sourceRefPattern: 'disk:%',
    serverId: 'web01',
    firstSeenAt: tsOffset(-60),
    lastSeenAt: tsOffset(-5),
  });
  assert.match(p.id, /^PRB-[A-F0-9]{8}$/);
  assert.equal(p.status, 'open');
  assert.equal(p.severity, 'high');
  assert.equal(p.serverId, 'web01');
  assert.equal(p.sourceRefPattern, 'disk:%');
  assert.equal(p.rootCause, null);
  assert.equal(p.resolvedAt, null);
});

test('linkIncident is idempotent — duplicate links do not duplicate rows', () => {
  const s = newStore();
  const p = s.create({
    title: 't', description: 'd', severity: 'medium',
    firstSeenAt: tsOffset(-10), lastSeenAt: tsOffset(-5),
  });
  s.linkIncident(p.id, 'INC-1', tsOffset(-10));
  s.linkIncident(p.id, 'INC-1', tsOffset(-9));
  s.linkIncident(p.id, 'INC-2', tsOffset(-5));
  const ids = s.getLinkedIncidents(p.id);
  assert.deepEqual(ids.sort(), ['INC-1', 'INC-2']);
});

test('linkIncident advances last_seen_at when the new incident is newer', () => {
  const s = newStore();
  const p = s.create({
    title: 't', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-60), lastSeenAt: tsOffset(-60),
  });
  s.linkIncident(p.id, 'INC-1', tsOffset(-30));
  const after = s.get(p.id)!;
  assert.ok(after.lastSeenAt > p.lastSeenAt);
});

test('linkIncident does NOT regress last_seen_at when the new incident is older', () => {
  const s = newStore();
  const p = s.create({
    title: 't', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-60), lastSeenAt: tsOffset(-5),
  });
  s.linkIncident(p.id, 'INC-OLD', tsOffset(-120));
  const after = s.get(p.id)!;
  assert.equal(after.lastSeenAt, p.lastSeenAt, 'older incident must not move last_seen_at backwards');
});

test('getWithIncidents returns ids + occurrence count', () => {
  const s = newStore();
  const p = s.create({
    title: 't', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5),
  });
  s.linkIncident(p.id, 'INC-1', tsOffset(-30));
  s.linkIncident(p.id, 'INC-2', tsOffset(-15));
  s.linkIncident(p.id, 'INC-3', tsOffset(-5));
  const w = s.getWithIncidents(p.id)!;
  assert.equal(w.incidentIds.length, 3);
  assert.equal(w.occurrences, 3);
});

test('findProblemForIncident returns the linked problem', () => {
  const s = newStore();
  const p = s.create({ title: 't', description: 'd', severity: 'medium',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  s.linkIncident(p.id, 'INC-7', tsOffset(-30));
  const found = s.findProblemForIncident('INC-7');
  assert.ok(found);
  assert.equal(found!.id, p.id);
});

test('findProblemForIncident returns null for unlinked incidents', () => {
  const s = newStore();
  assert.equal(s.findProblemForIncident('INC-NOPE'), null);
});

test('update() patches fields; resolving stamps resolved_at', async () => {
  const s = newStore();
  const p = s.create({ title: 't', description: 'd', severity: 'medium',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  await new Promise(r => setTimeout(r, 10)); // ensure updated_at moves
  const r1 = s.update(p.id, { status: 'investigating', rootCause: 'foo' })!;
  assert.equal(r1.status, 'investigating');
  assert.equal(r1.rootCause, 'foo');
  assert.equal(r1.resolvedAt, null, 'investigating does not stamp resolved_at');
  const r2 = s.update(p.id, { status: 'resolved', resolution: 'fixed', resolvedBy: 'admin' })!;
  assert.equal(r2.status, 'resolved');
  assert.ok(r2.resolvedAt, 'resolved must stamp resolved_at');
  assert.equal(r2.resolvedBy, 'admin');
  // Re-opening clears resolved_at.
  const r3 = s.update(p.id, { status: 'investigating' })!;
  assert.equal(r3.resolvedAt, null);
});

test('list filter by status accepts a single value or an array', () => {
  const s = newStore();
  const a = s.create({ title: 'a', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  const b = s.create({ title: 'b', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  s.update(b.id, { status: 'resolved', resolution: 'x' });

  const openOnly = s.list({ status: 'open' });
  assert.deepEqual(openOnly.map(p => p.id), [a.id]);
  const both = s.list({ status: ['open', 'resolved'] });
  assert.equal(both.length, 2);
});

test('findBySourcePattern matches with SQL LIKE semantics', () => {
  const s = newStore();
  const p = s.create({
    title: 'Disk family', description: 'd', severity: 'high',
    sourceRefPattern: 'disk:%', serverId: null,
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5),
  });
  assert.equal(s.findBySourcePattern('disk:/data')!.id, p.id);
  assert.equal(s.findBySourcePattern('disk:/')!.id, p.id);
  // Non-matching source.
  assert.equal(s.findBySourcePattern('cpu:high'), null);
});

test('findBySourcePattern with serverId scope respects fleet vs server-specific problems', () => {
  const s = newStore();
  const fleet = s.create({
    title: 'fleet disk', description: 'd', severity: 'high',
    sourceRefPattern: 'disk:%', serverId: null,
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5),
  });
  const serverScoped = s.create({
    title: 'web02 disk', description: 'd', severity: 'high',
    sourceRefPattern: 'disk:%', serverId: 'web02',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5),
  });
  // Server-scoped problem listed first (last_seen_at DESC, both equal —
  // tie-broken by insertion order). With serverId='web02' both should
  // match; the LIMIT 1 ordering by last_seen_at DESC picks the most
  // recent. We don't assert ordering here, just that server-scoped
  // problem doesn't bleed across servers.
  const a = s.findBySourcePattern('disk:/data', { serverId: 'web02' });
  assert.ok(a, 'fleet OR server-matched problem should be returned');
  // web03 must not match the web02-scoped one but must still pick up
  // the fleet one.
  const b = s.findBySourcePattern('disk:/data', { serverId: 'web03' });
  assert.ok(b);
  assert.equal(b!.id, fleet.id, 'web03 must only see the fleet-wide problem');
  void serverScoped;
});

test('findBySourcePattern only matches open/investigating problems', () => {
  const s = newStore();
  const p = s.create({
    title: 't', description: 'd', severity: 'high',
    sourceRefPattern: 'disk:%', serverId: null,
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5),
  });
  s.update(p.id, { status: 'resolved', resolution: 'x' });
  assert.equal(s.findBySourcePattern('disk:/data'), null);
});

test('listOpenProblemsForServer returns only open problems on that server', () => {
  const s = newStore();
  const a = s.create({ title: 'a', description: 'd', severity: 'medium',
    serverId: 'web01', firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  const b = s.create({ title: 'b', description: 'd', severity: 'high',
    serverId: 'web02', firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  s.update(b.id, { status: 'resolved', resolution: 'x' });
  const c = s.create({ title: 'c', description: 'd', severity: 'high',
    serverId: 'web01', firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  const list = s.listOpenProblemsForServer('web01');
  assert.deepEqual(list.map(p => p.id).sort(), [a.id, c.id].sort());
});

test('topRecurring orders by occurrence count and excludes resolved', () => {
  const s = newStore();
  const a = s.create({ title: 'a', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  const b = s.create({ title: 'b', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  s.linkIncident(a.id, 'INC-A1', tsOffset(-30));
  s.linkIncident(a.id, 'INC-A2', tsOffset(-20));
  s.linkIncident(b.id, 'INC-B1', tsOffset(-30));
  s.linkIncident(b.id, 'INC-B2', tsOffset(-20));
  s.linkIncident(b.id, 'INC-B3', tsOffset(-10));
  const top = s.topRecurring(5);
  assert.equal(top[0].problem.id, b.id);
  assert.equal(top[0].occurrences, 3);
  assert.equal(top[1].problem.id, a.id);
  assert.equal(top[1].occurrences, 2);
  // Resolve b → should drop from list.
  s.update(b.id, { status: 'resolved', resolution: 'x' });
  const top2 = s.topRecurring(5);
  assert.equal(top2.length, 1);
  assert.equal(top2[0].problem.id, a.id);
});

test('stats counts problems by status', () => {
  const s = newStore();
  const a = s.create({ title: 'a', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  const b = s.create({ title: 'b', description: 'd', severity: 'high',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  s.update(a.id, { status: 'investigating' });
  s.update(b.id, { status: 'resolved', resolution: 'x' });
  const stats = s.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.open, 0);
  assert.equal(stats.investigating, 1);
  assert.equal(stats.resolved, 1);
});

test('unlinkIncident removes the link', () => {
  const s = newStore();
  const p = s.create({ title: 't', description: 'd', severity: 'medium',
    firstSeenAt: tsOffset(-30), lastSeenAt: tsOffset(-5) });
  s.linkIncident(p.id, 'INC-1', tsOffset(-30));
  s.linkIncident(p.id, 'INC-2', tsOffset(-15));
  s.unlinkIncident(p.id, 'INC-1');
  assert.deepEqual(s.getLinkedIncidents(p.id), ['INC-2']);
});

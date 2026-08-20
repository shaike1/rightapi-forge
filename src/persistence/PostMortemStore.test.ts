import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostMortemStore, deriveIncidentType } from './PostMortemStore.js';

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-store-test-'));
  return new PostMortemStore(join(dir, 'post-mortems.db'));
}

function seed(store: PostMortemStore, n: number, base: Partial<Parameters<PostMortemStore['insert']>[0]> = {}) {
  const written: ReturnType<PostMortemStore['insert']>[] = [];
  for (let i = 0; i < n; i++) {
    written.push(store.insert({
      incidentId: `INC-${i.toString().padStart(8, '0')}`,
      serverId: 'local',
      incidentType: 'general',
      title: `Test incident #${i}`,
      severity: 'medium',
      rootCause: `cause ${i}`,
      actionsTaken: [`step a ${i}`, `step b ${i}`],
      resolution: `fixed ${i}`,
      durationMinutes: i + 1,
      lessons: [`lesson ${i}`],
      prevention: [`prevent ${i}`],
      tags: ['general'],
      aiModel: 'claude-test',
      ...base,
    }));
  }
  return written;
}

test('insert + get round-trips all fields', () => {
  const store = newStore();
  const written = store.insert({
    incidentId: 'INC-DEADBEEF',
    serverId: 'web-1',
    incidentType: 'disk-pressure',
    title: 'Disk Critical: /data at 92%',
    severity: 'high',
    rootCause: 'Log rotation stopped a week ago.',
    actionsTaken: ['ran df', 'vacuumed journal'],
    resolution: 'journalctl --vacuum-time=3d freed 18GB',
    durationMinutes: 12,
    lessons: ['journal vacuum is the canonical disk fix'],
    prevention: ['alert on journal size'],
    tags: ['disk', 'journal'],
    aiModel: 'claude-sonnet-4-6',
  });
  const fetched = store.get(written.id);
  assert.deepEqual(fetched, written);
});

test('byIncident returns rows for the given incident id only', () => {
  const store = newStore();
  store.insert({ incidentId: 'INC-A', serverId: null, incidentType: 'general', title: 'a', severity: 'medium', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 0, lessons: [], prevention: [], tags: [], aiModel: null });
  store.insert({ incidentId: 'INC-B', serverId: null, incidentType: 'general', title: 'b', severity: 'medium', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 0, lessons: [], prevention: [], tags: [], aiModel: null });
  store.insert({ incidentId: 'INC-A', serverId: null, incidentType: 'general', title: 'a-second', severity: 'medium', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 0, lessons: [], prevention: [], tags: [], aiModel: null });

  const a = store.byIncident('INC-A');
  assert.equal(a.length, 2);
  for (const pm of a) assert.equal(pm.incidentId, 'INC-A');

  assert.equal(store.byIncident('INC-MISSING').length, 0);
});

test('list paginates and filters by serverId / incidentType / severity', () => {
  const store = newStore();
  seed(store, 5, { serverId: 'a', incidentType: 'disk-pressure', severity: 'high' });
  seed(store, 3, { serverId: 'b', incidentType: 'docker-issue', severity: 'medium' });

  const all = store.list({ limit: 100 });
  assert.equal(all.total, 8);
  assert.equal(all.items.length, 8);

  const onlyA = store.list({ serverId: 'a' });
  assert.equal(onlyA.total, 5);
  assert.ok(onlyA.items.every(i => i.serverId === 'a'));

  const onlyDocker = store.list({ incidentType: 'docker-issue' });
  assert.equal(onlyDocker.total, 3);

  const onlyMedium = store.list({ severity: 'medium' });
  assert.equal(onlyMedium.total, 3);

  const paged = store.list({ limit: 4, offset: 0 });
  assert.equal(paged.items.length, 4);
  assert.equal(paged.total, 8);
  const page2 = store.list({ limit: 4, offset: 4 });
  assert.equal(page2.items.length, 4);
});

test('search returns FTS5 matches across title + body + tags + lessons', () => {
  const store = newStore();
  store.insert({
    incidentId: 'INC-1', serverId: null, incidentType: 'disk-pressure',
    title: 'Disk Critical /var at 92%', severity: 'high',
    rootCause: 'Docker overlay2 fat layers piling up',
    actionsTaken: ['docker image prune'], resolution: 'freed 14GB via image prune',
    durationMinutes: 8, lessons: ['prune dangling images quarterly'], prevention: [], tags: ['disk', 'docker'], aiModel: null,
  });
  store.insert({
    incidentId: 'INC-2', serverId: null, incidentType: 'memory-pressure',
    title: 'High memory on web-1', severity: 'medium',
    rootCause: 'Memory leak in fastify worker',
    actionsTaken: ['restarted worker'], resolution: 'restart restored headroom',
    durationMinutes: 3, lessons: [], prevention: [], tags: ['memory'], aiModel: null,
  });

  const diskHits = store.search('disk');
  assert.ok(diskHits.length >= 1);
  assert.equal(diskHits[0].incidentId, 'INC-1');

  const pruneHits = store.search('prune');
  // The "prune" token appears in INC-1's actionsTaken + resolution. FTS5
  // indexes title/root_cause/resolution/tags/lessons; resolution alone is
  // enough to surface it.
  assert.ok(pruneHits.some(p => p.incidentId === 'INC-1'));

  const memHits = store.search('memory leak');
  assert.ok(memHits.some(p => p.incidentId === 'INC-2'));

  assert.equal(store.search('').length, 0);
});

test('findSimilar boosts same-server and same-type matches', () => {
  const store = newStore();
  // PM-A: same server + same type → should win.
  const a = store.insert({
    incidentId: 'INC-A', serverId: 'web-1', incidentType: 'disk-pressure',
    title: 'Disk Critical /data at 91%', severity: 'high',
    rootCause: 'overlay2 fat', actionsTaken: [], resolution: 'image prune',
    durationMinutes: 5, lessons: [], prevention: [], tags: ['disk'], aiModel: null,
  });
  // PM-B: different server, same type.
  const b = store.insert({
    incidentId: 'INC-B', serverId: 'web-2', incidentType: 'disk-pressure',
    title: 'Disk full /var', severity: 'high',
    rootCause: 'logs', actionsTaken: [], resolution: 'vacuumed',
    durationMinutes: 9, lessons: [], prevention: [], tags: ['disk'], aiModel: null,
  });
  // PM-C: unrelated.
  store.insert({
    incidentId: 'INC-C', serverId: 'web-1', incidentType: 'cert-issue',
    title: 'Cert expired', severity: 'high',
    rootCause: '', actionsTaken: [], resolution: 'renew',
    durationMinutes: 12, lessons: [], prevention: [], tags: ['cert'], aiModel: null,
  });

  const similar = store.findSimilar({
    id: 'INC-NEW', title: 'Disk pressure on /data', serverId: 'web-1', sourceRef: 'disk:/data',
  }, 3);
  assert.ok(similar.length >= 1);
  // PM-A scores highest (same server + same type + title overlap).
  assert.equal(similar[0].id, a.id);
});

test('findSimilar excludes the incident itself', () => {
  const store = newStore();
  store.insert({
    incidentId: 'INC-X', serverId: 'web-1', incidentType: 'disk-pressure',
    title: 'Disk Critical /data', severity: 'high',
    rootCause: '', actionsTaken: [], resolution: '',
    durationMinutes: 5, lessons: [], prevention: [], tags: ['disk'], aiModel: null,
  });
  const matches = store.findSimilar({
    id: 'INC-X', title: 'Disk Critical /data', serverId: 'web-1', sourceRef: 'disk:/data',
  }, 5);
  assert.ok(matches.every(m => m.incidentId !== 'INC-X'));
});

test('stats returns rollups by type / severity / server', () => {
  const store = newStore();
  store.insert({ incidentId: '1', serverId: 'a', incidentType: 'disk-pressure', title: '', severity: 'high', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 10, lessons: [], prevention: [], tags: [], aiModel: null });
  store.insert({ incidentId: '2', serverId: 'a', incidentType: 'disk-pressure', title: '', severity: 'medium', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 20, lessons: [], prevention: [], tags: [], aiModel: null });
  store.insert({ incidentId: '3', serverId: 'b', incidentType: 'docker-issue', title: '', severity: 'medium', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 30, lessons: [], prevention: [], tags: [], aiModel: null });
  store.insert({ incidentId: '4', serverId: null, incidentType: 'general', title: '', severity: 'critical', rootCause: '', actionsTaken: [], resolution: '', durationMinutes: 40, lessons: [], prevention: [], tags: [], aiModel: null });

  const stats = store.stats();
  assert.equal(stats.total, 4);
  assert.equal(stats.avgDurationMinutes, 25);
  assert.equal(stats.byIncidentType['disk-pressure'], 2);
  assert.equal(stats.byIncidentType['docker-issue'], 1);
  assert.equal(stats.bySeverity['medium'], 2);
  assert.equal(stats.bySeverity['high'], 1);
  assert.equal(stats.bySeverity['critical'], 1);
  assert.equal(stats.byServer['a'], 2);
  assert.equal(stats.byServer['b'], 1);
  assert.equal(stats.byServer['unknown'], 1);
});

test('deriveIncidentType maps sourceRef + title to stable tags', () => {
  assert.equal(deriveIncidentType({ title: 'Disk Critical /data', sourceRef: 'disk:/data' }), 'disk-pressure');
  assert.equal(deriveIncidentType({ title: 'Container nginx unhealthy', sourceRef: 'docker:nginx' }), 'docker-issue');
  assert.equal(deriveIncidentType({ title: 'High memory on web-1', sourceRef: null }), 'memory-pressure');
  assert.equal(deriveIncidentType({ title: 'SSL cert expiring', sourceRef: null }), 'cert-issue');
  assert.equal(deriveIncidentType({ title: 'random thing', sourceRef: null }), 'general');
});

test('remove deletes the row + drops it from FTS', () => {
  const store = newStore();
  const pm = store.insert({
    incidentId: 'INC-Z', serverId: null, incidentType: 'general',
    title: 'unique-marker zebra', severity: 'medium',
    rootCause: '', actionsTaken: [], resolution: '',
    durationMinutes: 0, lessons: [], prevention: [], tags: [], aiModel: null,
  });
  assert.equal(store.search('zebra').length, 1);
  assert.equal(store.remove(pm.id), true);
  assert.equal(store.search('zebra').length, 0);
  assert.equal(store.get(pm.id), null);
});

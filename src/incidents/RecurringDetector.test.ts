import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecurringDetector, _testing } from './RecurringDetector.js';
import { ProblemStore } from './ProblemStore.js';
import { IncidentManager } from './IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

function newStack(overrides: { minCount?: number; windowDays?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recur-det-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const problems = new ProblemStore(join(dir, 'problems.db'));
  const audit: string[] = [];
  const created: string[] = [];
  const detector = new RecurringDetector({
    incidents,
    problems,
    config: { minCount: overrides.minCount ?? 3, windowDays: overrides.windowDays ?? 7 },
    onProblemCreated: p => created.push(p.id),
    audit: (action, detail) => audit.push(`${action}|${detail}`),
  });
  return { incidents, problems, detector, audit, created };
}

// ── Pure helpers ──────────────────────────────────────────────────────

test('sourceRefPrefix splits on first colon', () => {
  assert.equal(_testing.sourceRefPrefix('disk:/data'), 'disk');
  assert.equal(_testing.sourceRefPrefix('disk:/var/log'), 'disk');
  assert.equal(_testing.sourceRefPrefix('service:nginx:web01'), 'service');
  assert.equal(_testing.sourceRefPrefix(null), null);
  assert.equal(_testing.sourceRefPrefix(''), null);
  assert.equal(_testing.sourceRefPrefix('noColonHere'), null);
});

test('titleSimilarity returns 0 for identical normalised titles', () => {
  // "Disk full on web01" and "Disk full on web02" normalise identically
  // (digits stripped) so similarity is 0.
  assert.equal(_testing.titleSimilarity('Disk full on web01', 'Disk full on web02'), 0);
});

test('titleSimilarity returns 1 for fully different strings', () => {
  assert.equal(_testing.titleSimilarity('abc', 'xyz'), 1);
});

test('titleSimilarity returns proportional distance for partial overlap', () => {
  // "memory leak" vs "memory pressure" — same first word, different tail.
  const s = _testing.titleSimilarity('memory leak', 'memory pressure');
  assert.ok(s > 0 && s < 1, `expected a non-degenerate similarity, got ${s}`);
});

test('strongestSeverity walks the severity scale', () => {
  assert.equal(_testing.strongestSeverity(['low', 'medium', 'critical', 'high']), 'critical');
  assert.equal(_testing.strongestSeverity(['low', 'medium']), 'medium');
  assert.equal(_testing.strongestSeverity([]), 'medium');
});

test('parseAiPayload tolerates code-fenced JSON', () => {
  const r = _testing.parseAiPayload('```json\n{"rootCause":"x","suggestedFix":"y","confidence":"high"}\n```');
  assert.equal(r.rootCause, 'x');
  assert.equal(r.suggestedFix, 'y');
  assert.equal(r.confidence, 'high');
});

test('parseAiPayload defaults confidence to low for unknown values', () => {
  const r = _testing.parseAiPayload('{"rootCause":"x","suggestedFix":"y","confidence":"unsure"}');
  assert.equal(r.confidence, 'low');
});

// ── Detection: below threshold → no problem ───────────────────────────

test('below minCount: no problem is created', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  const a = incidents.create({ title: 'disk', severity: 'high', source: 'manual', sourceRef: 'disk:/data' });
  const b = incidents.create({ title: 'disk', severity: 'high', source: 'manual', sourceRef: 'disk:/data', dedup: false });
  // 2 incidents — below the threshold of 3.
  const r1 = await detector.checkIncident(incidents.get(a.id)!);
  const r2 = await detector.checkIncident(incidents.get(b.id)!);
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(problems.list().length, 0);
});

// ── Detection: at threshold → problem created ─────────────────────────

test('at minCount: problem created and all peers linked', async () => {
  const { incidents, detector, problems, created } = newStack({ minCount: 3 });
  const a = incidents.create({ title: 'Disk full /data', severity: 'high', source: 'manual', sourceRef: 'disk:/data' });
  const b = incidents.create({ title: 'Disk full /data', severity: 'high', source: 'manual', sourceRef: 'disk:/data', dedup: false });
  const c = incidents.create({ title: 'Disk full /var',  severity: 'medium', source: 'manual', sourceRef: 'disk:/var',  dedup: false });
  // The detector finds all peers at-once, so whichever incident is
  // examined first ends up creating the problem. What matters is the
  // end state: exactly one problem with all three incidents linked.
  await detector.checkIncident(incidents.get(a.id)!);
  await detector.checkIncident(incidents.get(b.id)!);
  await detector.checkIncident(incidents.get(c.id)!);
  const list = problems.list();
  assert.equal(list.length, 1);
  const p = list[0];
  assert.equal(p.sourceRefPattern, 'disk:%');
  // Severity escalates to the strongest among grouped incidents.
  assert.equal(p.severity, 'high');
  const ids = problems.getLinkedIncidents(p.id).sort();
  assert.deepEqual(ids, [a.id, b.id, c.id].sort());
  // onProblemCreated callback fired exactly once even though we call
  // checkIncident three times — the 2nd + 3rd calls attach to the
  // problem the 1st call created.
  assert.equal(created.length, 1);
  assert.equal(created[0], p.id);
});

// ── Subsequent incidents attach to the existing problem ───────────────

test('after problem created, further matching incidents attach (no new problem)', async () => {
  const { incidents, detector, problems, created } = newStack({ minCount: 3 });
  for (let i = 0; i < 3; i++) {
    const inc = incidents.create({
      title: 'disk', severity: 'high', source: 'manual', sourceRef: 'disk:/data', dedup: false,
    });
    await detector.checkIncident(incidents.get(inc.id)!);
  }
  // One problem created.
  assert.equal(problems.list().length, 1);
  // Fourth + fifth → attach, no new problem.
  for (let i = 0; i < 2; i++) {
    const inc = incidents.create({
      title: 'disk', severity: 'high', source: 'manual', sourceRef: 'disk:/data', dedup: false,
    });
    const r = await detector.checkIncident(incidents.get(inc.id)!);
    assert.equal(r?.created, false);
  }
  assert.equal(problems.list().length, 1);
  assert.equal(created.length, 1, 'onProblemCreated must fire only once');
  // Five incidents now linked.
  const p = problems.list()[0];
  assert.equal(problems.getLinkedIncidents(p.id).length, 5);
});

// ── Server-scoped grouping by title similarity ────────────────────────

test('groups by server + similar title when sourceRef is absent', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  // No sourceRef — must fall back to server + title similarity.
  for (const t of ['Service down on web01', 'Service down on web02', 'Service down on web03']) {
    const inc = incidents.create({
      title: t, severity: 'high', source: 'manual', serverId: 'web01', dedup: false,
    });
    await detector.checkIncident(incidents.get(inc.id)!);
  }
  assert.equal(problems.list().length, 1, 'titles all normalise to "service down on web" — one problem');
});

test('different servers with similar titles do NOT group', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  let i = 0;
  for (const server of ['web01', 'web02', 'web03']) {
    const inc = incidents.create({
      title: 'Service down', severity: 'high', source: 'manual', serverId: server,
      dedup: false,
    });
    await detector.checkIncident(incidents.get(inc.id)!);
    i++;
  }
  // No sourceRef on any incident, and the three incidents are on three
  // different servers — neither matching rule applies.
  assert.equal(problems.list().length, 0);
  assert.equal(i, 3);
});

// ── Severity escalation ───────────────────────────────────────────────

test('problem inherits the strongest severity across grouped incidents', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  for (const sev of ['low', 'medium', 'critical'] as const) {
    const inc = incidents.create({
      title: 'disk', severity: sev, source: 'manual', sourceRef: 'disk:/data', dedup: false,
    });
    await detector.checkIncident(incidents.get(inc.id)!);
  }
  const p = problems.list()[0];
  assert.equal(p.severity, 'critical');
});

// ── Dedup: existing problem keeps owning new matches ──────────────────

test('an incident matched by sourceRef LIKE pattern attaches to the existing problem', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  // Manually create an open problem to simulate prior detection.
  const seed = problems.create({
    title: 'Recurring disk on web01',
    description: 'seeded',
    severity: 'high',
    sourceRefPattern: 'disk:%',
    serverId: 'web01',
    firstSeenAt: new Date(Date.now() - 86400_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  const inc = incidents.create({
    title: 'Disk full /var/log', severity: 'high', source: 'manual',
    sourceRef: 'disk:/var/log', serverId: 'web01',
  });
  const r = await detector.checkIncident(incidents.get(inc.id)!);
  assert.equal(r?.created, false, 'should attach, not create');
  assert.equal(r?.problem!.id, seed.id);
  const ids = problems.getLinkedIncidents(seed.id);
  assert.deepEqual(ids, [inc.id]);
});

test('an incident already linked to a problem is NOT pulled into a new one', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  // Seed: a problem with one incident already in it.
  const seed = problems.create({
    title: 'Seeded', description: 'd', severity: 'medium',
    sourceRefPattern: 'disk:%', serverId: null,
    firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
  });
  const existing = incidents.create({
    title: 'Disk full /data', severity: 'medium', source: 'manual',
    sourceRef: 'disk:/data',
  });
  problems.linkIncident(seed.id, existing.id, existing.createdAt);
  // Now resolve the existing problem. The next 3 matching incidents
  // should form a NEW problem — the linked-and-resolved one mustn't be
  // pulled in.
  problems.update(seed.id, { status: 'resolved', resolution: 'old' });
  for (let i = 0; i < 3; i++) {
    const inc = incidents.create({
      title: 'Disk full /data', severity: 'high', source: 'manual',
      sourceRef: 'disk:/data', dedup: false,
    });
    await detector.checkIncident(incidents.get(inc.id)!);
  }
  // Two problems exist: the resolved seed + the fresh one.
  const list = problems.list();
  assert.equal(list.length, 2);
  const fresh = list.find(p => p.status !== 'resolved')!;
  // The existing incident from the resolved problem must NOT be linked
  // to the fresh problem.
  const ids = problems.getLinkedIncidents(fresh.id);
  assert.ok(!ids.includes(existing.id), 'incident from resolved problem must not bleed into the new one');
});

// ── Out-of-window peers are ignored ───────────────────────────────────

test('incidents outside the look-back window do not count toward threshold', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3, windowDays: 7 });
  // SqliteIncidentStore.upsert preserves created_at on conflict, so
  // we can't backdate via update. Insert two fully-formed rows with
  // a created_at 10 days in the past directly via incidentStore.
  const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  for (const id of ['INC-OLD-A', 'INC-OLD-B']) {
    incidents.incidentStore.upsert({
      id, title: 'old', description: '', severity: 'high', status: 'resolved',
      assignedTo: null, assignedAgent: null,
      createdAt: tenDaysAgo, updatedAt: tenDaysAgo, resolvedAt: tenDaysAgo,
      source: 'manual', sourceRef: 'disk:/data', slaMinutes: 240,
      serverId: null,
    });
  }
  // Fresh incident today.
  const c = incidents.create({
    title: 'fresh', severity: 'high', source: 'manual', sourceRef: 'disk:/data',
  });
  const r = await detector.checkIncident(incidents.get(c.id)!);
  assert.equal(r, null, 'two of the three matches are out-of-window — below threshold');
  assert.equal(problems.list().length, 0);
});

// ── sweep() ───────────────────────────────────────────────────────────

test('sweep() catches missed groupings (e.g. if checkIncident was skipped)', async () => {
  const { incidents, detector, problems } = newStack({ minCount: 3 });
  for (let i = 0; i < 3; i++) {
    incidents.create({
      title: 'disk', severity: 'high', source: 'manual', sourceRef: 'disk:/data', dedup: false,
    });
  }
  // No checkIncident calls yet.
  assert.equal(problems.list().length, 0);
  const r = await detector.sweep();
  assert.ok(r.scanned >= 3);
  assert.ok(r.newProblems >= 1);
  assert.equal(problems.list().length, 1);
});

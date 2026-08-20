import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostMortemGenerator } from './PostMortemGenerator.js';
import { PostMortemStore } from '../persistence/PostMortemStore.js';
import { IncidentManager } from './IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

/** Build a fake AIProviderFactory that returns a stub provider whose
 *  chat() returns whatever the test supplies. Lets us cover the happy
 *  path, the malformed-JSON path, and the error path without standing
 *  up a real LLM. */
function mockFactory(answer: { content: string; model?: string } | Error) {
  return {
    async getDefaultProvider() {
      return {
        name: 'mock',
        async initialize() {},
        async chat() {
          if (answer instanceof Error) throw answer;
          return { content: answer.content, model: answer.model ?? 'mock-1', usage: undefined };
        },
        async streamChat() { throw new Error('not used'); },
        isAvailable() { return true; },
      };
    },
    async getProvider(_: string) {
      return this.getDefaultProvider();
    },
  } as any;
}

function newStack() {
  const dir = mkdtempSync(join(tmpdir(), 'pm-gen-test-'));
  const incidentStore = new SqliteIncidentStore(join(dir, 'incidents.db'));
  const pmStore = new PostMortemStore(join(dir, 'pm.db'));
  const incidents = new IncidentManager(incidentStore);
  return { incidentStore, pmStore, incidents };
}

test('generate(): happy path persists AI fields, derives type + duration', async () => {
  const { incidents, pmStore } = newStack();
  // Open an incident, then resolve it after a small fake duration.
  const inc = incidents.create({
    title: 'Disk Critical /data at 92%',
    description: 'Auto health monitor disk alert',
    severity: 'high',
    source: 'alert-rule',
    sourceRef: 'disk:/data',
  });
  // Inject a couple of timeline events so the generator has something
  // beyond the opened entry to summarise.
  incidents.addNote(inc.id, 'agent', 'Ran df — /data at 92%');
  incidents.addNote(inc.id, 'agent', 'Vacuumed journal, freed 14GB');
  incidents.resolve(inc.id, 'journalctl --vacuum-time=3d reclaimed 14GB');

  const factory = mockFactory({
    content: JSON.stringify({
      rootCause: 'Journal had stopped rotating; /data climbed to 92%.',
      actionsTaken: ['ran df -h', 'journalctl --vacuum-time=3d'],
      resolution: 'Freed 14GB; /data dropped to 78%.',
      lessons: ['Watch journal size — vacuum is the canonical disk fix here.'],
      prevention: ['Add an alert on journal size > 5GB.'],
      tags: ['disk', 'journal'],
    }),
    model: 'claude-sonnet-4-6',
  });

  const gen = new PostMortemGenerator(factory, incidents, pmStore);
  const resolved = incidents.get(inc.id);
  assert.ok(resolved);
  const pm = await gen.generate(resolved!);
  assert.ok(pm);
  assert.equal(pm!.incidentId, inc.id);
  assert.equal(pm!.severity, 'high');
  assert.equal(pm!.incidentType, 'disk-pressure');
  assert.match(pm!.rootCause, /Journal had stopped/);
  assert.ok(pm!.actionsTaken.length >= 2);
  assert.match(pm!.resolution, /14GB/);
  assert.equal(pm!.aiModel, 'claude-sonnet-4-6');
  // Tags should include the derived type + the AI's tags.
  assert.ok(pm!.tags.includes('disk-pressure'));
  assert.ok(pm!.tags.some(t => t.toLowerCase() === 'disk'));
});

test('generate(): low-severity incidents are skipped', async () => {
  const { incidents, pmStore } = newStack();
  const inc = incidents.create({ title: 'low thing', severity: 'low' });
  incidents.resolve(inc.id, 'eh');

  const factory = mockFactory({ content: '{"rootCause":"","actionsTaken":[],"resolution":"","lessons":[],"prevention":[]}' });
  const gen = new PostMortemGenerator(factory, incidents, pmStore);
  const resolved = incidents.get(inc.id);
  const pm = await gen.generate(resolved!);
  assert.equal(pm, null);
  assert.equal(pmStore.byIncident(inc.id).length, 0);
});

test('generate(): idempotent — second call returns the existing post-mortem', async () => {
  const { incidents, pmStore } = newStack();
  const inc = incidents.create({ title: 'mem high', severity: 'medium' });
  incidents.resolve(inc.id, 'restarted');

  const factory = mockFactory({
    content: JSON.stringify({
      rootCause: 'memory leak in worker',
      actionsTaken: ['restart worker'],
      resolution: 'restart cleared the leak',
      lessons: [],
      prevention: [],
      tags: [],
    }),
  });
  const gen = new PostMortemGenerator(factory, incidents, pmStore);
  const resolved = incidents.get(inc.id)!;
  const first = await gen.generate(resolved);
  const second = await gen.generate(resolved);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first!.id, second!.id);
  assert.equal(pmStore.byIncident(inc.id).length, 1);
});

test('generate(): malformed JSON falls back to a heuristic post-mortem', async () => {
  const { incidents, pmStore } = newStack();
  const inc = incidents.create({
    title: 'Service nginx unhealthy',
    description: 'docker reports unhealthy for nginx',
    severity: 'medium',
    sourceRef: 'docker:nginx',
  });
  incidents.addNote(inc.id, 'agent', 'restarted nginx');
  incidents.resolve(inc.id, 'restart restored health');

  const factory = mockFactory({ content: 'not actually json {{{' });
  const gen = new PostMortemGenerator(factory, incidents, pmStore);
  const resolved = incidents.get(inc.id)!;
  const pm = await gen.generate(resolved);
  assert.ok(pm);
  // Heuristic populates rootCause from the description and pulls actions
  // from timeline notes.
  assert.match(pm!.rootCause, /docker reports unhealthy/i);
  assert.ok(pm!.actionsTaken.length > 0);
  assert.equal(pm!.aiModel, null, 'no AI model recorded when AI output was unusable');
  assert.equal(pm!.incidentType, 'docker-issue');
});

test('generate(): AI throws → falls back without crashing', async () => {
  const { incidents, pmStore } = newStack();
  const inc = incidents.create({ title: 'cpu high', severity: 'medium' });
  incidents.resolve(inc.id, 'killed runaway proc');

  const factory = mockFactory(new Error('upstream timeout'));
  const gen = new PostMortemGenerator(factory, incidents, pmStore);
  const resolved = incidents.get(inc.id)!;
  const pm = await gen.generate(resolved);
  assert.ok(pm, 'should still persist a heuristic post-mortem after AI failure');
  assert.equal(pm!.aiModel, null);
});

test('generate(): skipAi=true bypasses the AI call entirely', async () => {
  const { incidents, pmStore } = newStack();
  const inc = incidents.create({ title: 'Disk pressure /var', severity: 'medium', sourceRef: 'disk:/var' });
  incidents.addNote(inc.id, 'agent', 'pruned images');
  incidents.resolve(inc.id, 'docker image prune freed 8GB');

  let chatCalled = false;
  const factory = {
    async getDefaultProvider() {
      return {
        name: 'mock',
        async initialize() {},
        async chat() { chatCalled = true; return { content: '{}', model: 'shouldnt-be-called' }; },
        async streamChat() { throw new Error('nope'); },
        isAvailable() { return true; },
      };
    },
    async getProvider() { return this.getDefaultProvider(); },
  } as any;

  const gen = new PostMortemGenerator(factory, incidents, pmStore, { skipAi: true });
  const resolved = incidents.get(inc.id)!;
  const pm = await gen.generate(resolved);
  assert.ok(pm);
  assert.equal(chatCalled, false, 'AI should not be invoked when skipAi=true');
  assert.equal(pm!.incidentType, 'disk-pressure');
  assert.equal(pm!.aiModel, null);
});

test('IncidentManager.onResolved fires listeners after resolve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-onresolve-test-'));
  const store = new SqliteIncidentStore(join(dir, 'incidents.db'));
  const mgr = new IncidentManager(store);
  const seen: string[] = [];
  mgr.onResolved((inc) => seen.push(inc.id));
  const inc = mgr.create({ title: 'x', severity: 'medium' });
  mgr.resolve(inc.id, 'done');
  assert.deepEqual(seen, [inc.id]);
});

test('IncidentManager.onResolved isolates listener errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-onresolve-isolate-'));
  const store = new SqliteIncidentStore(join(dir, 'incidents.db'));
  const mgr = new IncidentManager(store);
  const seen: string[] = [];
  mgr.onResolved(() => { throw new Error('bad listener'); });
  mgr.onResolved((inc) => seen.push(inc.id));
  const inc = mgr.create({ title: 'x', severity: 'medium' });
  assert.doesNotThrow(() => mgr.resolve(inc.id, 'done'));
  assert.deepEqual(seen, [inc.id], 'second listener still runs after first one throws');
});

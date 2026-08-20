import test from 'node:test';
import assert from 'node:assert/strict';
import { RunbookMatcher } from './RunbookMatcher.js';
import type { RunbookEngine } from './RunbookEngine.js';
import type { RunbookTemplate } from './RunbookTypes.js';

/** Fake engine — exposes just the surface the matcher consults. */
function fakeEngine(templates: RunbookTemplate[], cooldownState: { allow: boolean } = { allow: true }) {
  const fired: Array<{ id: string; triggeredBy: string; context: any }> = [];
  const engine = {
    listTemplates: () => templates,
    executeRun: async (id: string, triggeredBy: string, opts: any) => {
      fired.push({ id, triggeredBy, context: opts?.context });
      return { id: 'run-' + id, status: 'running' } as any;
    },
    metricCooldownExpired: (_t: string, _s: string, _c: number) => cooldownState.allow,
  } as unknown as RunbookEngine;
  return { engine, fired };
}

function tpl(id: string, triggerType: RunbookTemplate['triggerType'], triggerConfig: any, enabled = true): RunbookTemplate {
  return {
    id, name: id, description: '', category: '', tags: [],
    triggerType, triggerConfig, enabled,
    steps: [{ id: 's1', type: 'wait', description: 'noop', seconds: 0 }],
    createdAt: '', updatedAt: '',
  };
}

// ── Incident matching ─────────────────────────────────────────────────

test('matches sourceRef LIKE pattern, fires runbook with incident context', async () => {
  const t = tpl('rb-disk', 'incident_match', { sourceRef: 'disk:%' });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({
    id: 'INC-1', title: 'disk full', severity: 'high',
    sourceRef: 'disk:/data', serverId: 'web01',
  });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, 'rb-disk');
  assert.equal(fired[0].triggeredBy, 'auto:incident_match');
  assert.deepEqual(fired[0].context, { incidentId: 'INC-1', serverId: 'web01' });
});

test('severity acts as a minimum bar — high config matches critical incident', async () => {
  const t = tpl('rb-sev', 'incident_match', { severity: 'high' });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({ id: 'INC-9', title: 't', severity: 'critical', sourceRef: null, serverId: null });
  assert.equal(fired.length, 1);
});

test('severity below the bar does not match', async () => {
  const t = tpl('rb-sev', 'incident_match', { severity: 'high' });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({ id: 'INC-9', title: 't', severity: 'low', sourceRef: null, serverId: null });
  assert.equal(fired.length, 0);
});

test('serverId equality must match exactly', async () => {
  const t = tpl('rb-srv', 'incident_match', { serverId: 'web01' });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({ id: 'INC-1', title: 't', severity: 'medium', sourceRef: null, serverId: 'web02' });
  assert.equal(fired.length, 0);
  await m.matchIncident({ id: 'INC-2', title: 't', severity: 'medium', sourceRef: null, serverId: 'web01' });
  assert.equal(fired.length, 1);
});

test('disabled templates are skipped', async () => {
  const t = tpl('rb-off', 'incident_match', { sourceRef: '%' }, false);
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({ id: 'INC-1', title: 't', severity: 'high', sourceRef: 'anything', serverId: null });
  assert.equal(fired.length, 0);
});

test('empty trigger config never matches by accident', async () => {
  const t = tpl('rb-empty', 'incident_match', {});
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({ id: 'INC-1', title: 't', severity: 'high', sourceRef: 'x', serverId: null });
  assert.equal(fired.length, 0, 'empty config must require at least one selector');
});

test('title LIKE pattern works case-insensitively', async () => {
  const t = tpl('rb-title', 'incident_match', { title: '%cpu%' });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchIncident({ id: 'INC-1', title: 'High CPU on web01', severity: 'high', sourceRef: null, serverId: null });
  assert.equal(fired.length, 1);
});

// ── Metric matching ───────────────────────────────────────────────────

test('metric > threshold fires; serverId filter narrows', async () => {
  const t1 = tpl('rb-disk-any', 'metric_threshold', { metric: 'disk', operator: '>', threshold: 90 });
  const t2 = tpl('rb-disk-only-web01', 'metric_threshold', { metric: 'disk', operator: '>', threshold: 90, serverId: 'web01' });
  const { engine, fired } = fakeEngine([t1, t2]);
  const m = new RunbookMatcher(engine);
  await m.matchMetric('web02', 'disk', 91);
  assert.deepEqual(fired.map(f => f.id), ['rb-disk-any']);
});

test('metric below threshold does not fire', async () => {
  const t = tpl('rb-disk', 'metric_threshold', { metric: 'disk', operator: '>', threshold: 90 });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchMetric('web01', 'disk', 85);
  assert.equal(fired.length, 0);
});

test('cooldown silences a re-fire within the window', async () => {
  const t = tpl('rb-disk', 'metric_threshold', { metric: 'disk', operator: '>', threshold: 90 });
  const cooldown = { allow: true };
  const { engine, fired } = fakeEngine([t], cooldown);
  const m = new RunbookMatcher(engine);
  await m.matchMetric('web01', 'disk', 95);
  cooldown.allow = false;
  await m.matchMetric('web01', 'disk', 96);
  assert.equal(fired.length, 1);
});

test('different metric type is ignored', async () => {
  const t = tpl('rb-disk', 'metric_threshold', { metric: 'disk', operator: '>', threshold: 90 });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  await m.matchMetric('web01', 'cpu', 99);
  assert.equal(fired.length, 0);
});

// ── findMatching* introspection (no side effects) ─────────────────────

test('findMatchingIncidentTemplates does not execute', () => {
  const t = tpl('rb-x', 'incident_match', { sourceRef: '%' });
  const { engine, fired } = fakeEngine([t]);
  const m = new RunbookMatcher(engine);
  const found = m.findMatchingIncidentTemplates({
    id: 'INC-1', title: 't', severity: 'high', sourceRef: 'disk:/data', serverId: null,
  });
  assert.equal(found.length, 1);
  assert.equal(fired.length, 0);
});

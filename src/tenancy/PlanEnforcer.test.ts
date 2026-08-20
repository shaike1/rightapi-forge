import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SqliteTenantStore } from './TenantStore.js';
import { PlanEnforcer, monthStartIso } from './PlanEnforcer.js';

function tmpStack(plan: 'free' | 'pro' | 'enterprise' = 'free') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-plan-'));
  const tenants = new SqliteTenantStore(path.join(dir, 't.db'));
  tenants.upsert({ id: 'acme', slug: 'acme', name: 'Acme', plan });
  const counters = { servers: 0, incidents: 0, ai: 0 };
  const enforcer = new PlanEnforcer(tenants, {
    countServers: () => counters.servers,
    countIncidentsSince: () => counters.incidents,
    countAiDecisionsSince: () => counters.ai,
  });
  return { dir, tenants, enforcer, counters };
}

test('free plan blocks server adds past 3', async () => {
  const { enforcer, counters } = tmpStack('free');
  counters.servers = 3;
  const r = await enforcer.checkServerAdd('acme');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /Server limit reached/);
  assert.equal(r.current, 3);
  assert.equal(r.limit, 3);
});

test('free plan allows 1st, 2nd, 3rd server but not the 4th', async () => {
  const { enforcer, counters } = tmpStack('free');
  for (let i = 0; i < 3; i++) {
    counters.servers = i;
    const r = await enforcer.checkServerAdd('acme');
    assert.equal(r.ok, true, `should allow at count=${i}`);
  }
  counters.servers = 3;
  const blocked = await enforcer.checkServerAdd('acme');
  assert.equal(blocked.ok, false);
});

test('pro plan allows up to 20 servers', async () => {
  const { enforcer, counters } = tmpStack('pro');
  counters.servers = 19;
  assert.equal((await enforcer.checkServerAdd('acme')).ok, true);
  counters.servers = 20;
  assert.equal((await enforcer.checkServerAdd('acme')).ok, false);
});

test('enterprise plan never blocks servers or incidents', async () => {
  const { enforcer, counters } = tmpStack('enterprise');
  counters.servers = 9999;
  counters.incidents = 9999999;
  assert.equal((await enforcer.checkServerAdd('acme')).ok, true);
  assert.equal((await enforcer.checkIncidentCreate('acme')).ok, true);
});

test('incident cap kicks in on free at 50/month', async () => {
  const { enforcer, counters } = tmpStack('free');
  counters.incidents = 50;
  const r = await enforcer.checkIncidentCreate('acme');
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /Monthly incident cap/);
});

test('free plan blocks the AI feature gates', async () => {
  const { enforcer } = tmpStack('free');
  for (const f of ['autoResolve', 'predictiveAlerts', 'runbookGeneration'] as const) {
    const r = await enforcer.checkFeature('acme', f);
    assert.equal(r.ok, false, `expected ${f} blocked on free`);
  }
});

test('pro plan allows the AI feature gates', async () => {
  const { enforcer } = tmpStack('pro');
  for (const f of ['autoResolve', 'predictiveAlerts', 'runbookGeneration'] as const) {
    const r = await enforcer.checkFeature('acme', f);
    assert.equal(r.ok, true);
  }
});

test('usage returns a snapshot the dashboard can render', async () => {
  const { enforcer, counters } = tmpStack('pro');
  counters.servers = 5; counters.incidents = 12; counters.ai = 33;
  const u = await enforcer.usage('acme');
  assert.equal(u.plan, 'pro');
  assert.equal(u.servers.current, 5);
  assert.equal(u.servers.limit, 20);
  assert.equal(u.incidentsThisMonth.limit, -1, 'pro has unlimited incidents');
  assert.equal(u.aiDecisionsThisMonth, 33);
  assert.equal(u.featureFlags.autoResolveAllowed, true);
});

test('monthStartIso returns the UTC 1st-of-month at 00:00:00', () => {
  const ms = new Date('2026-05-13T12:34:56Z');
  assert.equal(monthStartIso(ms), '2026-05-01T00:00:00.000Z');
});

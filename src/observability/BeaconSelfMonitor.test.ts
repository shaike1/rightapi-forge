import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HealthChecker, type ProbeStatus } from '../web/healthCheck.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { BeaconSelfMonitor } from './BeaconSelfMonitor.js';

function tempDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-self-'));
  return { dir, path: join(dir, 'inc.db') };
}

/** Toggleable health checker: each probe reads a current status from
 *  a shared map so the test can flip pass↔fail between ticks without
 *  re-registering probes. */
function makeChecker(initial: Record<string, ProbeStatus>) {
  const states = new Map(Object.entries(initial));
  const checker = new HealthChecker();
  for (const name of states.keys()) {
    checker.register({
      name,
      critical: false,
      fn: async () => ({ status: states.get(name) ?? 'pass', error: states.get(name) === 'fail' ? 'simulated' : undefined }),
    });
  }
  return {
    checker,
    setStatus: (name: string, status: ProbeStatus) => { states.set(name, status); },
  };
}

test('BeaconSelfMonitor: 3 consecutive fails open a self-incident, severity scales with streak', async () => {
  const { dir, path } = tempDb();
  try {
    const store = new SqliteIncidentStore(path);
    const incidentManager = new IncidentManager(store);
    const { checker, setStatus } = makeChecker({ 'flaky-check': 'fail' });
    const sm = new BeaconSelfMonitor({ healthChecker: checker, incidentManager }, { failThreshold: 3, recoverThreshold: 2 });

    await sm.tickOnce(); // 1 fail
    assert.equal(store.list({}).length, 0, 'one fail tick must not yet open an incident');

    await sm.tickOnce(); // 2 fails
    assert.equal(store.list({}).length, 0, 'two fail ticks must not yet open an incident');

    await sm.tickOnce(); // 3 fails — triggers
    const opened = store.list({}).filter(i => i.source === 'agent' && (i.sourceRef || '').startsWith('beacon-self:'));
    assert.equal(opened.length, 1, 'fail threshold should open exactly one incident');
    assert.equal(opened[0].severity, 'medium', 'initial severity is medium');
    assert.match(opened[0].title, /RightAPI Forge self-check failing/);
    assert.equal(opened[0].sourceRef, 'beacon-self:flaky-check');

    // Six more fail ticks: streak hits 9 (≥ failThreshold * 2 = 6) → upgrade to high.
    for (let i = 0; i < 6; i++) await sm.tickOnce();
    const upgraded = store.list({}).filter(i => i.sourceRef === 'beacon-self:flaky-check')[0];
    assert.ok(upgraded.severity === 'high' || upgraded.severity === 'critical', `expected escalated severity, got ${upgraded.severity}`);

    // And another six ticks → streak hits 15 (≥ failThreshold * 4 = 12) → critical.
    for (let i = 0; i < 6; i++) await sm.tickOnce();
    const peaked = store.list({}).filter(i => i.sourceRef === 'beacon-self:flaky-check')[0];
    assert.equal(peaked.severity, 'critical', 'sustained failure should reach critical');

    // Still exactly one row — dedup honoured the sourceRef.
    assert.equal(
      store.list({}).filter(i => (i.sourceRef || '').startsWith('beacon-self:')).length,
      1,
      'dedup must keep the row count at 1 across repeated fail ticks',
    );

    sm.stop();
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('BeaconSelfMonitor: recovery threshold auto-resolves the self-incident', async () => {
  const { dir, path } = tempDb();
  try {
    const store = new SqliteIncidentStore(path);
    const incidentManager = new IncidentManager(store);
    const { checker, setStatus } = makeChecker({ 'recoverable': 'fail' });
    const sm = new BeaconSelfMonitor({ healthChecker: checker, incidentManager }, { failThreshold: 2, recoverThreshold: 2 });

    await sm.tickOnce(); await sm.tickOnce();
    let inc = store.list({}).find(i => i.sourceRef === 'beacon-self:recoverable');
    assert.ok(inc, 'incident should be open after fail threshold');
    assert.notEqual(inc!.status, 'resolved');

    // Flip the probe to passing — but only one pass tick.
    setStatus('recoverable', 'pass');
    await sm.tickOnce();
    inc = store.list({}).find(i => i.sourceRef === 'beacon-self:recoverable');
    assert.notEqual(inc!.status, 'resolved', 'one pass below recoverThreshold must not close yet');

    // Second consecutive pass → auto-resolve.
    await sm.tickOnce();
    inc = store.list({}).find(i => i.sourceRef === 'beacon-self:recoverable');
    assert.equal(inc!.status, 'resolved', 'recovery threshold met → auto-resolve');
    assert.match(inc!.resolvedAt || '', /\d{4}-\d{2}-\d{2}/);

    sm.stop();
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('BeaconSelfMonitor: warn status neither opens nor resolves an incident', async () => {
  const { dir, path } = tempDb();
  try {
    const store = new SqliteIncidentStore(path);
    const incidentManager = new IncidentManager(store);
    const { checker, setStatus } = makeChecker({ 'warner': 'warn' });
    const sm = new BeaconSelfMonitor({ healthChecker: checker, incidentManager }, { failThreshold: 2, recoverThreshold: 2 });

    for (let i = 0; i < 10; i++) await sm.tickOnce();
    assert.equal(store.list({}).length, 0, 'warn-only never opens an incident');

    // Now switch to fail to open one, then back to warn — must NOT auto-close.
    setStatus('warner', 'fail');
    await sm.tickOnce(); await sm.tickOnce();
    const opened = store.list({}).find(i => i.sourceRef === 'beacon-self:warner');
    assert.ok(opened, 'fail streak should open');

    setStatus('warner', 'warn');
    for (let i = 0; i < 5; i++) await sm.tickOnce();
    const stillOpen = store.list({}).find(i => i.sourceRef === 'beacon-self:warner');
    assert.notEqual(stillOpen!.status, 'resolved', 'warn must not count toward recovery');

    sm.stop();
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('BeaconSelfMonitor: snapshot() exposes per-check streak state', async () => {
  const { dir, path } = tempDb();
  try {
    const store = new SqliteIncidentStore(path);
    const incidentManager = new IncidentManager(store);
    const { checker } = makeChecker({ 'a': 'fail', 'b': 'pass' });
    const sm = new BeaconSelfMonitor({ healthChecker: checker, incidentManager }, { failThreshold: 5 });

    await sm.tickOnce();
    await sm.tickOnce();
    const snap = sm.snapshot();
    assert.equal(snap['a'].failStreak, 2);
    assert.equal(snap['a'].passStreak, 0);
    assert.equal(snap['b'].failStreak, 0);
    assert.equal(snap['b'].passStreak, 2);

    sm.stop();
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

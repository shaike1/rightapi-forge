import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteEventStore } from '../persistence/EventStore.js';
import { EventBus } from './EventBus.js';
import { runWithTenant, SYSTEM_TENANT_ID } from '../tenancy/TenantContext.js';
import { TenantScopedEventBus } from './TenantScopedEventBus.js';

function newBus(): { tenantBus: TenantScopedEventBus; rawBus: EventBus; store: SqliteEventStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-tenantbus-'));
  const store = new SqliteEventStore(path.join(dir, 'events.db'));
  const rawBus = new EventBus(store);
  const tenantBus = new TenantScopedEventBus(rawBus, store);
  return {
    tenantBus, rawBus, store,
    cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('publish stamps events with the active tenant', async () => {
  const { tenantBus, store, cleanup } = newBus();
  try {
    await runWithTenant({ tenantId: 'acme' }, async () => {
      await tenantBus.publish({
        aggregateType: 'task', aggregateId: 't1', type: 'task.created',
        actor: 'agent-1',
      });
    });
    const all = store.read();
    assert.equal(all.length, 1);
    assert.equal(all[0].tenantId, 'acme');
  } finally { cleanup(); }
});

test('publish outside any scope falls back to the system tenant', async () => {
  const { tenantBus, store, cleanup } = newBus();
  try {
    await tenantBus.publish({
      aggregateType: 'system', aggregateId: 'b', type: 'system.started',
      actor: 'system',
    });
    assert.equal(store.read()[0].tenantId, SYSTEM_TENANT_ID);
  } finally { cleanup(); }
});

test('subscribers only receive events for their own tenant', async () => {
  const { tenantBus, cleanup } = newBus();
  try {
    const acmeSeen: string[] = [];
    const betaSeen: string[] = [];
    await runWithTenant({ tenantId: 'acme' }, () => {
      tenantBus.subscribe({ type: 'task.created' }, (e) => acmeSeen.push(e.aggregateId), 'acme-listener');
    });
    await runWithTenant({ tenantId: 'beta' }, () => {
      tenantBus.subscribe({ type: 'task.created' }, (e) => betaSeen.push(e.aggregateId), 'beta-listener');
    });

    // Acme publishes two; beta one.
    await runWithTenant({ tenantId: 'acme' }, async () => {
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'a1', type: 'task.created', actor: 'a' });
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'a2', type: 'task.created', actor: 'a' });
    });
    await runWithTenant({ tenantId: 'beta' }, async () => {
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'b1', type: 'task.created', actor: 'b' });
    });

    assert.deepEqual(acmeSeen, ['a1', 'a2']);
    assert.deepEqual(betaSeen, ['b1']);
  } finally { cleanup(); }
});

test('subscribeAcrossAllTenants opt-in receives every tenant\'s events', async () => {
  const { tenantBus, cleanup } = newBus();
  try {
    const everything: Array<{ tenant: string; id: string }> = [];
    tenantBus.subscribeAcrossAllTenants({}, (e) =>
      everything.push({ tenant: e.tenantId, id: e.aggregateId }), 'audit-monitor');
    await runWithTenant({ tenantId: 'acme' }, async () => {
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'a', type: 'task.created', actor: 'x' });
    });
    await runWithTenant({ tenantId: 'beta' }, async () => {
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'b', type: 'task.created', actor: 'x' });
    });
    assert.equal(everything.length, 2);
    assert.deepEqual(everything.map(e => e.tenant).sort(), ['acme', 'beta']);
  } finally { cleanup(); }
});

test('read scopes results to the active tenant', async () => {
  const { tenantBus, cleanup } = newBus();
  try {
    await runWithTenant({ tenantId: 'acme' }, async () => {
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'a1', type: 'task.created', actor: 'x' });
    });
    await runWithTenant({ tenantId: 'beta' }, async () => {
      await tenantBus.publish({ aggregateType: 'task', aggregateId: 'b1', type: 'task.created', actor: 'x' });
    });
    const acme = await runWithTenant({ tenantId: 'acme' }, () => tenantBus.read());
    const beta = await runWithTenant({ tenantId: 'beta' }, () => tenantBus.read());
    assert.equal(acme.length, 1);
    assert.equal(acme[0].tenantId, 'acme');
    assert.equal(beta.length, 1);
    assert.equal(beta[0].tenantId, 'beta');
  } finally { cleanup(); }
});

test('publishAsSystem always records as the system tenant regardless of scope', async () => {
  const { tenantBus, store, cleanup } = newBus();
  try {
    await runWithTenant({ tenantId: 'acme' }, async () => {
      await tenantBus.publishAsSystem({
        aggregateType: 'system', aggregateId: 'b', type: 'system.started', actor: 'system',
      });
    });
    assert.equal(store.read()[0].tenantId, SYSTEM_TENANT_ID);
  } finally { cleanup(); }
});

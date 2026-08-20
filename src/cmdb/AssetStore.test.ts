import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AssetStore } from './AssetStore.js';

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'asset-test-'));
  return { dir, path: join(dir, 'assets.db') };
}

test('AssetStore: create assigns AST-prefixed id and persists fields', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.create({
      type: 'service',
      name: 'auth-api',
      description: 'OIDC token service',
      tags: ['prod', 'critical'],
      metadata: { port: 8443, version: '2.1.0' },
    });
    assert.match(a.id, /^AST-[A-F0-9]{8}$/);
    assert.equal(a.type, 'service');
    assert.equal(a.name, 'auth-api');
    assert.deepEqual(a.tags, ['prod', 'critical']);
    assert.equal((a.metadata as any).port, 8443);

    // Reload should return identical row.
    const reloaded = store.get(a.id);
    assert.deepEqual(reloaded?.metadata, a.metadata);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: upsertByServerId is idempotent and refreshes metadata', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.upsertByServerId({ name: 'vps1', serverId: 'srv-1', tags: ['seed'], metadata: { host: '10.0.0.1' } });
    const b = store.upsertByServerId({ name: 'vps1-renamed', serverId: 'srv-1', metadata: { host: '10.0.0.2', enabled: true } });
    assert.equal(a.id, b.id, 'same serverId → same asset row');
    assert.equal(store.list({ type: 'server' }).length, 1, 'no duplicates');
    assert.equal(b.name, 'vps1-renamed');
    assert.equal((b.metadata as any).host, '10.0.0.2');
    assert.equal((b.metadata as any).enabled, true);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: update merges metadata without clobbering existing keys', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.create({ type: 'database', name: 'pg-primary', metadata: { engine: 'postgres', port: 5432 } });
    const updated = store.update(a.id, { metadata: { version: '15.4' } });
    assert.equal((updated!.metadata as any).engine, 'postgres', 'pre-existing keys preserved');
    assert.equal((updated!.metadata as any).version, '15.4', 'new keys merged in');
    assert.equal((updated!.metadata as any).port, 5432);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: list filters by type, tag, q, serverId', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    store.create({ type: 'server', name: 'web-1', tags: ['prod', 'edge'], serverId: 'srv-1' });
    store.create({ type: 'server', name: 'web-2', tags: ['prod'], serverId: 'srv-2' });
    store.create({ type: 'database', name: 'db-1', tags: ['prod'], description: 'master postgres' });
    store.create({ type: 'service', name: 'queue', tags: ['internal'] });

    assert.equal(store.list({ type: 'server' }).length, 2);
    assert.equal(store.list({ tag: 'edge' }).length, 1);
    assert.equal(store.list({ q: 'postgres' }).length, 1);
    assert.equal(store.list({ serverId: 'srv-2' })[0].name, 'web-2');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: addRelationship is idempotent on duplicates', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.create({ type: 'server', name: 'srv' });
    const b = store.create({ type: 'service', name: 'svc' });
    const r1 = store.addRelationship(a.id, b.id, 'hosts');
    const r2 = store.addRelationship(a.id, b.id, 'hosts');
    assert.equal(r1.id, r2.id, 'duplicate relationship returns the existing row');
    assert.equal(store.listDownstream(a.id).length, 1);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: deleting an asset cascades its relationships', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.create({ type: 'server', name: 'a' });
    const b = store.create({ type: 'service', name: 'b' });
    const c = store.create({ type: 'application', name: 'c' });
    store.addRelationship(a.id, b.id, 'hosts');
    store.addRelationship(b.id, c.id, 'runs');
    store.addRelationship(a.id, c.id, 'depends_on');
    assert.equal(store.stats().relationships, 3);

    store.delete(a.id);
    // a → b and a → c removed; b → c survives.
    assert.equal(store.stats().relationships, 1);
    assert.equal(store.listDownstream(b.id).length, 1);
    assert.equal(store.listUpstream(c.id).length, 1);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: refuses self-relationships and unknown ids', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const a = store.create({ type: 'server', name: 'a' });
    assert.throws(() => store.addRelationship(a.id, a.id, 'hosts'), /itself/);
    assert.throws(() => store.addRelationship(a.id, 'AST-FFFFFFFF', 'hosts'), /unknown child/);
    assert.throws(() => store.addRelationship('AST-FFFFFFFF', a.id, 'hosts'), /unknown parent/);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('AssetStore: stats summarises by type + relationship count', () => {
  const { dir, path } = tmp();
  try {
    const store = new AssetStore(path);
    const s1 = store.create({ type: 'server', name: 's1' });
    store.create({ type: 'server', name: 's2' });
    store.create({ type: 'service', name: 'svc' });
    const a = store.create({ type: 'database', name: 'db' });
    store.addRelationship(s1.id, a.id, 'depends_on');
    const s = store.stats();
    assert.equal(s.total, 4);
    assert.equal(s.byType.server, 2);
    assert.equal(s.byType.service, 1);
    assert.equal(s.byType.database, 1);
    assert.equal(s.relationships, 1);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

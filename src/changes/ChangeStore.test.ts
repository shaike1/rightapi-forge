import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChangeStore } from './ChangeStore.js';

function tmp(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'change-test-'));
  return { dir, path: join(dir, 'changes.db') };
}

test('ChangeStore: create assigns CHG-prefixed id and stamps timestamps for terminal status', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);

    const planned = store.create({ type: 'deployment', title: 'Deploy v2.1' });
    assert.match(planned.id, /^CHG-[A-F0-9]{8}$/);
    assert.equal(planned.status, 'planned');
    assert.equal(planned.startedAt, null);
    assert.equal(planned.completedAt, null);

    const inProg = store.create({ type: 'deployment', title: 'Deploy v2.2', status: 'in_progress' });
    assert.equal(inProg.status, 'in_progress');
    assert.ok(inProg.startedAt, 'in_progress should auto-stamp started_at');
    assert.equal(inProg.completedAt, null);

    const done = store.create({ type: 'config', title: 'Edit nginx.conf', status: 'completed' });
    assert.ok(done.completedAt, 'completed should auto-stamp completed_at');

    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ChangeStore: update auto-stamps transition timestamps', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);
    const c = store.create({ type: 'maintenance', title: 'Patch kernel' });
    assert.equal(c.startedAt, null);
    const started = store.update(c.id, { status: 'in_progress' });
    assert.ok(started!.startedAt, 'started_at stamped on planned→in_progress');
    const finished = store.update(c.id, { status: 'completed' });
    assert.ok(finished!.completedAt, 'completed_at stamped on in_progress→completed');
    // A second update to a different terminal status must not re-stamp.
    const firstCompletedAt = finished!.completedAt;
    const rolled = store.update(c.id, { status: 'rolled_back' });
    assert.equal(rolled!.completedAt, firstCompletedAt, 'completed_at preserved on terminal→terminal');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ChangeStore: update merges metadata without clobbering existing keys', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);
    const c = store.create({ type: 'deployment', title: 'Deploy', metadata: { version: '1.0', author: 'alice' } });
    const updated = store.update(c.id, { metadata: { version: '1.1' } });
    assert.equal((updated!.metadata as any).version, '1.1');
    assert.equal((updated!.metadata as any).author, 'alice', 'pre-existing keys preserved');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ChangeStore: list filters by status / type / asset / server / time window', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);
    store.create({ type: 'deployment', title: 'd1', status: 'completed', assetId: 'AST-A', serverId: 'srv-1' });
    store.create({ type: 'config',     title: 'c1', status: 'planned',   assetId: 'AST-A' });
    store.create({ type: 'deployment', title: 'd2', status: 'failed',    serverId: 'srv-2' });
    assert.equal(store.list({ status: 'completed' }).length, 1);
    assert.equal(store.list({ type: 'deployment' }).length, 2);
    assert.equal(store.list({ assetId: 'AST-A' }).length, 2);
    assert.equal(store.list({ serverId: 'srv-2' }).length, 1);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ChangeStore: changesInWindow scoped to asset/server', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);
    const now = Date.now();
    const _a = store.create({ type: 'deployment', title: 'recent', assetId: 'AST-A', serverId: 'srv-1' });
    const _b = store.create({ type: 'config',     title: 'noise',  assetId: 'AST-B', serverId: 'srv-2' });
    // Force one row well outside the window by direct UPDATE.
    (store as any)['db'].prepare("UPDATE changes SET created_at = ? WHERE title = 'noise'").run(new Date(now - 24 * 3600 * 1000).toISOString());
    const sinceIso = new Date(now - 60 * 60 * 1000).toISOString();
    const untilIso = new Date(now + 1000).toISOString();
    const within = store.changesInWindow(sinceIso, untilIso, { assetId: 'AST-A' });
    assert.equal(within.length, 1);
    assert.equal(within[0].title, 'recent');
    const noiseScope = store.changesInWindow(sinceIso, untilIso, { assetId: 'AST-B' });
    assert.equal(noiseScope.length, 0, 'asset filter excludes the older row');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ChangeStore: stats counts by status + type', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);
    store.create({ type: 'deployment', title: 't1', status: 'completed' });
    store.create({ type: 'deployment', title: 't2', status: 'completed' });
    store.create({ type: 'deployment', title: 't3', status: 'failed' });
    store.create({ type: 'config',     title: 't4', status: 'planned' });
    const s = store.stats();
    assert.equal(s.total, 4);
    assert.equal(s.byStatus.completed, 2);
    assert.equal(s.byStatus.failed, 1);
    assert.equal(s.byStatus.planned, 1);
    assert.equal(s.byType.deployment, 3);
    assert.equal(s.byType.config, 1);
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('ChangeStore: delete removes the row', () => {
  const { dir, path } = tmp();
  try {
    const store = new ChangeStore(path);
    const c = store.create({ type: 'deployment', title: 'gone' });
    assert.equal(store.delete(c.id), true);
    assert.equal(store.get(c.id), null);
    assert.equal(store.delete(c.id), false, 'second delete returns false');
    store.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

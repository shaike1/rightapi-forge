import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteEventStore } from './EventStore.js';

function tempPath(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-eventstore-'));
  return {
    dbPath: path.join(dir, 'events.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('append assigns a unique id + timestamp and read returns chronological order', () => {
  const { dbPath, cleanup } = tempPath();
  try {
    const store = new SqliteEventStore(dbPath);
    const a = store.append({
      aggregateType: 'task', aggregateId: 't1', type: 'task.created',
      actor: 'agent-1', data: { title: 'first' },
    });
    const b = store.append({
      aggregateType: 'task', aggregateId: 't1', type: 'task.completed',
      actor: 'agent-1', data: { result: 'ok' },
    });
    assert.notEqual(a.id, b.id);
    assert.ok(a.timestamp <= b.timestamp);

    const all = store.read();
    assert.equal(all.length, 2);
    assert.equal(all[0].id, a.id);
    assert.equal(all[1].id, b.id);
    store.close();
  } finally {
    cleanup();
  }
});

test('read filters by aggregateType / aggregateId / type / time range', () => {
  const { dbPath, cleanup } = tempPath();
  try {
    const store = new SqliteEventStore(dbPath);
    store.append({ aggregateType: 'task',     aggregateId: 't1', type: 'task.created',   actor: 'a' });
    store.append({ aggregateType: 'task',     aggregateId: 't2', type: 'task.created',   actor: 'a' });
    store.append({ aggregateType: 'workflow', aggregateId: 'w1', type: 'workflow.run.started', actor: 'sys' });
    store.append({ aggregateType: 'task',     aggregateId: 't1', type: 'task.completed', actor: 'a' });

    assert.equal(store.read({ aggregateType: 'task' }).length, 3);
    assert.equal(store.read({ aggregateId: 't1' }).length, 2);
    assert.equal(store.read({ type: 'task.created' }).length, 2);
    assert.equal(store.count({ type: 'task.completed' }), 1);
    store.close();
  } finally {
    cleanup();
  }
});

test('purge removes events older than a given timestamp', () => {
  const { dbPath, cleanup } = tempPath();
  try {
    const store = new SqliteEventStore(dbPath);
    const oldT = '2020-01-01T00:00:00.000Z';
    store.append({ aggregateType: 'task', aggregateId: 'old', type: 'task.created', actor: 'a', timestamp: oldT });
    store.append({ aggregateType: 'task', aggregateId: 'new', type: 'task.created', actor: 'a' });
    const removed = store.purge('2020-12-31T00:00:00.000Z');
    assert.equal(removed, 1);
    assert.equal(store.count(), 1);
    store.close();
  } finally {
    cleanup();
  }
});

test('purge dry run counts old events without deleting them', () => {
  const { dbPath, cleanup } = tempPath();
  try {
    const store = new SqliteEventStore(dbPath);
    store.append({ aggregateType: 'task', aggregateId: 'old', type: 'task.created', actor: 'a', timestamp: '2020-01-01T00:00:00.000Z' });
    store.append({ aggregateType: 'task', aggregateId: 'new', type: 'task.created', actor: 'a' });
    assert.equal(store.purge('2020-12-31T00:00:00.000Z', true), 1);
    assert.equal(store.count(), 2);
    store.close();
  } finally {
    cleanup();
  }
});

test('round-trip preserves correlationId, causationId, and structured data', () => {
  const { dbPath, cleanup } = tempPath();
  try {
    const store = new SqliteEventStore(dbPath);
    const e = store.append({
      aggregateType: 'workflow', aggregateId: 'w1', type: 'workflow.step.completed',
      actor: 'wf', correlationId: 'task-42', causationId: 'evt-prev',
      data: { stepId: 's1', output: { count: 5, deep: { tag: ['a', 'b'] } } },
    });
    const got = store.read({ aggregateId: 'w1' })[0];
    assert.equal(got.id, e.id);
    assert.equal(got.correlationId, 'task-42');
    assert.equal(got.causationId, 'evt-prev');
    assert.deepEqual(got.data, { stepId: 's1', output: { count: 5, deep: { tag: ['a', 'b'] } } });
    store.close();
  } finally {
    cleanup();
  }
});

test('limit + offset paginate the result set in chronological order', () => {
  const { dbPath, cleanup } = tempPath();
  try {
    const store = new SqliteEventStore(dbPath);
    for (let i = 0; i < 10; i++) {
      store.append({
        aggregateType: 'task', aggregateId: `t${i}`, type: 'task.created',
        actor: 'a', data: { i },
      });
    }
    const page1 = store.read({ limit: 4, offset: 0 });
    const page2 = store.read({ limit: 4, offset: 4 });
    const page3 = store.read({ limit: 4, offset: 8 });
    assert.equal(page1.length, 4);
    assert.equal(page2.length, 4);
    assert.equal(page3.length, 2);
    // Pages don't overlap.
    const ids = new Set([...page1, ...page2, ...page3].map(e => e.id));
    assert.equal(ids.size, 10);
    store.close();
  } finally {
    cleanup();
  }
});

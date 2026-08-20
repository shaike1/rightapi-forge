import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteEventStore } from '../persistence/EventStore.js';
import { EventBus } from './EventBus.js';
import { EventTypes } from './EventTypes.js';

function newBus(): { bus: EventBus; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-eventbus-'));
  const store = new SqliteEventStore(path.join(dir, 'events.db'));
  const bus = new EventBus(store);
  return {
    bus,
    cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('publish persists the event and returns the populated record', async () => {
  const { bus, cleanup } = newBus();
  try {
    const stored = await bus.publish({
      aggregateType: 'task', aggregateId: 't1', type: 'task.created',
      actor: 'agent-1', data: { title: 'first' },
    });
    assert.match(stored.id, /^evt-/);
    assert.ok(stored.timestamp);
    const all = await bus.read({ aggregateId: 't1' });
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].data, { title: 'first' });
  } finally {
    cleanup();
  }
});

test('subscribers receive events that match their filter', async () => {
  const { bus, cleanup } = newBus();
  try {
    const taskCreatedEvents: string[] = [];
    const allEvents: string[] = [];
    bus.subscribe({ type: EventTypes.TASK_CREATED }, (e) => {
      taskCreatedEvents.push(e.aggregateId);
    }, 'task-created-listener');
    bus.subscribe({}, (e) => { allEvents.push(e.type); }, 'fanout-all');

    await bus.publish({ aggregateType: 'task', aggregateId: 't1', type: 'task.created',   actor: 'a' });
    await bus.publish({ aggregateType: 'task', aggregateId: 't2', type: 'task.completed', actor: 'a' });
    await bus.publish({ aggregateType: 'task', aggregateId: 't3', type: 'task.created',   actor: 'a' });

    assert.deepEqual(taskCreatedEvents, ['t1', 't3']);
    assert.deepEqual(allEvents, ['task.created', 'task.completed', 'task.created']);
  } finally {
    cleanup();
  }
});

test('typePrefix filter matches all events under a namespace', async () => {
  const { bus, cleanup } = newBus();
  try {
    const seen: string[] = [];
    bus.subscribe({ typePrefix: 'workflow.' }, (e) => seen.push(e.type));
    await bus.publish({ aggregateType: 'workflow', aggregateId: 'w', type: 'workflow.run.started', actor: 's' });
    await bus.publish({ aggregateType: 'workflow', aggregateId: 'w', type: 'workflow.step.completed', actor: 's' });
    await bus.publish({ aggregateType: 'task',     aggregateId: 't', type: 'task.created', actor: 's' });
    assert.deepEqual(seen, ['workflow.run.started', 'workflow.step.completed']);
  } finally {
    cleanup();
  }
});

test('a throwing handler does not break sibling handlers or future events', async () => {
  const { bus, cleanup } = newBus();
  try {
    const seen: string[] = [];
    bus.subscribe({}, () => { throw new Error('boom'); }, 'always-throws');
    bus.subscribe({}, (e) => seen.push(e.aggregateId), 'survivor');
    await bus.publish({ aggregateType: 'task', aggregateId: 'a', type: 'task.created', actor: 'x' });
    await bus.publish({ aggregateType: 'task', aggregateId: 'b', type: 'task.created', actor: 'x' });
    assert.deepEqual(seen, ['a', 'b']);
  } finally {
    cleanup();
  }
});

test('unsubscribe stops further deliveries', async () => {
  const { bus, cleanup } = newBus();
  try {
    const seen: string[] = [];
    const unsub = bus.subscribe({}, (e) => seen.push(e.aggregateId));
    await bus.publish({ aggregateType: 'task', aggregateId: 'a', type: 'task.created', actor: 'x' });
    unsub();
    await bus.publish({ aggregateType: 'task', aggregateId: 'b', type: 'task.created', actor: 'x' });
    assert.deepEqual(seen, ['a']);
  } finally {
    cleanup();
  }
});

test('replay feeds historical events into a projection without firing live handlers', async () => {
  const { bus, cleanup } = newBus();
  try {
    let liveFires = 0;
    bus.subscribe({}, () => { liveFires++; });
    await bus.publish({ aggregateType: 'task', aggregateId: 't', type: 'task.created',   actor: 'a' });
    await bus.publish({ aggregateType: 'task', aggregateId: 't', type: 'task.completed', actor: 'a' });
    assert.equal(liveFires, 2);

    // Project the count of completed tasks.
    const result = await bus.replay(
      { aggregateType: 'task' },
      (state: { completed: number }, e) =>
        e.type === 'task.completed' ? { completed: state.completed + 1 } : state,
      { completed: 0 },
    );
    assert.equal(result.state.completed, 1);
    assert.equal(result.visited, 2);
    // Replay must NOT have re-triggered the live subscriber.
    assert.equal(liveFires, 2);
  } finally {
    cleanup();
  }
});

test('listSubscriptions exposes the current subscribers for diagnostics', () => {
  const { bus, cleanup } = newBus();
  try {
    bus.subscribe({ type: 'task.created' },          () => {}, 'task-listener');
    bus.subscribe({ aggregateType: 'workflow' },     () => {}, 'workflow-listener');
    const subs = bus.listSubscriptions();
    assert.equal(subs.length, 2);
    const names = subs.map(s => s.name).sort();
    assert.deepEqual(names, ['task-listener', 'workflow-listener']);
  } finally {
    cleanup();
  }
});

test('correlation + causation ids are preserved through publish + read', async () => {
  const { bus, cleanup } = newBus();
  try {
    const root = await bus.publish({
      aggregateType: 'task', aggregateId: 't', type: 'task.created',
      actor: 'a', correlationId: 'corr-1',
    });
    const child = await bus.publish({
      aggregateType: 'task', aggregateId: 't', type: 'task.completed',
      actor: 'a', correlationId: 'corr-1', causationId: root.id,
    });
    const events = await bus.read({ aggregateId: 't' });
    assert.equal(events[0].correlationId, 'corr-1');
    assert.equal(events[1].causationId, root.id);
    assert.equal(child.causationId, root.id);
  } finally {
    cleanup();
  }
});

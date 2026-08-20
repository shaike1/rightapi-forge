import test from 'node:test';
import assert from 'node:assert/strict';
import { GracefulShutdown } from './GracefulShutdown.js';

function newCoordinator(drainTimeoutMs = 200) {
  return new GracefulShutdown({ drainTimeoutMs });
}

test('runs registered hooks in order', async () => {
  const order: string[] = [];
  const c = newCoordinator();
  c.register({ name: 'a', fn: () => { order.push('a'); } });
  c.register({ name: 'b', fn: async () => { order.push('b'); } });
  c.register({ name: 'c', fn: () => { order.push('c'); } });
  await c.shutdown({ exit: false });
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a failing hook does not abort the rest', async () => {
  const order: string[] = [];
  const c = newCoordinator();
  c.register({ name: 'first',  fn: () => { order.push('first'); } });
  c.register({ name: 'broken', fn: () => { throw new Error('boom'); } });
  c.register({ name: 'last',   fn: () => { order.push('last'); } });
  await c.shutdown({ exit: false });
  assert.deepEqual(order, ['first', 'last']);
});

test('isShuttingDown flips to true once shutdown begins', async () => {
  const c = newCoordinator();
  let observed = false;
  c.register({ name: 'check', fn: () => { observed = c.isShuttingDown(); } });
  assert.equal(c.isShuttingDown(), false);
  await c.shutdown({ exit: false });
  assert.equal(observed, true);
  assert.equal(c.isShuttingDown(), true);
});

test('shutdown is re-entry safe — second call returns immediately', async () => {
  const c = newCoordinator();
  let runs = 0;
  c.register({ name: 'once', fn: () => { runs++; } });
  await c.shutdown({ exit: false });
  await c.shutdown({ exit: false }); // re-entry
  assert.equal(runs, 1);
});

test('drain waits while in-flight counters report > 0', async () => {
  const c = newCoordinator(2000);
  let pending = 3;
  c.registerInFlightCounter(() => pending);

  // Drain pending → 0 over 300ms while shutdown runs.
  const drainPromise = c.shutdown({ exit: false });
  setTimeout(() => { pending = 1; }, 80);
  setTimeout(() => { pending = 0; }, 200);
  const start = Date.now();
  await drainPromise;
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 180, `expected drain to wait ≥ 180ms, got ${elapsed}ms`);
  assert.ok(elapsed < 1500, `expected drain to finish well before timeout, got ${elapsed}ms`);
});

test('drain times out and proceeds to hooks anyway', async () => {
  const c = newCoordinator(150); // tight drain timeout
  c.registerInFlightCounter(() => 5); // never drains
  let hookRan = false;
  c.register({ name: 'cleanup', fn: () => { hookRan = true; } });
  await c.shutdown({ exit: false });
  assert.equal(hookRan, true, 'hooks must run even when drain times out');
});

test('hook timeout abandons one slow hook without blocking others', async () => {
  const c = newCoordinator();
  let lateRan = false;
  c.register({
    name: 'slow',
    timeoutMs: 50,
    fn: () => new Promise(resolve => setTimeout(resolve, 1000)),
  });
  c.register({ name: 'late', fn: () => { lateRan = true; } });
  const start = Date.now();
  await c.shutdown({ exit: false });
  const elapsed = Date.now() - start;
  assert.equal(lateRan, true);
  assert.ok(elapsed < 500, `expected hooks to abandon the slow one quickly, got ${elapsed}ms`);
});

test('multiple counters are summed', async () => {
  const c = newCoordinator(300);
  let a = 2, b = 3;
  c.registerInFlightCounter(() => a);
  c.registerInFlightCounter(() => b);
  setTimeout(() => { a = 0; b = 0; }, 100);
  const start = Date.now();
  await c.shutdown({ exit: false });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 80 && elapsed < 280, `should drain at ~100ms, got ${elapsed}`);
});

test('counter that throws is treated as 0', async () => {
  const c = newCoordinator(150);
  c.registerInFlightCounter(() => { throw new Error('counter broken'); });
  const start = Date.now();
  await c.shutdown({ exit: false });
  const elapsed = Date.now() - start;
  // Drain returns immediately because the only counter "throws → ignored".
  assert.ok(elapsed < 100, `expected immediate drain, got ${elapsed}`);
});

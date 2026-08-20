import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreakerRegistry } from './CircuitBreaker.js';

test('starts CLOSED, allows calls, no failures', () => {
  const r = new CircuitBreakerRegistry();
  assert.deepEqual(r.canRun('s'), { allowed: true });
  assert.equal(r.getState('s').state, 'CLOSED');
  assert.equal(r.getState('s').consecutiveFailures, 0);
});

test('opens after failureThreshold consecutive failures', () => {
  const r = new CircuitBreakerRegistry({ failureThreshold: 3 });
  for (let i = 0; i < 3; i++) r.recordFailure('s');
  const v = r.canRun('s') as any;
  assert.equal(v.allowed, false);
  assert.match(v.reason, /open for skill "s"/);
  assert.match(v.reason, /last 3 call\(s\) failed/);
  assert.match(v.reason, /retry after \d+s/);
  assert.equal(r.getState('s').state, 'OPEN');
});

test('a single success resets the failure counter while still CLOSED', () => {
  const r = new CircuitBreakerRegistry({ failureThreshold: 3 });
  r.recordFailure('s');
  r.recordFailure('s');
  r.recordSuccess('s'); // resets
  assert.equal(r.getState('s').consecutiveFailures, 0);
  assert.equal(r.getState('s').state, 'CLOSED');

  // …and now we need 3 fresh failures to trip again.
  r.recordFailure('s');
  r.recordFailure('s');
  assert.equal(r.canRun('s').allowed, true);
  r.recordFailure('s');
  assert.equal(r.getState('s').state, 'OPEN');
});

test('OPEN → HALF_OPEN after resetTimeMs elapses', () => {
  let now = 1_000_000;
  const r = new CircuitBreakerRegistry({ failureThreshold: 2, resetTimeMs: 5000 }, () => now);
  r.recordFailure('s');
  r.recordFailure('s');
  assert.equal(r.canRun('s').allowed, false);
  // Advance the clock past resetTimeMs.
  now += 5001;
  const v = r.canRun('s');
  assert.equal(v.allowed, true);
  assert.equal(r.getState('s').state, 'HALF_OPEN');
});

test('observing an idle OPEN breaker advances an elapsed cooldown without closing it', () => {
  let now = 1_000_000;
  const r = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeMs: 1000 }, () => now);
  r.recordFailure('idle');
  assert.equal(r.getState('idle').state, 'OPEN');

  now += 1001;
  const ready = r.getState('idle');
  assert.equal(ready.state, 'HALF_OPEN');
  assert.equal(ready.consecutiveFailures, 1);
  assert.equal(ready.halfOpenInFlight, 0);

  assert.deepEqual(r.canRun('idle'), { allowed: true });
  assert.equal(r.getState('idle').halfOpenInFlight, 1);
  r.recordSuccess('idle');
  assert.equal(r.getState('idle').state, 'CLOSED');
});

test('listActive refreshes cooldown state for idle breakers', () => {
  let now = 1_000_000;
  const r = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeMs: 1000 }, () => now);
  r.recordFailure('idle');
  now += 1001;
  assert.equal(r.listActive()[0].state, 'HALF_OPEN');
});

test('HALF_OPEN allows up to halfOpenMaxAttempts probe calls, blocks the rest', () => {
  let now = 1_000_000;
  const r = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeMs: 1000, halfOpenMaxAttempts: 2 }, () => now);
  r.recordFailure('s');
  now += 1001;

  const a = r.canRun('s');
  const b = r.canRun('s');
  const c = r.canRun('s');
  assert.equal(a.allowed, true);
  assert.equal(b.allowed, true);
  assert.equal(c.allowed, false);
  assert.match((c as any).reason, /half-open/);
});

test('HALF_OPEN → CLOSED on probe success', () => {
  let now = 1_000_000;
  const r = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeMs: 1000 }, () => now);
  r.recordFailure('s');
  now += 1001;
  r.canRun('s');                  // takes us to HALF_OPEN
  r.recordSuccess('s');           // probe succeeded
  assert.equal(r.getState('s').state, 'CLOSED');
  assert.equal(r.getState('s').consecutiveFailures, 0);
});

test('HALF_OPEN → OPEN on probe failure (timer reset)', () => {
  let now = 1_000_000;
  const r = new CircuitBreakerRegistry({ failureThreshold: 1, resetTimeMs: 1000 }, () => now);
  r.recordFailure('s');
  now += 1001;
  r.canRun('s');                   // HALF_OPEN
  r.recordFailure('s');            // probe failed
  assert.equal(r.getState('s').state, 'OPEN');
  // openedAt should now be `now`, not the original failure time
  assert.equal(r.getState('s').openedAt, new Date(now).toISOString());
  // Still blocked, fresh timer.
  assert.equal(r.canRun('s').allowed, false);
});

test('reset() returns a tripped breaker to CLOSED with no history', () => {
  const r = new CircuitBreakerRegistry({ failureThreshold: 1 });
  r.recordFailure('s');
  assert.equal(r.canRun('s').allowed, false);
  r.reset('s');
  assert.equal(r.getState('s').state, 'CLOSED');
  assert.equal(r.getState('s').consecutiveFailures, 0);
  assert.equal(r.canRun('s').allowed, true);
});

test('listActive returns only breakers that have any non-default state', () => {
  const r = new CircuitBreakerRegistry({ failureThreshold: 2 });
  r.recordFailure('a');
  // touch `b` but with success
  r.recordSuccess('b');
  // `c` never touched
  const active = r.listActive();
  // a has 1 failure (counted) → listed
  // b has 0 failures + closed → not listed
  // c not seeded → not listed
  assert.equal(active.length, 1);
  assert.equal(active[0].skillId, 'a');
  assert.equal(active[0].consecutiveFailures, 1);
});

test('breakers are independent per skillId', () => {
  const r = new CircuitBreakerRegistry({ failureThreshold: 1 });
  r.recordFailure('a');
  assert.equal(r.canRun('a').allowed, false);
  assert.equal(r.canRun('b').allowed, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProxyGuard, AIProxyBreakerOpenError } from './AIProxyGuard.js';

function flaky(failsLeft: { n: number }, status = 500) {
  return async () => {
    if (failsLeft.n > 0) {
      failsLeft.n -= 1;
      const err: any = new Error('upstream error');
      err.status = status;
      throw err;
    }
    return 'ok';
  };
}

test('AIProxyGuard: retries transient 500s up to maxRetries', async () => {
  const g = new AIProxyGuard({ maxRetries: 3, baseDelayMs: 10 });
  const counter = { n: 2 }; // succeed on 3rd attempt
  const got = await g.run('test', flaky(counter));
  assert.equal(got, 'ok');
  assert.equal(counter.n, 0, 'all retry tokens consumed before success');
  assert.equal(g.snapshot().state, 'CLOSED');
});

test('AIProxyGuard: surrenders after maxRetries + 1 attempts', async () => {
  const g = new AIProxyGuard({ maxRetries: 2, baseDelayMs: 10, failureThreshold: 99 });
  const counter = { n: 99 };
  await assert.rejects(
    () => g.run('test', flaky(counter)),
    /upstream error/,
  );
  // 1 initial + 2 retries = 3 attempts
  assert.equal(99 - counter.n, 3);
});

test('AIProxyGuard: 4xx (non-429, non-408) is NOT retried', async () => {
  const g = new AIProxyGuard({ maxRetries: 3, baseDelayMs: 10 });
  let attempts = 0;
  await assert.rejects(
    () => g.run('test', async () => {
      attempts++;
      const err: any = new Error('bad request');
      err.status = 400;
      throw err;
    }),
    /bad request/,
  );
  assert.equal(attempts, 1, 'no retry on 400');
});

test('AIProxyGuard: 429 retries, then 408 retries', async () => {
  const g = new AIProxyGuard({ maxRetries: 3, baseDelayMs: 5 });
  let attempts = 0;
  const got = await g.run('test', async () => {
    attempts++;
    if (attempts === 1) { const e: any = new Error('rate limited'); e.status = 429; throw e; }
    if (attempts === 2) { const e: any = new Error('timeout');      e.status = 408; throw e; }
    return 'ok';
  });
  assert.equal(got, 'ok');
  assert.equal(attempts, 3);
});

test('AIProxyGuard: opens after consecutive failures, short-circuits with AIProxyBreakerOpenError', async () => {
  const g = new AIProxyGuard({ failureThreshold: 2, maxRetries: 0, openMs: 60_000 });
  const counter = { n: 99 };
  await assert.rejects(() => g.run('test', flaky(counter)));
  assert.equal(g.snapshot().state, 'CLOSED', 'one failure should not open');
  await assert.rejects(() => g.run('test', flaky(counter)));
  assert.equal(g.snapshot().state, 'OPEN', 'second failure trips the breaker');
  // Now subsequent calls short-circuit WITHOUT invoking fn.
  let invoked = 0;
  await assert.rejects(
    () => g.run('test', async () => { invoked++; return 'ok'; }),
    (err: unknown) => err instanceof AIProxyBreakerOpenError,
  );
  assert.equal(invoked, 0, 'open breaker must not invoke fn');
});

test('AIProxyGuard: HALF_OPEN probe success closes the breaker', async () => {
  const g = new AIProxyGuard({ failureThreshold: 1, maxRetries: 0, openMs: 50 });
  // Trip the breaker.
  await assert.rejects(() => g.run('t', async () => { const e: any = new Error('x'); e.status = 500; throw e; }));
  assert.equal(g.snapshot().state, 'OPEN');
  // Wait past cool-off.
  await new Promise(r => setTimeout(r, 80));
  const out = await g.run('t', async () => 'recovered');
  assert.equal(out, 'recovered');
  assert.equal(g.snapshot().state, 'CLOSED');
});

test('AIProxyGuard: HALF_OPEN probe failure re-opens the breaker immediately', async () => {
  const g = new AIProxyGuard({ failureThreshold: 1, maxRetries: 0, openMs: 50 });
  await assert.rejects(() => g.run('t', async () => { const e: any = new Error('x'); e.status = 500; throw e; }));
  await new Promise(r => setTimeout(r, 80));
  await assert.rejects(() => g.run('t', async () => { const e: any = new Error('y'); e.status = 500; throw e; }));
  assert.equal(g.snapshot().state, 'OPEN', 'half-open probe failure should re-open');
  // resetMs should be near-fresh openMs.
  const snap = g.snapshot();
  assert.ok(snap.resetMs > 40 && snap.resetMs <= 50, `expected fresh resetMs, got ${snap.resetMs}`);
});

test('AIProxyGuard: runWithFallback uses the fallback when breaker is open', async () => {
  const g = new AIProxyGuard({ failureThreshold: 1, maxRetries: 0, openMs: 60_000 });
  await assert.rejects(() => g.run('t', async () => { const e: any = new Error('x'); e.status = 500; throw e; }));
  const out = await g.runWithFallback('t', async () => 'live', () => 'canned');
  assert.equal(out, 'canned');
});

test('AIProxyGuard: onStateChange fires on transitions', async () => {
  const events: Array<{ state: string; reason: string }> = [];
  const g = new AIProxyGuard({
    failureThreshold: 1, maxRetries: 0, openMs: 30, onStateChange: (s, r) => events.push({ state: s, reason: r }),
  });
  await assert.rejects(() => g.run('t', async () => { const e: any = new Error('x'); e.status = 500; throw e; }));
  await new Promise(r => setTimeout(r, 60));
  await g.run('t', async () => 'ok');
  // Expect: CLOSED -> OPEN, OPEN -> HALF_OPEN, HALF_OPEN -> CLOSED
  assert.deepEqual(events.map(e => e.state), ['OPEN', 'HALF_OPEN', 'CLOSED']);
});

test('AIProxyGuard: network-style errors (fetch failed) are retried', async () => {
  const g = new AIProxyGuard({ maxRetries: 2, baseDelayMs: 5 });
  let attempts = 0;
  const got = await g.run('t', async () => {
    attempts++;
    if (attempts < 3) throw new TypeError('fetch failed');
    return 'ok';
  });
  assert.equal(got, 'ok');
  assert.equal(attempts, 3);
});

test('AIProxyGuard: operator reset closes an open breaker', async () => {
  const g = new AIProxyGuard({ failureThreshold: 1, maxRetries: 0 });
  await assert.rejects(() => g.run('t', async () => { throw new Error('failed'); }));
  assert.equal(g.snapshot().state, 'OPEN');
  g.reset();
  assert.equal(g.snapshot().state, 'CLOSED');
  assert.equal(g.snapshot().failureCount, 0);
});

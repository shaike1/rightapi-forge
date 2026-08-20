import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, wrapWithRateLimit, DEFAULT_RATE_LIMIT } from './RateLimiter.js';
import type { AIProvider, ChatParams, AIResponse } from './base.js';

const fast = (n: number) => new Promise<void>(r => setTimeout(r, n));

test('acquire fast-path returns immediately when under cap', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 3, perPlatform: { test: 3 } });
  const pending = lim.acquire('test');
  assert.equal(lim.stats().perPlatform.test.inFlight, 1, 'fast path acquires synchronously without queueing');
  assert.equal(lim.stats().perPlatform.test.queued, 0);
  const release = await pending;
  release();
  assert.equal(lim.stats().perPlatform.test.inFlight, 0);
});

test('acquire queues the (cap+1)-th caller until a slot frees', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { x: 1 } });
  const r1 = await lim.acquire('x');
  // Second request enqueues.
  const startedAt = Date.now();
  const p2 = lim.acquire('x');
  await fast(20);
  assert.equal(lim.stats().perPlatform.x.queued, 1, 'second caller is queued');
  // Release first → queued one acquires.
  r1();
  const r2 = await p2;
  assert.ok(Date.now() - startedAt >= 20);
  r2();
});

test('queue is FIFO', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { x: 1 } });
  const r1 = await lim.acquire('x');
  const order: number[] = [];
  const p2 = lim.acquire('x').then(rel => { order.push(2); rel(); });
  const p3 = lim.acquire('x').then(rel => { order.push(3); rel(); });
  const p4 = lim.acquire('x').then(rel => { order.push(4); rel(); });
  await fast(10);
  r1();
  await Promise.all([p2, p3, p4]);
  assert.deepEqual(order, [2, 3, 4]);
});

test('per-platform isolation: claude saturated does not block openai', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 5, perPlatform: { claude: 1, openai: 1 } });
  const claude1 = await lim.acquire('claude');
  // claude is full
  const openaiPending = lim.acquire('openai');
  assert.equal(lim.stats().perPlatform.openai.inFlight, 1, 'openai acquires independently');
  assert.equal(lim.stats().perPlatform.openai.queued, 0);
  const openai1 = await openaiPending;
  claude1();
  openai1();
});

test('queued caller times out with a clear error mentioning platform + cap', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { slow: 1 }, acquireTimeoutMs: 60 });
  const held = await lim.acquire('slow');
  await assert.rejects(
    () => lim.acquire('slow'),
    (err: Error) => /timeout/i.test(err.message) && /slow/.test(err.message) && /cap=1/.test(err.message)
  );
  held();
});

test('a timed-out queue entry frees its slot for later callers', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { p: 1 }, acquireTimeoutMs: 40 });
  const held = await lim.acquire('p');
  // Two callers queue; both will time out.
  const failures = await Promise.allSettled([lim.acquire('p'), lim.acquire('p')]);
  assert.equal(failures.filter(f => f.status === 'rejected').length, 2);
  assert.equal(lim.stats().perPlatform.p.queued, 0);
  held();
  // Now a fresh acquire works immediately.
  const fresh = await lim.acquire('p');
  fresh();
});

test('release() is idempotent (double-release does not over-decrement)', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 2, perPlatform: { y: 2 } });
  const r1 = await lim.acquire('y');
  const r2 = await lim.acquire('y');
  r1(); r1(); r2(); r2();
  assert.equal(lim.stats().perPlatform.y.inFlight, 0);
});

test('setCap raises the limit and drains the queue', async () => {
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { z: 1 } });
  const r1 = await lim.acquire('z');
  const queued = lim.acquire('z');
  await fast(10);
  assert.equal(lim.stats().perPlatform.z.queued, 1);
  // Bump cap → the queued waiter is admitted without releasing r1.
  lim.setCap('z', 2);
  const r2 = await queued;
  assert.equal(lim.stats().perPlatform.z.inFlight, 2);
  r1(); r2();
});

test('setCap rejects values < 1', () => {
  const lim = new RateLimiter();
  assert.throws(() => lim.setCap('test', 0), /≥ 1/);
});

test('default config caps Claude at 5 and OpenAI at 10', () => {
  assert.equal(DEFAULT_RATE_LIMIT.perPlatform!.claude, 5);
  assert.equal(DEFAULT_RATE_LIMIT.perPlatform!.openai, 10);
});

// ─── wrapWithRateLimit ────────────────────────────────────────────────────

function fakeProvider(): { provider: AIProvider; calls: { chat: number; stream: number } } {
  const calls = { chat: 0, stream: 0 };
  const provider: AIProvider = {
    name: 'fake',
    initialize: async () => {},
    isAvailable: () => true,
    chat: async (_p: ChatParams): Promise<AIResponse> => {
      calls.chat++;
      await fast(20);
      return { content: 'ok', model: 'fake' };
    },
    streamChat: async (_p, _onChunk): Promise<AIResponse> => {
      calls.stream++;
      await fast(20);
      return { content: 'streamed', model: 'fake' };
    },
  };
  return { provider, calls };
}

test('wrapWithRateLimit forwards calls and counts in-flight', async () => {
  const { provider, calls } = fakeProvider();
  const lim = new RateLimiter({ defaultMaxConcurrent: 2, perPlatform: { fake: 2 } });
  const wrapped = wrapWithRateLimit(provider, lim, 'fake');

  const out = await wrapped.chat({ messages: [{ role: 'user', content: 'hi' }] } as any);
  assert.equal(out.content, 'ok');
  assert.equal(calls.chat, 1);
  // After the call returns, no in-flight slots remain.
  assert.equal(lim.stats().perPlatform.fake?.inFlight ?? 0, 0);
});

test('wrapWithRateLimit serialises calls past the cap', async () => {
  const { provider } = fakeProvider();
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { fake: 1 } });
  const wrapped = wrapWithRateLimit(provider, lim, 'fake');

  const t0 = Date.now();
  await Promise.all([
    wrapped.chat({ messages: [] } as any),
    wrapped.chat({ messages: [] } as any),
  ]);
  // Each call sleeps 20ms; with cap=1 they must serialise ⇒ ≥ ~40ms total.
  assert.ok(Date.now() - t0 >= 35);
});

test('wrapWithRateLimit releases the slot when the inner call throws', async () => {
  const failing: AIProvider = {
    name: 'fail',
    initialize: async () => {},
    isAvailable: () => true,
    chat: async () => { throw new Error('upstream 500'); },
    streamChat: async () => { throw new Error('upstream 500'); },
  };
  const lim = new RateLimiter({ defaultMaxConcurrent: 1, perPlatform: { fail: 1 } });
  const wrapped = wrapWithRateLimit(failing, lim, 'fail');

  await assert.rejects(() => wrapped.chat({ messages: [] } as any), /upstream 500/);
  // Slot was released — a fresh acquire is immediate.
  assert.equal(lim.stats().perPlatform.fail?.inFlight ?? 0, 0);
  const r = await lim.acquire('fail');
  r();
});

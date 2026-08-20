import test from 'node:test';
import assert from 'node:assert/strict';
import { aiRateLimitKey, WsMessageRateLimiter } from './securityMiddleware.js';

test('HTTP limiter groups IPv6 addresses by subnet', () => {
  const request = (ip: string) => ({ ip, header: () => undefined });
  assert.equal(
    aiRateLimitKey(request('2001:db8:1234:5678::1')),
    aiRateLimitKey(request('2001:db8:1234:56ff::2')),
  );
  assert.notEqual(
    aiRateLimitKey(request('2001:db8:1234:5600::1')),
    aiRateLimitKey(request('2001:db8:1234:5700::1')),
  );
});

test('WS rate limiter: allows up to burst, denies the next', () => {
  const l = new WsMessageRateLimiter({ burst: 3, windowMs: 60_000 });
  const client = {};
  for (let i = 0; i < 3; i++) {
    const r = l.check(client);
    assert.equal(r.allowed, true, `burst slot ${i + 1} should allow`);
  }
  const r = l.check(client);
  assert.equal(r.allowed, false);
  assert.equal(r.rejections, 1);
  assert.ok(r.resetMs > 0);
});

test('WS rate limiter: independent buckets per client', () => {
  const l = new WsMessageRateLimiter({ burst: 2 });
  const a = {};
  const b = {};
  assert.equal(l.check(a).allowed, true);
  assert.equal(l.check(a).allowed, true);
  assert.equal(l.check(a).allowed, false, 'A exhausted');
  // B is still fresh.
  assert.equal(l.check(b).allowed, true);
  assert.equal(l.check(b).allowed, true);
  assert.equal(l.check(b).allowed, false);
});

test('WS rate limiter: refills linearly over the window', async () => {
  // Window is 1s, burst is 4 → 1 token / 250ms. Wait 400ms so a >=1
  // token refill is guaranteed even with Windows' coarse Date.now()
  // granularity (~16ms).
  const l = new WsMessageRateLimiter({ burst: 4, windowMs: 1000 });
  const c = {};
  for (let i = 0; i < 4; i++) l.check(c);
  assert.equal(l.check(c).allowed, false);
  await new Promise(r => setTimeout(r, 400));
  const r = l.check(c);
  assert.equal(r.allowed, true, `refill should grant at least one token after 400ms of a 1000ms window — got remaining=${r.remaining}, resetMs=${r.resetMs}`);
});

test('WS rate limiter: rejection counter survives across denied calls', () => {
  const l = new WsMessageRateLimiter({ burst: 1, windowMs: 60_000 });
  const c = {};
  l.check(c); // allowed
  const r1 = l.check(c);
  const r2 = l.check(c);
  const r3 = l.check(c);
  assert.equal(r1.allowed, false); assert.equal(r1.rejections, 1);
  assert.equal(r2.rejections, 2);
  assert.equal(r3.rejections, 3);
});

test('WS rate limiter: resetMs is 0 when tokens are available', () => {
  const l = new WsMessageRateLimiter({ burst: 5, windowMs: 60_000 });
  const r = l.check({});
  assert.equal(r.allowed, true);
  assert.equal(r.resetMs, 0);
});

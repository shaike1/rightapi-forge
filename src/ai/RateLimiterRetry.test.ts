import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, wrapWithRateLimit, withRetry, isRetryableError, backoffDelay, DEFAULT_RETRY } from './RateLimiter.js';
import type { AIProvider, ChatParams, AIResponse } from './base.js';

function ok(): AIResponse {
  return { content: 'ok', model: 'test', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
}

test('withRetry: retries a 502 once then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('HTTP 502 gateway');
    return 'fine';
  }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
  assert.equal(result, 'fine');
  assert.equal(calls, 2);
});

test('withRetry: does not retry a 400 (non-retryable)', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('HTTP 400 invalid_request');
    }, DEFAULT_RETRY),
    /400/,
  );
  assert.equal(calls, 1);
});

test('withRetry: exhausts attempts then rethrows last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('HTTP 503 service unavailable');
    }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 }),
    /503/,
  );
  assert.equal(calls, 2);
});

test('isRetryableError: recognizes transient patterns', () => {
  assert.equal(isRetryableError(new Error('Connection error.')), true);
  assert.equal(isRetryableError(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(isRetryableError(new Error('HTTP 500 Internal Server Error')), true);
  assert.equal(isRetryableError(new Error('overloaded')), true);
  assert.equal(isRetryableError(new Error('HTTP 400 invalid_request')), false);
  assert.equal(isRetryableError(new Error('Invalid API key')), false);
});

test('backoffDelay: grows exponentially and caps at maxDelayMs', () => {
  const a = backoffDelay(0, { baseDelayMs: 100, maxDelayMs: 5000 });
  const b = backoffDelay(3, { baseDelayMs: 100, maxDelayMs: 5000 });
  const c = backoffDelay(10, { baseDelayMs: 100, maxDelayMs: 5000 });
  assert.ok(a <= 125 && a >= 75, `attempt 0 ~100±25, got ${a}`);
  assert.ok(b <= 1000 && b >= 600, `attempt 3 ~800±200, got ${b}`);
  assert.ok(c <= 6250 && c >= 3750, `attempt 10 capped ~5000, got ${c}`);
});

test('wrapWithRateLimit: transparently retries transient provider failures', async () => {
  let calls = 0;
  const inner: AIProvider = {
    name: 'fake',
    initialize: async () => {},
    isAvailable: () => true,
    chat: async (_p: ChatParams) => {
      calls++;
      if (calls === 1) throw new Error('HTTP 502 gateway');
      return ok();
    },
    streamChat: async (_p: ChatParams, _onChunk) => ok(),
  };
  const limiter = new RateLimiter({});
  const wrapped = wrapWithRateLimit(inner, limiter, 'fake', { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
  const res = await wrapped.chat({ messages: [{ role: 'user', content: 'hi' }] } as ChatParams);
  assert.equal(res.content, 'ok');
  assert.equal(calls, 2);
  // Limiter slot released after success.
  assert.equal(limiter.stats().perPlatform['fake']?.inFlight, 0);
});

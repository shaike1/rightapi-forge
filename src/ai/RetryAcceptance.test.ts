import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, isRetryableError } from './RateLimiter.js';

test('Acceptance: transient 502/429 failures retry and succeed without losing the call', async () => {
  let calls = 0;
  
  // Simulate Anthropic API returning 502 then 429, then recovering
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('HTTP 502 Bad Gateway (Anthropic API)');
    if (calls === 2) throw new Error('HTTP 429 Too Many Requests (rate limit)');
    return 'success';
  }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
  
  assert.equal(result, 'success', 'Third attempt succeeded');
  assert.equal(calls, 3, 'Exactly 3 attempts (2 failures + 1 success)');
});

test('Acceptance: non-retryable 400/invalid_request errors fail fast on first try', async () => {
  let calls = 0;
  
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('HTTP 400 invalid_request_error: bad model name');
    }),
    /400/,
  );
  
  assert.equal(calls, 1, 'No retries for non-transient errors');
});

test('Acceptance: retryable detection matches expected Anthropic failure modes', () => {
  // Transient failures that SHOULD retry
  assert.equal(isRetryableError('HTTP 502 gateway'), true);
  assert.equal(isRetryableError('HTTP 429 rate_limit_error'), true);
  assert.equal(isRetryableError('HTTP 503 overloaded'), true);
  assert.equal(isRetryableError('Connection error.'), true);
  assert.equal(isRetryableError('socket hang up'), true);
  
  // Non-transient failures that should NOT retry
  assert.equal(isRetryableError('HTTP 400 invalid_request'), false);
  assert.equal(isRetryableError('authentication_error: invalid API key'), false);
});

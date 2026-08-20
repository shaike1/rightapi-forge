import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderHealthMonitor } from './ProviderHealthMonitor.js';
import type { OpenAIRouteHealth } from './openai.js';

function route(name: 'primary' | 'fallback', patch: Partial<OpenAIRouteHealth> = {}): OpenAIRouteHealth {
  return {
    route: name, configured: true, baseURL: 'http://router/v1', model: name === 'primary' ? 'gpt-5.6-sol' : 'best-chat',
    expectedModel: name === 'primary' ? 'gpt-5.6-sol' : 'best-chat', modelAligned: true,
    breaker: { state: 'CLOSED', failureCount: 0, openedAt: 0, resetMs: 0 },
    attempts: 1, successes: 1, failures: 0, errorRate: 0, averageLatencyMs: 100,
    p95LatencyMs: 100, lastLatencyMs: 100, lastAttemptAt: '2026-01-01T00:00:00.000Z',
    lastSuccessAt: '2026-01-01T00:00:00.000Z', lastFailureAt: null, lastError: null,
    lastResponseModel: 'gpt-5.6-sol', latencyBudgetMs: 1000, errorRateBudget: 0.2, budgetExceeded: false,
    ...patch,
  };
}

test('primary failure exposes controlled fallback and recovery clears the alert', () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const monitor = new ProviderHealthMonitor(undefined, () => now);
  const failed = route('primary', {
    successes: 0, failures: 1, errorRate: 1, lastSuccessAt: null, lastError: '401 invalid key',
    breaker: { state: 'OPEN', failureCount: 3, openedAt: 1, resetMs: 1000 }, budgetExceeded: true,
  });
  const degraded = monitor.evaluate([failed, route('fallback')], 'fallback');
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.alert?.active, true);
  assert.match(degraded.alert?.reason || '', /controlled fallback is healthy/);

  now = new Date('2026-01-01T00:01:00.000Z');
  const recovered = monitor.evaluate([route('primary'), route('fallback')], 'primary');
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.alert?.active, false);
  assert.equal(recovered.alert?.clearedAt, now.toISOString());
});

test('route/model mismatch raises a critical unavailable alert without a fallback', () => {
  const monitor = new ProviderHealthMonitor();
  const result = monitor.evaluate([route('primary', { model: 'claude-first', modelAligned: false, lastSuccessAt: null })], null);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.alert?.severity, 'critical');
  assert.match(result.alert?.reason || '', /route\/model mismatch/);
});

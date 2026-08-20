import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HealthChecker,
  sqliteProbe,
  aiProviderProbe,
  credentialVaultProbe,
  activeTasksProbe,
  circuitBreakerProbe,
  selectAIProviderBaseUrl,
} from './healthCheck.js';

test('selectAIProviderBaseUrl follows the active provider', () => {
  assert.equal(selectAIProviderBaseUrl({
    DEFAULT_AI_PLATFORM: 'openai',
    OPENAI_BASE_URL: 'http://router/v1',
    ANTHROPIC_BASE_URL: 'http://claude',
  }), 'http://router/v1');
  assert.equal(selectAIProviderBaseUrl({
    DEFAULT_AI_PLATFORM: 'claude',
    OPENAI_BASE_URL: 'http://router/v1',
    ANTHROPIC_BASE_URL: 'http://claude',
  }), 'http://claude');
  assert.equal(selectAIProviderBaseUrl({
    DEFAULT_AI_PLATFORM: 'ollama',
    OLLAMA_BASE_URL: 'http://ollama',
  }), 'http://ollama');
});

test('all probes pass ⇒ overall healthy', async () => {
  const c = new HealthChecker();
  c.register({ name: 'a', fn: async () => ({ status: 'pass' }) });
  c.register({ name: 'b', fn: async () => ({ status: 'pass' }) });
  const r = await c.check();
  assert.equal(r.status, 'healthy');
  assert.equal(r.summary.pass, 2);
});

test('any pass + any warn ⇒ overall degraded', async () => {
  const c = new HealthChecker();
  c.register({ name: 'a', fn: async () => ({ status: 'pass' }) });
  c.register({ name: 'b', fn: async () => ({ status: 'warn' }) });
  const r = await c.check();
  assert.equal(r.status, 'degraded');
  assert.equal(r.summary.warn, 1);
});

test('non-critical fail ⇒ degraded, not unhealthy', async () => {
  const c = new HealthChecker();
  c.register({ name: 'a', critical: false, fn: async () => ({ status: 'fail', error: 'optional dep down' }) });
  c.register({ name: 'b', fn: async () => ({ status: 'pass' }) });
  const r = await c.check();
  assert.equal(r.status, 'degraded');
});

test('critical fail ⇒ unhealthy', async () => {
  const c = new HealthChecker();
  c.register({ name: 'db', critical: true, fn: async () => ({ status: 'fail', error: 'connection refused' }) });
  c.register({ name: 'b', fn: async () => ({ status: 'pass' }) });
  const r = await c.check();
  assert.equal(r.status, 'unhealthy');
  assert.equal(r.summary.fail, 1);
});

test('probe that throws is reported as fail with the error message', async () => {
  const c = new HealthChecker();
  c.register({ name: 'boom', fn: async () => { throw new Error('boom'); } });
  const r = await c.check();
  const ck = r.checks[0];
  assert.equal(ck.status, 'fail');
  assert.equal(ck.error, 'boom');
});

test('every probe is timed individually', async () => {
  const c = new HealthChecker();
  c.register({ name: 'slow', fn: async () => { await new Promise(r => setTimeout(r, 25)); return { status: 'pass' }; } });
  c.register({ name: 'fast', fn: async () => ({ status: 'pass' }) });
  const r = await c.check();
  assert.ok(r.checks.find(x => x.name === 'slow')!.durationMs >= 20);
  assert.ok(r.checks.find(x => x.name === 'fast')!.durationMs < 25);
});

test('sqliteProbe passes on a working prepare()', async () => {
  const c = new HealthChecker();
  c.register(sqliteProbe('tasks_db', () => ({ get: () => ({ ok: 1 }) })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
});

test('sqliteProbe fails when get() throws', async () => {
  const c = new HealthChecker();
  c.register(sqliteProbe('tasks_db', () => ({ get: () => { throw new Error('locked'); } })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'fail');
  assert.match(r.checks[0].error!, /locked/);
});

test('aiProviderProbe reports configured providers and passes', async () => {
  const c = new HealthChecker();
  c.register(aiProviderProbe({ hasAnthropic: true, hasOpenai: false, hasOllama: false }));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
  assert.deepEqual(r.checks[0].details!.configured, ['claude']);
});

test('aiProviderProbe fails when no provider is configured (degraded overall, not unhealthy)', async () => {
  const c = new HealthChecker();
  c.register(aiProviderProbe({ hasAnthropic: false, hasOpenai: false }));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'fail');
  // critical:false on this probe, so overall is degraded.
  assert.equal(r.status, 'degraded');
});

test('aiProviderProbe ping success ⇒ pass; ping failure ⇒ warn', async () => {
  const ok = new HealthChecker();
  ok.register(aiProviderProbe({ hasAnthropic: true, hasOpenai: false, pingFn: async () => true }));
  assert.equal((await ok.check()).checks[0].status, 'pass');

  const bad = new HealthChecker();
  bad.register(aiProviderProbe({ hasAnthropic: true, hasOpenai: false, pingFn: async () => false }));
  assert.equal((await bad.check()).checks[0].status, 'warn');
});

test('credentialVaultProbe: all unlocked ⇒ pass; mixed ⇒ warn; all locked ⇒ fail', async () => {
  const pass = new HealthChecker();
  pass.register(credentialVaultProbe(() => ({ unlocked: 5, locked: 0, total: 5 })));
  assert.equal((await pass.check()).checks[0].status, 'pass');

  const warn = new HealthChecker();
  warn.register(credentialVaultProbe(() => ({ unlocked: 3, locked: 2, total: 5 })));
  assert.equal((await warn.check()).checks[0].status, 'warn');

  const failC = new HealthChecker();
  failC.register(credentialVaultProbe(() => ({ unlocked: 0, locked: 5, total: 5 })));
  assert.equal((await failC.check()).checks[0].status, 'fail');
});

test('activeTasksProbe is informational and always passes', async () => {
  const c = new HealthChecker();
  c.register(activeTasksProbe(() => ({ inProgress: 4, assigned: 1, rollingBack: 0 })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
  assert.equal((r.checks[0].details as any).total, 5);
});

test('redisProbe with null client stays passing (memory bus mode)', async () => {
  const { redisProbe } = await import('./healthCheck.js');
  const c = new HealthChecker();
  c.register(redisProbe(() => null));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
  assert.equal((r.checks[0].details as any).configured, false);
});

test('redisProbe passes when ping returns PONG', async () => {
  const { redisProbe } = await import('./healthCheck.js');
  const c = new HealthChecker();
  c.register(redisProbe(() => ({ ping: async () => 'PONG', status: 'ready' })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
  assert.equal((r.checks[0].details as any).ping, 'PONG');
});

test('redisProbe fails (critical) when ping throws ⇒ overall unhealthy', async () => {
  const { redisProbe } = await import('./healthCheck.js');
  const c = new HealthChecker();
  c.register(redisProbe(() => ({ ping: async () => { throw new Error('connection lost'); } })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'fail');
  assert.match(r.checks[0].error!, /connection lost/);
  assert.equal(r.status, 'unhealthy');
});

test('postgresProbe with null pool stays passing (sqlite mode)', async () => {
  const { postgresProbe } = await import('./healthCheck.js');
  const c = new HealthChecker();
  c.register(postgresProbe(() => null));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
  assert.equal((r.checks[0].details as any).configured, false);
});

test('postgresProbe passes when SELECT 1 succeeds and surfaces pool counts', async () => {
  const { postgresProbe } = await import('./healthCheck.js');
  const c = new HealthChecker();
  c.register(postgresProbe(() => ({
    query: async () => ({ rows: [{ '?column?': 1 }] }),
    totalCount: 4, idleCount: 3, waitingCount: 0,
  })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'pass');
  assert.equal((r.checks[0].details as any).totalConnections, 4);
});

test('postgresProbe fails (critical) when SELECT 1 throws ⇒ overall unhealthy', async () => {
  const { postgresProbe } = await import('./healthCheck.js');
  const c = new HealthChecker();
  c.register(postgresProbe(() => ({
    query: async () => { throw new Error('connection refused'); },
  })));
  const r = await c.check();
  assert.equal(r.checks[0].status, 'fail');
  assert.match(r.checks[0].error!, /connection refused/);
  assert.equal(r.status, 'unhealthy');
});

test('circuitBreakerProbe warns when any breaker is OPEN, lists the names', async () => {
  const c = new HealthChecker();
  c.register(circuitBreakerProbe(() => [
    { skillId: 'web', state: 'OPEN' },
    { skillId: 'jira', state: 'CLOSED' },
    { skillId: 'fs', state: 'HALF_OPEN' },
  ]));
  const r = await c.check();
  const ck = r.checks[0];
  assert.equal(ck.status, 'warn');
  assert.deepEqual(ck.details!.open, ['web']);
  assert.deepEqual(ck.details!.halfOpen, ['fs']);
});

test('circuitBreakerProbe treats probe-ready HALF_OPEN breakers as available', async () => {
  const c = new HealthChecker();
  c.register(circuitBreakerProbe(() => [
    { skillId: 'ssh', state: 'HALF_OPEN' },
  ]));
  const r = await c.check();
  assert.equal(r.status, 'healthy');
  assert.equal(r.checks[0].status, 'pass');
  assert.deepEqual(r.checks[0].details!.halfOpen, ['ssh']);
});

test('report includes timestamp + uptimeSec + per-probe durations', async () => {
  const c = new HealthChecker();
  c.register({ name: 'x', fn: async () => ({ status: 'pass' }) });
  const r = await c.check();
  assert.match(r.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(r.uptimeSec >= 0);
  assert.ok(r.durationMs >= 0);
  assert.ok(r.checks[0].durationMs >= 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createCircuitBreakerRouter } from './circuitBreakerApi.js';
import { SkillManager } from '../skills/SkillManager.js';
import { encode, fail } from '../skills/SkillResult.js';

async function startApp(sm: SkillManager) {
  const app = express();
  app.use('/api', createCircuitBreakerRouter({ skillManager: sm }));
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

function fakeSkill(id: string, alwaysFail = true) {
  return {
    skill: {
      id, name: id, description: 'fake', category: 'monitoring' as const, enabled: true,
      commands: [{ name: `${id}.do`, description: 'fake', handler: 'run' }],
    },
    executor: { run: async () => alwaysFail ? encode(fail('integration down')) : 'ok' } as any,
  };
}

test('GET /api/skills/circuit-breakers lists tripped breakers', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 2, resetTimeMs: 60_000 } });
  const f = fakeSkill('flaky');
  sm.registerWithExecutor(f.skill, f.executor);
  await sm.execute('flaky.do');
  await sm.execute('flaky.do'); // trips breaker

  const { base, close } = await startApp(sm);
  const resp = await fetch(`${base}/api/skills/circuit-breakers`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.count, 1);
  assert.equal(body.breakers[0].skillId, 'flaky');
  assert.equal(body.breakers[0].state, 'OPEN');
  await close();
});

test('GET /api/skills/circuit-breakers returns empty when nothing has failed', async () => {
  const sm = new SkillManager();
  const { base, close } = await startApp(sm);
  const resp = await fetch(`${base}/api/skills/circuit-breakers`);
  const body = await resp.json() as any;
  assert.equal(body.count, 0);
  assert.deepEqual(body.breakers, []);
  await close();
});

test('POST /api/skills/circuit-breakers/:skillId/reset closes a tripped breaker', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 1, resetTimeMs: 60_000 } });
  const f = fakeSkill('boom');
  sm.registerWithExecutor(f.skill, f.executor);
  await sm.execute('boom.do');
  assert.equal(sm.circuitBreakers.getState('boom').state, 'OPEN');

  const { base, close } = await startApp(sm);
  const resp = await fetch(`${base}/api/skills/circuit-breakers/boom/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.skillId, 'boom');
  assert.equal(body.state.state, 'CLOSED');
  assert.equal(body.state.consecutiveFailures, 0);
  await close();
});

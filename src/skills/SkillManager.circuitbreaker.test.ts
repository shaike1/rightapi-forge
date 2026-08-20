import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillManager } from './SkillManager.js';
import { encode, ok, fail } from './SkillResult.js';

/** Register a fake skill that returns a scripted SkillResult on every call. */
function fakeSkill(id: string, command: string, handler: (params: any) => string) {
  return {
    skill: {
      id,
      name: id,
      description: 'fake',
      category: 'monitoring' as const,
      enabled: true,
      commands: [{ name: command, description: 'fake', handler: 'run' }],
    },
    executor: { run: async (params: any) => handler(params) } as any,
  };
}

test('failing handler trips the breaker after the configured threshold', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 3, resetTimeMs: 60_000 } });
  const f = fakeSkill('flaky', 'flaky.do', () => encode(fail('integration down')));
  sm.registerWithExecutor(f.skill, f.executor);

  // Three calls fail through the handler.
  for (let i = 0; i < 3; i++) {
    const r = JSON.parse(await sm.execute('flaky.do'));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'integration down');
  }

  // 4th call should be short-circuited by the breaker.
  const blocked = JSON.parse(await sm.execute('flaky.do'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.summary, 'circuit-open');
  assert.match(blocked.error, /Circuit breaker open for skill "flaky"/);
  assert.match(blocked.error, /last 3 call\(s\) failed/);
});

test('thrown handler exception also counts as a failure', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 2, resetTimeMs: 60_000 } });
  const f = fakeSkill('boom', 'boom.do', () => { throw new Error('hard fail'); });
  sm.registerWithExecutor(f.skill, f.executor);

  // First two throw — caller sees the exception.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => sm.execute('boom.do'), /hard fail/);
  }
  // Third call gets short-circuited (no throw — SkillResult.fail).
  const blocked = JSON.parse(await sm.execute('boom.do'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.summary, 'circuit-open');
});

test('success on a call resets the failure streak', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 3, resetTimeMs: 60_000 } });
  let nextFails = true;
  const f = fakeSkill('mixed', 'mixed.do', () => nextFails ? encode(fail('nope')) : encode(ok({}, 'ok')));
  sm.registerWithExecutor(f.skill, f.executor);

  // Fail twice, then succeed → counter back to 0.
  await sm.execute('mixed.do');
  await sm.execute('mixed.do');
  nextFails = false;
  await sm.execute('mixed.do');
  // Now fail twice more — should NOT trip yet, because the streak resets.
  nextFails = true;
  await sm.execute('mixed.do');
  await sm.execute('mixed.do');
  // Third in this run finally trips the breaker.
  await sm.execute('mixed.do');
  const blocked = JSON.parse(await sm.execute('mixed.do'));
  assert.equal(blocked.summary, 'circuit-open');
});

test('non-JSON handler return is treated optimistically (legacy prose path)', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 2, resetTimeMs: 60_000 } });
  const f = fakeSkill('legacy', 'legacy.do', () => 'plain prose, not JSON');
  sm.registerWithExecutor(f.skill, f.executor);

  // Calls that return non-JSON strings should NOT count as failures.
  for (let i = 0; i < 5; i++) {
    const out = await sm.execute('legacy.do');
    assert.equal(out, 'plain prose, not JSON');
  }
  assert.equal(sm.circuitBreakers.getState('legacy').state, 'CLOSED');
});

test('manual reset re-allows traffic immediately', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 1, resetTimeMs: 60_000 } });
  const f = fakeSkill('m', 'm.do', () => encode(fail('x')));
  sm.registerWithExecutor(f.skill, f.executor);

  await sm.execute('m.do');
  let blocked = JSON.parse(await sm.execute('m.do'));
  assert.equal(blocked.summary, 'circuit-open');

  sm.resetCircuitBreaker('m');
  // After reset the next call goes through to the handler again.
  blocked = JSON.parse(await sm.execute('m.do'));
  assert.equal(blocked.error, 'x'); // back to handler-side failure, not breaker-side
});

test('listCircuitBreakers shows only skills with non-default state', async () => {
  const sm = new SkillManager({ circuitBreaker: { failureThreshold: 1, resetTimeMs: 60_000 } });
  const failing = fakeSkill('f', 'f.do', () => encode(fail('x')));
  const good = fakeSkill('g', 'g.do', () => encode(ok({}, 'ok')));
  sm.registerWithExecutor(failing.skill, failing.executor);
  sm.registerWithExecutor(good.skill, good.executor);

  await sm.execute('f.do');  // fails → opens
  await sm.execute('g.do');  // succeeds → stays closed and clean

  const active = sm.listCircuitBreakers();
  assert.equal(active.length, 1);
  assert.equal(active[0].skillId, 'f');
  assert.equal(active[0].state, 'OPEN');
});

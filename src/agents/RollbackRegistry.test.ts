import test from 'node:test';
import assert from 'node:assert/strict';
import { RollbackRegistry } from './RollbackRegistry.js';
import type { SkillManager } from '../skills/SkillManager.js';
import { encode, ok, fail } from '../skills/SkillResult.js';

/** SkillManager stub that resolves a known set of tools to a canned result. */
function stubSkillManager(handlers: Record<string, (params: any) => string>): SkillManager {
  return {
    execute: async (commandName: string, params?: any) => {
      const h = handlers[commandName];
      if (!h) throw new Error(`unknown tool ${commandName}`);
      return h(params || {});
    },
  } as unknown as SkillManager;
}

const baseEntry = {
  agentId: 'alice',
  taskId: 't-1',
  action: 'wrote /tmp/foo',
  rollback: { kind: 'tool' as const, tool: 'file.delete', params: { path: '/tmp/foo' } },
  skill: 'files',
};

test('register assigns ids and timestamps; list returns most-recent last', () => {
  const reg = new RollbackRegistry();
  const id1 = reg.register(baseEntry);
  const id2 = reg.register({ ...baseEntry, action: 'wrote /tmp/bar' });
  assert.notEqual(id1, id2);
  const list = reg.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, id1);
  assert.equal(list[0].executed, false);
  assert.ok(list[0].timestamp);
});

test('list filters by taskId / agentId / skill / executed', () => {
  const reg = new RollbackRegistry();
  reg.register(baseEntry);
  reg.register({ ...baseEntry, taskId: 't-2' });
  reg.register({ ...baseEntry, agentId: 'bob', skill: 'bash' });

  assert.equal(reg.list({ taskId: 't-1' }).length, 2);
  assert.equal(reg.list({ taskId: 't-2' }).length, 1);
  assert.equal(reg.list({ skill: 'bash' }).length, 1);
  assert.equal(reg.list({ agentId: 'alice' }).length, 2);
  assert.equal(reg.list({ executed: false }).length, 3);
});

test('executeAction marks the entry executed and stores the result', async () => {
  const reg = new RollbackRegistry();
  const id = reg.register(baseEntry);
  const sm = stubSkillManager({ 'file.delete': () => encode(ok({}, 'deleted')) });

  const out = await reg.executeAction(id, sm);
  assert.equal(out.ok, true);
  const a = reg.get(id)!;
  assert.equal(a.executed, true);
  assert.ok(a.executedAt);
  assert.match(a.executionResult!, /"summary": "deleted"/);
});

test('executeAction surfaces SkillResult-encoded failure as ok=false', async () => {
  const reg = new RollbackRegistry();
  const id = reg.register(baseEntry);
  const sm = stubSkillManager({ 'file.delete': () => encode(fail('permission denied', 'permission')) });
  const out = await reg.executeAction(id, sm);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'permission denied');
});

test('executeAction refuses to run an already-executed entry', async () => {
  const reg = new RollbackRegistry();
  const id = reg.register(baseEntry);
  const sm = stubSkillManager({ 'file.delete': () => encode(ok({}, 'ok')) });
  await reg.executeAction(id, sm);
  const second = await reg.executeAction(id, sm);
  assert.equal(second.ok, false);
  assert.match(second.error!, /already executed/);
});

test('bash-kind rollback is dispatched via bash.exec', async () => {
  const reg = new RollbackRegistry();
  let receivedCmd: string | null = null;
  const sm = stubSkillManager({
    'bash.exec': (params: any) => { receivedCmd = params.command; return encode(ok({ stdout: 'ok' }, 'ran')); }
  });
  const id = reg.register({
    ...baseEntry,
    rollback: { kind: 'bash', command: 'rm -f /tmp/foo' }
  });
  await reg.executeAction(id, sm);
  assert.equal(receivedCmd, 'rm -f /tmp/foo');
});

test('executeAll runs entries in REVERSE registration order', async () => {
  const reg = new RollbackRegistry();
  const order: string[] = [];
  const sm = stubSkillManager({
    'tool.a': () => { order.push('a'); return encode(ok({}, 'a')); },
    'tool.b': () => { order.push('b'); return encode(ok({}, 'b')); },
    'tool.c': () => { order.push('c'); return encode(ok({}, 'c')); },
  });
  reg.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.a' }, action: 'first' });
  reg.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.b' }, action: 'second' });
  reg.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.c' }, action: 'third' });

  const out = await reg.executeAll(sm);
  assert.deepEqual(order, ['c', 'b', 'a']); // LIFO
  assert.equal(out.executed, 3);
  assert.equal(out.failed, 0);
});

test('executeAll stops at the first failure unless continueOnError=true', async () => {
  const reg = new RollbackRegistry();
  let calls = 0;
  const sm = stubSkillManager({
    'tool.bad':  () => { calls++; return encode(fail('nope')); },
    'tool.good': () => { calls++; return encode(ok({}, 'fine')); },
  });
  reg.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.good' }, action: 'first' });
  reg.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.bad' },  action: 'second' });
  reg.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.good' }, action: 'third' });

  // Stop on first failure (executes from third → second; bails before first).
  let out = await reg.executeAll(sm);
  assert.equal(calls, 2);
  assert.equal(out.failed, 1);

  // Reset for continueOnError run.
  const reg2 = new RollbackRegistry();
  reg2.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.good' }, action: 'first' });
  reg2.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.bad' },  action: 'second' });
  reg2.register({ ...baseEntry, rollback: { kind: 'tool', tool: 'tool.good' }, action: 'third' });
  calls = 0;
  out = await reg2.executeAll(sm, { continueOnError: true });
  assert.equal(calls, 3);
  assert.equal(out.executed, 3);
  assert.equal(out.failed, 1);
});

test('clear() empties the registry; size + pendingCount reflect state', () => {
  const reg = new RollbackRegistry();
  reg.register(baseEntry);
  reg.register(baseEntry);
  assert.equal(reg.size(), 2);
  assert.equal(reg.pendingCount(), 2);
  reg.clear();
  assert.equal(reg.size(), 0);
  assert.equal(reg.pendingCount(), 0);
});

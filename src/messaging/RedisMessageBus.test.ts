import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisMessageBus } from './RedisMessageBus.js';

/**
 * In-memory ioredis mock that implements just the subset RedisMessageBus
 * uses: HMSET / HGETALL / HEXISTS / ZADD / ZREVRANGE / ZREMRANGEBYRANK /
 * SADD / SMEMBERS / EXISTS / PUBLISH / pipeline / quit. Mirrors the
 * pipeline().exec() return shape ([err, value][]).
 */
function makeMockRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const sortedSets = new Map<string, Map<string, number>>(); // key → member → score
  const sets = new Map<string, Set<string>>();
  const published: Array<{ channel: string; message: string }> = [];

  const api: any = {
    hmset: async (key: string, fields: Record<string, string>) => {
      const existing = hashes.get(key) ?? {};
      hashes.set(key, { ...existing, ...fields });
      return 'OK';
    },
    hgetall: async (key: string) => hashes.get(key) ?? {},
    exists: async (key: string) => (hashes.has(key) ? 1 : 0),
    zadd: async (key: string, score: number, member: string) => {
      const ss = sortedSets.get(key) ?? new Map();
      ss.set(member, score);
      sortedSets.set(key, ss);
      return 1;
    },
    zrevrange: async (key: string, start: number, stop: number) => {
      const ss = sortedSets.get(key);
      if (!ss) return [];
      const sorted = Array.from(ss.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0]);
      const end = stop === -1 ? sorted.length : stop + 1;
      return sorted.slice(start, end);
    },
    zremrangebyrank: async () => 0, // not asserted in tests
    sadd: async (key: string, member: string) => {
      const s = sets.get(key) ?? new Set();
      const before = s.size; s.add(member); sets.set(key, s);
      return s.size - before;
    },
    smembers: async (key: string) => Array.from(sets.get(key) ?? []),
    publish: async (channel: string, message: string) => {
      published.push({ channel, message });
      return 0;
    },
    ping: async () => 'PONG',
    quit: async () => 'OK',
    pipeline: () => {
      type Op = () => Promise<unknown>;
      const ops: Op[] = [];
      const builder: any = {
        hmset:           (k: string, f: Record<string, string>) => { ops.push(() => api.hmset(k, f)); return builder; },
        hgetall:         (k: string)                          => { ops.push(() => api.hgetall(k));     return builder; },
        zadd:            (k: string, s: number, m: string)    => { ops.push(() => api.zadd(k, s, m));   return builder; },
        sadd:            (k: string, m: string)               => { ops.push(() => api.sadd(k, m));     return builder; },
        publish:         (c: string, m: string)               => { ops.push(() => api.publish(c, m));  return builder; },
        zremrangebyrank: ()                                   => { ops.push(() => api.zremrangebyrank()); return builder; },
        exec: async () => {
          const results: any[] = [];
          for (const op of ops) {
            try { results.push([null, await op()]); }
            catch (e) { results.push([e, null]); }
          }
          return results;
        },
      };
      return builder;
    },
  };
  return { redis: api as any, published };
}

test('send writes a message and returns the populated record', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const out = await bus.send({ fromAgentId: 'alice', toAgentId: 'eve', content: 'hi' });
  assert.equal(out.fromAgentId, 'alice');
  assert.equal(out.content, 'hi');
  assert.equal(out.kind, 'message');
  assert.match(out.id, /^\d+-[a-z0-9]+$/);
  assert.match(out.threadId, /^thread-/);
});

test('send publishes a live event for fan-out', async () => {
  const { redis, published } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  await bus.send({ fromAgentId: 'a', toAgentId: 'b', content: 'x' });
  assert.equal(published.length, 1);
  assert.equal(published[0].channel, 'bus:live');
  const env = JSON.parse(published[0].message);
  assert.equal(env.type, 'message');
  assert.equal(env.data.content, 'x');
});

test('listMessages by threadId returns newest first', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const a = await bus.send({ fromAgentId: 'alice', toAgentId: 'eve', content: 'one' });
  // Force a 1ms gap so the second message has a strictly larger timestamp.
  await new Promise(r => setTimeout(r, 5));
  const b = await bus.send({ threadId: a.threadId, fromAgentId: 'eve', toAgentId: 'alice', content: 'two' });
  const list = await bus.listMessages({ threadId: a.threadId });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id, 'newest message should be first');
});

test('listMessages by agentId returns messages either direction', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  await bus.send({ fromAgentId: 'alice', toAgentId: 'eve', content: 'q1' });
  await bus.send({ fromAgentId: 'eve', toAgentId: 'alice', content: 'a1' });
  const list = await bus.listMessages({ agentId: 'alice' });
  assert.equal(list.length, 2);
});

test('markStatus updates the persisted record', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const m = await bus.send({ fromAgentId: 'a', toAgentId: 'b', content: 'x' });
  const updated = await bus.markStatus(m.id, 'processed');
  assert.ok(updated);
  assert.equal(updated!.status, 'processed');
});

test('markStatus on unknown id returns null', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const out = await bus.markStatus('does-not-exist', 'failed', 'oops');
  assert.equal(out, null);
});

test('delegateTask records a pending delegation and a request message', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const { id, threadId } = await bus.delegateTask({
    requesterAgentId: 'alice', requesterAgentName: 'alice',
    assigneeAgentId: 'eve',    assigneeAgentName: 'eve',
    parentTaskId: 't-42', objective: 'check firewall',
    context: 'port 443 timeouts',
  });
  assert.match(id, /^deleg-/);
  assert.match(threadId, /^thread-/);
  const recs = await bus.listDelegations();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].state, 'pending');
  assert.equal(recs[0].objective, 'check firewall');
});

test('recordDelegationResult flips the record + posts a response message', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const { id, threadId } = await bus.delegateTask({
    requesterAgentId: 'alice', assigneeAgentId: 'eve',
    requesterAgentName: 'alice', assigneeAgentName: 'eve',
    objective: 'check',
  });
  const updated = await bus.recordDelegationResult(id, {
    state: 'completed', summary: 'fixed', durationMs: 4200,
  });
  assert.ok(updated);
  assert.equal(updated!.state, 'completed');
  assert.equal(updated!.summary, 'fixed');
  assert.equal(updated!.durationMs, 4200);
  // Audit trail should now have a delegation_response in the same thread.
  const messages = await bus.listMessages({ threadId });
  const responses = messages.filter(m => m.kind === 'delegation_response');
  assert.equal(responses.length, 1);
  assert.match(responses[0].content, /eve completed in 4s/);
});

test('listDelegations filters by requester / assignee / state / limit', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const a = await bus.delegateTask({
    requesterAgentId: 'alice', assigneeAgentId: 'eve',
    requesterAgentName: 'alice', assigneeAgentName: 'eve',
    objective: '1',
  });
  await bus.delegateTask({
    requesterAgentId: 'alice', assigneeAgentId: 'bob',
    requesterAgentName: 'alice', assigneeAgentName: 'bob',
    objective: '2',
  });
  await bus.delegateTask({
    requesterAgentId: 'director', assigneeAgentId: 'eve',
    requesterAgentName: 'director', assigneeAgentName: 'eve',
    objective: '3',
  });
  await bus.recordDelegationResult(a.id, { state: 'completed', summary: 'ok' });

  assert.equal((await bus.listDelegations({ requesterAgentId: 'alice' })).length, 2);
  assert.equal((await bus.listDelegations({ assigneeAgentId: 'eve' })).length, 2);
  assert.equal((await bus.listDelegations({ state: 'completed' })).length, 1);
  assert.equal((await bus.listDelegations({ limit: 1 })).length, 1);
});

test('getDelegationStatsByAssignee aggregates totals + avg duration', async () => {
  const { redis } = makeMockRedis();
  const bus = new RedisMessageBus(redis);
  const a = await bus.delegateTask({ requesterAgentId: 'a', assigneeAgentId: 'eve', objective: '1' });
  const b = await bus.delegateTask({ requesterAgentId: 'a', assigneeAgentId: 'eve', objective: '2' });
  const c = await bus.delegateTask({ requesterAgentId: 'a', assigneeAgentId: 'eve', objective: '3' });
  await bus.recordDelegationResult(a.id, { state: 'completed', durationMs: 1000 });
  await bus.recordDelegationResult(b.id, { state: 'completed', durationMs: 3000 });
  await bus.recordDelegationResult(c.id, { state: 'rejected', durationMs: 500 });
  const stats = await bus.getDelegationStatsByAssignee();
  const eve = stats.get('eve');
  assert.ok(eve);
  assert.equal(eve!.total, 3);
  assert.equal(eve!.completed, 2);
  assert.equal(eve!.rejected, 1);
  assert.equal(eve!.avgDurationMs, 1500);
});

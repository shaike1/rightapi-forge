import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { createReflectionsRouter } from './reflectionsApi.js';
import { SqliteAgentMemoryStore, type ReflectionRecord } from '../persistence/SqliteStore.js';

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-refl-api-'));
  return path.join(dir, 'mem.db');
}

function fakeAgent(id: string, name: string, role: string) {
  return { id, name, role } as any;
}

function refl(overrides: Partial<ReflectionRecord> = {}): ReflectionRecord {
  return {
    taskId: 't-' + Math.random().toString(36).slice(2, 8),
    agentId: 'agent-1',
    selfRating: 3,
    whatWorked: ['ok'],
    whatDidntWork: ['slow'],
    lessonsLearned: ['be faster'],
    suggestedImprovements: [],
    toolEfficiency: [{ tool: 'mock.tool', useful: true, reason: 'fine' }],
    wouldDoDifferently: 'cache the lookup',
    taskTitle: 'firewall outage',
    ...overrides,
  };
}

/** Spin up a minimal Express app on a random port. Returns a teardown fn. */
async function startApp(memory: SqliteAgentMemoryStore, agentLookup: (id: string) => any) {
  const app = express();
  app.use('/api', createReflectionsRouter({
    agentMemoryStore: memory,
    getAgent: agentLookup,
  }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('GET /api/agents/:id/reflections returns stored reflections newest first', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  for (let i = 0; i < 3; i++) {
    memory.storeReflection(refl({
      agentId: 'agent-1',
      taskId: 't-' + i,
      taskTitle: 't-' + i,
      timestamp: new Date(2026, 0, i + 1).toISOString(),
    }));
  }
  const { base, close } = await startApp(memory, (id) => id === 'agent-1' ? fakeAgent('agent-1', 'alice', 'sysadmin') : undefined);

  const resp = await fetch(`${base}/api/agents/agent-1/reflections`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.agentId, 'agent-1');
  assert.equal(body.agentName, 'alice');
  assert.equal(body.count, 3);
  assert.equal(body.reflections[0].taskId, 't-2', 'newest first');

  await close();
  memory.close();
});

test('GET /api/agents/:id/reflections respects ?limit=', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  for (let i = 0; i < 5; i++) {
    memory.storeReflection(refl({ agentId: 'a', taskId: 't-' + i, timestamp: new Date(2026, 0, i + 1).toISOString() }));
  }
  const { base, close } = await startApp(memory, (id) => id === 'a' ? fakeAgent('a', 'a', 'sysadmin') : undefined);

  const resp = await fetch(`${base}/api/agents/a/reflections?limit=2`);
  const body = await resp.json() as any;
  assert.equal(body.count, 2);

  await close();
  memory.close();
});

test('GET /api/agents/:id/reflections filters by rating range', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  memory.storeReflection(refl({ agentId: 'a', selfRating: 1, taskId: 'low' }));
  memory.storeReflection(refl({ agentId: 'a', selfRating: 5, taskId: 'high' }));

  const { base, close } = await startApp(memory, () => fakeAgent('a', 'a', 'sysadmin'));

  const lowResp = await fetch(`${base}/api/agents/a/reflections?minRating=1&maxRating=2`);
  const lowBody = await lowResp.json() as any;
  assert.equal(lowBody.count, 1);
  assert.equal(lowBody.reflections[0].taskId, 'low');

  await close();
  memory.close();
});

test('GET /api/agents/:id/reflections returns 404 for unknown agent', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  const { base, close } = await startApp(memory, () => undefined);

  const resp = await fetch(`${base}/api/agents/nope/reflections`);
  assert.equal(resp.status, 404);
  const body = await resp.json() as any;
  assert.match(body.error, /not found/i);

  await close();
  memory.close();
});

test('GET /api/agents/:id/performance returns aggregated stats', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  memory.storeReflection(refl({
    agentId: 'a', selfRating: 5,
    toolEfficiency: [{ tool: 'network.dns', useful: true, reason: 'fast' }],
    whatDidntWork: ['ping retried too much'],
  }));
  memory.storeReflection(refl({
    agentId: 'a', selfRating: 2,
    toolEfficiency: [{ tool: 'network.dns', useful: true, reason: 'fast' }, { tool: 'bash.exec', useful: false, reason: 'denied' }],
    whatDidntWork: ['ping retried too much', 'sudo prompt blocked'],
  }));
  memory.storeReflection(refl({
    agentId: 'a', selfRating: 3,
    toolEfficiency: [{ tool: 'bash.exec', useful: false, reason: 'denied' }],
    whatDidntWork: ['sudo prompt blocked'],
  }));

  const { base, close } = await startApp(memory, () => fakeAgent('a', 'alice', 'sysadmin'));

  const resp = await fetch(`${base}/api/agents/a/performance`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.agentId, 'a');
  assert.equal(body.role, 'sysadmin');
  assert.equal(body.totalReflections, 3);
  assert.equal(body.averageRating, (5 + 2 + 3) / 3);
  assert.ok(body.ratingDistribution);
  assert.equal(body.mostEffectiveTools[0].tool, 'network.dns');
  assert.ok(body.commonFailurePatterns.length > 0);

  await close();
  memory.close();
});

test('GET /api/agents/:id/performance returns empty shape for agent with no reflections', async () => {
  const memory = new SqliteAgentMemoryStore(tempDb());
  const { base, close } = await startApp(memory, () => fakeAgent('a', 'alice', 'sysadmin'));

  const resp = await fetch(`${base}/api/agents/a/performance`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.totalReflections, 0);
  assert.equal(body.averageRating, 0);
  assert.equal(body.trend, 'insufficient');
  assert.equal(body.mostEffectiveTools.length, 0);

  await close();
  memory.close();
});

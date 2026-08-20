import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { createUsageRouter } from './usageApi.js';
import { UsageTracker } from '../agents/UsageTracker.js';

function fakeAgent(id: string, name = 'alice', role = 'sysadmin') {
  return { id, name, role } as any;
}

async function startApp(usageTracker: UsageTracker, lookup: (id: string) => any) {
  const app = express();
  app.use('/api', createUsageRouter({ usageTracker, getAgent: lookup }));
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('GET /api/agents/:id/usage returns today + week + budget=null when none set', async () => {
  const ut = new UsageTracker();
  ut.recordTask('a', { totalTokens: 100, toolCalls: 1, estimatedCostUsd: 0.001 });
  const { base, close } = await startApp(ut, () => fakeAgent('a'));

  const resp = await fetch(`${base}/api/agents/a/usage`);
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.agentId, 'a');
  assert.equal(body.today.totalTokens, 100);
  assert.equal(body.week.totalTokens, 100);
  assert.equal(body.budget, null);
  assert.equal(body.gate.allowed, true);
  assert.equal(body.gate.remainingTokens, null); // serialised infinity → null
  await close();
});

test('GET /api/agents/:id/usage 404s for unknown agent', async () => {
  const ut = new UsageTracker();
  const { base, close } = await startApp(ut, () => undefined);
  const resp = await fetch(`${base}/api/agents/x/usage`);
  assert.equal(resp.status, 404);
  await close();
});

test('POST /api/agents/:id/usage/budget sets the budget; gate then enforces it', async () => {
  const ut = new UsageTracker();
  const { base, close } = await startApp(ut, () => fakeAgent('a'));

  let resp = await fetch(`${base}/api/agents/a/usage/budget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dailyTokens: 1000, warnAtFraction: 0.5 }),
  });
  assert.equal(resp.status, 200);
  const set = await resp.json() as any;
  assert.equal(set.budget.dailyTokens, 1000);
  assert.equal(set.budget.warnAtFraction, 0.5);

  // Burn the budget.
  ut.recordTask('a', { totalTokens: 1000, toolCalls: 0, estimatedCostUsd: 0 });
  resp = await fetch(`${base}/api/agents/a/usage`);
  const body = await resp.json() as any;
  assert.equal(body.gate.allowed, false);
  assert.match(body.gate.reason, /daily token budget exhausted/);
  await close();
});

test('POST /api/agents/:id/usage/budget rejects missing dailyTokens', async () => {
  const ut = new UsageTracker();
  const { base, close } = await startApp(ut, () => fakeAgent('a'));
  const resp = await fetch(`${base}/api/agents/a/usage/budget`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dailyCostUsd: 0.5 }),
  });
  assert.equal(resp.status, 400);
  const body = await resp.json() as any;
  assert.match(body.error, /dailyTokens/);
  await close();
});

test('POST /api/agents/:id/usage/reset (today) clears today\'s counter', async () => {
  const ut = new UsageTracker();
  ut.recordTask('a', { totalTokens: 500, toolCalls: 5, estimatedCostUsd: 0.005 });
  const { base, close } = await startApp(ut, () => fakeAgent('a'));

  const resp = await fetch(`${base}/api/agents/a/usage/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(body.scope, 'today');
  assert.equal(body.today.totalTokens, 0);
  assert.equal(ut.getToday('a').totalTokens, 0);
  await close();
});

test('GET /api/agents/:id/usage/history returns per-day records', async () => {
  const ut = new UsageTracker();
  ut.recordTask('a', { totalTokens: 100, toolCalls: 1, estimatedCostUsd: 0.001 });
  const { base, close } = await startApp(ut, () => fakeAgent('a'));

  const resp = await fetch(`${base}/api/agents/a/usage/history`);
  const body = await resp.json() as any;
  assert.equal(body.days.length, 1);
  assert.equal(body.days[0].totalTokens, 100);
  await close();
});

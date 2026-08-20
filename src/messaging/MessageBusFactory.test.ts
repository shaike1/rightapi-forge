import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getMessageBus, resetMessageBus } from './MessageBusFactory.js';
import { AgentMessageBus } from '../agents/AgentMessageBus.js';

function tempBusPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-busfac-'));
  return path.join(dir, 'bus.json');
}

test('default provider is memory; returns AgentMessageBus instance', async () => {
  await resetMessageBus();
  const bus = await getMessageBus({ memoryPath: tempBusPath() });
  assert.ok(bus instanceof AgentMessageBus);
});

test('singleton: second getMessageBus returns the same instance', async () => {
  await resetMessageBus();
  const a = await getMessageBus({ memoryPath: tempBusPath() });
  const b = await getMessageBus({ memoryPath: tempBusPath() });
  assert.equal(a, b);
});

test('rejects unknown provider', async () => {
  await resetMessageBus();
  await assert.rejects(
    () => getMessageBus({ provider: 'kafka' as any }),
    /must be "memory" or "redis"/,
  );
});

test('redis provider without REDIS_URL falls back to memory bus', async () => {
  await resetMessageBus();
  const prev = process.env.REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    const bus = await getMessageBus({ provider: 'redis', memoryPath: tempBusPath() });
    assert.ok(bus instanceof AgentMessageBus, 'should be the memory fallback');
  } finally {
    if (prev !== undefined) process.env.REDIS_URL = prev;
  }
});

test('redis provider with unreachable URL falls back to memory bus', async () => {
  await resetMessageBus();
  // Pick a port unlikely to have anything listening; ioredis will fail to connect.
  const bus = await getMessageBus({
    provider: 'redis',
    redisUrl: 'redis://127.0.0.1:1', // port 1 = error
    connectTimeoutMs: 250,
    memoryPath: tempBusPath(),
  });
  assert.ok(bus instanceof AgentMessageBus, 'should be the memory fallback when Redis unreachable');
  await resetMessageBus(); // ensure no Redis client lingers and keeps the event loop alive
});

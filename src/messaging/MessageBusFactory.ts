// Message-bus factory.
//
//   MESSAGE_BUS=memory  (default — backward compatible; the in-process
//                        AgentMessageBus that ships with the project)
//   MESSAGE_BUS=redis   (requires REDIS_URL)
//   REDIS_URL=redis://localhost:6379
//
// If MESSAGE_BUS=redis but the connection can't be established within
// `connectTimeoutMs`, the factory falls back to the in-memory bus and
// logs a warning. Existing deployments that don't set MESSAGE_BUS keep
// using the JSON-file-backed in-memory bus untouched.
//
// Single shared Redis client per process so multiple consumers (the bus
// + any other Redis user) share one connection if added later.

import IORedis, { type Redis } from 'ioredis';
import { logger } from '../utils/logger.js';
import { AgentMessageBus } from '../agents/index.js';
import { RedisMessageBus } from './RedisMessageBus.js';
import type { MessageBus } from './MessageBus.js';

export type BusProvider = 'memory' | 'redis';

export interface MessageBusFactoryOptions {
  /** Override the env-derived provider (used by tests). */
  provider?: BusProvider;
  /** Persistence path for the in-memory bus. Ignored when provider=redis. */
  memoryPath?: string;
  /** Redis URL — overrides REDIS_URL. */
  redisUrl?: string;
  /** Connect timeout (ms). When exceeded with provider=redis, fall back
   *  to the in-memory bus and log a warning. Default 3000. */
  connectTimeoutMs?: number;
  /** Pre-built Redis client (used by tests). */
  redisClient?: Redis;
}

let cachedBus: MessageBus | null = null;
let cachedRedis: Redis | null = null;

function resolveProvider(opts?: MessageBusFactoryOptions): BusProvider {
  const explicit = (opts?.provider ?? process.env.MESSAGE_BUS ?? 'memory').toLowerCase();
  if (explicit !== 'memory' && explicit !== 'redis') {
    throw new Error(`MESSAGE_BUS must be "memory" or "redis", got "${explicit}"`);
  }
  return explicit as BusProvider;
}

/**
 * Build (or return the cached) MessageBus. With provider=redis, this is
 * async because it waits for the Redis client to connect (or times out
 * and falls back). The in-memory path is sync but always returned via a
 * Promise for a uniform interface.
 */
export async function getMessageBus(opts?: MessageBusFactoryOptions): Promise<MessageBus> {
  if (cachedBus) return cachedBus;

  const provider = resolveProvider(opts);
  if (provider === 'memory') {
    const path = opts?.memoryPath ?? process.env.AGENT_BUS_PATH ?? '/data/itops-agents/agent-bus.json';
    cachedBus = new AgentMessageBus(path);
    logger.info('[MessageBusFactory] memory backend ready', { path });
    return cachedBus;
  }

  // Redis path. Try to connect; if it fails or times out, fall back.
  const url = opts?.redisUrl ?? process.env.REDIS_URL;
  if (!url) {
    logger.warn('[MessageBusFactory] MESSAGE_BUS=redis but REDIS_URL is not set — falling back to memory bus');
    return memoryFallback(opts);
  }
  const timeoutMs = opts?.connectTimeoutMs ?? 3000;

  let client: Redis | null = null;
  try {
    client = opts?.redisClient ?? new IORedis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      // Cap retries hard so a misconfigured URL fails fast and we get to
      // fall back. With a default retry strategy ioredis keeps an internal
      // timer alive forever and prevents the process from exiting cleanly.
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });

    // Wait for the connection (or timeout).
    if (!opts?.redisClient) {
      await Promise.race([
        client.connect(),
        new Promise<void>((_, reject) => setTimeout(
          () => reject(new Error(`Redis connect timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )),
      ]);
    }
    // Smoke-ping to confirm we can talk.
    await client.ping();

    cachedRedis = client;
    cachedBus = new RedisMessageBus(client);
    logger.info('[MessageBusFactory] redis backend ready', { url: redactUrl(url) });
    return cachedBus;
  } catch (e: any) {
    logger.warn('[MessageBusFactory] redis unreachable — falling back to memory bus', {
      err: e?.message ?? String(e),
      url: redactUrl(url),
    });
    // Disconnect the failed client immediately so its retry timer + socket
    // don't keep the process alive — matters for clean test exit AND for
    // any real deployment that fails initial connect.
    if (client && !opts?.redisClient) {
      try { client.disconnect(); } catch { /* */ }
    }
    return memoryFallback(opts);
  }
}

function memoryFallback(opts?: MessageBusFactoryOptions): MessageBus {
  const path = opts?.memoryPath ?? process.env.AGENT_BUS_PATH ?? '/data/itops-agents/agent-bus.json';
  cachedBus = new AgentMessageBus(path);
  return cachedBus;
}

/** Drop the cached bus + Redis client (used by tests + GracefulShutdown). */
export async function resetMessageBus(): Promise<void> {
  if (cachedBus && typeof cachedBus.close === 'function') {
    try { await cachedBus.close(); } catch { /* */ }
  }
  if (cachedRedis) {
    try { await cachedRedis.quit(); } catch { /* */ }
  }
  cachedBus = null;
  cachedRedis = null;
}

/** Read-only handle on the active Redis client (for the health probe). */
export function getActiveRedisClient(): Redis | null {
  return cachedRedis;
}

/** Strip credentials from a redis URL before logging. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch { return '<malformed-url>'; }
}

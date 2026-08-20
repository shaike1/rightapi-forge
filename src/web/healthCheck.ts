// Deep health check — composable per-subsystem probes that aggregate into
// an overall status. Each probe is independently registered so the
// /api/health route doesn't need to know about every subsystem and tests
// can build a HealthChecker with just the probes they care about.
//
// Outcome model:
//   • Each probe returns { name, status: 'pass'|'warn'|'fail', durationMs,
//                          details?, error? }
//   • Overall status:
//       - any probe fails (and is critical) ⇒ "unhealthy"
//       - any probe fails or warns          ⇒ "degraded"
//       - all probes pass                   ⇒ "healthy"
//   • Probes flagged `critical: false` only contribute to "degraded",
//     never "unhealthy" — useful for nice-to-haves like disk space.

import fs from 'fs/promises';
import { statfs as statfsCb } from 'fs';
import { promisify } from 'util';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';
export type ProbeStatus  = 'pass' | 'warn' | 'fail';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ProbeFn {
  name: string;
  /** When fail = critical (unhealthy). When false, fail only contributes to degraded. */
  critical?: boolean;
  fn: () => Promise<{ status: ProbeStatus; details?: Record<string, unknown>; error?: string }>;
}

export interface HealthReport {
  status: HealthStatus;
  timestamp: string;
  uptimeSec: number;
  durationMs: number;
  checks: ProbeResult[];
  summary: { pass: number; warn: number; fail: number; total: number };
}

export class HealthChecker {
  private probes: ProbeFn[] = [];

  /** Register a probe. Probes run in parallel when check() is called. */
  register(probe: ProbeFn): void {
    this.probes.push(probe);
  }

  async check(): Promise<HealthReport> {
    const startedAt = Date.now();
    const checks = await Promise.all(this.probes.map(async (probe) => {
      const probeStart = Date.now();
      try {
        const out = await probe.fn();
        return {
          name: probe.name,
          status: out.status,
          durationMs: Date.now() - probeStart,
          details: out.details,
          error: out.error,
        } as ProbeResult;
      } catch (e: any) {
        return {
          name: probe.name,
          status: 'fail' as ProbeStatus,
          durationMs: Date.now() - probeStart,
          error: e?.message ?? String(e),
        };
      }
    }));

    // Overall: critical fail ⇒ unhealthy; any fail/warn ⇒ degraded.
    let overall: HealthStatus = 'healthy';
    for (let i = 0; i < this.probes.length; i++) {
      const probe = this.probes[i];
      const result = checks[i];
      if (result.status === 'fail') {
        if (probe.critical !== false) overall = 'unhealthy';
        else if (overall === 'healthy') overall = 'degraded';
      } else if (result.status === 'warn' && overall === 'healthy') {
        overall = 'degraded';
      }
    }

    const summary = {
      pass: checks.filter(c => c.status === 'pass').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
      total: checks.length,
    };

    return {
      status: overall,
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      durationMs: Date.now() - startedAt,
      checks,
      summary,
    };
  }
}

// ─── Built-in probe builders ──────────────────────────────────────────────

/**
 * SQLite database probe — runs a trivial SELECT 1 to verify the
 * connection is alive. Accepts a `prepare` function (the better-sqlite3
 * Database.prepare bound) so tests can substitute fakes.
 */
export function sqliteProbe(name: string, prepare: () => { get: (...args: any[]) => unknown }): ProbeFn {
  return {
    name,
    critical: true,
    fn: async () => {
      try {
        const stmt = prepare();
        stmt.get();
        return { status: 'pass', details: { driver: 'better-sqlite3' } };
      } catch (e: any) {
        return { status: 'fail', error: e?.message ?? String(e) };
      }
    },
  };
}

/**
 * AI-provider probe — checks whether at least one API key is configured.
 * `pingFn` lets the caller actually hit the provider's healthcheck endpoint
 * if they want; without it we only verify configuration.
 */
export function aiProviderProbe(opts: {
  hasAnthropic: boolean;
  hasOpenai: boolean;
  hasOllama?: boolean;
  pingFn?: () => Promise<boolean>;
}): ProbeFn {
  return {
    name: 'ai_providers',
    critical: false, // unconfigured AI is degraded, not unhealthy
    fn: async () => {
      const configured: string[] = [];
      if (opts.hasAnthropic) configured.push('claude');
      if (opts.hasOpenai)    configured.push('openai');
      if (opts.hasOllama)    configured.push('ollama');

      if (configured.length === 0) {
        return {
          status: 'fail',
          error: 'no AI provider configured — agents cannot think',
          details: { configured: [] },
        };
      }

      if (opts.pingFn) {
        try {
          const ok = await opts.pingFn();
          return {
            status: ok ? 'pass' : 'warn',
            details: { configured, reachable: ok },
          };
        } catch (e: any) {
          return { status: 'warn', details: { configured }, error: e?.message ?? String(e) };
        }
      }
      return { status: 'pass', details: { configured } };
    },
  };
}

/** Credential vault probe — calls a function that returns { unlocked, locked, total }. */
export function credentialVaultProbe(getStatus: () => { unlocked: number; locked: number; total: number } | null): ProbeFn {
  return {
    name: 'credential_vault',
    critical: false,
    fn: async () => {
      const s = getStatus();
      if (!s) return { status: 'warn', error: 'vault not initialised' };
      const status: ProbeStatus = s.locked === 0 ? 'pass' : (s.unlocked > 0 ? 'warn' : 'fail');
      return { status, details: s };
    },
  };
}

const statfs = promisify(statfsCb as any) as (p: string) => Promise<any>;

/** Disk-space probe — warns if free < warnPctFree, fails if < failPctFree. */
export function diskSpaceProbe(opts: { path: string; warnPctFree?: number; failPctFree?: number; critical?: boolean }): ProbeFn {
  const warnPct = opts.warnPctFree ?? 0.10;
  const failPct = opts.failPctFree ?? 0.02;
  return {
    name: 'disk_space',
    critical: opts.critical ?? false,
    fn: async () => {
      try {
        const stats = await statfs(opts.path);
        const blockSize = stats.bsize ?? 4096;
        const totalBytes = stats.blocks * blockSize;
        const freeBytes  = stats.bavail * blockSize;
        const pctFree = totalBytes > 0 ? freeBytes / totalBytes : 0;
        const status: ProbeStatus = pctFree < failPct ? 'fail' : pctFree < warnPct ? 'warn' : 'pass';
        return {
          status,
          details: {
            path: opts.path,
            freeBytes,
            totalBytes,
            pctFree: Number(pctFree.toFixed(4)),
            warnAt: warnPct,
            failAt: failPct,
          },
        };
      } catch (e: any) {
        return { status: 'warn', error: e?.message ?? String(e), details: { path: opts.path } };
      }
    },
  };
}

/** Active task count probe — purely informational; status is always pass. */
export function activeTasksProbe(getCounts: () => { inProgress: number; assigned: number; rollingBack: number }): ProbeFn {
  return {
    name: 'active_tasks',
    critical: false,
    fn: async () => {
      const c = getCounts();
      const total = c.inProgress + c.assigned + c.rollingBack;
      return { status: 'pass', details: { total, ...c } };
    },
  };
}

/**
 * PostgreSQL pool probe — runs SELECT 1 through the shared pool and
 * surfaces totalCount / idleCount / waitingCount so the dashboard can
 * spot pool exhaustion. Critical because every store call routes through
 * this pool when DB_PROVIDER=postgres. Returns "configured: false" when
 * passed null (i.e. DB_PROVIDER=sqlite) and stays passing — postgres
 * isn't required, just one of the two backends has to be working.
 */
export function postgresProbe(getPool: () => {
  query: (sql: string) => Promise<unknown>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
} | null): ProbeFn {
  return {
    name: 'postgres',
    critical: true,
    fn: async () => {
      const pool = getPool();
      if (!pool) return { status: 'pass', details: { configured: false } };
      try {
        await pool.query('SELECT 1');
        return {
          status: 'pass',
          details: {
            configured: true,
            totalConnections: pool.totalCount,
            idleConnections:  pool.idleCount,
            waitingClients:   pool.waitingCount,
          },
        };
      } catch (e: any) {
        return { status: 'fail', error: e?.message ?? String(e), details: { configured: true } };
      }
    },
  };
}

/**
 * Redis probe — runs PING through the active client. Critical when
 * MESSAGE_BUS=redis (a broken client means delegations / live events
 * stop). Passes with configured:false when getClient() returns null
 * (i.e. MESSAGE_BUS=memory) so the deep-health overall doesn't go
 * unhealthy just because Redis isn't configured.
 */
export function redisProbe(getClient: () => {
  ping: () => Promise<string>;
  status?: string;
} | null): ProbeFn {
  return {
    name: 'redis',
    critical: true,
    fn: async () => {
      const client = getClient();
      if (!client) return { status: 'pass', details: { configured: false } };
      try {
        const reply = await client.ping();
        const ok = reply === 'PONG' || reply === 'pong';
        return {
          status: ok ? 'pass' : 'warn',
          details: { configured: true, ping: reply, ioredisStatus: client.status },
        };
      } catch (e: any) {
        return { status: 'fail', error: e?.message ?? String(e), details: { configured: true } };
      }
    },
  };
}

/** Circuit breaker summary probe — warns when any breaker is OPEN. */
export function circuitBreakerProbe(listSnapshots: () => Array<{ skillId: string; state: string }>): ProbeFn {
  return {
    name: 'circuit_breakers',
    critical: false,
    fn: async () => {
      const all = listSnapshots() || [];
      const open = all.filter(b => b.state === 'OPEN').map(b => b.skillId);
      const halfOpen = all.filter(b => b.state === 'HALF_OPEN').map(b => b.skillId);
      const status: ProbeStatus = open.length > 0 ? 'warn' : 'pass';
      return { status, details: { totalTracked: all.length, open, halfOpen } };
    },
  };
}

/**
 * WebSocket connection-count probe. Always passes — purely a count for
 * dashboards. Tracked as a separate probe (rather than baked into the
 * health summary) so the metric surfaces under `/api/health/deep` and
 * /api/metrics without polluting the overall status.
 */
export function websocketProbe(getCount: () => number): ProbeFn {
  return {
    name: 'websocket_connections',
    critical: false,
    fn: async () => ({ status: 'pass', details: { active: getCount() } }),
  };
}

export function selectAIProviderBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const platform = String(env.DEFAULT_AI_PLATFORM || '').toLowerCase();
  if (platform === 'openai') return env.OPENAI_BASE_URL;
  if (platform === 'ollama') return env.OLLAMA_BASE_URL;
  if (platform === 'claude' || platform === 'anthropic') return env.ANTHROPIC_BASE_URL;
  return env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL || env.OLLAMA_BASE_URL;
}

/**
 * AI proxy reachability probe. Hits the configured provider-compatible
 * base URL (omniroute / cliproxy / direct) with a short GET to confirm
 * the endpoint answers TCP+HTTP at all. We don't issue a real /v1/
 * messages call — that costs tokens and requires a valid key. Status
 * codes 200-499 all count as "reachable" (auth errors still mean the
 * proxy is up). 5xx and network errors are warn-level by default —
 * the rest of the platform degrades when AI is down but doesn't go
 * unhealthy, so we mirror that severity here.
 *
 * Timeout defaults to 2 seconds. Set via opts.timeoutMs.
 */
export function aiProxyReachabilityProbe(opts: { baseUrl: string | undefined; timeoutMs?: number; critical?: boolean }): ProbeFn {
  const timeout = opts.timeoutMs ?? 2000;
  return {
    name: 'ai_proxy_reachable',
    critical: opts.critical ?? false,
    fn: async () => {
      if (!opts.baseUrl) {
        return { status: 'warn', details: { configured: false }, error: 'no AI provider base URL configured' };
      }
      const url = opts.baseUrl;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const startedAt = Date.now();
      try {
        // Most proxies (omniroute, cliproxy) answer the root path with
        // a 404 or 200 + JSON — both confirm the listener is alive. We
        // use GET because some proxies don't implement HEAD.
        const resp = await fetch(url, { method: 'GET', signal: ctrl.signal });
        clearTimeout(t);
        const latencyMs = Date.now() - startedAt;
        if (resp.status >= 500) {
          return { status: 'warn', details: { url, httpStatus: resp.status, latencyMs }, error: `proxy returned ${resp.status}` };
        }
        return { status: 'pass', details: { url, httpStatus: resp.status, latencyMs } };
      } catch (e: any) {
        clearTimeout(t);
        return { status: 'warn', details: { url, latencyMs: Date.now() - startedAt }, error: e?.message ?? String(e) };
      }
    },
  };
}

/** Process / memory metrics probe — always passes. Threads the same
 *  numbers that prom-client exposes for `/api/metrics` consumers, but
 *  in the JSON health envelope for direct dashboard reads. */
export function processProbe(): ProbeFn {
  return {
    name: 'process',
    critical: false,
    fn: async () => {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        status: 'pass',
        details: {
          uptimeSec: Math.round(process.uptime()),
          memory: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external },
          cpu: { userMicros: cpu.user, systemMicros: cpu.system },
          pid: process.pid,
          nodeVersion: process.version,
        },
      };
    },
  };
}

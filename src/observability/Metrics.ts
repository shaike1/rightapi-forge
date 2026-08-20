// Prometheus exposition for Beacon's self-observability surface.
//
// One registry, populated at import time. Lives separate from the
// existing /api/health JSON probes — those are for the dashboard's
// dependency-status panel; this is for Prometheus / Grafana / alert
// managers that pull text-format metrics on a scrape interval.
//
// What we expose:
//   • process_memory_bytes{kind=rss|heapTotal|heapUsed|external}
//   • process_cpu_seconds_total{type=user|system}
//   • process_uptime_seconds
//   • beacon_ws_connections_active
//   • beacon_http_requests_total{method,route,status}
//   • beacon_http_request_duration_seconds (histogram, per route+method)
//   • beacon_http_errors_total{method,route,status} (5xx only)
//   • beacon_ai_proxy_reachable{base_url}     1=ok 0=down
//   • beacon_health_check_status{check}        1=pass 0.5=warn 0=fail
//
// The runtime metrics (process_*) are populated by prom-client's
// `collectDefaultMetrics`; our app-level metrics are tracked by the
// helpers below and read at scrape time.

import client, { Registry, Counter, Histogram, Gauge } from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

export const registry = new Registry();

// Default runtime metrics: process_cpu_seconds_total, process_resident
// _memory_bytes, nodejs_*, etc. prefix='' so we keep prom-client's
// canonical names — easier to plug into the standard Node.js dashboards.
client.collectDefaultMetrics({
  register: registry,
  prefix: '',
});

// ── HTTP timing ─────────────────────────────────────────────────────
//
// route label = req.route?.path ?? a coarsened bucket. Without
// coarsening, ids in the path (/api/incidents/INC-ABC) blow up the
// cardinality. We collapse ids via a tiny regex pass before recording.

export const httpRequestsTotal = new Counter({
  name: 'beacon_http_requests_total',
  help: 'Total HTTP requests handled by Beacon, by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'beacon_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method/route.',
  labelNames: ['method', 'route'] as const,
  // 50ms .. 30s; covers the realistic Beacon response distribution
  // (fast list/get + slow AI-backed analyses).
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});


export const ticketingSyncTotal = new Counter({
  name: 'beacon_ticketing_sync_total',
  help: 'Total incident ticketing sync attempts.',
  labelNames: ['system', 'status'] as const,
  registers: [registry],
});

export const httpErrorsTotal = new Counter({
  name: 'beacon_http_errors_total',
  help: '5xx responses returned by Beacon, by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

// ── WebSocket ───────────────────────────────────────────────────────

let wsCountProvider: () => number = () => 0;
/** Provide a callback that reports the current WS connection count.
 *  Wired in server.ts to `() => clients.size`. Cheap on every scrape. */
export function setWsCountProvider(fn: () => number): void {
  wsCountProvider = fn;
}
new Gauge({
  name: 'beacon_ws_connections_active',
  help: 'Active WebSocket connections to /ws.',
  registers: [registry],
  collect() {
    // collect() runs on every scrape — pulls the live count without
    // requiring callers to .inc()/.dec() on every connect/disconnect.
    this.set(wsCountProvider());
  },
});

// ── AI proxy reachability ──────────────────────────────────────────
//
// Refreshed by the SelfMonitor every probe interval (~60s). The Gauge
// is the latest known state — Prometheus interpolates between scrapes.

export const aiProxyReachable = new Gauge({
  name: 'beacon_ai_proxy_reachable',
  help: 'Reachability of the configured AI proxy (1=ok, 0=unreachable).',
  labelNames: ['base_url'] as const,
  registers: [registry],
});

// ── Health-check rollup ────────────────────────────────────────────

export const healthCheckStatus = new Gauge({
  name: 'beacon_health_check_status',
  help: 'Beacon health check status per probe (1=pass, 0.5=warn, 0=fail).',
  labelNames: ['check'] as const,
  registers: [registry],
});

// ── Express middleware ─────────────────────────────────────────────
//
// Route label = req.route?.path when known (post-routing) or a
// coarsened path (pre-routing for static / 404). UUIDs, INC-ids, KB-
// ids etc. all collapse to ":id" so the metric cardinality stays
// bounded regardless of how many incidents exist.

const ID_PATTERNS: Array<{ pat: RegExp; rep: string }> = [
  { pat: /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, rep: '/:uuid' },
  { pat: /\/INC-[A-F0-9]+/g,  rep: '/:incidentId' },
  { pat: /\/PRB-[A-F0-9]+/g,  rep: '/:problemId' },
  { pat: /\/CHG-[A-F0-9]+/g,  rep: '/:changeId' },
  { pat: /\/KB-[A-F0-9]+/g,   rep: '/:kbId' },
  { pat: /\/\d{3,}/g,         rep: '/:n' },
];

function coarsenRoute(req: Request): string {
  const raw = (req.route?.path as string | undefined) ?? req.baseUrl + req.path;
  let r = raw || req.path || '/';
  for (const { pat, rep } of ID_PATTERNS) r = r.replace(pat, rep);
  // Trim trailing slash so /api/foo and /api/foo/ collapse.
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip metric scrapes themselves so the cardinality of /api/metrics
  // doesn't dominate the histogram with sub-ms self-calls.
  if (req.path === '/api/metrics') return next();
  const startNs = process.hrtime.bigint();
  res.on('finish', () => {
    try {
      const elapsedSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      const labels = {
        method: req.method,
        route: coarsenRoute(req),
        status: String(res.statusCode),
      };
      httpRequestsTotal.inc({ method: labels.method, route: labels.route, status: labels.status });
      httpRequestDuration.observe({ method: labels.method, route: labels.route }, elapsedSec);
      if (res.statusCode >= 500) {
        httpErrorsTotal.inc(labels);
      }
    } catch {
      // Never break a request because we couldn't tally a metric.
    }
  });
  next();
}

/** Render the current registry as text/plain Prometheus exposition. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

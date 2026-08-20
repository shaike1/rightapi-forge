// /api/metrics — per-server time-series exposed to the dashboard.
//
// Read endpoints back the disk/memory/CPU sparklines on the Dashboard
// and the per-server detail charts on the Servers page. The POST/record
// endpoint exists so external probes (or tests) can feed samples; the
// health-monitor loop in server.ts records directly through the store
// for the in-process path.
//
// Distinct from the Prometheus-export `metricsApi.ts` at /metrics —
// that one emits a Prometheus scrape format for external observability
// tooling. This module owns the dashboard's time-series store.

import { Router, type Request, type Response } from 'express';
import type { MetricsHistoryStore, MetricType } from '../monitoring/MetricsHistoryStore.js';
import type { TrendAnalyzer } from '../monitoring/TrendAnalyzer.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface MetricsHistoryApiDeps {
  store: MetricsHistoryStore;
  /** Optional trend analyzer. When present, /trends + /trends/:serverId
   *  are mounted. Older deployments that haven't wired the analyzer
   *  keep working unchanged. */
  trendAnalyzer?: TrendAnalyzer;
  validateAuth: AuthCheck;
  logError: (msg: string, ctx: Record<string, unknown>) => void;
}

const VALID_METRIC_TYPES: ReadonlySet<MetricType> = new Set<MetricType>([
  'cpu', 'memory', 'disk', 'load1', 'load5',
]);

function requireAuth(deps: MetricsHistoryApiDeps, req: Request, res: Response, perm: string): boolean {
  const r = deps.validateAuth(req.headers.authorization, perm);
  if (!r.ok) {
    res.status(401).json({ error: r.reason || 'unauthorized' });
    return false;
  }
  return true;
}

export function createMetricsHistoryRouter(deps: MetricsHistoryApiDeps): Router {
  const router = Router();

  // Series for one server + metric. Default window 24h; tunable via
  // ?windowMs (max 30d) or ?sinceMs (epoch). The query is bounded by a
  // 10k point cap inside the store; clients downsample if they want
  // fewer points on the wire.
  router.get('/series', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    const serverId = String(req.query.serverId || '').trim();
    const metricType = String(req.query.metricType || '').trim() as MetricType;
    if (!serverId || !VALID_METRIC_TYPES.has(metricType)) {
      return res.status(400).json({ error: 'serverId and metricType (cpu|memory|disk|load1|load5) are required' });
    }
    const dimension = typeof req.query.dimension === 'string' ? req.query.dimension : undefined;
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 10_000) : undefined;

    let sinceMs: number | undefined;
    if (req.query.sinceMs) {
      const n = Number(req.query.sinceMs);
      if (Number.isFinite(n)) sinceMs = n;
    } else if (req.query.windowMs) {
      const w = Math.min(Number(req.query.windowMs), 30 * 86400 * 1000);
      if (Number.isFinite(w) && w > 0) sinceMs = Date.now() - w;
    }

    try {
      const series = deps.store.series({ serverId, metricType, sinceMs, dimension, limit });
      res.json(series);
    } catch (e: any) {
      deps.logError('metrics series failed', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Latest sample per metric/dimension for a server. Cheap fan-out used
  // by the Servers page card to show current %.
  router.get('/latest', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    const serverId = String(req.query.serverId || '').trim();
    if (!serverId) return res.status(400).json({ error: 'serverId is required' });
    try {
      res.json({ samples: deps.store.latest(serverId) });
    } catch (e: any) {
      deps.logError('metrics latest failed', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  // Record one or more samples. Body shape:
  //   { samples: [{ serverId, metricType, value, dimension?, timestamp? }, ...] }
  router.post('/record', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const body = req.body;
    if (!body || !Array.isArray(body.samples)) {
      return res.status(400).json({ error: 'request body must contain a "samples" array' });
    }
    const samples = body.samples.filter((s: any) =>
      s && typeof s.serverId === 'string' && VALID_METRIC_TYPES.has(s.metricType)
        && typeof s.value === 'number' && Number.isFinite(s.value),
    ).map((s: any) => ({
      timestamp: typeof s.timestamp === 'string' ? s.timestamp : new Date().toISOString(),
      serverId: s.serverId,
      metricType: s.metricType,
      value: s.value,
      dimension: typeof s.dimension === 'string' ? s.dimension : null,
    }));
    if (samples.length === 0) {
      return res.status(400).json({ error: 'no valid samples in body' });
    }
    try {
      deps.store.record(samples);
      res.json({ ok: true, recorded: samples.length });
    } catch (e: any) {
      deps.logError('metrics record failed', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/stats', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    try {
      res.json({ rowCount: deps.store.count() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Trends ──────────────────────────────────────────────────────────────
  // Cached result from the TrendAnalyzer that ran inside the last health-
  // monitor tick. Avoids re-running regressions on every request; the data
  // is at most one tick (default 5 min) stale, which is fine for a
  // dashboard view of "what's projected to break soon".
  //
  // Each entry mirrors the brief's contract:
  //   { serverId, metric, currentValue, ratePerHour, predictedCriticalAt, isAnomaly }
  // plus a few extras (dimension, hoursUntilCritical, zScore, samples) so
  // the UI can be informative without a follow-up call.
  router.get('/trends', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    if (!deps.trendAnalyzer) {
      return res.json({ trends: [], enabled: false, reason: 'trend analyzer not wired' });
    }
    const report = deps.trendAnalyzer.getLastReport();
    res.json({
      enabled: deps.trendAnalyzer.isEnabled(),
      trends: report?.trends ?? [],
      finishedAt: report?.finishedAt ?? null,
      inspected: report?.inspected ?? 0,
      incidentsOpened: report?.incidentsOpened ?? 0,
    });
  });

  router.get('/trends/:serverId', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    if (!deps.trendAnalyzer) {
      return res.json({ trends: [], enabled: false, reason: 'trend analyzer not wired' });
    }
    const serverId = req.params.serverId;
    const trends = deps.trendAnalyzer.trendsForServer(serverId);
    const report = deps.trendAnalyzer.getLastReport();
    res.json({
      enabled: deps.trendAnalyzer.isEnabled(),
      serverId,
      trends,
      finishedAt: report?.finishedAt ?? null,
    });
  });

  return router;
}

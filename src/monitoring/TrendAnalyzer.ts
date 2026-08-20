// TrendAnalyzer — runs at the end of every health-monitor tick.
//
// Two passes over the metrics-history table per metric/server/dimension:
//
//   1. Trend analysis — simple least-squares linear regression over the
//      last 24h of samples. If the slope projects the metric to cross a
//      critical threshold within 48h, open a predictive incident (medium
//      if it'll hit in 24-48h, high if it'll hit in <24h). Currently
//      wired for disk % only — CPU/memory burn too noisy at this cadence
//      to give useful predictions, but the per-metric config map keeps
//      that easy to extend.
//
//   2. Anomaly detection — rolling 7d mean + standard deviation per
//      metric/server/dimension. Current sample > 2.5σ away from the mean
//      → open an anomaly incident. Severity scales with how far out of
//      band the value is.
//
// Dedup
// ─────
// Both passes call IncidentManager.create with `dedupBy: 'sourceRef'`, so
// repeated ticks fold into the existing incident. We additionally skip
// emitting at all if there's already an *active* incident from
// SystemMonitors whose sourceRef points at the same metric/server (e.g.
// disk:/data on vps1). That avoids opening a trend warning at the same
// moment the threshold monitor opens the real alert.
//
// Constraints from the task brief:
//   • Pure-JS regression (least squares), no external libs.
//   • Lightweight — runs every 5 minutes alongside the existing monitors.
//   • TREND_ANALYSIS_ENABLED env toggle (default true).
//   • Need ≥ 6 data points (30 minutes of history) before predicting.

import type { MetricsHistoryStore, MetricType } from './MetricsHistoryStore.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { ServerRegistry, MonitoredServer } from './ServerRegistry.js';
import type { Incident } from '../persistence/SqliteStore.js';
import { LOCAL_SERVER_ID } from './ServerRegistry.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'trend-analyzer' });

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Window for the linear regression fit. 24h captures a normal duty cycle
 *  (work day + overnight cron) without letting last-week noise wag the
 *  prediction. */
const TREND_WINDOW_MS = 24 * 3600 * 1000;
/** Window for the rolling mean/stddev that drives anomaly detection. 7d
 *  smooths over weekly variation (Sun/Mon are usually quieter). */
const ANOMALY_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Future window we consider "imminent" for trend-warning incidents. */
const PREDICT_HORIZON_MS = 48 * 3600 * 1000;
/** Severity-bump cutoff: predictions inside this window are high severity. */
const PREDICT_HIGH_HORIZON_MS = 24 * 3600 * 1000;
/** Minimum samples before we trust either pass. Matches the brief:
 *  6 samples ≈ 30min at the default 5min cadence. */
const MIN_SAMPLES = 6;
/** Anomaly threshold — values past this many σ are flagged. */
const ANOMALY_SIGMA = 2.5;
/** Minimum stddev before we even consider an anomaly. With a tiny σ
 *  (e.g. all samples within 0.1% of each other) the z-score becomes
 *  unstable and we'd flag every minor blip. */
const ANOMALY_MIN_STDDEV: Partial<Record<MetricType, number>> = {
  cpu:    2,   // % points
  memory: 2,
  disk:   1,
  load1:  0.2,
  load5:  0.2,
};

interface TrendThreshold {
  /** Threshold the metric should not cross (e.g. 90 for disk %). */
  critical: number;
  /** Direction we care about. 'up' means we open an incident when the
   *  metric trends *toward* the threshold from below (disk filling up);
   *  'down' would be e.g. "free memory dropping toward zero" but we
   *  don't track that metric directly. */
  direction: 'up';
}

/** Which metrics get a predictive-incident pass. Disk % is the headline
 *  use-case — it monotonically grows in most environments, so the linear
 *  fit is meaningful. We could extend to memory once we trust the noise
 *  characteristic; CPU's spikiness makes it a poor candidate. */
const TREND_CONFIG: Partial<Record<MetricType, TrendThreshold>> = {
  disk: { critical: 90, direction: 'up' },
};

/** Metrics we run anomaly detection on. We exclude load5 to avoid
 *  double-flagging when load1 already spiked. */
const ANOMALY_METRICS: MetricType[] = ['cpu', 'memory', 'disk', 'load1'];

// ── Public types ─────────────────────────────────────────────────────────────

export interface TrendPoint {
  serverId: string;
  serverName: string;
  metricType: MetricType;
  dimension: string | null;
  currentValue: number;
  /** Slope expressed in metric units per hour. Positive = increasing. */
  ratePerHour: number;
  /** When the metric is predicted to reach its configured critical
   *  threshold (e.g. 90% for disk). Null when the metric isn't trending
   *  toward it, or no threshold is configured for this metricType. */
  predictedCriticalAt: string | null;
  /** Hours until predictedCriticalAt. Null when prediction is null. */
  hoursUntilCritical: number | null;
  /** Number of samples in the regression window. */
  samples: number;
  /** Standard deviation across the regression window — useful for
   *  callers building a "confidence" UI. */
  stddev: number;
  /** True when the most recent sample is > ANOMALY_SIGMA away from the
   *  rolling-7d mean. */
  isAnomaly: boolean;
  /** Distance (in σ) of the most recent sample from the rolling mean.
   *  Negative means below the mean, positive means above. */
  anomalyZScore: number | null;
}

export interface TrendAnalysisResult {
  /** All metric/server combinations that had enough data to analyse. */
  trends: TrendPoint[];
  /** Number of incidents created this run (combined trend + anomaly). */
  incidentsOpened: number;
  /** Number of trends inspected (after the MIN_SAMPLES gate). */
  inspected: number;
  /** Timestamp at the end of the analysis. */
  finishedAt: string;
}

export interface TrendAnalyzerOpts {
  /** Master toggle. Defaults to TREND_ANALYSIS_ENABLED env (true if unset). */
  enabled?: boolean;
  /** Override the window for the regression fit (mostly for tests). */
  trendWindowMs?: number;
  /** Override the rolling-stat window for anomaly detection. */
  anomalyWindowMs?: number;
  /** Optional broadcaster — emitted when an incident is opened. */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

// ── Class ────────────────────────────────────────────────────────────────────

export class TrendAnalyzer {
  private readonly enabled: boolean;
  private readonly trendWindowMs: number;
  private readonly anomalyWindowMs: number;
  private readonly broadcast?: (event: { type: string; data: unknown }) => void;

  /** Cache of the last trend report so the /api/metrics-history/trends
   *  endpoint can respond without re-running the regression for every
   *  request. Health-monitor refreshes this every tick. */
  private lastReport: TrendAnalysisResult | null = null;

  constructor(
    private readonly history: MetricsHistoryStore,
    private readonly incidents: IncidentManager,
    private readonly registry: ServerRegistry,
    opts: TrendAnalyzerOpts = {},
  ) {
    const envFlag = (process.env.TREND_ANALYSIS_ENABLED ?? 'true').toLowerCase();
    this.enabled = opts.enabled ?? (envFlag !== 'false' && envFlag !== '0');
    this.trendWindowMs = opts.trendWindowMs ?? TREND_WINDOW_MS;
    this.anomalyWindowMs = opts.anomalyWindowMs ?? ANOMALY_WINDOW_MS;
    this.broadcast = opts.broadcast;
  }

  isEnabled(): boolean { return this.enabled; }
  getLastReport(): TrendAnalysisResult | null { return this.lastReport; }

  /** Run a full pass across every enabled server. Safe to call as
   *  fire-and-forget from the health-monitor loop — errors are
   *  swallowed (logged) so a parse blip can't break the tick. */
  async analyze(): Promise<TrendAnalysisResult> {
    if (!this.enabled) {
      const empty: TrendAnalysisResult = {
        trends: [], incidentsOpened: 0, inspected: 0,
        finishedAt: new Date().toISOString(),
      };
      this.lastReport = empty;
      return empty;
    }

    const servers = this.registry.enabledServers();
    const trends: TrendPoint[] = [];
    let opened = 0;

    // Snapshot all active incidents once so dedup is O(1) per check —
    // refetching inside the loop would be wasteful with N servers.
    const activeIncidents = this.incidents.list({})
      .filter(i => ['open', 'investigating', 'mitigating'].includes(i.status));

    for (const server of servers) {
      try {
        const serverTrends = this.analyzeServer(server, activeIncidents);
        for (const t of serverTrends.trends) trends.push(t);
        opened += serverTrends.opened;
      } catch (e) {
        log.warn('analyzer crashed on server', {
          serverId: server.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const result: TrendAnalysisResult = {
      trends, incidentsOpened: opened, inspected: trends.length,
      finishedAt: new Date().toISOString(),
    };
    this.lastReport = result;
    return result;
  }

  /** Public single-server entry point — used by the /trends/:serverId
   *  endpoint to return a fresh per-server cut without waiting for the
   *  next analyzer tick. Always reads from the cache when possible. */
  trendsForServer(serverId: string): TrendPoint[] {
    if (this.lastReport) {
      return this.lastReport.trends.filter(t => t.serverId === serverId);
    }
    return [];
  }

  // ── Per-server pass ────────────────────────────────────────────────────────

  private analyzeServer(
    server: MonitoredServer,
    activeIncidents: Incident[],
  ): { trends: TrendPoint[]; opened: number } {
    const out: TrendPoint[] = [];
    let opened = 0;

    // Discover which (metricType, dimension) pairs this server has data
    // for. Read the most recent samples once and enumerate the distinct
    // combinations — cheaper than running N separate queries when most
    // servers only have a handful of disk mounts.
    const latest = this.history.latest(server.id);
    if (latest.length === 0) return { trends: out, opened: 0 };

    for (const sample of latest) {
      const metric = sample.metricType;
      const dimension = sample.dimension ?? null;

      // Pull the regression window. The store caps at 10k rows so we
      // don't need to add our own ceiling — the 24h window at 5min
      // cadence is ~288 points per series.
      const sinceMs = Date.now() - this.trendWindowMs;
      const series = this.history.series({
        serverId: server.id,
        metricType: metric,
        dimension,
        sinceMs,
      });
      if (series.points.length < MIN_SAMPLES) continue;

      const regression = linearRegression(series.points);
      const stddev = sampleStddev(series.points.map(p => p.value), regression.mean);
      const currentValue = sample.value;

      // ── Trend prediction ────────────────────────────────────────────────
      const cfg = TREND_CONFIG[metric];
      let predictedCriticalAt: string | null = null;
      let hoursUntilCritical: number | null = null;
      let ratePerHour = msSlopeToPerHour(regression.slopePerMs);

      if (cfg && cfg.direction === 'up' && regression.slopePerMs > 0) {
        const msUntil = (cfg.critical - currentValue) / regression.slopePerMs;
        if (Number.isFinite(msUntil) && msUntil > 0 && msUntil < PREDICT_HORIZON_MS) {
          predictedCriticalAt = new Date(Date.now() + msUntil).toISOString();
          hoursUntilCritical = msUntil / 3_600_000;
        }
      }

      // ── Anomaly detection ──────────────────────────────────────────────
      let isAnomaly = false;
      let zScore: number | null = null;
      if (ANOMALY_METRICS.includes(metric)) {
        const anomalySince = Date.now() - this.anomalyWindowMs;
        const anomalySeries = this.history.series({
          serverId: server.id,
          metricType: metric,
          dimension,
          sinceMs: anomalySince,
        });
        const values = anomalySeries.points.map(p => p.value);
        if (values.length >= MIN_SAMPLES) {
          const m = mean(values);
          const s = sampleStddev(values, m);
          const minSigma = ANOMALY_MIN_STDDEV[metric] ?? 0.1;
          if (s >= minSigma) {
            zScore = (currentValue - m) / s;
            if (Math.abs(zScore) >= ANOMALY_SIGMA) {
              isAnomaly = true;
            }
          }
        }
      }

      const trendPoint: TrendPoint = {
        serverId: server.id,
        serverName: server.name,
        metricType: metric,
        dimension,
        currentValue: round1(currentValue),
        ratePerHour: round3(ratePerHour),
        predictedCriticalAt,
        hoursUntilCritical: hoursUntilCritical != null ? round1(hoursUntilCritical) : null,
        samples: series.points.length,
        stddev: round3(stddev),
        isAnomaly,
        anomalyZScore: zScore != null ? round1(zScore) : null,
      };
      out.push(trendPoint);

      // ── Open incidents from this trend point ──────────────────────────
      if (predictedCriticalAt && hoursUntilCritical != null) {
        if (this.openTrendIncident(server, trendPoint, cfg!.critical, activeIncidents)) opened++;
      }
      if (isAnomaly && zScore != null) {
        if (this.openAnomalyIncident(server, trendPoint, activeIncidents)) opened++;
      }
    }

    return { trends: out, opened };
  }

  // ── Incident generation ────────────────────────────────────────────────────

  private openTrendIncident(
    server: MonitoredServer,
    trend: TrendPoint,
    criticalThreshold: number,
    activeIncidents: Incident[],
  ): boolean {
    const ref = trendSourceRef(trend);
    if (hasActiveThresholdIncident(server, trend, activeIncidents)) {
      log.debug('skipping trend incident — active threshold incident covers this metric', {
        server: server.name, metric: trend.metricType, dimension: trend.dimension,
      });
      return false;
    }
    const severity: 'medium' | 'high' = (trend.hoursUntilCritical ?? 99) <= PREDICT_HIGH_HORIZON_MS / 3_600_000
      ? 'high' : 'medium';
    const eta = formatEta(trend.hoursUntilCritical ?? 0);
    const dimSuffix = trend.dimension ? ` (${trend.dimension})` : '';
    const title = `${titlePrefix(server)}${metricLabel(trend.metricType)} usage trending toward ${criticalThreshold}%${dimSuffix} (estimated in ${eta})`;
    const description = [
      `Predictive alert from trend analyzer.`,
      ``,
      `Server:            ${server.name} (${server.id})`,
      `Metric:            ${trend.metricType}${trend.dimension ? ' / ' + trend.dimension : ''}`,
      `Current value:     ${trend.currentValue}${unitFor(trend.metricType)}`,
      `Critical threshold: ${criticalThreshold}${unitFor(trend.metricType)}`,
      `Rate of change:    ${trend.ratePerHour > 0 ? '+' : ''}${trend.ratePerHour}${unitFor(trend.metricType)}/hour`,
      `Samples in window: ${trend.samples} over the last ${Math.round(this.trendWindowMs / 3_600_000)}h`,
      `Predicted to cross threshold: ${trend.predictedCriticalAt} (~${eta} from now)`,
      ``,
      `If this is a sustained climb, run a runbook (disk-cleanup, docker-housekeeping, log-rotation) before the threshold is hit.`,
    ].join('\n');

    try {
      this.incidents.create({
        title,
        description,
        severity,
        source: 'health-monitor',
        sourceRef: ref,
        serverId: server.id,
        dedupBy: 'sourceRef',
        updateOnDup: true,
        // No assignedTo — dispatchIncidentToAgent picks the right
        // sysadmin and fills the label. Hardcoding 'IT Director' here
        // bypassed the picker because assignAgent only fills assignedTo
        // when it's null.
      });
      this.broadcast?.({
        type: 'trend_incident_opened',
        data: { incidentSourceRef: ref, serverId: server.id, severity, eta },
      });
      log.info('opened trend incident', { server: server.name, ref, severity, eta });
      return true;
    } catch (e) {
      log.error('failed to open trend incident', {
        server: server.name, ref,
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  private openAnomalyIncident(
    server: MonitoredServer,
    trend: TrendPoint,
    activeIncidents: Incident[],
  ): boolean {
    const ref = anomalySourceRef(trend);
    if (hasActiveThresholdIncident(server, trend, activeIncidents)) {
      log.debug('skipping anomaly incident — active threshold incident covers this metric', {
        server: server.name, metric: trend.metricType, dimension: trend.dimension,
      });
      return false;
    }
    const z = trend.anomalyZScore ?? 0;
    const direction = z > 0 ? 'above' : 'below';
    const severity: 'medium' | 'high' = Math.abs(z) >= 4 ? 'high' : 'medium';
    const dimSuffix = trend.dimension ? ` (${trend.dimension})` : '';
    const title = `${titlePrefix(server)}${metricLabel(trend.metricType)} anomaly${dimSuffix}: ${trend.currentValue}${unitFor(trend.metricType)} (${Math.abs(z).toFixed(1)}σ ${direction} 7d mean)`;
    const description = [
      `Statistical anomaly detected by the trend analyzer.`,
      ``,
      `Server:            ${server.name} (${server.id})`,
      `Metric:            ${trend.metricType}${trend.dimension ? ' / ' + trend.dimension : ''}`,
      `Current value:     ${trend.currentValue}${unitFor(trend.metricType)}`,
      `Distance from 7d mean: ${z.toFixed(2)}σ (threshold: ±${ANOMALY_SIGMA}σ)`,
      `Recent rate of change: ${trend.ratePerHour > 0 ? '+' : ''}${trend.ratePerHour}${unitFor(trend.metricType)}/hour`,
      ``,
      `This value is outside the normal operating range for this server.`,
      `It may indicate a workload change, a leak, or an upstream incident.`,
    ].join('\n');

    try {
      this.incidents.create({
        title,
        description,
        severity,
        source: 'health-monitor',
        sourceRef: ref,
        serverId: server.id,
        dedupBy: 'sourceRef',
        updateOnDup: true,
        // No assignedTo — see the matching note above on
        // openTrendIncident. The dispatcher fills it from the picker.
      });
      this.broadcast?.({
        type: 'anomaly_incident_opened',
        data: { incidentSourceRef: ref, serverId: server.id, severity, zScore: z },
      });
      log.info('opened anomaly incident', { server: server.name, ref, severity, zScore: z });
      return true;
    } catch (e) {
      log.error('failed to open anomaly incident', {
        server: server.name, ref,
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }
}

// ── Math helpers (kept module-private; tests cover them indirectly via
//    the public analyse() entry point). ─────────────────────────────────

/** Least-squares linear regression on (ts, value) points. Slope is per
 *  millisecond — callers convert to per-hour for display. Returning the
 *  mean too saves an extra pass for the stddev calculation. */
export function linearRegression(points: Array<{ ts: number; value: number }>): {
  slopePerMs: number;
  intercept: number;
  mean: number;
} {
  const n = points.length;
  if (n === 0) return { slopePerMs: 0, intercept: 0, mean: 0 };
  if (n === 1) return { slopePerMs: 0, intercept: points[0].value, mean: points[0].value };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  // Anchor x at the first timestamp so the numbers stay sane — Date.now()-scale
  // values squared overflow Number precision for very long histories.
  const x0 = points[0].ts;
  for (const p of points) {
    const x = p.ts - x0;
    const y = p.value;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slopePerMs: 0, intercept: sumY / n, mean: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slopePerMs: slope, intercept, mean: sumY / n };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Sample stddev (n-1 denominator). Bessel's correction matters here
 *  because the 7d anomaly window often has <100 points after gaps. */
export function sampleStddev(values: number[], precomputedMean?: number): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = precomputedMean ?? mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / (n - 1));
}

function msSlopeToPerHour(slopePerMs: number): number {
  return slopePerMs * 3_600_000;
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

function formatEta(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return 'imminent';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function titlePrefix(server: MonitoredServer): string {
  return server.isLocal && server.id === LOCAL_SERVER_ID ? '' : `[${server.name}] `;
}

function metricLabel(metric: MetricType): string {
  switch (metric) {
    case 'cpu':    return 'CPU';
    case 'memory': return 'Memory';
    case 'disk':   return 'Disk';
    case 'load1':  return 'Load avg 1m';
    case 'load5':  return 'Load avg 5m';
  }
}

function unitFor(metric: MetricType): string {
  switch (metric) {
    case 'cpu':
    case 'memory':
    case 'disk':
      return '%';
    case 'load1':
    case 'load5':
      return '';
  }
}

// ── Source-ref + dedup helpers ───────────────────────────────────────────────

/** sourceRef pattern: trend:<metric>[:<dimension>]:<serverName>
 *  — keeps server scope at the end so deploys with a single host don't
 *    accidentally collide with multi-server deploys later. */
export function trendSourceRef(trend: { metricType: MetricType; dimension: string | null; serverName: string }): string {
  const dim = trend.dimension ? `:${trend.dimension}` : '';
  return `trend:${trend.metricType}${dim}:${trend.serverName}`;
}

export function anomalySourceRef(trend: { metricType: MetricType; dimension: string | null; serverName: string }): string {
  const dim = trend.dimension ? `:${trend.dimension}` : '';
  return `anomaly:${trend.metricType}${dim}:${trend.serverName}`;
}

/** Return true when there's already an active incident on the same
 *  metric+server (from the threshold-based health monitor — disk:/data,
 *  memory:>80, etc.). We use this to suppress the trend/anomaly alert so
 *  operators don't get two cards for the same underlying condition. */
function hasActiveThresholdIncident(
  server: MonitoredServer,
  trend: { metricType: MetricType; dimension: string | null },
  activeIncidents: Incident[],
): boolean {
  // The threshold monitor uses sourceRefs like:
  //   disk:/data            (local)
  //   disk:/data:vps1       (remote)
  //   cpu:sustained
  //   cpu:sustained:vps1
  //   iowait:sustained[:server]
  // We match on the metric prefix scoped to this server (via serverId
  // when present, falling back to a string match on the ref's suffix).
  const metricPrefixes: string[] = [];
  switch (trend.metricType) {
    case 'disk':
      // disk:/data or disk:/data:server. Threshold monitor doesn't write
      // disk-trend refs so the trend prefix is safe.
      metricPrefixes.push('disk:');
      break;
    case 'cpu':
    case 'load1':
    case 'load5':
      metricPrefixes.push('cpu:', 'cpu', 'load:');
      break;
    case 'memory':
      metricPrefixes.push('memory:', 'memory');
      break;
  }
  for (const inc of activeIncidents) {
    const ref = (inc.sourceRef ?? '').toLowerCase();
    if (!ref) continue;
    // Trend / anomaly refs of our own don't count as "threshold incidents".
    if (ref.startsWith('trend:') || ref.startsWith('anomaly:')) continue;
    // Same server check — prefer the structured field when set.
    const sameServer = inc.serverId
      ? inc.serverId === server.id
      : ref.endsWith(`:${server.name.toLowerCase()}`) || server.isLocal;
    if (!sameServer) continue;
    for (const p of metricPrefixes) {
      if (ref.startsWith(p)) return true;
    }
  }
  return false;
}

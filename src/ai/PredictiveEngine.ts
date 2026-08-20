// PredictiveEngine — periodic worker that fits a simple linear regression
// over recent metric history per (serverId, metricType, dimension) and
// projects forward. If the projection breaches a threshold inside the
// configured horizon, a "predicted" incident opens against the same
// server. A second-tier anomaly check uses the mean+stddev of the
// historical baseline to catch outliers the regression misses.
//
// Why a simple LR + outlier check instead of ML:
//   • The forward window is short (default 2h). LR over 6h of data
//     captures the trend without overfitting noise.
//   • The platform's incident pipeline already handles dedup. A
//     predicted incident with `sourceRef='predict:<server>:<metric>'`
//     dedups cleanly so a steady trend doesn't generate one ticket
//     per tick.
//
// Seasonality:
//   • The engine maintains an hour-of-day baseline per (serverId,
//     metric) from the last `seasonalLookbackDays` of data (default
//     14). When a current sample is within seasonal_band of the
//     hourly baseline, the anomaly path returns "expected — no
//     alert" even if it's globally elevated. This is what stops the
//     2am backup spike paging every night.
//
// Outcome tracking:
//   • Every predicted incident records an AiDecisionStore row with
//     kind='predict'. A periodic accuracy sweep checks whether the
//     real metric actually breached after the prediction; if not, the
//     decision outcome flips to 'failed'. The dashboard surfaces
//     prediction accuracy from these rows.

import { v4 as uuidv4 } from 'uuid';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { AiDecisionStore, AiDecision } from './AiDecisionStore.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'predictive-engine' });

export type PredictMetric = 'cpu' | 'memory' | 'disk' | 'load1' | 'load5';

export interface MetricPoint {
  ts: number;     // epoch ms
  value: number;
}

export interface MetricSource {
  /** Fetch a time-series for one (serverId, metric, dimension). Used
   *  for both the projection window and the seasonal baseline. */
  series(args: { serverId: string; metricType: PredictMetric; sinceMs: number; dimension?: string | null }): { points: MetricPoint[] };
  /** Most recent samples for a server — used to discover which
   *  (metric, dimension) pairs exist without baking a fleet inventory
   *  into the engine. */
  latest(serverId: string): Array<{ metricType: PredictMetric | string; dimension?: string | null; value: number; timestamp: string }>;
}

export interface ServerSource {
  list(filter?: { enabled?: boolean }): Array<{ id: string; name: string }>;
}

export interface PredictiveEngineDeps {
  metrics: MetricSource;
  servers: ServerSource;
  incidentManager: IncidentManager;
  decisionStore: AiDecisionStore;
  /** Optional audit-log appender. Soft-fails when omitted. */
  auditLog?: (entry: { actor: string; actorType: string; action: string; resource: string; resourceId?: string; outcome: 'success' | 'failure'; severity: 'info' | 'warning' | 'critical'; details?: Record<string, unknown> }) => void;
  broadcast?: (msg: { type: string; data: unknown }) => void;
  now?: () => number;
}

export interface PredictiveEngineOptions {
  enabled?: boolean;
  /** Tick interval. Default 10 min — same cadence as the existing
   *  alert engine so the two pipelines run on parallel rhythms. */
  intervalMs?: number;
  /** How far ahead to project. Default 2 hours. */
  horizonMs?: number;
  /** Regression window. Default 6 hours. */
  regressionWindowMs?: number;
  /** Days of history feeding the hourly seasonal baseline. Default 14. */
  seasonalLookbackDays?: number;
  /** When the current sample is within `seasonalBand * stddev` of the
   *  hour-of-day mean, the anomaly path is suppressed. Default 1.5. */
  seasonalBand?: number;
  /** Per-metric threshold (percent) above which we open an incident
   *  if the projection breaches. Override individual metrics via env. */
  thresholds?: Partial<Record<PredictMetric, number>>;
  /** Minimum slope (value/min) required before a regression fires.
   *  Stops a flat metric from generating predictions every tick. */
  minSlopePerMinute?: number;
}

export interface PredictionPayload {
  serverId: string;
  serverName: string;
  metric: PredictMetric;
  dimension: string | null;
  currentValue: number;
  projectedValue: number;
  threshold: number;
  horizonMs: number;
  slopePerMinute: number;
  /** When the projection crosses the threshold, expressed as ms since
   *  now. Negative means the threshold has already been crossed. */
  timeToBreachMs: number;
  /** 'regression' or 'anomaly'. */
  reason: 'regression' | 'anomaly';
}

export class PredictiveEngine {
  private deps: PredictiveEngineDeps;
  private opts: Required<Omit<PredictiveEngineOptions, 'thresholds'>> & { thresholds: Record<PredictMetric, number> };
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: PredictiveEngineDeps, opts: PredictiveEngineOptions = {}) {
    this.deps = deps;
    this.opts = {
      enabled:                opts.enabled ?? true,
      intervalMs:             Math.max(60_000, opts.intervalMs ?? 10 * 60 * 1000),
      horizonMs:              Math.max(60_000, opts.horizonMs ?? 2 * 60 * 60 * 1000),
      regressionWindowMs:     Math.max(15 * 60_000, opts.regressionWindowMs ?? 6 * 60 * 60 * 1000),
      seasonalLookbackDays:   Math.max(1, opts.seasonalLookbackDays ?? 14),
      seasonalBand:           Math.max(0.1, opts.seasonalBand ?? 1.5),
      minSlopePerMinute:      Math.max(0, opts.minSlopePerMinute ?? 0.02),
      thresholds: {
        cpu:    opts.thresholds?.cpu    ?? 90,
        memory: opts.thresholds?.memory ?? 90,
        disk:   opts.thresholds?.disk   ?? 90,
        load1:  opts.thresholds?.load1  ?? 4,
        load5:  opts.thresholds?.load5  ?? 3,
      },
    };
  }

  getConfig() {
    return { ...this.opts };
  }

  updateConfig(patch: Partial<{ enabled: boolean; intervalMs: number; horizonMs: number; thresholds: Partial<Record<PredictMetric, number>> }>): void {
    if (patch.enabled !== undefined)   this.opts.enabled = !!patch.enabled;
    if (patch.intervalMs !== undefined) this.opts.intervalMs = Math.max(60_000, patch.intervalMs);
    if (patch.horizonMs !== undefined)  this.opts.horizonMs = Math.max(60_000, patch.horizonMs);
    if (patch.thresholds) this.opts.thresholds = { ...this.opts.thresholds, ...patch.thresholds };
    // No timer restart needed — the new interval is picked up on the
    // next tickSafe() since setInterval semantics rely on the timer
    // having been armed at create-time. For runtime cadence changes,
    // call stop() + start().
  }

  start(): void {
    if (this.timer) return;
    log.info('started', { intervalMs: this.opts.intervalMs, horizonMs: this.opts.horizonMs, regressionWindowMs: this.opts.regressionWindowMs });
    this.timer = setInterval(() => this.tickSafe(), this.opts.intervalMs);
    if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Public test seam — runs a single pass and returns the predictions
   *  it found. The same code path setInterval uses. */
  async tickOnce(): Promise<PredictionPayload[]> {
    return this.tick();
  }

  private async tickSafe(): Promise<void> {
    if (!this.opts.enabled || this.running) return;
    this.running = true;
    try { await this.tick(); }
    catch (e) { log.error('tick threw', { err: errMsg(e) }); }
    finally { this.running = false; }
  }

  private async tick(): Promise<PredictionPayload[]> {
    const now = this.deps.now?.() ?? Date.now();
    const servers = this.deps.servers.list({ enabled: true });
    const out: PredictionPayload[] = [];
    for (const s of servers) {
      const pairs = this.discoverMetricDimensions(s.id);
      for (const { metric, dimension } of pairs) {
        const series = this.deps.metrics.series({
          serverId: s.id,
          metricType: metric,
          dimension,
          sinceMs: now - this.opts.regressionWindowMs,
        }).points;
        if (series.length < 3) continue;

        const threshold = this.opts.thresholds[metric];
        const projection = this.projectLinear(series, this.opts.horizonMs);
        const slopePerMinute = projection.slope * 60_000;

        let prediction: PredictionPayload | null = null;
        if (Math.abs(slopePerMinute) >= this.opts.minSlopePerMinute && projection.endValue >= threshold) {
          // Linear-regression breach prediction.
          const timeToBreachMs = projection.slope > 0
            ? Math.max(0, (threshold - projection.startValue) / projection.slope)
            : -1;
          prediction = {
            serverId: s.id, serverName: s.name, metric, dimension,
            currentValue: projection.startValue,
            projectedValue: projection.endValue,
            threshold, horizonMs: this.opts.horizonMs,
            slopePerMinute,
            timeToBreachMs,
            reason: 'regression',
          };
        } else {
          // Anomaly fallback — if current is more than seasonalBand stddevs
          // above the hourly mean baseline, fire an "anomaly" prediction.
          const anomaly = this.checkAnomaly(s.id, metric, dimension, series[series.length - 1].value, now);
          if (anomaly) {
            prediction = {
              serverId: s.id, serverName: s.name, metric, dimension,
              currentValue: series[series.length - 1].value,
              projectedValue: series[series.length - 1].value,
              threshold, horizonMs: 0,
              slopePerMinute: 0,
              timeToBreachMs: 0,
              reason: 'anomaly',
            };
          }
        }

        if (prediction) {
          out.push(prediction);
          this.recordPrediction(prediction);
        }
      }
    }
    return out;
  }

  /** Find the live (metric, dimension) pairs for a server from its
   *  latest samples. Returns 'cpu', 'memory', 'load1', 'load5' as
   *  single-dimensioned entries and one entry per disk mount. */
  private discoverMetricDimensions(serverId: string): Array<{ metric: PredictMetric; dimension: string | null }> {
    const out: Array<{ metric: PredictMetric; dimension: string | null }> = [];
    let samples: Array<{ metricType: PredictMetric | string; dimension?: string | null }> = [];
    try { samples = this.deps.metrics.latest(serverId); }
    catch (e) { log.warn('metrics.latest threw', { serverId, err: errMsg(e) }); return out; }
    const seen = new Set<string>();
    for (const s of samples) {
      if (!isPredictMetric(s.metricType)) continue;
      const key = `${s.metricType}:${s.dimension ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ metric: s.metricType as PredictMetric, dimension: s.dimension ?? null });
    }
    return out;
  }

  /** Ordinary least squares slope + intercept over (ts, value). Returns
   *  slope (value/ms), the value at the start of the window, and the
   *  projected value at start+horizonMs. */
  private projectLinear(series: MetricPoint[], horizonMs: number): { slope: number; startValue: number; endValue: number } {
    const n = series.length;
    // Use ts0-relative time so the numbers stay small.
    const ts0 = series[0].ts;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of series) {
      const x = p.ts - ts0;
      sumX += x; sumY += p.value; sumXY += x * p.value; sumXX += x * x;
    }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const lastX = series[n - 1].ts - ts0;
    const startValue = series[0].value;
    const endValue = intercept + slope * (lastX + horizonMs);
    return { slope, startValue, endValue };
  }

  /** Seasonal anomaly check. Pulls the last `seasonalLookbackDays` of
   *  samples in the same hour-of-day window and asks: is this sample
   *  more than `seasonalBand * stddev` above the mean? When yes, an
   *  anomaly is reported. Inside the band ⇒ "expected", returns null. */
  private checkAnomaly(serverId: string, metric: PredictMetric, dimension: string | null, current: number, nowMs: number): boolean {
    const hour = new Date(nowMs).getUTCHours();
    const sinceMs = nowMs - this.opts.seasonalLookbackDays * 24 * 60 * 60 * 1000;
    let points: MetricPoint[] = [];
    try {
      points = this.deps.metrics.series({
        serverId, metricType: metric, dimension, sinceMs,
      }).points;
    } catch (e) {
      log.warn('seasonal series fetch failed', { serverId, metric, err: errMsg(e) });
      return false;
    }
    const sameHour = points.filter(p => new Date(p.ts).getUTCHours() === hour);
    if (sameHour.length < 5) return false;
    const mean = sameHour.reduce((a, p) => a + p.value, 0) / sameHour.length;
    const variance = sameHour.reduce((a, p) => a + (p.value - mean) ** 2, 0) / sameHour.length;
    const stddev = Math.sqrt(variance);
    const upperBand = mean + this.opts.seasonalBand * stddev;
    // Only flag anomalies that are also genuinely high — a 5% disk
    // sitting at 6% during off-hours is statistically anomalous but
    // operationally irrelevant.
    const threshold = this.opts.thresholds[metric];
    return current > upperBand && current >= threshold * 0.8;
  }

  /** Open (or refresh) a predicted incident and log the decision. */
  private recordPrediction(p: PredictionPayload): void {
    const dimSuffix = p.dimension ? `:${p.dimension}` : '';
    const sourceRef = `predict:${p.serverId}:${p.metric}${dimSuffix}`;
    const title = p.reason === 'regression'
      ? `Predicted ${p.metric}${dimSuffix} breach on ${p.serverName} in ${formatDuration(p.timeToBreachMs)}`
      : `Anomaly: ${p.metric}${dimSuffix} unusually high on ${p.serverName}`;
    const description = [
      `Reason: ${p.reason}`,
      `Server: ${p.serverName} (${p.serverId})`,
      `Metric: ${p.metric}${dimSuffix}`,
      `Current: ${p.currentValue.toFixed(2)} · Projected: ${p.projectedValue.toFixed(2)}`,
      `Threshold: ${p.threshold} · Horizon: ${formatDuration(p.horizonMs)}`,
      `Slope: ${p.slopePerMinute.toFixed(4)} /minute`,
    ].join('\n');

    let incidentId: string | null = null;
    try {
      const inc = this.deps.incidentManager.create({
        title,
        description,
        severity: 'low', // 'warning' isn't a valid severity in the existing schema — using 'low' so SLA stays sane until the prediction materialises.
        source: 'agent',
        sourceRef,
        serverId: p.serverId,
        dedup: true,
        dedupBy: 'sourceRef',
        updateOnDup: true,
      });
      incidentId = inc.id;
    } catch (e) {
      log.warn('failed to open predicted incident', { sourceRef, err: errMsg(e) });
    }

    const decisionId = `predict-${uuidv4()}`;
    this.deps.decisionStore.insert({
      id: decisionId,
      kind: 'predict',
      incidentId,
      confidence: confidenceFor(p),
      reasoning: title + ' — ' + description.replace(/\n/g, '; '),
      autoApplied: true,
      payload: { ...p },
    });

    this.deps.auditLog?.({
      actor: 'predictive-engine',
      actorType: 'system',
      action: 'predict.opened',
      resource: 'incident',
      resourceId: incidentId ?? undefined,
      outcome: 'success',
      severity: 'info',
      details: { sourceRef, reason: p.reason, projected: p.projectedValue, threshold: p.threshold },
    });

    this.deps.broadcast?.({ type: 'prediction', data: p });
  }

  /** Background sweep — flips predictions to 'success'/'failed' once
   *  the horizon has passed. If the actual metric breached the
   *  threshold, the prediction was correct (outcome=success). Else,
   *  it was a false positive (outcome=failed). */
  trackAccuracy(opts: { graceMs?: number } = {}): { reviewed: number; success: number; failed: number } {
    const graceMs = opts.graceMs ?? 30 * 60 * 1000;
    const now = this.deps.now?.() ?? Date.now();
    const pending = this.deps.decisionStore.list({ kind: 'predict', outcome: 'pending', limit: 2000 });
    let success = 0, failed = 0, reviewed = 0;
    for (const d of pending) {
      const payload = d.payload as Partial<PredictionPayload>;
      if (!payload?.serverId || !payload.metric) continue;
      const horizonEndsAt = Date.parse(d.createdAt) + (payload.horizonMs ?? 0);
      if (now < horizonEndsAt + graceMs) continue;
      reviewed++;
      const samples = this.deps.metrics.series({
        serverId: payload.serverId,
        metricType: payload.metric as PredictMetric,
        dimension: (payload as any).dimension ?? null,
        sinceMs: Date.parse(d.createdAt),
      }).points;
      const breached = samples.some(p => p.value >= (payload.threshold ?? Infinity));
      if (breached) { this.deps.decisionStore.recordOutcome(d.id, 'success'); success++; }
      else          { this.deps.decisionStore.recordOutcome(d.id, 'failed');  failed++; }
    }
    if (reviewed > 0) log.info('accuracy sweep complete', { reviewed, success, failed });
    return { reviewed, success, failed };
  }

  /** Snapshot the most recent N predictions for the dashboard. */
  recent(limit = 100): AiDecision[] {
    return this.deps.decisionStore.list({ kind: 'predict', limit });
  }
}

function confidenceFor(p: PredictionPayload): number {
  if (p.reason === 'anomaly') return 0.6;
  // Regression confidence grows with how far above threshold the
  // projection is, capped at 0.95 since LR over short windows is
  // intrinsically noisy.
  const margin = (p.projectedValue - p.threshold) / Math.max(1, p.threshold);
  return Math.min(0.95, 0.55 + Math.min(0.4, margin));
}

function isPredictMetric(s: string): s is PredictMetric {
  return s === 'cpu' || s === 'memory' || s === 'disk' || s === 'load1' || s === 'load5';
}

function formatDuration(ms: number): string {
  if (ms < 0) return 'already breached';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

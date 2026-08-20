import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricsHistoryStore, type MetricSample, type MetricType } from './MetricsHistoryStore.js';
import { ServerRegistry, LOCAL_SERVER_ID } from './ServerRegistry.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import {
  TrendAnalyzer,
  linearRegression,
  sampleStddev,
  trendSourceRef,
  anomalySourceRef,
} from './TrendAnalyzer.js';

// ── Setup helpers ─────────────────────────────────────────────────────────

function makeStack() {
  const dir = mkdtempSync(join(tmpdir(), 'trend-analyzer-test-'));
  const history = new MetricsHistoryStore(join(dir, 'metrics.db'), { retentionDays: 7 });
  const incidentStore = new SqliteIncidentStore(join(dir, 'incidents.db'));
  const incidents = new IncidentManager(incidentStore);
  const registry = new ServerRegistry(join(dir, 'servers.db'));
  registry.ensureLocal();
  return { history, incidents, registry };
}

/** Insert a synthetic series for a metric on a server. `valueAt(i)` is
 *  evaluated at i = 0..n-1 (oldest → newest). Timestamps step backwards
 *  from `now` so the most recent sample is at index n-1. */
function seedSeries(
  history: MetricsHistoryStore,
  serverId: string,
  metric: MetricType,
  n: number,
  valueAt: (i: number) => number,
  opts: { stepMs?: number; dimension?: string | null; now?: number } = {},
) {
  const stepMs = opts.stepMs ?? 5 * 60_000; // 5min cadence — matches health monitor
  const now = opts.now ?? Date.now();
  const samples: MetricSample[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(now - (n - 1 - i) * stepMs).toISOString();
    samples.push({
      timestamp: ts,
      serverId,
      metricType: metric,
      value: valueAt(i),
      dimension: opts.dimension ?? null,
    });
  }
  history.record(samples);
}

// ── Math helpers ──────────────────────────────────────────────────────────

test('linearRegression: perfectly linear data recovers exact slope', () => {
  // y = 2x + 10, x in milliseconds
  const points = [0, 1, 2, 3, 4].map(i => ({ ts: i * 1000, value: 10 + 2 * i }));
  const r = linearRegression(points);
  // slope per ms = 2/1000 = 0.002
  assert.ok(Math.abs(r.slopePerMs - 0.002) < 1e-9, `slope was ${r.slopePerMs}`);
  assert.ok(Math.abs(r.intercept - 10) < 1e-9, `intercept was ${r.intercept}`);
  assert.equal(r.mean, 14);
});

test('linearRegression: flat data yields zero slope', () => {
  const points = [0, 1, 2, 3, 4].map(i => ({ ts: i * 1000, value: 42 }));
  const r = linearRegression(points);
  assert.equal(r.slopePerMs, 0);
  assert.equal(r.intercept, 42);
});

test('linearRegression: empty / single-point input doesn\'t throw', () => {
  assert.deepEqual(linearRegression([]), { slopePerMs: 0, intercept: 0, mean: 0 });
  const r1 = linearRegression([{ ts: 1000, value: 5 }]);
  assert.equal(r1.slopePerMs, 0);
  assert.equal(r1.intercept, 5);
  assert.equal(r1.mean, 5);
});

test('sampleStddev: known stddev for a simple sequence', () => {
  // mean=3, variance=2 (sample, n-1 denom), stddev=√2
  const s = sampleStddev([1, 2, 3, 4, 5]);
  assert.ok(Math.abs(s - Math.sqrt(2.5)) < 1e-9, `got ${s}`);
});

test('sampleStddev: degenerate inputs return 0', () => {
  assert.equal(sampleStddev([]), 0);
  assert.equal(sampleStddev([7]), 0);
});

// ── Source-ref shape ──────────────────────────────────────────────────────

test('trendSourceRef / anomalySourceRef carry metric + dimension + server', () => {
  assert.equal(
    trendSourceRef({ metricType: 'disk', dimension: '/data', serverName: 'vps1' }),
    'trend:disk:/data:vps1',
  );
  assert.equal(
    trendSourceRef({ metricType: 'memory', dimension: null, serverName: 'web' }),
    'trend:memory:web',
  );
  assert.equal(
    anomalySourceRef({ metricType: 'cpu', dimension: null, serverName: 'db' }),
    'anomaly:cpu:db',
  );
});

// ── analyze() — trend prediction ─────────────────────────────────────────

test('analyze(): rising disk usage opens a trend incident with ETA', async () => {
  const { history, incidents, registry } = makeStack();
  // Climb from 50% → 80% over the last 24h, 5min cadence (288 samples).
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 288,
    i => 50 + (i / 287) * 30,
    { dimension: '/data' },
  );
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  const report = await analyzer.analyze();

  const trend = report.trends.find(t => t.metricType === 'disk' && t.dimension === '/data');
  assert.ok(trend, 'expected a disk trend');
  assert.ok(trend!.ratePerHour > 0, `rate should be positive, got ${trend!.ratePerHour}`);
  assert.ok(trend!.predictedCriticalAt, 'should predict a crossing time');
  // At ~30%/24h = 1.25%/h, going from 80% → 90% takes ~8h. Within the
  // <24h cutoff so the incident should be high severity.
  assert.ok((trend!.hoursUntilCritical ?? 99) < 24);

  const open = incidents.list({}).filter(i => ['open', 'investigating'].includes(i.status));
  const trendInc = open.find(i => (i.sourceRef || '').startsWith('trend:disk'));
  assert.ok(trendInc, 'expected a trend incident');
  assert.equal(trendInc!.severity, 'high');
  assert.equal(trendInc!.source, 'health-monitor');
  assert.match(trendInc!.title, /trending toward 90%/i);
});

test('analyze(): flat disk usage does NOT open a trend incident', async () => {
  const { history, incidents, registry } = makeStack();
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 200, () => 50, { dimension: '/' });
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  await analyzer.analyze();
  const open = incidents.list({}).filter(i =>
    ['open', 'investigating'].includes(i.status) && (i.sourceRef || '').startsWith('trend:'));
  assert.equal(open.length, 0);
});

test('analyze(): respects MIN_SAMPLES — fewer than 6 points → no trend row', async () => {
  const { history, incidents, registry } = makeStack();
  // Only 5 samples, climbing.
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 5, i => 60 + i * 5, { dimension: '/' });
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  const report = await analyzer.analyze();
  // No disk trend should appear because we're below the MIN_SAMPLES cap.
  assert.equal(report.trends.filter(t => t.metricType === 'disk').length, 0);
});

test('analyze(): trend prediction far in the future (>48h) doesn\'t open an incident', async () => {
  const { history, incidents, registry } = makeStack();
  // Very slow climb: 50% → 50.5% over 24h ≈ 0.02%/h → reaching 90% takes ~2000h.
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 288,
    i => 50 + (i / 287) * 0.5,
    { dimension: '/' });
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  const report = await analyzer.analyze();
  const trend = report.trends.find(t => t.metricType === 'disk');
  assert.ok(trend);
  assert.equal(trend!.predictedCriticalAt, null);
  const trendInc = incidents.list({}).filter(i => (i.sourceRef || '').startsWith('trend:'));
  assert.equal(trendInc.length, 0);
});

// ── analyze() — anomaly detection ────────────────────────────────────────

test('analyze(): sudden spike >2.5σ above 7-day mean opens an anomaly incident', async () => {
  const { history, incidents, registry } = makeStack();
  // Seed 200 samples of memory % oscillating tightly around 25 (stddev ~1)
  // then jam the latest sample to 60% (massive z-score).
  seedSeries(history, LOCAL_SERVER_ID, 'memory', 199, i => 25 + Math.sin(i / 5) * 1);
  // Append one anomalous sample with the freshest timestamp.
  history.record([{
    timestamp: new Date().toISOString(),
    serverId: LOCAL_SERVER_ID, metricType: 'memory', value: 60, dimension: null,
  }]);
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  const report = await analyzer.analyze();

  const t = report.trends.find(x => x.metricType === 'memory');
  assert.ok(t, 'expected a memory trend row');
  assert.equal(t!.isAnomaly, true);
  assert.ok((t!.anomalyZScore ?? 0) > 2.5);

  const anomInc = incidents.list({}).find(i => (i.sourceRef || '').startsWith('anomaly:memory'));
  assert.ok(anomInc, 'expected an anomaly incident');
  assert.match(anomInc!.title, /σ above 7d mean/i);
});

test('analyze(): values within normal range produce no anomaly incident', async () => {
  const { history, incidents, registry } = makeStack();
  // Tight band around 30 with small noise. Current sample matches the band.
  seedSeries(history, LOCAL_SERVER_ID, 'cpu', 200, i => 30 + ((i % 7) - 3) * 0.5);
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  const report = await analyzer.analyze();
  const t = report.trends.find(x => x.metricType === 'cpu');
  assert.ok(t);
  assert.equal(t!.isAnomaly, false);
  const anomInc = incidents.list({}).find(i => (i.sourceRef || '').startsWith('anomaly:cpu'));
  assert.equal(anomInc, undefined);
});

// ── Dedup behaviour ──────────────────────────────────────────────────────

test('analyze(): suppresses trend/anomaly when a threshold incident already covers the metric', async () => {
  const { history, incidents, registry } = makeStack();
  // Open a threshold-style incident (the kind SystemMonitors creates) so
  // our analyzer should bail out for that metric.
  incidents.create({
    title: 'Disk Critical: /data at 92%',
    severity: 'high',
    source: 'health-monitor',
    sourceRef: 'disk:/data',
    serverId: LOCAL_SERVER_ID,
    dedupBy: 'sourceRef',
  });
  // Climbing disk on the same dimension that *would* otherwise trigger
  // a trend incident.
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 288,
    i => 70 + (i / 287) * 20,
    { dimension: '/data' });

  const analyzer = new TrendAnalyzer(history, incidents, registry);
  await analyzer.analyze();
  const trendInc = incidents.list({}).filter(i => (i.sourceRef || '').startsWith('trend:disk'));
  assert.equal(trendInc.length, 0, 'should suppress trend incident when threshold incident is active');
});

test('analyze(): repeated runs deduplicate trend incidents via sourceRef', async () => {
  const { history, incidents, registry } = makeStack();
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 288,
    i => 50 + (i / 287) * 30,
    { dimension: '/var' });
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  await analyzer.analyze();
  await analyzer.analyze();
  await analyzer.analyze();
  const all = incidents.list({}).filter(i => (i.sourceRef || '').startsWith('trend:disk:/var'));
  assert.equal(all.length, 1, 'dedup should fold three runs into one incident');
});

// ── API surface: getLastReport + trendsForServer ─────────────────────────

test('getLastReport / trendsForServer surface the cached result', async () => {
  const { history, incidents, registry } = makeStack();
  seedSeries(history, LOCAL_SERVER_ID, 'memory', 200, i => 25 + i * 0.05);
  const analyzer = new TrendAnalyzer(history, incidents, registry);
  assert.equal(analyzer.getLastReport(), null, 'no report before first analyze()');
  await analyzer.analyze();
  const report = analyzer.getLastReport();
  assert.ok(report);
  assert.ok(report!.trends.length >= 1);
  const local = analyzer.trendsForServer(LOCAL_SERVER_ID);
  assert.equal(local.length, report!.trends.length);
  assert.equal(analyzer.trendsForServer('nonexistent').length, 0);
});

test('disabled analyzer is a no-op', async () => {
  const { history, incidents, registry } = makeStack();
  seedSeries(history, LOCAL_SERVER_ID, 'disk', 288, i => 50 + i * 0.1, { dimension: '/' });
  const analyzer = new TrendAnalyzer(history, incidents, registry, { enabled: false });
  const report = await analyzer.analyze();
  assert.equal(report.trends.length, 0);
  assert.equal(report.incidentsOpened, 0);
  assert.equal(incidents.list({}).filter(i => (i.sourceRef || '').startsWith('trend:')).length, 0);
});

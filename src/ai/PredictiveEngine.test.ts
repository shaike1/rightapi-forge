import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PredictiveEngine, type MetricSource } from './PredictiveEngine.js';
import { AiDecisionStore } from './AiDecisionStore.js';

function tmpStore(): AiDecisionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-predict-'));
  return new AiDecisionStore(path.join(dir, 'd.db'));
}

function fakeIm() {
  const created: any[] = [];
  return {
    created,
    create: (input: any) => { const r = { id: 'INC-' + created.length, severity: input.severity }; created.push({ input, id: r.id }); return r; },
    update: () => null,
    resolve: () => null,
    get: (id: string) => null,
    addNote: () => null,
  };
}

const FIXED_NOW = Date.parse('2026-05-13T12:00:00Z');

function makeMetricsSource(opts: {
  series?: (args: any) => { points: Array<{ ts: number; value: number }> };
  latest?: (serverId: string) => Array<{ metricType: string; dimension?: string | null; value: number; timestamp: string }>;
}): MetricSource {
  return {
    series: (args) => opts.series ? opts.series(args) : { points: [] },
    latest: (id) => opts.latest ? opts.latest(id) : [],
  };
}

test('PredictiveEngine projects forward and predicts a breach', async () => {
  const store = tmpStore();
  const im = fakeIm();
  // Linear rise from 70 → 80 over the last 60 minutes. Slope ≈ 0.167/min.
  // With horizon=120min → end ≈ 80 + 20 = 100, well above the 90 threshold.
  const series = Array.from({ length: 12 }, (_, i) => ({
    ts: FIXED_NOW - (60 - i * 5) * 60 * 1000,
    value: 70 + (i * 10) / 11,
  }));
  const engine = new PredictiveEngine(
    {
      metrics: makeMetricsSource({
        series: () => ({ points: series }),
        latest: () => [{ metricType: 'cpu', value: 80, timestamp: new Date(FIXED_NOW).toISOString() }],
      }),
      servers: { list: () => [{ id: 'srv-1', name: 'app-01' }] },
      incidentManager: im as any,
      decisionStore: store,
      now: () => FIXED_NOW,
    },
    { regressionWindowMs: 60 * 60 * 1000, horizonMs: 120 * 60 * 1000, minSlopePerMinute: 0.01 },
  );
  const preds = await engine.tickOnce();
  assert.equal(preds.length, 1);
  assert.equal(preds[0].metric, 'cpu');
  assert.equal(preds[0].reason, 'regression');
  assert.ok(preds[0].projectedValue >= 90);
  assert.equal(im.created.length, 1);
  assert.equal(store.list({ kind: 'predict' }).length, 1);
  store.close();
});

test('PredictiveEngine stays quiet on flat metrics', async () => {
  const store = tmpStore();
  const im = fakeIm();
  const flat = Array.from({ length: 12 }, (_, i) => ({
    ts: FIXED_NOW - (60 - i * 5) * 60 * 1000,
    value: 40,
  }));
  const engine = new PredictiveEngine(
    {
      metrics: makeMetricsSource({
        series: () => ({ points: flat }),
        latest: () => [{ metricType: 'cpu', value: 40, timestamp: new Date(FIXED_NOW).toISOString() }],
      }),
      servers: { list: () => [{ id: 'srv-1', name: 'app-01' }] },
      incidentManager: im as any,
      decisionStore: store,
      now: () => FIXED_NOW,
    },
    {},
  );
  const preds = await engine.tickOnce();
  assert.equal(preds.length, 0);
  assert.equal(im.created.length, 0);
  store.close();
});

test('PredictiveEngine raises anomaly for outlier above seasonal baseline', async () => {
  const store = tmpStore();
  const im = fakeIm();
  // Seasonal baseline: stable ~60% at this hour for 14 days.
  // Current sample: 95% — way above mean + 1.5 * stddev AND above 80% of threshold (90).
  // Flat over the last hour so no regression breach triggers.
  const recentFlat = Array.from({ length: 6 }, (_, i) => ({ ts: FIXED_NOW - (30 - i * 5) * 60 * 1000, value: 95 }));
  const seasonal = Array.from({ length: 14 }, (_, i) => ({ ts: FIXED_NOW - i * 24 * 3600 * 1000, value: 60 }));
  let call = 0;
  const engine = new PredictiveEngine(
    {
      metrics: makeMetricsSource({
        series: (args: any) => {
          // First call: regression window. Second call: seasonal lookback.
          call++;
          return call === 1 ? { points: recentFlat } : { points: seasonal };
        },
        latest: () => [{ metricType: 'cpu', value: 95, timestamp: new Date(FIXED_NOW).toISOString() }],
      }),
      servers: { list: () => [{ id: 'srv-1', name: 'app-01' }] },
      incidentManager: im as any,
      decisionStore: store,
      now: () => FIXED_NOW,
    },
    { regressionWindowMs: 60 * 60 * 1000 },
  );
  const preds = await engine.tickOnce();
  assert.equal(preds.length, 1);
  assert.equal(preds[0].reason, 'anomaly');
  store.close();
});

test('PredictiveEngine.trackAccuracy flips outcomes after horizon ends', () => {
  const store = tmpStore();
  // Predicted disk:/ breach at 90% with horizon 30 min, created 2h ago.
  const createdAt = new Date(FIXED_NOW - 2 * 60 * 60 * 1000).toISOString();
  store.insert({
    id: 'p-success',
    kind: 'predict',
    incidentId: 'INC-99',
    confidence: 0.8,
    reasoning: 'x',
    autoApplied: true,
    payload: { serverId: 'srv-1', metric: 'disk', dimension: '/', threshold: 90, horizonMs: 30 * 60 * 1000 },
    createdAt,
  });
  store.insert({
    id: 'p-failed',
    kind: 'predict',
    incidentId: 'INC-98',
    confidence: 0.8,
    reasoning: 'x',
    autoApplied: true,
    payload: { serverId: 'srv-2', metric: 'cpu', dimension: null, threshold: 90, horizonMs: 30 * 60 * 1000 },
    createdAt,
  });

  let queriedFor: any[] = [];
  const engine = new PredictiveEngine(
    {
      metrics: makeMetricsSource({
        series: (args: any) => {
          queriedFor.push(args);
          if (args.serverId === 'srv-1') return { points: [{ ts: FIXED_NOW, value: 95 }] };
          return { points: [{ ts: FIXED_NOW, value: 60 }] };
        },
      }),
      servers: { list: () => [] },
      incidentManager: {} as any,
      decisionStore: store,
      now: () => FIXED_NOW,
    },
    {},
  );
  const out = engine.trackAccuracy();
  assert.equal(out.reviewed, 2);
  assert.equal(out.success, 1);
  assert.equal(out.failed, 1);
  assert.equal(store.get('p-success')?.outcome, 'success');
  assert.equal(store.get('p-failed')?.outcome,  'failed');
  store.close();
});

test('PredictiveEngine.updateConfig flips enabled + thresholds at runtime', () => {
  const store = tmpStore();
  const engine = new PredictiveEngine(
    {
      metrics: makeMetricsSource({}),
      servers: { list: () => [] },
      incidentManager: {} as any,
      decisionStore: store,
    },
    { thresholds: { cpu: 85 } },
  );
  engine.updateConfig({ enabled: false, thresholds: { cpu: 95 } });
  const cfg = engine.getConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.thresholds.cpu, 95);
  store.close();
});

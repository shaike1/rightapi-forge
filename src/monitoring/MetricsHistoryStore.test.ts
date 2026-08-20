import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetricsHistoryStore } from './MetricsHistoryStore.js';

function fresh(retentionDays = 7): MetricsHistoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-metrics-'));
  return new MetricsHistoryStore(path.join(dir, 'metrics.db'), { retentionDays });
}

test('record + series round-trip preserves chronological order', () => {
  const s = fresh();
  const now = Date.now();
  s.record([
    { timestamp: new Date(now - 30_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 12 },
    { timestamp: new Date(now - 20_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 15 },
    { timestamp: new Date(now - 10_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 17 },
  ]);
  const series = s.series({ serverId: 'local', metricType: 'cpu', sinceMs: now - 60_000 });
  assert.equal(series.points.length, 3);
  assert.equal(series.points[0].value, 12);
  assert.equal(series.points[2].value, 17);
  // Strictly increasing timestamps
  assert.ok(series.points[1].ts > series.points[0].ts);
  assert.ok(series.points[2].ts > series.points[1].ts);
});

test('series scopes to the requested server', () => {
  const s = fresh();
  s.record([
    { timestamp: new Date().toISOString(), serverId: 'local', metricType: 'memory', value: 40 },
    { timestamp: new Date().toISOString(), serverId: 'vps2', metricType: 'memory', value: 90 },
  ]);
  const local = s.series({ serverId: 'local', metricType: 'memory' });
  const vps2  = s.series({ serverId: 'vps2',  metricType: 'memory' });
  assert.equal(local.points.length, 1);
  assert.equal(local.points[0].value, 40);
  assert.equal(vps2.points.length, 1);
  assert.equal(vps2.points[0].value, 90);
});

test('series window cutoff drops older samples', () => {
  const s = fresh();
  const now = Date.now();
  s.record([
    { timestamp: new Date(now - 90 * 60_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 1 },
    { timestamp: new Date(now - 5 * 60_000).toISOString(),  serverId: 'local', metricType: 'cpu', value: 2 },
  ]);
  const lastHour = s.series({ serverId: 'local', metricType: 'cpu', sinceMs: now - 60 * 60_000 });
  assert.equal(lastHour.points.length, 1);
  assert.equal(lastHour.points[0].value, 2);
});

test('series respects dimension filter (per-mount disk)', () => {
  const s = fresh();
  s.record([
    { timestamp: new Date().toISOString(), serverId: 'local', metricType: 'disk', value: 60, dimension: '/' },
    { timestamp: new Date().toISOString(), serverId: 'local', metricType: 'disk', value: 85, dimension: '/data' },
  ]);
  const root = s.series({ serverId: 'local', metricType: 'disk', dimension: '/' });
  const data = s.series({ serverId: 'local', metricType: 'disk', dimension: '/data' });
  assert.equal(root.points[0].value, 60);
  assert.equal(data.points[0].value, 85);
});

test('latest returns one row per (metricType, dimension) — newest sample wins', () => {
  const s = fresh();
  const now = Date.now();
  s.record([
    { timestamp: new Date(now - 30_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 10 },
    { timestamp: new Date(now - 10_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 14 },
    { timestamp: new Date(now - 20_000).toISOString(), serverId: 'local', metricType: 'disk', value: 60, dimension: '/' },
    { timestamp: new Date(now - 5_000).toISOString(),  serverId: 'local', metricType: 'disk', value: 70, dimension: '/' },
    { timestamp: new Date(now - 8_000).toISOString(),  serverId: 'local', metricType: 'disk', value: 81, dimension: '/data' },
  ]);
  const latest = s.latest('local');
  // Three rows: cpu (no dimension), disk:/ , disk:/data.
  assert.equal(latest.length, 3);
  const cpu = latest.find(r => r.metricType === 'cpu')!;
  assert.equal(cpu.value, 14, 'newest cpu wins');
  const diskRoot = latest.find(r => r.metricType === 'disk' && r.dimension === '/')!;
  assert.equal(diskRoot.value, 70);
});

test('cleanup drops rows older than the retention window', () => {
  const s = fresh(1); // 1d retention for the test
  const now = Date.now();
  s.record([
    { timestamp: new Date(now - 3 * 86400_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 1 },
    { timestamp: new Date(now - 12 * 3600_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 2 },
  ]);
  assert.equal(s.count(), 2);
  const dropped = s.cleanup();
  assert.equal(dropped, 1);
  assert.equal(s.count(), 1);
});

test('record is a no-op on empty input', () => {
  const s = fresh();
  s.record([]);
  assert.equal(s.count(), 0);
});

test('series caps at the configured limit', () => {
  const s = fresh();
  const now = Date.now();
  const rows = Array.from({ length: 50 }, (_, i) => ({
    timestamp: new Date(now - (50 - i) * 1000).toISOString(),
    serverId: 'local', metricType: 'cpu' as const, value: i,
  }));
  s.record(rows);
  const out = s.series({ serverId: 'local', metricType: 'cpu', limit: 5 });
  assert.equal(out.points.length, 5);
  // Limit returns the OLDEST 5 (we ORDER BY timestamp ASC LIMIT N).
  // That's by design for chart rendering — the caller passes the window
  // they want to see and trusts the store to slice in chronological order.
  assert.equal(out.points[0].value, 0);
});

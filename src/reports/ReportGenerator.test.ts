import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportGenerator, _testing } from './ReportGenerator.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { ServerRegistry } from '../monitoring/ServerRegistry.js';
import { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import { SLAEngine } from '../sla/SLAEngine.js';

function newStack() {
  const dir = mkdtempSync(join(tmpdir(), 'report-gen-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const servers = new ServerRegistry(join(dir, 'servers.db'));
  const metrics = new MetricsHistoryStore(join(dir, 'metrics.db'));
  const sla = new SLAEngine({ dbPath: join(dir, 'sla.db'), incidentManager: incidents });
  servers.upsert({ id: 'local', name: 'Local', isLocal: true });
  servers.upsert({ id: 'web01', name: 'Web 01', host: 'web01' });
  const gen = new ReportGenerator({ incidents, sla, servers, metrics });
  return { dir, incidents, servers, metrics, sla, gen };
}

test('daily_summary: createdInPeriod counts incidents in the last 24h window', () => {
  const { gen, incidents } = newStack();
  incidents.create({ title: 'a', severity: 'high', source: 'manual' });
  incidents.create({ title: 'b', severity: 'low',  source: 'manual' });
  const r = gen.generate('daily_summary');
  assert.equal(r.type, 'daily_summary');
  assert.equal(r.period.label, 'Last 24 hours');
  assert.equal(r.incidents.createdInPeriod, 2);
  assert.equal(r.incidents.activeAtEnd, 2);
});

test('resolvedInPeriod counts only incidents whose resolvedAt falls in window', () => {
  const { gen, incidents } = newStack();
  const a = incidents.create({ title: 'a', severity: 'high', source: 'manual' });
  incidents.resolve(a.id, 'ok');
  const r = gen.generate('daily_summary');
  assert.equal(r.incidents.resolvedInPeriod, 1);
});

test('activeBySeverity buckets correctly', () => {
  const { gen, incidents } = newStack();
  incidents.create({ title: 'c1', severity: 'critical', source: 'manual' });
  incidents.create({ title: 'h1', severity: 'high', source: 'manual' });
  incidents.create({ title: 'h2', severity: 'high', source: 'manual' });
  incidents.create({ title: 'm1', severity: 'medium', source: 'manual' });
  const r = gen.generate('daily_summary');
  assert.deepEqual(r.incidents.activeBySeverity, { critical: 1, high: 2, medium: 1, low: 0 });
});

test('topRecurring buckets similar titles', () => {
  const { gen, incidents } = newStack();
  // Three "Disk full" titles with varying server IDs — fingerprint
  // strips numbers so they collapse into one bucket.
  incidents.create({ title: 'Disk full on web01', severity: 'high', source: 'manual' });
  incidents.create({ title: 'Disk full on web02', severity: 'high', source: 'manual' });
  incidents.create({ title: 'Disk full on web03', severity: 'high', source: 'manual' });
  incidents.create({ title: 'Something else', severity: 'low',  source: 'manual' });
  const r = gen.generate('daily_summary');
  assert.equal(r.incidents.topRecurring.length, 1);
  assert.equal(r.incidents.topRecurring[0].count, 3);
});

test('sla section reports the engine metrics', () => {
  const { gen, incidents, sla } = newStack();
  const inc = incidents.create({ title: 'x', severity: 'medium', source: 'manual' });
  sla.onIncidentCreated(incidents.get(inc.id)!);
  sla.onIncidentResolved(incidents.resolve(inc.id, 'ok')!);
  const r = gen.generate('daily_summary');
  assert.equal(r.sla.overall.total, 1);
  assert.equal(r.sla.overall.resolutionMet, 1);
  assert.equal(r.sla.overall.compliancePercent, 100);
  assert.equal(r.sla.activeBreaches, 0);
});

test('servers section returns one row per registered server with metric averages', () => {
  const { gen, metrics } = newStack();
  // Two CPU samples for local (avg 50), one disk sample at 88 for web01.
  const now = new Date();
  metrics.record([
    { timestamp: new Date(now.getTime() - 60_000).toISOString(), serverId: 'local', metricType: 'cpu', value: 40, dimension: null },
    { timestamp: now.toISOString(), serverId: 'local', metricType: 'cpu', value: 60, dimension: null },
    { timestamp: now.toISOString(), serverId: 'web01', metricType: 'disk', value: 88, dimension: '/data' },
  ]);
  const r = gen.generate('daily_summary');
  const local = r.servers.healthSnapshots.find(s => s.serverId === 'local')!;
  assert.equal(local.avgCpu, 50);
  const web = r.servers.healthSnapshots.find(s => s.serverId === 'web01')!;
  assert.equal(web.avgDisk, 88);
});

test('weekly_report uses a 7-day window', () => {
  const { gen } = newStack();
  const r = gen.generate('weekly_report');
  const start = new Date(r.period.since).getTime();
  const end = new Date(r.period.until).getTime();
  const days = (end - start) / (24 * 60 * 60 * 1000);
  assert.equal(Math.round(days), 7);
});

test('monthly_report uses a 30-day window', () => {
  const { gen } = newStack();
  const r = gen.generate('monthly_report');
  const start = new Date(r.period.since).getTime();
  const end = new Date(r.period.until).getTime();
  const days = (end - start) / (24 * 60 * 60 * 1000);
  assert.equal(Math.round(days), 30);
});

test('titleFingerprint collapses incident IDs and numbers', () => {
  const f = _testing.titleFingerprint;
  assert.equal(f('Disk full on web01'), f('Disk full on web02'));
  assert.equal(f('INC-ABC1234: disk full'), f('INC-XYZ9876: disk full'));
});

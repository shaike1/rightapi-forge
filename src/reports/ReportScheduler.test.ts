import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportScheduler, cronMatches, formatReport } from './ReportScheduler.js';
import { ReportGenerator } from './ReportGenerator.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { ServerRegistry } from '../monitoring/ServerRegistry.js';
import { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import { SLAEngine } from '../sla/SLAEngine.js';
import type { ReportData, DeliveryChannel } from './ReportTypes.js';

function newGenerator() {
  const dir = mkdtempSync(join(tmpdir(), 'rsch-gen-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const servers = new ServerRegistry(join(dir, 'servers.db'));
  servers.upsert({ id: 'local', name: 'Local', isLocal: true });
  const metrics = new MetricsHistoryStore(join(dir, 'metrics.db'));
  const sla = new SLAEngine({ dbPath: join(dir, 'sla.db'), incidentManager: incidents });
  return { generator: new ReportGenerator({ incidents, sla, servers, metrics }), incidents, sla };
}

function newScheduler(opts: { dispatcher?: (ch: DeliveryChannel, r: ReportData) => Promise<{ ok: boolean; detail?: string }> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rsch-test-'));
  const { generator } = newGenerator();
  const calls: Array<{ ch: DeliveryChannel; report: ReportData }> = [];
  const dispatcher = opts.dispatcher ?? (async (ch, report) => { calls.push({ ch, report }); return { ok: true }; });
  const s = new ReportScheduler({ dbPath: join(dir, 'reports.db'), generator, dispatcher });
  return { scheduler: s, calls };
}

// ── Seeding ───────────────────────────────────────────────────────────

test('seeds default schedules on first boot, idempotent on second open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsch-seed-'));
  const { generator } = newGenerator();
  const dispatcher = async () => ({ ok: true });
  const a = new ReportScheduler({ dbPath: join(dir, 'reports.db'), generator, dispatcher });
  const first = a.listSchedules();
  assert.equal(first.length, 2);
  const types = first.map(s => s.reportType).sort();
  assert.deepEqual(types, ['daily_summary', 'weekly_report']);
  a.close();
  const b = new ReportScheduler({ dbPath: join(dir, 'reports.db'), generator, dispatcher });
  assert.equal(b.listSchedules().length, 2, 'no duplicates on second open');
});

// ── CRUD + validation ────────────────────────────────────────────────

test('createSchedule rejects invalid cron expressions', () => {
  const { scheduler } = newScheduler();
  assert.throws(() => scheduler.createSchedule({
    name: 'bad', reportType: 'daily_summary',
    cronExpression: 'not a cron', channels: [{ type: 'chat', config: {} }],
    enabled: true, createdBy: 'u',
  }), /invalid cron/);
});

test('createSchedule rejects empty channels list', () => {
  const { scheduler } = newScheduler();
  assert.throws(() => scheduler.createSchedule({
    name: 'empty', reportType: 'daily_summary',
    cronExpression: '0 8 * * *', channels: [],
    enabled: true, createdBy: 'u',
  }), /at least one delivery channel/);
});

test('createSchedule rejects webhook channel without url', () => {
  const { scheduler } = newScheduler();
  assert.throws(() => scheduler.createSchedule({
    name: 'wh', reportType: 'daily_summary',
    cronExpression: '0 8 * * *', channels: [{ type: 'webhook', config: {} }],
    enabled: true, createdBy: 'u',
  }), /webhook channel requires config.url/);
});

test('createSchedule populates nextRun based on cron expression', () => {
  const { scheduler } = newScheduler();
  const s = scheduler.createSchedule({
    name: 'hourly', reportType: 'daily_summary',
    cronExpression: '0 * * * *',
    channels: [{ type: 'chat', config: {} }],
    enabled: true, createdBy: 'u',
  });
  assert.ok(s.nextRun);
  const ms = new Date(s.nextRun!).getTime();
  assert.ok(ms > Date.now(), 'nextRun must be in the future');
});

test('updateSchedule with new cron recomputes nextRun', () => {
  const { scheduler } = newScheduler();
  const s = scheduler.createSchedule({
    name: 'orig', reportType: 'daily_summary',
    cronExpression: '0 8 * * *',
    channels: [{ type: 'chat', config: {} }],
    enabled: true, createdBy: 'u',
  });
  const updated = scheduler.updateSchedule(s.id, { cronExpression: '*/15 * * * *' })!;
  assert.notEqual(updated.nextRun, s.nextRun);
});

// ── Cron matching ────────────────────────────────────────────────────

test('cronMatches handles "0 8 * * *"', () => {
  // 8:00 AM exact match
  assert.equal(cronMatches('0 8 * * *', new Date(2030, 0, 1, 8, 0)), true);
  // 8:01 — no match (cron is at :00 only)
  assert.equal(cronMatches('0 8 * * *', new Date(2030, 0, 1, 8, 1)), false);
  // 9:00 — no match
  assert.equal(cronMatches('0 8 * * *', new Date(2030, 0, 1, 9, 0)), false);
});

test('cronMatches handles weekday spec', () => {
  // "0 9 * * 0" = 9 AM on Sunday. day=0 in JS getDay().
  const sun = new Date(2030, 0, 6, 9, 0); // 2030-01-06 = Sunday
  const mon = new Date(2030, 0, 7, 9, 0);
  assert.equal(cronMatches('0 9 * * 0', sun), true);
  assert.equal(cronMatches('0 9 * * 0', mon), false);
});

test('cronMatches handles step intervals', () => {
  assert.equal(cronMatches('*/5 * * * *', new Date(2030, 0, 1, 10, 0)), true);
  assert.equal(cronMatches('*/5 * * * *', new Date(2030, 0, 1, 10, 5)), true);
  assert.equal(cronMatches('*/5 * * * *', new Date(2030, 0, 1, 10, 3)), false);
});

// ── Tick dispatch ─────────────────────────────────────────────────────

test('tick fires schedules whose cron matches "now"', async () => {
  const { scheduler, calls } = newScheduler();
  const s = scheduler.createSchedule({
    name: 'minute', reportType: 'daily_summary',
    cronExpression: '* * * * *', // every minute
    channels: [{ type: 'chat', config: {} }],
    enabled: true, createdBy: 'u',
  });
  await scheduler.tick(new Date());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ch.type, 'chat');
  const refreshed = scheduler.getSchedule(s.id)!;
  assert.ok(refreshed.lastRun);
});

test('tick respects last_run debounce — does not double-fire in the same minute', async () => {
  const { scheduler, calls } = newScheduler();
  scheduler.createSchedule({
    name: 'minute', reportType: 'daily_summary',
    cronExpression: '* * * * *',
    channels: [{ type: 'chat', config: {} }],
    enabled: true, createdBy: 'u',
  });
  const now = new Date();
  await scheduler.tick(now);
  await scheduler.tick(now);
  assert.equal(calls.length, 1, 'second tick within the same minute must be skipped');
});

test('tick records partial failures per channel', async () => {
  const dispatcher = async (ch: DeliveryChannel) => {
    return ch.type === 'webhook' ? { ok: false, detail: 'connect refused' } : { ok: true };
  };
  const { scheduler } = newScheduler({ dispatcher });
  scheduler.createSchedule({
    name: 'mixed', reportType: 'daily_summary',
    cronExpression: '* * * * *',
    channels: [
      { type: 'chat', config: {} },
      { type: 'webhook', config: { url: 'http://example' } },
    ],
    enabled: true, createdBy: 'u',
  });
  await scheduler.tick(new Date());
  const hist = scheduler.listHistory(5);
  assert.equal(hist.length, 1);
  const deliveries = hist[0].deliveries;
  assert.equal(deliveries.length, 2);
  const wh = deliveries.find(d => d.channel === 'webhook')!;
  assert.equal(wh.ok, false);
  assert.match(wh.detail!, /connect refused/);
});

test('disabled schedules are skipped', async () => {
  const { scheduler, calls } = newScheduler();
  scheduler.createSchedule({
    name: 'off', reportType: 'daily_summary',
    cronExpression: '* * * * *',
    channels: [{ type: 'chat', config: {} }],
    enabled: false, createdBy: 'u',
  });
  await scheduler.tick(new Date());
  assert.equal(calls.length, 0);
});

// ── Run-once API ──────────────────────────────────────────────────────

test('runOnce returns rendered output and records history', async () => {
  const { scheduler } = newScheduler();
  const r = await scheduler.runOnce({ type: 'daily_summary', format: 'markdown', triggeredBy: 'api:test' });
  assert.equal(r.data.type, 'daily_summary');
  assert.match(r.rendered, /Daily Summary/);
  assert.ok(r.historyId);
  const stored = scheduler.getHistory(r.historyId);
  assert.ok(stored);
});

// ── Formatter ────────────────────────────────────────────────────────

test('formatReport renders each format', async () => {
  const { scheduler } = newScheduler();
  const r = await scheduler.runOnce({ type: 'daily_summary', format: 'markdown', triggeredBy: 'api:test' });
  const md = formatReport(r.data, 'markdown');
  const html = formatReport(r.data, 'html');
  const jsonText = formatReport(r.data, 'json');
  assert.match(md, /^# Daily Summary/m);
  assert.match(html, /<h1>Daily Summary<\/h1>/);
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.type, 'daily_summary');
});

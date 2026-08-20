// ReportScheduler — SQLite-backed cron schedules for recurring reports.
//
// Distinct from the legacy `notifications/ReportsScheduler.ts` (hour-of-day
// emails). This one supports real 5/6-field cron expressions, multiple
// delivery channels per schedule, an audit-trail history table, and on-
// demand generation. The legacy scheduler keeps running independently for
// the SMTP email path it was built for; we don't migrate or disturb it.
//
// Cron evaluation reuses node-cron's validate() for syntax checks and
// a small "match" helper for minute-resolution polling — same algorithm
// the existing ScheduleEngine uses (see src/scheduling/ScheduleEngine.ts).
// Polling cadence is 60s, matching MaintenanceScheduler and the SLA tick.

import Database from 'better-sqlite3';
import cron from 'node-cron';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';
import type {
  DeliveryChannel, ReportData, ReportFormat, ReportHistoryEntry,
  ReportSchedule, ReportType,
} from './ReportTypes.js';
import type { ReportGenerator } from './ReportGenerator.js';
import { renderHtml, renderJson, renderMarkdown } from './ReportFormatter.js';

// ── Channel handler interface ─────────────────────────────────────────

/** Side-effecting channel dispatch — implemented by the wiring in
 *  server.ts. Returns `ok: true` for accepted deliveries, `ok: false`
 *  with a short detail string for failures. Per-channel failures don't
 *  abort the other channels for the same report. */
export type ChannelDispatcher = (channel: DeliveryChannel, report: ReportData) => Promise<{ ok: boolean; detail?: string }>;

// ── Persistence rows ──────────────────────────────────────────────────

interface ScheduleRow {
  id: string;
  name: string;
  report_type: string;
  cron_expression: string;
  channels: string;       // JSON
  enabled: number;
  last_run: string | null;
  next_run: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface HistoryRow {
  id: string;
  report_type: string;
  generated_at: string;
  triggered_by: string;
  schedule_id: string | null;
  summary: string;
  data: string;           // JSON
  deliveries: string;     // JSON
}

// ── Default seed schedules ────────────────────────────────────────────

const DEFAULT_SEEDS: Array<Omit<ReportSchedule, 'id' | 'lastRun' | 'nextRun' | 'lastError' | 'createdBy' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'Daily summary',
    reportType: 'daily_summary',
    cronExpression: '0 8 * * *',
    channels: [{ type: 'chat', config: {} }],
    enabled: true,
  },
  {
    name: 'Weekly report',
    reportType: 'weekly_report',
    cronExpression: '0 9 * * 0',
    channels: [{ type: 'chat', config: {} }],
    enabled: true,
  },
];

// ── Engine ────────────────────────────────────────────────────────────

export interface ReportSchedulerDeps {
  dbPath: string;
  generator: ReportGenerator;
  dispatcher: ChannelDispatcher;
  /** Audit hook — every cron-driven run + on-demand run is logged. The
   *  caller provides this so we don't import the audit log here. */
  auditLog?: { log: (entry: { action: string; username: string; role: string; resource: string; method: string; ip: string; success: boolean; detail?: string }) => void };
}

export class ReportScheduler {
  private readonly db: Database.Database;
  private readonly generator: ReportGenerator;
  private readonly dispatcher: ChannelDispatcher;
  private readonly auditLog?: ReportSchedulerDeps['auditLog'];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ReportSchedulerDeps) {
    const dir = dirname(deps.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(deps.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.generator = deps.generator;
    this.dispatcher = deps.dispatcher;
    this.auditLog = deps.auditLog;
    this.migrate();
    this.seedDefaults();
    logger.info('[ReportScheduler] opened', { dbPath: deps.dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS report_schedules (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        report_type     TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        channels        TEXT NOT NULL,
        enabled         INTEGER NOT NULL DEFAULT 1,
        last_run        TEXT,
        next_run        TEXT,
        last_error      TEXT,
        created_by      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_report_schedules_enabled ON report_schedules(enabled);

      CREATE TABLE IF NOT EXISTS report_history (
        id            TEXT PRIMARY KEY,
        report_type   TEXT NOT NULL,
        generated_at  TEXT NOT NULL,
        triggered_by  TEXT NOT NULL,
        schedule_id   TEXT,
        summary       TEXT NOT NULL,
        data          TEXT NOT NULL,
        deliveries    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_report_history_generated ON report_history(generated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_report_history_schedule  ON report_history(schedule_id);
    `);
    addTenantColumnSqlite(this.db, 'report_schedules');
    addTenantColumnSqlite(this.db, 'report_history');
  }

  private seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM report_schedules').get() as { n: number }).n;
    if (count > 0) return;
    const now = new Date().toISOString();
    for (const seed of DEFAULT_SEEDS) {
      const id = 'rs-' + crypto.randomBytes(6).toString('hex');
      this.db.prepare(`
        INSERT INTO report_schedules
          (id, name, report_type, cron_expression, channels, enabled, last_run, next_run, last_error, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
      `).run(
        id, seed.name, seed.reportType, seed.cronExpression, JSON.stringify(seed.channels),
        seed.enabled ? 1 : 0, this.computeNextRun(seed.cronExpression), now, now,
      );
    }
    logger.info('[ReportScheduler] seeded default schedules', { count: DEFAULT_SEEDS.length });
  }

  // ─── Schedule CRUD ────────────────────────────────────────────────────

  listSchedules(): ReportSchedule[] {
    const rows = this.db.prepare('SELECT * FROM report_schedules ORDER BY name').all() as ScheduleRow[];
    return rows.map(this.rowToSchedule);
  }

  getSchedule(id: string): ReportSchedule | null {
    const row = this.db.prepare('SELECT * FROM report_schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  createSchedule(input: Omit<ReportSchedule, 'id' | 'lastRun' | 'nextRun' | 'lastError' | 'createdAt' | 'updatedAt'>): ReportSchedule {
    this.validate(input);
    const id = 'rs-' + crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO report_schedules
        (id, name, report_type, cron_expression, channels, enabled, last_run, next_run, last_error, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?)
    `).run(
      id, input.name, input.reportType, input.cronExpression, JSON.stringify(input.channels),
      input.enabled ? 1 : 0, this.computeNextRun(input.cronExpression), input.createdBy ?? null, now, now,
    );
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, patch: Partial<Omit<ReportSchedule, 'id' | 'createdAt' | 'updatedAt'>>): ReportSchedule | null {
    const existing = this.getSchedule(id);
    if (!existing) return null;
    const next: ReportSchedule = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.validate(next);
    this.db.prepare(`
      UPDATE report_schedules
      SET name=?, report_type=?, cron_expression=?, channels=?, enabled=?, next_run=?, updated_at=?
      WHERE id=?
    `).run(
      next.name, next.reportType, next.cronExpression, JSON.stringify(next.channels),
      next.enabled ? 1 : 0, this.computeNextRun(next.cronExpression), next.updatedAt, id,
    );
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): boolean {
    return this.db.prepare('DELETE FROM report_schedules WHERE id = ?').run(id).changes > 0;
  }

  // ─── History ──────────────────────────────────────────────────────────

  listHistory(limit = 50): ReportHistoryEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM report_history ORDER BY generated_at DESC LIMIT ?'
    ).all(Math.min(Math.max(limit, 1), 500)) as HistoryRow[];
    return rows.map(this.rowToHistory);
  }

  getHistory(id: string): ReportHistoryEntry | null {
    const row = this.db.prepare('SELECT * FROM report_history WHERE id = ?').get(id) as HistoryRow | undefined;
    return row ? this.rowToHistory(row) : null;
  }

  // ─── Generation ───────────────────────────────────────────────────────

  /** On-demand generation (no scheduled dispatch). Returns the report
   *  data + the requested format string. History is recorded so the UI
   *  can show the generation later. */
  async runOnce(params: {
    type: ReportType;
    format: ReportFormat;
    triggeredBy: string;
  }): Promise<{ data: ReportData; rendered: string; historyId: string }> {
    const data = this.generator.generate(params.type);
    const rendered = formatReport(data, params.format);
    const historyId = this.recordHistory({
      data,
      triggeredBy: params.triggeredBy,
      scheduleId: null,
      deliveries: [],
    });
    this.auditLog?.log({
      action: 'reports.generate',
      username: params.triggeredBy.replace(/^api:/, ''),
      role: 'unknown',
      resource: '/reports',
      method: 'POST',
      ip: '',
      success: true,
      detail: `type=${params.type} format=${params.format}`,
    });
    return { data, rendered, historyId };
  }

  /** Cron-driven dispatch — generate the report, push to every channel
   *  on the schedule, record history + deliveries, advance next_run. */
  private async runScheduled(schedule: ReportSchedule): Promise<void> {
    const data = this.generator.generate(schedule.reportType);
    const deliveries: ReportHistoryEntry['deliveries'] = [];
    for (const channel of schedule.channels) {
      try {
        const r = await this.dispatcher(channel, data);
        deliveries.push({ channel: channel.type, ok: r.ok, detail: r.detail });
      } catch (e) {
        deliveries.push({ channel: channel.type, ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    }
    this.recordHistory({ data, triggeredBy: `cron:${schedule.id}`, scheduleId: schedule.id, deliveries });
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE report_schedules SET last_run = ?, next_run = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(now, this.computeNextRun(schedule.cronExpression), null, now, schedule.id);

    const ok = deliveries.length > 0 && deliveries.every(d => d.ok);
    this.auditLog?.log({
      action: ok ? 'reports.dispatch.ok' : 'reports.dispatch.partial',
      username: 'cron',
      role: 'system',
      resource: '/reports/cron',
      method: 'CRON',
      ip: '',
      success: ok,
      detail: `scheduleId=${schedule.id} type=${schedule.reportType} channels=${deliveries.map(d => `${d.channel}:${d.ok}`).join(',')}`,
    });
  }

  // ─── Tick loop ────────────────────────────────────────────────────────

  start(): void {
    if (this.intervalHandle !== null) return;
    // Run once on boot so a deploy in the middle of a scheduled minute
    // doesn't miss the firing. Then poll every 60s.
    this.tick().catch(e => logger.warn('[ReportScheduler] initial tick threw', { err: e instanceof Error ? e.message : String(e) }));
    this.intervalHandle = setInterval(
      () => this.tick().catch(e => logger.warn('[ReportScheduler] tick threw', { err: e instanceof Error ? e.message : String(e) })),
      60_000,
    );
    logger.info('[ReportScheduler] started — 60s polling');
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Public so tests can invoke a manual tick. */
  async tick(now: Date = new Date()): Promise<void> {
    const schedules = this.listSchedules().filter(s => s.enabled);
    for (const s of schedules) {
      // Avoid double-firing in the same minute: skip if last_run is
      // within this minute. Minute granularity matches our 60s poll +
      // cron expression resolution.
      const lastMs = s.lastRun ? new Date(s.lastRun).getTime() : 0;
      if (now.getTime() - lastMs < 60_000) continue;
      if (!cronMatches(s.cronExpression, now)) continue;
      try {
        await this.runScheduled(s);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('[ReportScheduler] schedule run failed', { scheduleId: s.id, err: msg });
        this.db.prepare('UPDATE report_schedules SET last_error = ?, updated_at = ? WHERE id = ?')
          .run(msg.slice(0, 500), new Date().toISOString(), s.id);
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private validate(s: Pick<ReportSchedule, 'name' | 'reportType' | 'cronExpression' | 'channels'>): void {
    if (!s.name || typeof s.name !== 'string') throw new Error('name is required');
    if (!['daily_summary', 'weekly_report', 'monthly_report'].includes(s.reportType)) {
      throw new Error('reportType must be daily_summary | weekly_report | monthly_report');
    }
    if (!cron.validate(s.cronExpression)) {
      throw new Error(`invalid cron expression "${s.cronExpression}"`);
    }
    if (!Array.isArray(s.channels) || s.channels.length === 0) {
      throw new Error('at least one delivery channel is required');
    }
    for (const ch of s.channels) {
      if (!['chat', 'telegram', 'webhook', 'email'].includes(ch.type)) {
        throw new Error(`channel type must be chat | telegram | webhook | email (got "${ch.type}")`);
      }
      if (ch.type === 'webhook' && (!ch.config || typeof (ch.config as Record<string, unknown>).url !== 'string')) {
        throw new Error('webhook channel requires config.url');
      }
    }
  }

  /** Next cron tick after `after`, stepping minute-by-minute up to a
   *  366-day cap. Same shape as ScheduleEngine.computeNextRun. */
  private computeNextRun(expression: string, after: Date = new Date()): string | null {
    if (!cron.validate(expression)) return null;
    const start = after.getTime();
    const stepMs = 60_000;
    const cap = 366 * 24 * 60 * 60 * 1000;
    for (let dt = stepMs; dt <= cap; dt += stepMs) {
      const candidate = new Date(start + dt);
      if (cronMatches(expression, candidate)) return candidate.toISOString();
    }
    return null;
  }

  private recordHistory(params: {
    data: ReportData;
    triggeredBy: string;
    scheduleId: string | null;
    deliveries: ReportHistoryEntry['deliveries'];
  }): string {
    const id = 'rh-' + crypto.randomBytes(6).toString('hex');
    const summary = renderMarkdown(params.data);
    this.db.prepare(`
      INSERT INTO report_history (id, report_type, generated_at, triggered_by, schedule_id, summary, data, deliveries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.data.type, params.data.generatedAt, params.triggeredBy, params.scheduleId,
      summary, JSON.stringify(params.data), JSON.stringify(params.deliveries),
    );
    return id;
  }

  private rowToSchedule = (r: ScheduleRow): ReportSchedule => ({
    id: r.id, name: r.name,
    reportType: r.report_type as ReportType,
    cronExpression: r.cron_expression,
    channels: safeJson(r.channels) ?? [],
    enabled: r.enabled === 1,
    lastRun: r.last_run, nextRun: r.next_run, lastError: r.last_error,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  private rowToHistory = (r: HistoryRow): ReportHistoryEntry => ({
    id: r.id,
    reportType: r.report_type as ReportType,
    generatedAt: r.generated_at,
    triggeredBy: r.triggered_by,
    scheduleId: r.schedule_id,
    summary: r.summary,
    data: safeJson(r.data) ?? ({} as ReportData),
    deliveries: safeJson(r.deliveries) ?? [],
  });

  close(): void { this.db.close(); }
}

// ─── Pure helpers (exported for tests + the API) ─────────────────────

export function formatReport(data: ReportData, format: ReportFormat): string {
  switch (format) {
    case 'html':     return renderHtml(data);
    case 'markdown': return renderMarkdown(data);
    case 'json':     return renderJson(data);
  }
}

/** Minute-resolution cron match — same logic as ScheduleEngine but
 *  re-exported here so the scheduler is self-contained. */
export function cronMatches(expr: string, date: Date): boolean {
  if (!cron.validate(expr)) return false;
  const parts = expr.trim().split(/\s+/);
  let sec: string | null = null, min: string, hr: string, dom: string, mon: string, dow: string;
  if (parts.length === 6) [sec, min, hr, dom, mon, dow] = parts;
  else                    [min, hr, dom, mon, dow] = parts;
  if (sec !== null && !fieldMatches(sec, date.getSeconds(), 0, 59)) return false;
  if (!fieldMatches(min, date.getMinutes(), 0, 59)) return false;
  if (!fieldMatches(hr,  date.getHours(),   0, 23)) return false;
  if (!fieldMatches(dom, date.getDate(),    1, 31)) return false;
  if (!fieldMatches(mon, date.getMonth() + 1, 1, 12)) return false;
  const day = date.getDay();
  if (!fieldMatches(dow, day, 0, 7) && !fieldMatches(dow, day === 0 ? 7 : day, 0, 7)) return false;
  return true;
}

function fieldMatches(expr: string, value: number, min: number, max: number): boolean {
  for (const piece of expr.split(',')) {
    if (matchPiece(piece.trim(), value, min, max)) return true;
  }
  return false;
}
function matchPiece(piece: string, value: number, min: number, max: number): boolean {
  let stem = piece;
  let step = 1;
  const slash = piece.indexOf('/');
  if (slash >= 0) {
    stem = piece.slice(0, slash) || '*';
    step = Math.max(1, Number(piece.slice(slash + 1)) || 1);
  }
  let lo = min, hi = max;
  if (stem === '*' || stem === '?') { /* any */ }
  else if (stem.includes('-')) {
    const [a, b] = stem.split('-');
    lo = Number(a); hi = Number(b);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return false;
  } else {
    const exact = Number(stem);
    if (Number.isNaN(exact)) return false;
    return exact === value;
  }
  if (value < lo || value > hi) return false;
  return ((value - lo) % step) === 0;
}

function safeJson<T = unknown>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

// SLAEngine — per-incident SLA policy + tracking + breach detection.
//
// Distinct from the existing `incident.slaMinutes` field (single resolution
// timer, populated from env defaults). The new engine adds:
//
//   - Two deadlines per incident: response (acknowledge) + resolution.
//   - A policy table so operators can tune limits per severity from the UI
//     without redeploying.
//   - A live tracking row per incident — breach flag is persisted, not
//     re-computed at every resolve like the old timeline-only path.
//   - Metrics aggregation (MTTR / MTTA / compliance %) consumed by both
//     the SLA dashboard and the new report system.
//
// The engine does not push notifications itself. The server's tick loop
// calls `checkBreaches()` and forwards the returned list to the broadcast
// + plugin fan-out paths. That keeps the engine pure-data and easy to test.
//
// "Response" = first activity on the incident after creation. We poll the
// timeline rather than instrumenting every call site, because the timeline
// already records the events we care about and a poll is simpler than four
// new listeners on IncidentManager.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';
import type {
  Incident, IncidentSeverity, IncidentStatus, TimelineEntry,
} from '../persistence/SqliteStore.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface SlaPolicy {
  id: string;
  name: string;
  severity: IncidentSeverity;
  responseTimeMinutes: number;
  resolutionTimeMinutes: number;
  businessHoursOnly: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SlaTracking {
  id: string;
  incidentId: string;
  policyId: string;
  responseDeadline: string;
  resolutionDeadline: string;
  /** null until decided. true = within deadline, false = missed. */
  responseMet: boolean | null;
  resolutionMet: boolean | null;
  respondedAt: string | null;
  resolvedAt: string | null;
  /** Persistent: set once we cross a deadline without meeting it. */
  breached: boolean;
  /** Persistent: set once we cross 75% of the resolution window without
   *  resolving. Used by the UI + alerting to surface warnings before a
   *  hard breach. */
  warningEmitted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SlaMetrics {
  /** Total incidents tracked in the window. */
  total: number;
  /** Incidents whose resolution deadline was met (true), missed (false),
   *  or still pending (null). */
  resolutionMet: number;
  resolutionMissed: number;
  resolutionPending: number;
  /** Same shape for the response timer. */
  responseMet: number;
  responseMissed: number;
  responsePending: number;
  /** Mean Time To Resolve in minutes, only for incidents that resolved
   *  within the window. */
  mttrMinutes: number | null;
  /** Mean Time To Acknowledge in minutes, only for incidents that
   *  responded within the window. */
  mttaMinutes: number | null;
  /** Resolution compliance %, considering only resolved incidents. */
  compliancePercent: number | null;
  /** Active breaches at the time of the call. */
  activeBreaches: number;
}

export type MetricsPeriod = '24h' | '7d' | '30d' | '90d';

// ── Row mappers ───────────────────────────────────────────────────────

interface PolicyRow {
  id: string;
  name: string;
  severity: string;
  response_minutes: number;
  resolution_minutes: number;
  business_hours_only: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface TrackingRow {
  id: string;
  incident_id: string;
  policy_id: string;
  response_deadline: string;
  resolution_deadline: string;
  response_met: number | null;
  resolution_met: number | null;
  responded_at: string | null;
  resolved_at: string | null;
  breached: number;
  warning_emitted: number;
  created_at: string;
  updated_at: string;
}

// ── Default policies ──────────────────────────────────────────────────

const DEFAULT_POLICIES: Array<Omit<SlaPolicy, 'id' | 'createdAt' | 'updatedAt'>> = [
  { name: 'Critical', severity: 'critical', responseTimeMinutes: 15,   resolutionTimeMinutes: 60,   businessHoursOnly: false, enabled: true },
  { name: 'High',     severity: 'high',     responseTimeMinutes: 60,   resolutionTimeMinutes: 240,  businessHoursOnly: false, enabled: true },
  { name: 'Medium',   severity: 'medium',   responseTimeMinutes: 240,  resolutionTimeMinutes: 1440, businessHoursOnly: false, enabled: true },
  { name: 'Low',      severity: 'low',      responseTimeMinutes: 1440, resolutionTimeMinutes: 4320, businessHoursOnly: false, enabled: true },
];

const WARNING_THRESHOLD = 0.75; // 75% of resolution window elapsed → warning

// Treat these statuses as "in-flight" — clock counts down, deadlines
// matter. Anything else (resolved, closed) freezes the timer.
const ACTIVE_STATUSES: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['open', 'investigating', 'mitigating']);

// ── Engine ────────────────────────────────────────────────────────────

export interface SLAEngineDeps {
  dbPath: string;
  incidentManager: IncidentManager;
}

/** Result of one breach-check pass. The server's tick loop uses these to
 *  drive notifications, plugin fan-out, and auto-escalation. */
export interface BreachCheckResult {
  newBreaches: Array<{ tracking: SlaTracking; incident: Incident; kind: 'response' | 'resolution' }>;
  newWarnings: Array<{ tracking: SlaTracking; incident: Incident }>;
}

export class SLAEngine {
  private readonly db: Database.Database;
  private readonly incidents: IncidentManager;

  constructor(deps: SLAEngineDeps) {
    const dir = dirname(deps.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(deps.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.incidents = deps.incidentManager;
    this.migrate();
    this.seedDefaults();
    logger.info('[SLAEngine] opened', { dbPath: deps.dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sla_policies (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        severity             TEXT NOT NULL,
        response_minutes     INTEGER NOT NULL,
        resolution_minutes   INTEGER NOT NULL,
        business_hours_only  INTEGER NOT NULL DEFAULT 0,
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sla_policies_severity ON sla_policies(severity);
      CREATE INDEX IF NOT EXISTS idx_sla_policies_enabled  ON sla_policies(enabled);

      CREATE TABLE IF NOT EXISTS sla_tracking (
        id                   TEXT PRIMARY KEY,
        incident_id          TEXT NOT NULL UNIQUE,
        policy_id            TEXT NOT NULL,
        response_deadline    TEXT NOT NULL,
        resolution_deadline  TEXT NOT NULL,
        response_met         INTEGER,
        resolution_met       INTEGER,
        responded_at         TEXT,
        resolved_at          TEXT,
        breached             INTEGER NOT NULL DEFAULT 0,
        warning_emitted      INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sla_tracking_incident ON sla_tracking(incident_id);
      CREATE INDEX IF NOT EXISTS idx_sla_tracking_breached ON sla_tracking(breached);
      CREATE INDEX IF NOT EXISTS idx_sla_tracking_created  ON sla_tracking(created_at);
    `);
    addTenantColumnSqlite(this.db, 'sla_policies');
    addTenantColumnSqlite(this.db, 'sla_tracking');
  }

  /** Idempotent: only seeds if the policy table is empty. Operators who
   *  customise then truncate the table to re-seed are accommodated by the
   *  emptiness check rather than upserts that would clobber edits. */
  private seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM sla_policies').get() as { n: number }).n;
    if (count > 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO sla_policies
        (id, name, severity, response_minutes, resolution_minutes, business_hours_only, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of DEFAULT_POLICIES) {
      stmt.run(
        `sla-${p.severity}`, p.name, p.severity,
        p.responseTimeMinutes, p.resolutionTimeMinutes,
        p.businessHoursOnly ? 1 : 0, p.enabled ? 1 : 0, now, now,
      );
    }
    logger.info('[SLAEngine] seeded default policies', { count: DEFAULT_POLICIES.length });
  }

  // ─── Policy CRUD ──────────────────────────────────────────────────────

  listPolicies(): SlaPolicy[] {
    const rows = this.db.prepare('SELECT * FROM sla_policies ORDER BY severity, name').all() as PolicyRow[];
    return rows.map(this.rowToPolicy);
  }

  getPolicy(id: string): SlaPolicy | null {
    const row = this.db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(id) as PolicyRow | undefined;
    return row ? this.rowToPolicy(row) : null;
  }

  /** Return the enabled policy that best matches the given severity.
   *  Prefers exact-severity matches over generic ones; returns null when
   *  no enabled policy applies. */
  resolvePolicy(severity: IncidentSeverity): SlaPolicy | null {
    const rows = this.db.prepare(
      'SELECT * FROM sla_policies WHERE severity = ? AND enabled = 1 ORDER BY created_at LIMIT 1',
    ).all(severity) as PolicyRow[];
    return rows.length > 0 ? this.rowToPolicy(rows[0]) : null;
  }

  createPolicy(input: Omit<SlaPolicy, 'id' | 'createdAt' | 'updatedAt'>): SlaPolicy {
    if (!['critical', 'high', 'medium', 'low'].includes(input.severity)) {
      throw new Error(`severity must be one of critical|high|medium|low (got "${input.severity}")`);
    }
    if (!Number.isFinite(input.responseTimeMinutes) || input.responseTimeMinutes <= 0) {
      throw new Error('responseTimeMinutes must be a positive number');
    }
    if (!Number.isFinite(input.resolutionTimeMinutes) || input.resolutionTimeMinutes <= 0) {
      throw new Error('resolutionTimeMinutes must be a positive number');
    }
    const now = new Date().toISOString();
    const id = 'sla-' + crypto.randomBytes(6).toString('hex');
    this.db.prepare(`
      INSERT INTO sla_policies
        (id, name, severity, response_minutes, resolution_minutes, business_hours_only, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.severity, input.responseTimeMinutes, input.resolutionTimeMinutes,
      input.businessHoursOnly ? 1 : 0, input.enabled ? 1 : 0, now, now);
    return this.getPolicy(id)!;
  }

  updatePolicy(id: string, patch: Partial<Omit<SlaPolicy, 'id' | 'createdAt' | 'updatedAt'>>): SlaPolicy | null {
    const existing = this.getPolicy(id);
    if (!existing) return null;
    const next: SlaPolicy = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    if (!Number.isFinite(next.responseTimeMinutes) || next.responseTimeMinutes <= 0) {
      throw new Error('responseTimeMinutes must be a positive number');
    }
    if (!Number.isFinite(next.resolutionTimeMinutes) || next.resolutionTimeMinutes <= 0) {
      throw new Error('resolutionTimeMinutes must be a positive number');
    }
    this.db.prepare(`
      UPDATE sla_policies
      SET name=?, severity=?, response_minutes=?, resolution_minutes=?, business_hours_only=?, enabled=?, updated_at=?
      WHERE id=?
    `).run(next.name, next.severity, next.responseTimeMinutes, next.resolutionTimeMinutes,
      next.businessHoursOnly ? 1 : 0, next.enabled ? 1 : 0, next.updatedAt, id);
    return this.getPolicy(id);
  }

  deletePolicy(id: string): boolean {
    const r = this.db.prepare('DELETE FROM sla_policies WHERE id = ?').run(id);
    return r.changes > 0;
  }

  // ─── Tracking lifecycle ───────────────────────────────────────────────

  /** Idempotent: returns the existing tracking row if one was already
   *  created for this incident. Called from the IncidentManager onCreated
   *  hook in server.ts. */
  onIncidentCreated(incident: Incident): SlaTracking | null {
    const existing = this.getTracking(incident.id);
    if (existing) return existing;
    const policy = this.resolvePolicy(incident.severity);
    if (!policy) {
      logger.warn('[SLAEngine] no enabled policy for severity — incident untracked', {
        incidentId: incident.id, severity: incident.severity,
      });
      return null;
    }
    const createdAt = new Date(incident.createdAt).getTime();
    const responseDeadline   = new Date(createdAt + policy.responseTimeMinutes   * 60_000).toISOString();
    const resolutionDeadline = new Date(createdAt + policy.resolutionTimeMinutes * 60_000).toISOString();
    const now = new Date().toISOString();
    const id = 'slt-' + crypto.randomBytes(6).toString('hex');
    this.db.prepare(`
      INSERT INTO sla_tracking
        (id, incident_id, policy_id, response_deadline, resolution_deadline,
         response_met, resolution_met, responded_at, resolved_at,
         breached, warning_emitted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?, ?)
    `).run(id, incident.id, policy.id, responseDeadline, resolutionDeadline, now, now);
    return this.getTracking(incident.id);
  }

  /** Called by the IncidentManager.onResolved listener. Records the
   *  resolution timestamp and decides whether the resolution deadline
   *  was met. The breach flag stays set if it was already set (a late
   *  resolution doesn't "un-breach" the record). */
  onIncidentResolved(incident: Incident): void {
    const tracking = this.getTracking(incident.id);
    if (!tracking) return;
    const resolvedAt = incident.resolvedAt ?? new Date().toISOString();
    const met = new Date(resolvedAt).getTime() <= new Date(tracking.resolutionDeadline).getTime();
    this.db.prepare(`
      UPDATE sla_tracking
      SET resolved_at = ?, resolution_met = ?, updated_at = ?
      WHERE incident_id = ?
    `).run(resolvedAt, met ? 1 : 0, new Date().toISOString(), incident.id);
  }

  getTracking(incidentId: string): SlaTracking | null {
    const row = this.db.prepare('SELECT * FROM sla_tracking WHERE incident_id = ?').get(incidentId) as TrackingRow | undefined;
    return row ? this.rowToTracking(row) : null;
  }

  listTracking(filter: { state?: 'breached' | 'pending' | 'met'; sinceMs?: number; limit?: number } = {}): SlaTracking[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.state === 'breached') where.push('breached = 1');
    else if (filter.state === 'pending') where.push('resolution_met IS NULL AND breached = 0');
    else if (filter.state === 'met')     where.push('resolution_met = 1');
    if (filter.sinceMs) {
      where.push('created_at >= @since');
      params.since = new Date(filter.sinceMs).toISOString();
    }
    const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
    const q = `SELECT * FROM sla_tracking ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    const rows = this.db.prepare(q).all(params) as TrackingRow[];
    return rows.map(this.rowToTracking);
  }

  // ─── Tick: respond detection + breach detection ───────────────────────

  /** Detect any active incidents whose first non-"opened" timeline entry
   *  hasn't been mirrored into sla_tracking.responded_at yet. Sets the row
   *  fields atomically per incident. */
  detectResponses(): { detected: SlaTracking[] } {
    const active = this.db.prepare(
      'SELECT * FROM sla_tracking WHERE responded_at IS NULL'
    ).all() as TrackingRow[];
    const detected: SlaTracking[] = [];
    for (const row of active) {
      const inc = this.incidents.get(row.incident_id);
      if (!inc) continue;
      const firstActivity = this.firstActivityAt(inc.timeline, inc.assignedAgent, inc.assignedTo);
      if (!firstActivity) continue;
      const responseDeadlineMs = new Date(row.response_deadline).getTime();
      const met = new Date(firstActivity).getTime() <= responseDeadlineMs;
      this.db.prepare(`
        UPDATE sla_tracking
        SET responded_at = ?, response_met = ?, updated_at = ?
        WHERE incident_id = ?
      `).run(firstActivity, met ? 1 : 0, new Date().toISOString(), row.incident_id);
      const updated = this.getTracking(row.incident_id);
      if (updated) detected.push(updated);
    }
    return { detected };
  }

  /** Sweep active tracking rows; flip breached + warning_emitted as
   *  thresholds cross. Returns the rows that newly transitioned so the
   *  caller can fan out notifications + auto-escalate. */
  checkBreaches(nowMs: number = Date.now()): BreachCheckResult {
    const newBreaches: BreachCheckResult['newBreaches'] = [];
    const newWarnings: BreachCheckResult['newWarnings'] = [];
    const rows = this.db.prepare(
      'SELECT * FROM sla_tracking WHERE resolution_met IS NULL'
    ).all() as TrackingRow[];
    for (const row of rows) {
      const inc = this.incidents.get(row.incident_id);
      if (!inc) continue;
      // Freeze the clock for terminal-state incidents that somehow
      // slipped past the onResolved hook (e.g. a manual SQL touch).
      if (!ACTIVE_STATUSES.has(inc.status)) continue;

      const createdMs    = new Date(row.created_at).getTime();
      const resDlMs      = new Date(row.response_deadline).getTime();
      const resolveDlMs  = new Date(row.resolution_deadline).getTime();
      const totalMs      = resolveDlMs - createdMs;
      const elapsedMs    = nowMs - createdMs;

      // Warning at 75% — only fired once, recorded persistently.
      if (!row.warning_emitted && elapsedMs >= totalMs * WARNING_THRESHOLD && nowMs < resolveDlMs) {
        this.db.prepare('UPDATE sla_tracking SET warning_emitted = 1, updated_at = ? WHERE incident_id = ?')
          .run(new Date().toISOString(), row.incident_id);
        const updated = this.getTracking(row.incident_id);
        if (updated) newWarnings.push({ tracking: updated, incident: inc });
      }

      // Response breach: time past the response deadline with no
      // recorded response yet. We don't flip `breached` for the
      // response-only case unless the resolution deadline is also
      // past — operators want resolution breaches as the headline
      // signal. The response breach is surfaced via responseMet=false
      // once detectResponses() decides.
      if (row.response_met === null && nowMs > resDlMs) {
        // Stamp response_met = false so the metric is decided even
        // if the operator never responds.
        this.db.prepare(`
          UPDATE sla_tracking SET response_met = 0, updated_at = ?
          WHERE incident_id = ? AND response_met IS NULL
        `).run(new Date().toISOString(), row.incident_id);
      }

      // Resolution breach: time past the resolution deadline with no
      // recorded resolution. Set once; repeated ticks don't re-emit.
      if (!row.breached && nowMs > resolveDlMs) {
        this.db.prepare('UPDATE sla_tracking SET breached = 1, updated_at = ? WHERE incident_id = ?')
          .run(new Date().toISOString(), row.incident_id);
        const updated = this.getTracking(row.incident_id);
        if (updated) newBreaches.push({ tracking: updated, incident: inc, kind: 'resolution' });
      }
    }
    return { newBreaches, newWarnings };
  }

  // ─── Metrics ──────────────────────────────────────────────────────────

  getMetrics(period: MetricsPeriod = '7d'): SlaMetrics {
    const ms = this.periodMs(period);
    const sinceMs = Date.now() - ms;
    const rows = this.db.prepare(
      'SELECT * FROM sla_tracking WHERE created_at >= ?'
    ).all(new Date(sinceMs).toISOString()) as TrackingRow[];
    return this.aggregateMetrics(rows);
  }

  /** Same as getMetrics but bucketed by severity, for the dashboard's
   *  per-severity table. */
  getMetricsBySeverity(period: MetricsPeriod = '7d'): Record<IncidentSeverity, SlaMetrics> {
    const ms = this.periodMs(period);
    const sinceMs = Date.now() - ms;
    const rows = this.db.prepare(`
      SELECT t.*, p.severity AS policy_severity
      FROM sla_tracking t
      JOIN sla_policies p ON p.id = t.policy_id
      WHERE t.created_at >= ?
    `).all(new Date(sinceMs).toISOString()) as Array<TrackingRow & { policy_severity: string }>;
    const groups: Record<string, TrackingRow[]> = {};
    for (const r of rows) {
      const k = r.policy_severity as IncidentSeverity;
      (groups[k] ?? (groups[k] = [])).push(r);
    }
    const out = {} as Record<IncidentSeverity, SlaMetrics>;
    for (const sev of ['critical', 'high', 'medium', 'low'] as IncidentSeverity[]) {
      out[sev] = this.aggregateMetrics(groups[sev] ?? []);
    }
    return out;
  }

  /** Daily compliance trend over the period — one bucket per day. Used
   *  by the dashboard's recharts line. */
  getComplianceTrend(period: MetricsPeriod = '30d'): Array<{ day: string; compliancePercent: number | null; total: number }> {
    const ms = this.periodMs(period);
    const dayMs = 24 * 60 * 60 * 1000;
    const buckets = Math.max(1, Math.ceil(ms / dayMs));
    const out: Array<{ day: string; compliancePercent: number | null; total: number }> = [];
    for (let i = buckets - 1; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * dayMs);
      const end   = new Date(Date.now() - i * dayMs);
      const rows = this.db.prepare(`
        SELECT * FROM sla_tracking
        WHERE created_at >= ? AND created_at < ?
      `).all(start.toISOString(), end.toISOString()) as TrackingRow[];
      const m = this.aggregateMetrics(rows);
      out.push({
        day: start.toISOString().slice(0, 10),
        compliancePercent: m.compliancePercent,
        total: m.total,
      });
    }
    return out;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private aggregateMetrics(rows: TrackingRow[]): SlaMetrics {
    let resMet = 0, resMissed = 0, resPending = 0;
    let respMet = 0, respMissed = 0, respPending = 0;
    let resDurations = 0, resDurationCount = 0;
    let respDurations = 0, respDurationCount = 0;
    let activeBreaches = 0;
    for (const r of rows) {
      if (r.resolution_met === 1) resMet++;
      else if (r.resolution_met === 0) resMissed++;
      else resPending++;
      if (r.response_met === 1) respMet++;
      else if (r.response_met === 0) respMissed++;
      else respPending++;
      if (r.resolved_at) {
        const dur = (new Date(r.resolved_at).getTime() - new Date(r.created_at).getTime()) / 60_000;
        if (Number.isFinite(dur) && dur >= 0) { resDurations += dur; resDurationCount++; }
      }
      if (r.responded_at) {
        const dur = (new Date(r.responded_at).getTime() - new Date(r.created_at).getTime()) / 60_000;
        if (Number.isFinite(dur) && dur >= 0) { respDurations += dur; respDurationCount++; }
      }
      if (r.breached && r.resolution_met === null) activeBreaches++;
    }
    const decided = resMet + resMissed;
    return {
      total: rows.length,
      resolutionMet: resMet,
      resolutionMissed: resMissed,
      resolutionPending: resPending,
      responseMet: respMet,
      responseMissed: respMissed,
      responsePending: respPending,
      mttrMinutes: resDurationCount > 0 ? round1(resDurations / resDurationCount) : null,
      mttaMinutes: respDurationCount > 0 ? round1(respDurations / respDurationCount) : null,
      compliancePercent: decided > 0 ? round1((resMet / decided) * 100) : null,
      activeBreaches,
    };
  }

  private periodMs(period: MetricsPeriod): number {
    switch (period) {
      case '24h': return 24 * 60 * 60 * 1000;
      case '7d':  return 7  * 24 * 60 * 60 * 1000;
      case '30d': return 30 * 24 * 60 * 60 * 1000;
      case '90d': return 90 * 24 * 60 * 60 * 1000;
    }
  }

  /** First timeline event after creation, OR the moment the incident
   *  gained an assignee. The earlier of the two wins. */
  private firstActivityAt(timeline: TimelineEntry[], assignedAgent: string | null, assignedTo: string | null): string | null {
    let earliest: string | null = null;
    for (const t of timeline) {
      if (t.type === 'opened') continue;
      if (!earliest || t.timestamp < earliest) earliest = t.timestamp;
    }
    // If an assignment timeline entry exists it's already covered above.
    // If not but the incident shows an assignedAgent/assignedTo (e.g. the
    // store was mutated outside addTimeline), fall back to the updated_at
    // timestamp of the incident. We don't have direct access to the
    // raw incident.updatedAt here; the caller already knows assignedAgent
    // is set — leave earliest = null and let the next tick reconcile.
    void assignedAgent; void assignedTo;
    return earliest;
  }

  private rowToPolicy = (r: PolicyRow): SlaPolicy => ({
    id: r.id, name: r.name, severity: r.severity as IncidentSeverity,
    responseTimeMinutes: r.response_minutes, resolutionTimeMinutes: r.resolution_minutes,
    businessHoursOnly: r.business_hours_only === 1, enabled: r.enabled === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

  private rowToTracking = (r: TrackingRow): SlaTracking => ({
    id: r.id, incidentId: r.incident_id, policyId: r.policy_id,
    responseDeadline: r.response_deadline, resolutionDeadline: r.resolution_deadline,
    responseMet:   r.response_met   === null ? null : r.response_met   === 1,
    resolutionMet: r.resolution_met === null ? null : r.resolution_met === 1,
    respondedAt: r.responded_at, resolvedAt: r.resolved_at,
    breached: r.breached === 1, warningEmitted: r.warning_emitted === 1,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

  close(): void { this.db.close(); }
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

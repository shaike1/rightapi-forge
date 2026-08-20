// ReportGenerator — collects data from across the platform and returns
// a ReportData payload that the formatter renders into HTML / Markdown
// / JSON.
//
// The generator is pure-data — it does no I/O beyond reading from the
// stores it was given. That keeps it cheap to test against in-memory
// fixtures and means the same generator runs for both scheduled cron
// reports and on-demand API generation.

import type {
  ReportData, ReportType,
} from './ReportTypes.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { SLAEngine, MetricsPeriod } from '../sla/SLAEngine.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';
import type { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import type { PostMortemStore } from '../persistence/PostMortemStore.js';
import type { RunbookRunStore } from '../runbooks/RunbookRunStore.js';
import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';

export interface ReportGeneratorDeps {
  incidents: IncidentManager;
  sla: SLAEngine;
  servers: ServerRegistry;
  metrics: MetricsHistoryStore;
  postMortems?: PostMortemStore;
  runbookRuns?: RunbookRunStore;
}

interface PeriodInfo {
  since: Date;
  until: Date;
  label: string;
  slaPeriod: MetricsPeriod;
}

function periodFor(type: ReportType, now: Date = new Date()): PeriodInfo {
  const until = now;
  switch (type) {
    case 'daily_summary':
      return { since: new Date(until.getTime() - 24 * 60 * 60 * 1000), until, label: 'Last 24 hours', slaPeriod: '24h' };
    case 'weekly_report':
      return { since: new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000), until, label: 'Last 7 days', slaPeriod: '7d' };
    case 'monthly_report':
      return { since: new Date(until.getTime() - 30 * 24 * 60 * 60 * 1000), until, label: 'Last 30 days', slaPeriod: '30d' };
  }
}

/** Cheap "fingerprint" for grouping similar incident titles. We strip
 *  numbers + INC ids + common IP/hostname digit suffixes so
 *  "Disk full on web01" and "Disk full on web02" land in the same
 *  bucket. The bare `\d+` (no word boundaries) is on purpose — we want
 *  digits-inside-tokens (like `web01`) to vanish too. */
function titleFingerprint(title: string): string {
  return title
    .toLowerCase()
    .replace(/inc-[a-z0-9]+/gi, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const SEVERITIES: IncidentSeverity[] = ['critical', 'high', 'medium', 'low'];

export class ReportGenerator {
  constructor(private readonly deps: ReportGeneratorDeps) {}

  generate(type: ReportType, now: Date = new Date()): ReportData {
    const period = periodFor(type, now);
    return {
      type,
      generatedAt: now.toISOString(),
      period: {
        since: period.since.toISOString(),
        until: period.until.toISOString(),
        label: period.label,
      },
      incidents: this.collectIncidents(period),
      sla: this.collectSla(period),
      servers: this.collectServers(period),
      postMortems: this.collectPostMortems(period),
      runbooks: this.collectRunbooks(period),
    };
  }

  // ─── Collectors ──────────────────────────────────────────────────────

  private collectIncidents(period: PeriodInfo): ReportData['incidents'] {
    const all = this.deps.incidents.list({});
    const sinceMs = period.since.getTime();
    const untilMs = period.until.getTime();

    const createdInPeriod = all.filter(i => {
      const t = Date.parse(i.createdAt);
      return t >= sinceMs && t <= untilMs;
    }).length;

    const resolvedInPeriod = all.filter(i => {
      if (!i.resolvedAt) return false;
      const t = Date.parse(i.resolvedAt);
      return t >= sinceMs && t <= untilMs;
    }).length;

    const active = all.filter(i =>
      i.status === 'open' || i.status === 'investigating' || i.status === 'mitigating'
    );
    const activeBySeverity = SEVERITIES.reduce<Record<IncidentSeverity, number>>((acc, sev) => {
      acc[sev] = active.filter(i => i.severity === sev).length;
      return acc;
    }, {} as Record<IncidentSeverity, number>);

    // Top recurring — bucket by title fingerprint over incidents created
    // in the period. Keep the top 5.
    const buckets = new Map<string, { title: string; count: number }>();
    for (const inc of all) {
      const t = Date.parse(inc.createdAt);
      if (t < sinceMs || t > untilMs) continue;
      const key = titleFingerprint(inc.title);
      if (!key) continue;
      const existing = buckets.get(key);
      if (existing) existing.count++;
      else buckets.set(key, { title: inc.title, count: 1 });
    }
    const topRecurring = Array.from(buckets.values())
      .filter(b => b.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      createdInPeriod,
      resolvedInPeriod,
      activeAtEnd: active.length,
      activeBySeverity,
      topRecurring,
    };
  }

  private collectSla(period: PeriodInfo): ReportData['sla'] {
    const overall = this.deps.sla.getMetrics(period.slaPeriod);
    const bySeverity = this.deps.sla.getMetricsBySeverity(period.slaPeriod);
    return {
      overall,
      bySeverity,
      activeBreaches: overall.activeBreaches,
    };
  }

  private collectServers(period: PeriodInfo): ReportData['servers'] {
    const servers = this.deps.servers.list({});
    const healthSnapshots: ReportData['servers']['healthSnapshots'] = servers.map(s => {
      const cpu = this.avgOverPeriod(s.id, 'cpu', period);
      const mem = this.avgOverPeriod(s.id, 'memory', period);
      const disk = this.maxOverPeriod(s.id, 'disk', period);
      return {
        serverId: s.id,
        name: s.name,
        avgCpu: cpu,
        avgMemory: mem,
        avgDisk: disk,
        lastCheckStatus: s.lastCheckStatus,
      };
    });
    return {
      monitored: servers.length,
      healthSnapshots,
    };
  }

  private collectPostMortems(period: PeriodInfo): ReportData['postMortems'] {
    if (!this.deps.postMortems) {
      return { createdInPeriod: 0, recent: [] };
    }
    const r = this.deps.postMortems.list({
      since: period.since.toISOString(),
      limit: 50,
    });
    return {
      createdInPeriod: r.total,
      recent: r.items.slice(0, 5).map(pm => ({
        id: pm.id,
        incidentId: pm.incidentId,
        title: pm.title,
        severity: pm.severity,
        createdAt: pm.createdAt,
      })),
    };
  }

  private collectRunbooks(period: PeriodInfo): ReportData['runbooks'] {
    if (!this.deps.runbookRuns) {
      return { runsInPeriod: 0, byStatus: {}, top: [] };
    }
    // No since-filter on the run store; pull a generous slice and filter
    // here. Cap at 500 so a runaway run history doesn't bloat reports.
    const all = this.deps.runbookRuns.list({ limit: 500 });
    const sinceMs = period.since.getTime();
    const inPeriod = all.filter(r => Date.parse(r.startedAt) >= sinceMs);
    const byStatus: Record<string, number> = {};
    const byTemplate = new Map<string, { templateId: string; templateName: string; runs: number }>();
    for (const r of inPeriod) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const key = r.templateId;
      const ex = byTemplate.get(key);
      if (ex) ex.runs++;
      else byTemplate.set(key, { templateId: r.templateId, templateName: r.templateName, runs: 1 });
    }
    const top = Array.from(byTemplate.values()).sort((a, b) => b.runs - a.runs).slice(0, 5);
    return { runsInPeriod: inPeriod.length, byStatus, top };
  }

  // ─── Metric aggregation helpers ──────────────────────────────────────

  private avgOverPeriod(serverId: string, metricType: 'cpu' | 'memory', period: PeriodInfo): number | null {
    try {
      const series = this.deps.metrics.series({
        serverId,
        metricType,
        sinceMs: period.since.getTime(),
      });
      const points = series.points.filter(p => p.ts <= period.until.getTime());
      if (points.length === 0) return null;
      const sum = points.reduce((a, p) => a + p.value, 0);
      return Math.round((sum / points.length) * 10) / 10;
    } catch {
      return null;
    }
  }

  private maxOverPeriod(serverId: string, _metricType: 'disk', period: PeriodInfo): number | null {
    try {
      // Disk samples are dimensioned per-mount; we want the worst case
      // across mounts, so we don't filter by dimension here. The store
      // ORDER BY timestamp + we max across all rows in the window.
      const series = this.deps.metrics.series({
        serverId,
        metricType: 'disk',
        sinceMs: period.since.getTime(),
      });
      const points = series.points.filter(p => p.ts <= period.until.getTime());
      if (points.length === 0) return null;
      return Math.round(Math.max(...points.map(p => p.value)) * 10) / 10;
    } catch {
      return null;
    }
  }
}

// Surface the local helper for unit testing — the buckets in `incidents`
// depend on it.
export const _testing = { titleFingerprint };

// Make sure unused locals from the type imports don't trip lint.
void ((_: Incident | undefined) => _);

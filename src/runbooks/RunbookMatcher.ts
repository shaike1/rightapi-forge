// RunbookMatcher — bridges declarative trigger configs on runbook templates
// to actual events: incident creation + metric-threshold ticks.
//
// Used by server.ts in two places:
//   - IncidentManager.onCreated → matcher.matchIncident(incident) →
//     auto-executes every runbook with trigger_type='incident_match'
//     whose config matches the incident.
//   - AlertRulesEngine evaluate() → matcher.matchMetric(serverId, metric,
//     value) → fires every runbook with trigger_type='metric_threshold'
//     whose (metric, operator, threshold) matches and isn't on cooldown.
//
// The matcher is intentionally side-effecting (it calls executeRun) so
// the wiring in server.ts is a one-liner. Auto-runs are recorded with
// `triggeredBy: 'auto:<source>'` so /api/audit and the run history
// distinguish them from human-triggered runs.

import type { RunbookEngine } from './RunbookEngine.js';
import type {
  RunbookTemplate, IncidentMatchConfig, MetricThresholdConfig,
} from './RunbookTypes.js';
import { logger } from '../utils/logger.js';

type Severity = 'low' | 'medium' | 'high' | 'critical';
const SEVERITY_ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

interface IncidentForMatch {
  id: string;
  title: string;
  severity: Severity;
  sourceRef: string | null;
  serverId: string | null;
}

export class RunbookMatcher {
  constructor(private readonly engine: RunbookEngine) {}

  /** Returns matching template ids — exported for tests that don't want
   *  to actually execute anything. */
  findMatchingIncidentTemplates(incident: IncidentForMatch): RunbookTemplate[] {
    const all = this.engine.listTemplates();
    return all.filter(t => {
      if (t.enabled === false) return false;
      if (t.triggerType !== 'incident_match') return false;
      const cfg = (t.triggerConfig ?? {}) as IncidentMatchConfig;
      return this.incidentMatches(incident, cfg);
    });
  }

  findMatchingMetricTemplates(serverId: string, metric: string, value: number): RunbookTemplate[] {
    const all = this.engine.listTemplates();
    return all.filter(t => {
      if (t.enabled === false) return false;
      if (t.triggerType !== 'metric_threshold') return false;
      const cfg = (t.triggerConfig ?? {}) as MetricThresholdConfig;
      if (cfg.metric !== metric) return false;
      if (cfg.serverId && cfg.serverId !== serverId) return false;
      return compare(value, cfg.operator, cfg.threshold);
    });
  }

  /** Side-effecting — fires each matched runbook with the incident as
   *  context. The engine handles per-run failures; matcher only logs. */
  async matchIncident(incident: IncidentForMatch): Promise<{ fired: string[] }> {
    const matches = this.findMatchingIncidentTemplates(incident);
    const fired: string[] = [];
    for (const t of matches) {
      try {
        await this.engine.executeRun(t.id, 'auto:incident_match', {
          context: {
            incidentId: incident.id,
            serverId: incident.serverId ?? undefined,
          },
        });
        fired.push(t.id);
        logger.info('[RunbookMatcher] auto-fired on incident', { runbook: t.id, incident: incident.id });
      } catch (e) {
        logger.error('[RunbookMatcher] auto-fire failed', {
          runbook: t.id, incident: incident.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { fired };
  }

  async matchMetric(serverId: string, metric: string, value: number): Promise<{ fired: string[] }> {
    const matches = this.findMatchingMetricTemplates(serverId, metric, value);
    const fired: string[] = [];
    for (const t of matches) {
      const cfg = (t.triggerConfig ?? {}) as MetricThresholdConfig;
      const cooldown = Math.max(60, cfg.cooldownSeconds ?? 300);
      if (!this.engine.metricCooldownExpired(t.id, serverId, cooldown)) {
        // Within cooldown — silent skip, no log noise.
        continue;
      }
      try {
        await this.engine.executeRun(t.id, 'auto:metric_threshold', {
          context: { serverId },
        });
        fired.push(t.id);
        logger.info('[RunbookMatcher] auto-fired on metric', {
          runbook: t.id, serverId, metric, value,
        });
      } catch (e) {
        logger.error('[RunbookMatcher] auto-fire failed', {
          runbook: t.id, serverId, metric,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { fired };
  }

  private incidentMatches(incident: IncidentForMatch, cfg: IncidentMatchConfig): boolean {
    if (cfg.sourceRef) {
      if (!matchesLike(incident.sourceRef ?? '', cfg.sourceRef)) return false;
    }
    if (cfg.title) {
      if (!matchesLike(incident.title ?? '', cfg.title)) return false;
    }
    if (cfg.severity) {
      const want = SEVERITY_ORDER[cfg.severity];
      const got  = SEVERITY_ORDER[incident.severity];
      if (got === undefined || got < want) return false;
    }
    if (cfg.serverId) {
      if ((incident.serverId ?? '') !== cfg.serverId) return false;
    }
    // Empty config = match everything for this trigger type. Avoid that
    // surprise — require at least one selector.
    return !!(cfg.sourceRef || cfg.title || cfg.severity || cfg.serverId);
  }
}

/** SQL LIKE-style matcher — `%` is a wildcard, `_` any single char. */
function matchesLike(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  const re = new RegExp('^' + escaped + '$', 'i');
  return re.test(value);
}

function compare(a: number, op: '<' | '>' | '<=' | '>=' | '==', b: number): boolean {
  switch (op) {
    case '<':  return a < b;
    case '>':  return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '==': return a === b;
    default:   return false;
  }
}

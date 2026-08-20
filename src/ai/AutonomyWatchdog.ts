import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { AiDecisionStore } from './AiDecisionStore.js';
import type { SkillManager } from '../skills/SkillManager.js';
import { computeAutonomyMetrics } from './AutonomyMetrics.js';
import { createLogger } from '../observability/Logger.js';
import type { AutonomyAttemptStore } from './AutonomyAttemptStore.js';

const log = createLogger({ component: 'autonomy-watchdog' });

export interface AutonomyWatchdogThresholds {
  /** Below this autonomous-resolution rate, fire. Default 0.6 (60%). */
  minResolutionRate: number;
  /** Above this false-resolve rate, fire. Default 0.05 (5%). */
  maxFalseResolveRate: number;
  /** Above this MTTR (minutes), fire. Default 15. */
  maxMttrMinutes: number;
  /** Window over which to measure (ms). Default 24h. */
  windowMs: number;
}

export interface AutonomyWatchdogDeps {
  incidents: IncidentManager;
  decisions: AiDecisionStore;
  skills: SkillManager;
  attempts?: AutonomyAttemptStore;
  /** Caller-provided hook — typically opens an incident, pages, etc. */
  onAlert?: (alert: AutonomyAlert) => void;
}

export type AutonomyAlertSeverity = 'warning' | 'critical';

export interface AutonomyAlert {
  kind: 'low_resolution' | 'high_false_resolve' | 'high_mttr';
  severity: AutonomyAlertSeverity;
  message: string;
  metric: number;
  threshold: number;
  observedAt: string;
}

const DEFAULTS: AutonomyWatchdogThresholds = {
  minResolutionRate: 0.60,
  maxFalseResolveRate: 0.05,
  maxMttrMinutes: 15,
  windowMs: 24 * 60 * 60 * 1000,
};

export class AutonomyWatchdog {
  private lastAlerts = new Set<string>();

  constructor(private readonly deps: AutonomyWatchdogDeps,
              private readonly thresholds: AutonomyWatchdogThresholds = DEFAULTS) {}

  /** Run one check and fire onAlert for each threshold breach. Idempotent
   *  per kind — a breach that already alerted won't fire again until the
   *  metric recovers and breaches again. */
  check(): AutonomyAlert[] {
    const m = computeAutonomyMetrics(this.deps.incidents, this.deps.decisions, this.deps.skills, this.thresholds.windowMs, this.deps.attempts);
    const alerts: AutonomyAlert[] = [];
    const now = new Date().toISOString();

    if (m.autonomousResolutionRate < this.thresholds.minResolutionRate) {
      alerts.push({
        kind: 'low_resolution',
        severity: 'warning',
        message: `Autonomous resolution rate ${(m.autonomousResolutionRate * 100).toFixed(1)}% is below target ${(this.thresholds.minResolutionRate * 100).toFixed(0)}%`,
        metric: m.autonomousResolutionRate,
        threshold: this.thresholds.minResolutionRate,
        observedAt: now,
      });
    }
    if (m.falseResolveRate > this.thresholds.maxFalseResolveRate) {
      alerts.push({
        kind: 'high_false_resolve',
        severity: 'critical',
        message: `False-resolve rate ${(m.falseResolveRate * 100).toFixed(1)}% exceeds threshold ${(this.thresholds.maxFalseResolveRate * 100).toFixed(0)}%`,
        metric: m.falseResolveRate,
        threshold: this.thresholds.maxFalseResolveRate,
        observedAt: now,
      });
    }
    if (m.mttrMinutes !== null && m.mttrMinutes > this.thresholds.maxMttrMinutes) {
      alerts.push({
        kind: 'high_mttr',
        severity: 'warning',
        message: `MTTR ${m.mttrMinutes.toFixed(1)}m exceeds target ${this.thresholds.maxMttrMinutes}m`,
        metric: m.mttrMinutes,
        threshold: this.thresholds.maxMttrMinutes,
        observedAt: now,
      });
    }

    // Dedupe: only emit alerts we haven't already emitted for the current
    // breach cycle. When a kind recovers, drop it from lastAlerts so the
    // next breach re-fires.
    const currentKinds = new Set(alerts.map(a => a.kind));
    for (const prev of this.lastAlerts) {
      if (!currentKinds.has(prev)) this.lastAlerts.delete(prev);
    }
    const fresh = alerts.filter(a => {
      if (this.lastAlerts.has(a.kind)) return false;
      this.lastAlerts.add(a.kind);
      return true;
    });
    fresh.forEach(a => {
      log.warn('autonomy threshold breached', { alert: a });
      this.deps.onAlert?.(a);
    });
    return fresh;
  }
}

// BeaconSelfMonitor — watches the deep-health pipeline and files an
// incident about Beacon itself when a probe stays unhealthy for N
// consecutive ticks. Auto-resolves the incident on a sustained
// recovery so the timeline closes cleanly without operator action.
//
// Why a separate service:
//   • The health endpoint is reactive — it answers when polled. Without
//     a watcher, a degraded subsystem only surfaces if a human is
//     looking. We want the platform to file a ticket against itself.
//   • Incident dedup keyed on (source='beacon-self', sourceRef=checkName)
//     mirrors how alert-rule / health-monitor sources already work, so
//     existing dedup logic in IncidentManager handles re-trigger.
//   • Severity escalates on persistence: a check that's been failing
//     for "many" ticks gets bumped from medium → high so the SLA timer
//     starts running tighter.

import { logger } from '../utils/logger.js';
import type { HealthChecker, HealthReport, ProbeStatus } from '../web/healthCheck.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import { aiProxyReachable, healthCheckStatus } from './Metrics.js';

export interface BeaconSelfMonitorOptions {
  /** Tick interval. Default 60s — matches the existing health-monitor
   *  cadence. */
  intervalMs?: number;
  /** Consecutive fail-ticks before an incident is opened. Default 3 so
   *  a single transient blip doesn't generate a ticket. */
  failThreshold?: number;
  /** Consecutive pass-ticks before an open incident auto-resolves.
   *  Default 2 so a flapping check doesn't auto-close prematurely. */
  recoverThreshold?: number;
}

export interface BeaconSelfMonitorDeps {
  healthChecker: HealthChecker;
  incidentManager: IncidentManager;
}

interface CheckState {
  failStreak: number;
  passStreak: number;
  /** The active incident id for this check, if one is open. Null when
   *  no active incident exists. */
  incidentId: string | null;
  /** Most recent error message for this check — surfaced in the
   *  incident description. */
  lastError: string | null;
}

export class BeaconSelfMonitor {
  private timer: NodeJS.Timeout | null = null;
  private state = new Map<string, CheckState>();
  private intervalMs: number;
  private failThreshold: number;
  private recoverThreshold: number;
  private deps: BeaconSelfMonitorDeps;
  private running = false;

  constructor(deps: BeaconSelfMonitorDeps, opts: BeaconSelfMonitorOptions = {}) {
    this.deps = deps;
    this.intervalMs = Math.max(5_000, opts.intervalMs ?? 60_000);
    this.failThreshold = Math.max(1, opts.failThreshold ?? 3);
    this.recoverThreshold = Math.max(1, opts.recoverThreshold ?? 2);
  }

  start(): void {
    if (this.timer) return;
    logger.info('[BeaconSelfMonitor] started', {
      intervalMs: this.intervalMs,
      failThreshold: this.failThreshold,
      recoverThreshold: this.recoverThreshold,
    });
    // Schedule recurring ticks. Don't fire immediately — give the
    // platform a moment to finish startup so we don't snapshot a
    // half-initialised state on the first poll.
    this.timer = setInterval(() => this.tickSafe(), this.intervalMs);
    if (typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Test seam — runs a single tick. */
  async tickOnce(): Promise<HealthReport | null> {
    return this.tick();
  }

  private async tickSafe(): Promise<void> {
    if (this.running) return; // skip overlap on slow ticks
    this.running = true;
    try {
      await this.tick();
    } catch (e) {
      logger.error('[BeaconSelfMonitor] tick failed', { err: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<HealthReport | null> {
    const report = await this.deps.healthChecker.check();
    for (const r of report.checks) {
      // Refresh the Prometheus gauge for every probe regardless of
      // whether an incident gets opened. 1=pass, 0.5=warn, 0=fail.
      healthCheckStatus.set({ check: r.name }, statusToScore(r.status));
      // The AI proxy probe is also surfaced as its own gauge with the
      // url label, so dashboards can group by target.
      if (r.name === 'ai_proxy_reachable') {
        const url = String((r.details as any)?.url || '');
        if (url) aiProxyReachable.set({ base_url: url }, r.status === 'pass' ? 1 : 0);
      }

      const state = this.state.get(r.name) ?? { failStreak: 0, passStreak: 0, incidentId: null, lastError: null };
      if (r.status === 'fail') {
        state.failStreak++;
        state.passStreak = 0;
        state.lastError = r.error ?? null;
        this.maybeOpenOrEscalate(r.name, state, r.error ?? 'unknown failure', r.details);
      } else if (r.status === 'pass') {
        state.passStreak++;
        state.failStreak = 0;
        this.maybeResolve(r.name, state);
      } else {
        // warn — degraded but not fully failed. Reset both streaks so
        // we neither open nor close an incident on warn-only flapping.
        state.failStreak = 0;
        state.passStreak = 0;
      }
      this.state.set(r.name, state);
    }
    return report;
  }

  private maybeOpenOrEscalate(checkName: string, state: CheckState, error: string, details: unknown): void {
    if (state.failStreak < this.failThreshold) return;

    // Severity grows with persistence so the SLA timer tightens for a
    // check that keeps failing for hours.
    const severity = state.failStreak >= this.failThreshold * 4 ? 'critical'
                  : state.failStreak >= this.failThreshold * 2 ? 'high'
                  : 'medium';

    try {
      const inc = this.deps.incidentManager.create({
        title: `RightAPI Forge self-check failing: ${checkName}`,
        description: [
          `RightAPI Forge' deep-health pipeline has reported "${checkName}" as failing for ${state.failStreak} consecutive ticks.`,
          `Latest error: ${error}`,
          details ? `Details: ${safeJson(details)}` : '',
        ].filter(Boolean).join('\n'),
        severity,
        source: 'agent', // 'agent' is the closest legal value — the
                         // self-monitor IS an internal agent. Surface
                         // distinguishes via sourceRef prefix.
        sourceRef: `beacon-self:${checkName}`,
        dedupBy: 'sourceRef',
        updateOnDup: true,
      });
      // IncidentManager.create() with updateOnDup refreshes description
      // and updatedAt but NOT severity (mutating severity from a dedup
      // path could surprise other callers). Patch it explicitly when
      // the streak has crossed an escalation threshold so the row
      // matches the current failure intensity.
      if (inc.severity !== severity) {
        this.deps.incidentManager.update(inc.id, { severity });
      }
      // Cache the id so a future resolve() knows what to close.
      state.incidentId = inc.id;
      logger.warn('[BeaconSelfMonitor] opened/refreshed self-incident', { check: checkName, incidentId: inc.id, severity, streak: state.failStreak });
    } catch (e) {
      logger.error('[BeaconSelfMonitor] failed to open self-incident', { check: checkName, err: e instanceof Error ? e.message : String(e) });
    }
  }

  private maybeResolve(checkName: string, state: CheckState): void {
    if (state.passStreak < this.recoverThreshold) return;
    if (!state.incidentId) return;
    try {
      const resolved = this.deps.incidentManager.resolve(state.incidentId, `Auto-resolved: "${checkName}" recovered after ${state.passStreak} consecutive passes`);
      if (resolved) {
        logger.info('[BeaconSelfMonitor] auto-resolved self-incident', { check: checkName, incidentId: state.incidentId, streak: state.passStreak });
      }
      state.incidentId = null;
      state.lastError = null;
    } catch (e) {
      logger.warn('[BeaconSelfMonitor] failed to auto-resolve self-incident', { check: checkName, incidentId: state.incidentId, err: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Inspect current per-check state. Test-only / debug. */
  snapshot(): Record<string, CheckState> {
    const out: Record<string, CheckState> = {};
    for (const [k, v] of this.state) out[k] = { ...v };
    return out;
  }
}

function statusToScore(s: ProbeStatus): number {
  if (s === 'pass') return 1;
  if (s === 'warn') return 0.5;
  return 0;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}

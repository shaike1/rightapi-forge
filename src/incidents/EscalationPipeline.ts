// Escalation pipeline for incidents that automation can't close.
//
// Before this module landed, every incident lived through exactly two
// possible fates: the assigned agent's ReAct loop resolved it, or the
// IncidentAutoRemediator's pattern-matched recipe resolved it. Anything
// past those two attempts just *sat there* — assigned to an agent who
// already gave up, slowly aging past SLA with nobody paged.
//
// This pipeline tracks five escalation levels and threads the previously
// disconnected pieces together:
//
//   L0  new                — incident just opened, nothing tried yet
//   L1  agent              — AgentIncidentHandler is running the ReAct loop
//   L2  auto-remediation   — agent failed; pattern-matched recipe in flight
//   L3  human notified     — automation exhausted; OpenClaw alert sent so a
//                            human channel knows to take it
//   L4  critical           — still open ESCALATION_L4_TIMEOUT_MS after L3:
//                            severity bumped (incidentManager.escalate),
//                            urgent OpenClaw follow-up, optional webhook
//
// Notes on storage and restart-safety
// ───────────────────────────────────
// The level + escalated_at are persisted on the incident row (see the
// SqliteStore migration adding `escalation_level` and `escalated_at`).
// Each transition also lands a `[L<n>] …` timeline note, so the *why* of
// every level change survives a process crash. The pipeline's only
// in-memory state is the set of one-shot L3 timers — we don't try to
// persist those; instead, `tick()` is the periodic recovery mechanism
// that rescues any L3-stuck incident whose timer was lost across a
// restart by comparing `escalated_at` against `Date.now()`.
//
// De-escalation
// ─────────────
// When an incident at L3 or L4 transitions to resolved/closed (typically
// because the underlying metric cleared and the health monitor's
// resolveActiveByRef sweep tagged it), `tick()` notices the status flip,
// sends a "✅ Resolved" notice to OpenClaw, and resets the level to 0
// so the next re-open of the same condition starts fresh.

import { logger } from '../utils/logger.js';
import type { IncidentManager } from './IncidentManager.js';
import type { OpenClawIntegration } from '../integrations/openclaw.js';
import type { TelegramAlerter } from '../integrations/telegram.js';
import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';

const SEVERITY_ORDER: IncidentSeverity[] = ['low', 'medium', 'high', 'critical'];

export type EscalationLevel = 0 | 1 | 2 | 3 | 4;

/** Context the pipeline weaves into the L3/L4 OpenClaw message so the
 *  human reading it sees what was already tried, not just "fix it". */
export interface EscalationContext {
  agentName?: string;
  agentIterations?: number;
  /** One-line summaries of the agent's tool calls / ReAct steps. The
   *  alerter shows the first four. */
  agentActions?: string[];
  /** Auto-remediator plan kind, e.g. 'disk-cleanup'. null = no recipe matched. */
  remediatorKind?: string | null;
  remediatorActions?: string[];
  /** Free-form metric snapshot (disk %, memory %, etc.) for the human. */
  currentMetrics?: string;
  /** Why we're escalating — surfaces in the OpenClaw message + timeline. */
  reason?: string;
}

export interface EscalationPipelineOpts {
  /** Optional Telegram alerter. When wired and configured, fires at L3
   *  (sendEscalation) and L4 (sendEscalation with level=4). Independent
   *  of the OpenClaw alerter — operators can use both, one, or neither. */
  telegram?: TelegramAlerter;
  enabled?: boolean;
  /** Delay between "remediator started" and "page a human" — gives the
   *  remediator (and the health-monitor auto-resolve sweep) a chance to
   *  clear the condition before we wake someone up. */
  l3DelayMs?: number;
  /** Time at L3 before promoting to L4 (urgent follow-up + severity bump). */
  l4TimeoutMs?: number;
  /** Optional external webhook POSTed at L4. Receives the structured
   *  payload below — designed for SMS/PagerDuty/Opsgenie bridges. */
  webhookUrl?: string;
  /** Minimum severity that participates in the pipeline. Below this,
   *  incidents just rely on the stale-sweep auto-resolve. Default 'medium'. */
  minSeverity?: IncidentSeverity;
  /** WebSocket broadcaster — emits `incident_escalation_level` events
   *  that the UI listens for to flip the badge. */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

export interface WebhookPayload {
  type: 'incident_escalation';
  level: EscalationLevel;
  incident: {
    id: string;
    title: string;
    severity: string;
    status: string;
    createdAt: string;
    escalatedAt: string | null;
    ageMinutes: number;
    sourceRef: string | null;
  };
  context: EscalationContext;
}

export class EscalationPipeline {
  private readonly enabled: boolean;
  private readonly l3DelayMs: number;
  private readonly l4TimeoutMs: number;
  private readonly webhookUrl: string;
  private readonly minSeverityRank: number;
  private readonly broadcast?: (event: { type: string; data: unknown }) => void;
  private readonly telegram?: TelegramAlerter;

  /** Pending L3 promotion timers, keyed by incident id. handleFallback
   *  arms one; the timer either fires (calls escalateToHuman) or is
   *  cleared by recordResolution. tick() is the cross-restart safety net. */
  private readonly l3Timers = new Map<string, NodeJS.Timeout>();

  /** Cache of which incidents we've already sent a "resolved" notice for,
   *  so a slow status flip + frequent tick() doesn't spam OpenClaw. */
  private readonly resolutionNotified = new Set<string>();

  constructor(
    private readonly incidents: IncidentManager,
    private readonly openclaw: OpenClawIntegration,
    opts: EscalationPipelineOpts = {},
  ) {
    this.enabled = opts.enabled ?? true;
    this.l3DelayMs = Math.max(0, opts.l3DelayMs ?? 60_000);
    this.l4TimeoutMs = Math.max(60_000, opts.l4TimeoutMs ?? 1_800_000);
    this.webhookUrl = (opts.webhookUrl ?? '').trim();
    this.broadcast = opts.broadcast;
    this.telegram = opts.telegram;
    const minSev = opts.minSeverity ?? 'medium';
    this.minSeverityRank = SEVERITY_ORDER.indexOf(minSev);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Severity gating — low-priority incidents skip the pipeline so chat
   *  doesn't get woken up for audit-row churn. Always returns true when
   *  ESCALATION_MIN_SEVERITY is 'low'. */
  shouldHandle(incident: Pick<Incident, 'severity'>): boolean {
    if (!this.enabled) return false;
    return SEVERITY_ORDER.indexOf(incident.severity) >= this.minSeverityRank;
  }

  // ── Level transitions ──────────────────────────────────────────────

  /** Agent has picked up the incident and is running its ReAct loop. */
  recordLevel1(incident: Incident, agentName: string): void {
    if (!this.shouldHandle(incident)) return;
    this.transition(incident.id, 1, `Agent ${agentName} ReAct loop started`);
  }

  /** Auto-remediator has matched a recipe and is executing it. */
  recordLevel2(incident: Incident, planKind: string): void {
    if (!this.shouldHandle(incident)) return;
    this.transition(incident.id, 2, `Auto-remediator running: ${planKind}`);
  }

  /** The agent's fallback chain returned without resolving the incident.
   *  If a remediator recipe started, give it `l3DelayMs` to land first;
   *  otherwise jump straight to L3. AgentIncidentHandler calls this from
   *  its `runFallback()` tail. */
  handleFallback(incident: Incident, ctx: EscalationContext): void {
    if (!this.shouldHandle(incident)) return;
    // Skip if the incident already moved past L2 (e.g. operator manually
    // resolved between agent fail and this callback) or has been resolved.
    const live = this.incidents.get(incident.id);
    if (!live || live.status === 'resolved' || live.status === 'closed') return;

    if (ctx.remediatorKind) {
      this.recordLevel2(live, ctx.remediatorKind);
      this.scheduleHumanEscalation(live.id, ctx);
    } else {
      // No automated recipe applied — go straight to L3.
      void this.escalateToHuman(live.id, ctx);
    }
  }

  /** Arm a one-shot L3 timer. The timer is the *fast path*; tick() is
   *  the durable recovery if the process restarts before it fires. */
  private scheduleHumanEscalation(incidentId: string, ctx: EscalationContext): void {
    if (this.l3Timers.has(incidentId)) return;
    if (this.l3DelayMs === 0) {
      void this.escalateToHuman(incidentId, ctx);
      return;
    }
    const t = setTimeout(() => {
      this.l3Timers.delete(incidentId);
      void this.escalateToHuman(incidentId, ctx);
    }, this.l3DelayMs);
    // Don't block process exit on this timer — it's purely advisory.
    if (typeof (t as any).unref === 'function') (t as any).unref();
    this.l3Timers.set(incidentId, t);
  }

  /** Promote to L3 — automation has run out and a human needs to look.
   *  Sends the OpenClaw alert, records the timeline note, and returns
   *  the resulting state. Idempotent: re-firing for an L3+ incident is
   *  a no-op for the level change but still re-sends the alert if
   *  `force=true` (used by tick() L4 promotion). */
  async escalateToHuman(incidentId: string, ctx: EscalationContext): Promise<void> {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    if (inc.status === 'resolved' || inc.status === 'closed') return;
    if (!this.shouldHandle(inc)) return;
    if ((inc.escalationLevel ?? 0) >= 3) return; // already at L3 or higher

    this.transition(incidentId, 3,
      `Notifying human channels — ${ctx.reason ?? 'automation exhausted'}`);
    await this.sendOpenClawAlert(3, inc, ctx);
    // Telegram fan-out runs in parallel with OpenClaw — they're
    // independent channels. Errors are swallowed inside sendTelegramAlert.
    await this.sendTelegramAlert(3, inc, ctx);
    this.broadcast?.({
      type: 'incident_escalation_level',
      data: { incidentId, level: 3 },
    });
  }

  /** Periodic sweep. Runs from the health-monitor tick. Two jobs:
   *    1. Push L3 → L4 for incidents that have aged past l4TimeoutMs.
   *    2. Detect L3+ incidents that became resolved/closed in the
   *       meantime and emit a single "✅ Resolved" notice. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    const active = this.incidents.list();
    for (const inc of active) {
      const level = (inc.escalationLevel ?? 0) as EscalationLevel;
      if (level === 0) continue;

      // De-escalation: incident has been resolved/closed (likely by
      // health-monitor auto-resolve or an operator) — clear state.
      if (inc.status === 'resolved' || inc.status === 'closed') {
        if (level >= 3 && !this.resolutionNotified.has(inc.id)) {
          this.resolutionNotified.add(inc.id);
          this.openclaw.sendResolutionNotice(
            inc,
            `Automation closed this after escalation. Final state: ${inc.status}.`,
          ).catch(e => logger.error('[escalation] resolution notice failed', {
            incidentId: inc.id,
            err: e instanceof Error ? e.message : String(e),
          }));
        }
        // Reset the persisted level so a future re-open of the same
        // condition starts fresh at L0.
        if (level !== 0) {
          this.incidents.setEscalation(inc.id, 0, {
            note: 'Reset — incident reached terminal state',
          });
        }
        this.cancelL3Timer(inc.id);
        continue;
      }

      // L3 → L4 promotion based on age.
      if (level === 3 && inc.escalatedAt) {
        const ageMs = Date.now() - Date.parse(inc.escalatedAt);
        if (Number.isFinite(ageMs) && ageMs >= this.l4TimeoutMs) {
          await this.promoteToL4(inc);
        }
      }
    }
  }

  /** Severity bump + urgent OpenClaw follow-up + optional webhook. */
  private async promoteToL4(inc: Incident): Promise<void> {
    const ageMinutes = Math.round((Date.now() - Date.parse(inc.createdAt)) / 60_000);
    this.transition(inc.id, 4,
      `Still open ${ageMinutes}m after L3 — promoting to critical urgency`);

    // Severity bump (skipped if already critical). escalate() also flips
    // status to 'investigating', which is harmless if already there.
    if (inc.severity !== 'critical') {
      try {
        this.incidents.escalate(inc.id, 'L4 escalation: stuck at L3 past timeout');
      } catch (e) {
        logger.error('[escalation] L4 severity bump failed', {
          incidentId: inc.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Re-fetch post-escalate so the alert + webhook reflect the new severity.
    const fresh = this.incidents.get(inc.id) ?? inc;
    await this.sendOpenClawAlert(4, fresh, {
      reason: `L4 — no human action ${Math.round(this.l4TimeoutMs / 60_000)}m after L3`,
    });
    await this.sendTelegramAlert(4, fresh, {
      reason: `L4 — no human action ${Math.round(this.l4TimeoutMs / 60_000)}m after L3`,
    });
    await this.firewebhook(fresh, {
      reason: `L4 timeout (${Math.round(this.l4TimeoutMs / 60_000)}m)`,
    });
    this.broadcast?.({
      type: 'incident_escalation_level',
      data: { incidentId: inc.id, level: 4 },
    });
  }

  /** Operator/agent successfully closed the incident — clean up pipeline
   *  state. Safe to call for any incident; no-ops if we never tracked it. */
  recordResolution(incident: Incident): void {
    this.cancelL3Timer(incident.id);
    const level = incident.escalationLevel ?? 0;
    if (level === 0) return;
    if (level >= 3 && !this.resolutionNotified.has(incident.id)) {
      this.resolutionNotified.add(incident.id);
      this.openclaw.sendResolutionNotice(
        incident,
        'Resolved before L4 escalation. Thanks!',
      ).catch(e => logger.error('[escalation] resolution notice failed', {
        incidentId: incident.id,
        err: e instanceof Error ? e.message : String(e),
      }));
    }
    this.incidents.setEscalation(incident.id, 0, {
      note: 'Reset — incident resolved',
    });
  }

  /** Cancel pending timers — called from server shutdown to keep node
   *  from holding the event loop open. */
  shutdown(): void {
    for (const t of this.l3Timers.values()) clearTimeout(t);
    this.l3Timers.clear();
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private transition(incidentId: string, level: EscalationLevel, note: string): void {
    this.incidents.setEscalation(incidentId, level, { note });
    logger.info('[escalation] level transition', {
      incidentId, level, note,
    });
  }

  private cancelL3Timer(incidentId: string): void {
    const t = this.l3Timers.get(incidentId);
    if (t) {
      clearTimeout(t);
      this.l3Timers.delete(incidentId);
    }
  }

  /** Telegram fan-out — independent of OpenClaw. Operators using either
   *  channel (or both) get the same level transitions. Silent no-op when
   *  the alerter isn't configured. */
  private async sendTelegramAlert(
    level: EscalationLevel,
    inc: Incident,
    ctx: EscalationContext,
  ): Promise<void> {
    if (!this.telegram?.isConfigured()) return;
    try {
      await this.telegram.sendEscalation(inc, level, {
        agentName: ctx.agentName,
        agentActions: ctx.agentActions,
        agentIterations: ctx.agentIterations,
        remediatorKind: ctx.remediatorKind,
        remediatorActions: ctx.remediatorActions,
        reason: ctx.reason,
      });
    } catch (e) {
      logger.error('[escalation] Telegram alert threw', {
        incidentId: inc.id, level,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async sendOpenClawAlert(
    level: EscalationLevel,
    inc: Incident,
    ctx: EscalationContext,
  ): Promise<void> {
    if (!this.openclaw.isConfigured()) {
      logger.debug('[escalation] OpenClaw not configured — skipping alert', {
        incidentId: inc.id, level,
      });
      return;
    }
    const ageMinutes = Math.round((Date.now() - Date.parse(inc.createdAt)) / 60_000);
    try {
      await this.openclaw.sendEscalationAlert(level, inc, { ...ctx, ageMinutes });
    } catch (e) {
      logger.error('[escalation] OpenClaw alert threw', {
        incidentId: inc.id, level,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async firewebhook(inc: Incident, ctx: EscalationContext): Promise<void> {
    if (!this.webhookUrl) return;
    const payload: WebhookPayload = {
      type: 'incident_escalation',
      level: 4,
      incident: {
        id: inc.id,
        title: inc.title,
        severity: inc.severity,
        status: inc.status,
        createdAt: inc.createdAt,
        escalatedAt: inc.escalatedAt ?? null,
        ageMinutes: Math.round((Date.now() - Date.parse(inc.createdAt)) / 60_000),
        sourceRef: inc.sourceRef ?? null,
      },
      context: ctx,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const resp = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!resp.ok) {
        logger.warn('[escalation] webhook non-2xx', {
          incidentId: inc.id,
          status: resp.status,
        });
      } else {
        logger.info('[escalation] webhook delivered', {
          incidentId: inc.id, status: resp.status,
        });
      }
      try { await resp.body?.cancel(); } catch { /* ignore */ }
    } catch (e) {
      logger.error('[escalation] webhook failed', {
        incidentId: inc.id,
        err: e instanceof Error ? e.message : String(e),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

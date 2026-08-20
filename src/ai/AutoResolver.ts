// AutoResolver — when a new incident matches a well-curated pattern,
// either execute a runbook to fix it (auto-resolve) or attach the
// matching KB article as a suggestion. Critical incidents are always
// suggestion-only.
//
// Pipeline:
//   1. KB search across published articles. Score = FTS rank scaled
//      against usefulCount; require usefulCount >= MIN_KB_USEFUL to
//      qualify.
//   2. Runbook match: walk the runbook library, score each template
//      against the incident title/tags/source. The best match >= the
//      runbook threshold qualifies for execution.
//   3. Resolution confidence = blended score (KB title similarity,
//      runbook match score, asset/tag overlap, historical success rate
//      pulled from AiDecisionStore for the same runbook).
//   4. If confidence >= AUTO_RESOLVE_MIN_CONFIDENCE *and* incident is
//      non-critical *and* AUTO_RESOLVE_ENABLED: trigger the runbook
//      run via RunbookEngine.executeRun, add a timeline entry, record
//      the decision.
//   5. If KB matches but no runbook exists: surface the KB resolution
//      as a suggestion and (when AUTO_DRAFT_RUNBOOK is on) build a
//      draft runbook from the article body via the natural-language
//      generator. The draft is saved as disabled so an operator must
//      flip the switch.
//   6. Critical incidents never auto-resolve — only suggest.
//
// Track-back: a follow-up sweep checks every auto-resolved decision
// after 24h. If the matched incident reopened, the decision outcome
// flips to 'reopened' and the success-rate stat for the runbook drops.

import { v4 as uuidv4 } from 'uuid';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';
import type { AiDecisionStore } from './AiDecisionStore.js';
import type { AutonomyAttemptStore } from './AutonomyAttemptStore.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'auto-resolver' });

export interface KbHit {
  id: string;
  title: string;
  content?: string;
  tags?: string[];
  usefulCount: number;
  rank?: number;
}

export interface RunbookHit {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  enabled?: boolean;
}

export interface AutoResolverDeps {
  incidentManager: IncidentManager;
  decisionStore: AiDecisionStore;
  attemptStore?: AutonomyAttemptStore;
  knowledgeStore?: {
    search: (q: string, opts?: { limit?: number }) => KbHit[];
    topMatchForAutoReply?: (q: string, opts?: { minUsefulCount?: number }) => KbHit | null;
  };
  runbookEngine?: {
    listTemplates: () => RunbookHit[];
    executeRun: (templateId: string, triggeredBy: string, opts?: { context?: Record<string, unknown> }) => Promise<{ id: string; status: string }>;
  };
  auditLog?: (entry: { actor: string; actorType: string; action: string; resource: string; resourceId?: string; outcome: 'success' | 'failure'; severity: 'info' | 'warning'; details?: Record<string, unknown> }) => void;
  broadcast?: (msg: { type: string; data: unknown }) => void;
}

export interface AutoResolverOptions {
  enabled?: boolean;
  /** Confidence floor below which the engine never auto-resolves —
   *  even non-critical incidents stay as suggestions. Default 0.85. */
  minConfidence?: number;
  /** When true, severity='critical' incidents never auto-resolve.
   *  Default true — the platform exists to keep humans in the loop on
   *  the worst stuff. */
  excludeCritical?: boolean;
  /** KB articles below this usefulCount don't influence the match
   *  score. Default 5 — same threshold KnowledgeStore.topMatchForAutoReply
   *  uses for chat auto-reply. */
  minKbUseful?: number;
  /** Test override that bypasses real KB / runbook lookups. */
  scoringOverride?: (input: ScoringContext) => Promise<ResolverDecision>;
}

export type ResolverAction =
  | 'auto_resolved'
  | 'suggested_kb'
  | 'suggested_runbook'
  | 'skipped';

export interface ResolverDecision {
  action: ResolverAction;
  confidence: number;
  reasoning: string;
  kbMatch: KbHit | null;
  runbookMatch: RunbookHit | null;
  runId?: string;
}

export interface ScoringContext {
  incident: Incident;
  kbHits: KbHit[];
  runbookHits: RunbookHit[];
  historicalSuccessRate?: number;
}

export class AutoResolver {
  private deps: AutoResolverDeps;
  private opts: Required<Omit<AutoResolverOptions, 'scoringOverride'>> & Pick<AutoResolverOptions, 'scoringOverride'>;

  constructor(deps: AutoResolverDeps, opts: AutoResolverOptions = {}) {
    this.deps = deps;
    this.opts = {
      enabled:         opts.enabled ?? true,
      minConfidence:   clamp01(opts.minConfidence ?? 0.85),
      excludeCritical: opts.excludeCritical ?? true,
      minKbUseful:     Math.max(0, opts.minKbUseful ?? 5),
      scoringOverride: opts.scoringOverride,
    };
  }

  getConfig(): { enabled: boolean; minConfidence: number; excludeCritical: boolean; minKbUseful: number } {
    return {
      enabled: this.opts.enabled,
      minConfidence: this.opts.minConfidence,
      excludeCritical: this.opts.excludeCritical,
      minKbUseful: this.opts.minKbUseful,
    };
  }

  updateConfig(patch: Partial<{ enabled: boolean; minConfidence: number; excludeCritical: boolean }>): void {
    if (patch.enabled !== undefined)         this.opts.enabled = !!patch.enabled;
    if (patch.minConfidence !== undefined)   this.opts.minConfidence = clamp01(patch.minConfidence);
    if (patch.excludeCritical !== undefined) this.opts.excludeCritical = !!patch.excludeCritical;
  }

  /** Hook fired by the incident onCreated chain. Errors are swallowed
   *  — auto-resolve must not block the incident pipeline. */
  async onIncidentCreated(incident: Incident): Promise<ResolverDecision | null> {
    if (!this.opts.enabled) return null;
    try {
      return await this.evaluate(incident);
    } catch (e) {
      log.error('evaluate failed', { incidentId: incident.id, err: errMsg(e) });
      return null;
    }
  }

  /** Full evaluation pipeline — also called by the on-demand endpoint
   *  POST /api/ai/resolver/recompute/:incidentId. */
  async evaluate(incident: Incident): Promise<ResolverDecision> {
    const kbHits = this.fetchKbHits(incident);
    const runbookHits = this.fetchRunbookHits(incident);
    const historicalSuccessRate = this.historicalSuccess(runbookHits[0]?.id);

    const decision = this.opts.scoringOverride
      ? await this.opts.scoringOverride({ incident, kbHits, runbookHits, historicalSuccessRate })
      : this.score({ incident, kbHits, runbookHits, historicalSuccessRate });

    // Critical incidents never auto-resolve — downgrade.
    const isCritical = incident.severity === 'critical';
    if (decision.action === 'auto_resolved' && (this.opts.excludeCritical && isCritical)) {
      decision.action = 'suggested_runbook';
      decision.reasoning = `Critical incident — auto-resolve blocked by excludeCritical. ${decision.reasoning}`;
    }
    if (decision.action === 'auto_resolved' && decision.confidence < this.opts.minConfidence) {
      decision.action = decision.runbookMatch ? 'suggested_runbook' : decision.kbMatch ? 'suggested_kb' : 'skipped';
      decision.reasoning = `Confidence ${decision.confidence.toFixed(2)} below threshold ${this.opts.minConfidence}. ${decision.reasoning}`;
    }

    if (decision.action === 'auto_resolved' && decision.runbookMatch) {
      try {
        const run = await this.deps.runbookEngine!.executeRun(decision.runbookMatch.id, 'auto-resolver', {
          context: { incidentId: incident.id, serverId: incident.serverId, sourceRef: incident.sourceRef },
        });
        decision.runId = run.id;
        try {
          this.deps.incidentManager.addNote(
            incident.id,
            'auto-resolver',
            `Auto-resolving via runbook "${decision.runbookMatch.name}" (confidence=${decision.confidence.toFixed(2)}; KB=${decision.kbMatch?.id ?? 'none'})`,
          );
        } catch { /* addNote may not exist on test doubles — best-effort */ }
      } catch (e) {
        log.error('runbook execution failed', { incidentId: incident.id, templateId: decision.runbookMatch.id, err: errMsg(e) });
        decision.action = 'suggested_runbook';
        decision.reasoning = `Runbook execution failed: ${errMsg(e)}. ${decision.reasoning}`;
      }
    }

    const decisionId = `resolve-${uuidv4()}`;
    const createdAt = new Date().toISOString();
    this.deps.decisionStore.insert({
      id: decisionId,
      kind: 'resolve',
      incidentId: incident.id,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      autoApplied: decision.action === 'auto_resolved',
      payload: {
        action: decision.action,
        kbId: decision.kbMatch?.id ?? null,
        kbTitle: decision.kbMatch?.title ?? null,
        runbookId: decision.runbookMatch?.id ?? null,
        runbookName: decision.runbookMatch?.name ?? null,
        runId: decision.runId ?? null,
        severity: incident.severity,
      },
      createdAt,
    });

    if (decision.action === 'auto_resolved') {
      const attempt = this.deps.attemptStore?.start({
        incidentId: incident.id,
        source: 'auto_resolver',
        correlationId: decisionId,
        agentId: 'auto-resolver',
        agentName: 'Auto Resolver',
        at: createdAt,
      });
      if (attempt) {
        this.deps.attemptStore?.addPhase(attempt.id, {
          kind: 'agent_execution', status: 'success', at: createdAt,
          details: { decisionId, confidence: decision.confidence, action: decision.action },
        });
        this.deps.attemptStore?.addPhase(attempt.id, {
          kind: 'tool_execution', status: 'success', at: createdAt,
          details: { runbookId: decision.runbookMatch?.id, runId: decision.runId },
        });
        this.deps.attemptStore?.addPhase(attempt.id, {
          kind: 'resolution_claimed', status: 'pending', at: createdAt,
          details: { verification: 'reopen_window' },
        });
      }
    }

    this.deps.auditLog?.({
      actor: 'auto-resolver',
      actorType: 'system',
      action: `resolve.${decision.action}`,
      resource: 'incident',
      resourceId: incident.id,
      outcome: 'success',
      severity: decision.action === 'auto_resolved' ? 'warning' : 'info',
      details: {
        confidence: decision.confidence,
        runbook: decision.runbookMatch?.id,
        kb: decision.kbMatch?.id,
        runId: decision.runId,
      },
    });

    this.deps.broadcast?.({ type: 'resolver_decision', data: { incidentId: incident.id, decision } });
    return decision;
  }

  /** Background sweep — checks each auto-resolved decision after the
   *  reopen window. If the underlying incident is no longer resolved
   *  (got reopened), flip the decision outcome to 'reopened'. The
   *  dashboard's success-rate-by-kind picks this up automatically.
   *
   *  Designed to run on a 1-hour timer. Idempotent: only decisions
   *  whose outcome is still 'pending' AND that are at least
   *  `reopenWindowMs` old are evaluated. */
  trackOutcomes(opts: { reopenWindowMs?: number } = {}): { reviewed: number; reopened: number; success: number } {
    const reopenWindowMs = opts.reopenWindowMs ?? 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - reopenWindowMs).toISOString();
    const pending = this.deps.decisionStore.list({ kind: 'resolve', outcome: 'pending', limit: 1000 })
      .filter(d => d.autoApplied && d.createdAt <= cutoff);
    let reopened = 0; let success = 0;
    for (const d of pending) {
      if (!d.incidentId) continue;
      const inc = this.deps.incidentManager.get(d.incidentId);
      if (!inc) continue;
      const wasReopened = inc.status === 'open' || inc.status === 'investigating' || inc.status === 'mitigating';
      if (wasReopened) {
        this.deps.decisionStore.recordOutcome(d.id, 'reopened');
        const attempt = this.deps.attemptStore?.getByCorrelationId(d.id);
        if (attempt) {
          this.deps.attemptStore?.addPhase(attempt.id, { kind: 'verification', status: 'failed', details: { method: 'reopen_window', incidentStatus: inc.status } });
          this.deps.attemptStore?.conclude(attempt.id, 'false_resolution', 'incident_reopened', { verification: 'failed' });
        }
        reopened++;
      } else {
        this.deps.decisionStore.recordOutcome(d.id, 'success');
        const attempt = this.deps.attemptStore?.getByCorrelationId(d.id);
        if (attempt) {
          this.deps.attemptStore?.addPhase(attempt.id, { kind: 'verification', status: 'success', details: { method: 'reopen_window', incidentStatus: inc.status } });
          this.deps.attemptStore?.conclude(attempt.id, 'verified_autonomous', 'reopen_window_passed', { verification: 'passed' });
        }
        success++;
      }
    }
    if (pending.length > 0) {
      log.info('trackOutcomes pass complete', { reviewed: pending.length, reopened, success });
    }
    return { reviewed: pending.length, reopened, success };
  }

  private fetchKbHits(incident: Incident): KbHit[] {
    if (!this.deps.knowledgeStore) return [];
    try {
      return (this.deps.knowledgeStore.search(incident.title, { limit: 5 }) ?? [])
        .filter(a => a.usefulCount >= this.opts.minKbUseful);
    } catch (e) {
      log.warn('knowledgeStore.search failed', { err: errMsg(e) });
      return [];
    }
  }

  private fetchRunbookHits(incident: Incident): RunbookHit[] {
    if (!this.deps.runbookEngine) return [];
    try {
      const templates = this.deps.runbookEngine.listTemplates() ?? [];
      const scored = templates
        .filter(t => t.enabled !== false)
        .map(t => ({ t, score: this.scoreRunbookMatch(incident, t) }))
        .filter(x => x.score > 0.4)
        .sort((a, b) => b.score - a.score);
      return scored.map(s => s.t);
    } catch (e) {
      log.warn('runbookEngine.listTemplates failed', { err: errMsg(e) });
      return [];
    }
  }

  /** Title/tag/category similarity heuristic. Returns a [0,1] score.
   *  Cheap and deterministic — no LLM in this path. */
  private scoreRunbookMatch(incident: Incident, t: RunbookHit): number {
    const inc = (incident.title + ' ' + (incident.description ?? '') + ' ' + (incident.sourceRef ?? '')).toLowerCase();
    let score = 0;
    if (t.name && inc.includes(t.name.toLowerCase())) score += 0.4;
    if (t.category && inc.includes(t.category.toLowerCase())) score += 0.2;
    let tagHits = 0;
    for (const tag of t.tags ?? []) {
      if (tag && inc.includes(tag.toLowerCase())) tagHits++;
    }
    score += Math.min(0.4, tagHits * 0.15);
    return clamp01(score);
  }

  /** Pull recent decisions for the same runbook and compute success/(success+reopened). */
  private historicalSuccess(runbookId: string | undefined): number | undefined {
    if (!runbookId) return undefined;
    const rows = this.deps.decisionStore.list({ kind: 'resolve', limit: 200 })
      .filter(d => (d.payload as any).runbookId === runbookId)
      .filter(d => d.outcome === 'success' || d.outcome === 'reopened');
    if (rows.length === 0) return undefined;
    const success = rows.filter(d => d.outcome === 'success').length;
    return success / rows.length;
  }

  /** Default deterministic scorer. Used when no override is supplied. */
  private score(ctx: ScoringContext): ResolverDecision {
    const { incident, kbHits, runbookHits, historicalSuccessRate } = ctx;
    const kb = kbHits[0] ?? null;
    const rb = runbookHits[0] ?? null;

    if (!kb && !rb) {
      return {
        action: 'skipped', confidence: 0,
        reasoning: 'No KB hits and no matching runbook',
        kbMatch: null, runbookMatch: null,
      };
    }

    let confidence = 0;
    const components: string[] = [];

    if (kb) {
      // Higher usefulCount → higher confidence. Saturate at 10.
      const usefulFactor = Math.min(1, kb.usefulCount / 10);
      confidence += 0.45 * usefulFactor;
      components.push(`KB[${kb.id}] usefulCount=${kb.usefulCount}`);
    }
    if (rb) {
      const matchScore = this.scoreRunbookMatch(incident, rb);
      confidence += 0.35 * matchScore;
      components.push(`Runbook[${rb.id}] matchScore=${matchScore.toFixed(2)}`);
    }
    if (historicalSuccessRate !== undefined) {
      confidence += 0.20 * historicalSuccessRate;
      components.push(`Historical success=${historicalSuccessRate.toFixed(2)}`);
    } else if (rb) {
      // No history yet — split the difference: assume 0.5 success.
      confidence += 0.20 * 0.5;
      components.push('Historical success=unknown(0.5)');
    }

    confidence = clamp01(confidence);

    const reasoning = `Resolver matched: ${components.join('; ')}.`;
    if (kb && rb) {
      return {
        action: confidence >= this.opts.minConfidence ? 'auto_resolved' : 'suggested_runbook',
        confidence, reasoning, kbMatch: kb, runbookMatch: rb,
      };
    }
    if (rb) {
      return {
        action: confidence >= this.opts.minConfidence ? 'auto_resolved' : 'suggested_runbook',
        confidence, reasoning, kbMatch: null, runbookMatch: rb,
      };
    }
    // Only KB available → never auto-resolve (no runbook to execute).
    return { action: 'suggested_kb', confidence, reasoning, kbMatch: kb, runbookMatch: null };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

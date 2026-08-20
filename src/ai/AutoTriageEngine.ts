// AutoTriageEngine — fires on every new incident and:
//   1. Pulls context from AssetStore, ChangeStore, ProblemStore, and the
//      KnowledgeStore so the LLM has the operator's mental model
//      (recent changes, recurring problems, relevant KB articles).
//   2. Asks the LLM to classify severity, suggest a category set,
//      estimate MTTR, and pick an assignee from the available agents
//      based on past resolution patterns.
//   3. If the model's confidence is above `autoApplyThreshold` (default
//      0.8), it patches the incident in place — severity, agent
//      assignment, a timeline note. Below the threshold, the decision
//      is recorded as a suggestion and an operator can confirm.
//
// Why a separate engine and not a path inside the existing
// IncidentAnalyzer:
//   • IncidentAnalyzer is a free-form root-cause + remediation report;
//     this engine produces a structured triage decision with
//     actionable, machine-verifiable fields.
//   • Triage runs first (synchronously enough that severity escalations
//     hit the SLA tracker before anything else), then analysis fills in
//     the longer narrative.
//
// Audit:
//   • Every decision (auto-applied or suggested) lands in AiDecisionStore.
//   • A `triage.auto_applied` / `triage.suggested` audit log entry is
//     written so operator-facing audit history surfaces it alongside
//     human actions.

import { v4 as uuidv4 } from 'uuid';
import type { AIProviderFactory } from './factory.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';
import type { AiDecisionStore } from './AiDecisionStore.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'auto-triage' });

export type TriageCategory =
  | 'network'
  | 'disk'
  | 'cpu'
  | 'memory'
  | 'service'
  | 'security'
  | 'application'
  | 'database'
  | 'unknown';

const VALID_CATEGORIES: TriageCategory[] = [
  'network', 'disk', 'cpu', 'memory', 'service', 'security', 'application', 'database', 'unknown',
];

export interface TriageSuggestion {
  /** Model's recommended severity. May differ from the incident's
   *  declared severity — applied only when confidence >= threshold. */
  severity: IncidentSeverity;
  /** Tag set, drawn from VALID_CATEGORIES. Unknown labels coming back
   *  from the model are coerced to 'unknown'. */
  categories: TriageCategory[];
  /** Suggested assignee — stable agent id when one matches, else null. */
  suggestedAgentId: string | null;
  /** Human-readable assignee name for the timeline. */
  suggestedAgentName: string | null;
  /** Best-guess MTTR in minutes. */
  estimatedResolutionMinutes: number;
  /** [0, 1]. The model is asked to self-report a single confidence
   *  number; the engine clamps it. */
  confidence: number;
  /** Short, single-paragraph reasoning surfaced in the timeline. */
  reasoning: string;
}

export interface TriageDecisionRecord extends TriageSuggestion {
  id: string;
  incidentId: string;
  autoApplied: boolean;
  createdAt: string;
}

export interface AutoTriageEngineDeps {
  aiFactory: AIProviderFactory;
  incidentManager: IncidentManager;
  decisionStore: AiDecisionStore;
  /** Optional context providers — engine works without them but the
   *  quality of the LLM's grounding drops. */
  assetStore?:    { getByServerId: (id: string) => unknown };
  changeStore?:   { changesInWindow: (since: string, until: string, opts?: { serverId?: string }) => unknown[] };
  problemStore?:  { findBySourcePattern: (sourceRef: string, opts: { serverId?: string | null }) => unknown };
  knowledgeStore?:{ search: (q: string, opts?: { limit?: number }) => Array<{ id: string; title: string; usefulCount: number }> };
  organization?:  { getAllAgents: () => Array<{ id: string; name: string; role?: string; skills?: string[] }> };
  /** Optional audit-log appender — engine soft-fails when omitted. */
  auditLog?: (entry: { actor: string; actorType: string; action: string; resource: string; resourceId?: string; outcome: 'success' | 'failure'; severity: 'info' | 'warning'; details?: Record<string, unknown> }) => void;
  broadcast?: (msg: { type: string; data: unknown }) => void;
}

export interface AutoTriageEngineOptions {
  enabled?: boolean;
  /** Confidence threshold above which a decision is auto-applied.
   *  Below the threshold the decision is suggested only. Default 0.8. */
  autoApplyThreshold?: number;
  /** Cap on the change-window the engine pulls into the prompt — keeps
   *  token counts predictable. Default 7 days. */
  changeWindowDays?: number;
  /** Max KB hits surfaced in the prompt. Default 3. */
  knowledgeLimit?: number;
  /** Override for tests / Phase-6 runs: a fixed decision function that
   *  bypasses the LLM and returns deterministic suggestions. */
  modelOverride?: (input: TriageContext) => Promise<TriageSuggestion>;
}

export interface TriageContext {
  incident: Incident;
  asset: unknown | null;
  recentChanges: unknown[];
  recurringProblem: unknown | null;
  relevantKb: Array<{ id: string; title: string; usefulCount: number }>;
  candidateAgents: Array<{ id: string; name: string; role?: string; skills?: string[] }>;
}

export class AutoTriageEngine {
  private deps: AutoTriageEngineDeps;
  private opts: Required<Omit<AutoTriageEngineOptions, 'modelOverride'>> & Pick<AutoTriageEngineOptions, 'modelOverride'>;

  constructor(deps: AutoTriageEngineDeps, opts: AutoTriageEngineOptions = {}) {
    this.deps = deps;
    this.opts = {
      enabled:            opts.enabled ?? true,
      autoApplyThreshold: clamp01(opts.autoApplyThreshold ?? 0.8),
      changeWindowDays:   Math.max(1, opts.changeWindowDays ?? 7),
      knowledgeLimit:     Math.max(0, opts.knowledgeLimit ?? 3),
      modelOverride:      opts.modelOverride,
    };
  }

  /** Live config snapshot — used by the dashboard's "controls" tab. */
  getConfig(): { enabled: boolean; autoApplyThreshold: number; changeWindowDays: number; knowledgeLimit: number } {
    return {
      enabled: this.opts.enabled,
      autoApplyThreshold: this.opts.autoApplyThreshold,
      changeWindowDays: this.opts.changeWindowDays,
      knowledgeLimit: this.opts.knowledgeLimit,
    };
  }

  /** Operator can flip the config at runtime — picked up by the next
   *  call to triage(). */
  updateConfig(patch: Partial<{ enabled: boolean; autoApplyThreshold: number }>): void {
    if (patch.enabled !== undefined) this.opts.enabled = !!patch.enabled;
    if (patch.autoApplyThreshold !== undefined) this.opts.autoApplyThreshold = clamp01(patch.autoApplyThreshold);
  }

  /** Hook the engine to an incoming incident. Errors are swallowed —
   *  triage failure must not block the incident pipeline. */
  async onIncidentCreated(incident: Incident): Promise<TriageDecisionRecord | null> {
    if (!this.opts.enabled) return null;
    try {
      return await this.triage(incident);
    } catch (e) {
      log.error('triage failed', { incidentId: incident.id, err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** Full triage pipeline — gather context, query the model, decide
   *  whether to auto-apply, record + audit. Exposed for the on-demand
   *  endpoint POST /api/ai/triage/recompute/:incidentId. */
  async triage(incident: Incident): Promise<TriageDecisionRecord> {
    const ctx = this.gatherContext(incident);
    const suggestion = this.opts.modelOverride
      ? await this.opts.modelOverride(ctx)
      : await this.invokeModel(ctx);

    const safe = this.coerceSuggestion(suggestion, ctx);
    const autoApplied = safe.confidence >= this.opts.autoApplyThreshold;

    const decisionId = `triage-${uuidv4()}`;
    const createdAt = new Date().toISOString();
    const record: TriageDecisionRecord = {
      id: decisionId,
      incidentId: incident.id,
      ...safe,
      autoApplied,
      createdAt,
    };

    if (autoApplied) {
      this.applyDecision(incident, safe);
    }

    this.deps.decisionStore.insert({
      id: decisionId,
      kind: 'triage',
      incidentId: incident.id,
      confidence: safe.confidence,
      reasoning: safe.reasoning,
      autoApplied,
      payload: {
        severity: safe.severity,
        categories: safe.categories,
        suggestedAgentId:   safe.suggestedAgentId,
        suggestedAgentName: safe.suggestedAgentName,
        estimatedResolutionMinutes: safe.estimatedResolutionMinutes,
        originalSeverity: incident.severity,
      },
      createdAt,
    });

    this.deps.auditLog?.({
      actor: 'auto-triage',
      actorType: 'system',
      action: autoApplied ? 'triage.auto_applied' : 'triage.suggested',
      resource: 'incident',
      resourceId: incident.id,
      outcome: 'success',
      severity: 'info',
      details: {
        severity: safe.severity,
        categories: safe.categories,
        suggestedAgent: safe.suggestedAgentName,
        confidence: safe.confidence,
        autoApplied,
      },
    });

    this.deps.broadcast?.({ type: 'triage_decision', data: record });
    return record;
  }

  /** Build the structured context payload handed to the model. Each
   *  store is optional — the engine degrades gracefully without them. */
  private gatherContext(incident: Incident): TriageContext {
    let asset: unknown = null;
    if (this.deps.assetStore && incident.serverId) {
      try { asset = this.deps.assetStore.getByServerId(incident.serverId); }
      catch (e) { log.warn('assetStore.getByServerId failed', { err: errMsg(e) }); }
    }

    let recentChanges: unknown[] = [];
    if (this.deps.changeStore && incident.serverId) {
      try {
        const since = new Date(Date.now() - this.opts.changeWindowDays * 24 * 60 * 60 * 1000).toISOString();
        const until = new Date().toISOString();
        recentChanges = this.deps.changeStore.changesInWindow(since, until, { serverId: incident.serverId });
      } catch (e) { log.warn('changeStore.changesInWindow failed', { err: errMsg(e) }); }
    }

    let recurringProblem: unknown = null;
    if (this.deps.problemStore && incident.sourceRef) {
      try {
        recurringProblem = this.deps.problemStore.findBySourcePattern(incident.sourceRef, { serverId: incident.serverId ?? null });
      } catch (e) { log.warn('problemStore.findBySourcePattern failed', { err: errMsg(e) }); }
    }

    let relevantKb: Array<{ id: string; title: string; usefulCount: number }> = [];
    if (this.deps.knowledgeStore && this.opts.knowledgeLimit > 0) {
      try {
        // KnowledgeStore.search returns a typed ScoredArticle list —
        // we project to the minimal shape the engine actually uses so
        // the rest of the engine doesn't depend on KB internals.
        const raw = this.deps.knowledgeStore.search(incident.title, { limit: this.opts.knowledgeLimit });
        relevantKb = (raw || []).map(a => ({ id: a.id, title: a.title, usefulCount: a.usefulCount ?? 0 }));
      } catch (e) { log.warn('knowledgeStore.search failed', { err: errMsg(e) }); }
    }

    const candidateAgents = this.deps.organization?.getAllAgents() ?? [];

    return { incident, asset, recentChanges, recurringProblem, relevantKb, candidateAgents };
  }

  /** Patch the incident with the model's decision. Severity changes go
   *  through IncidentManager.update so the SLA tracker + downstream
   *  listeners pick the change up. */
  private applyDecision(incident: Incident, s: TriageSuggestion): void {
    if (s.severity !== incident.severity) {
      try { this.deps.incidentManager.update(incident.id, { severity: s.severity }); }
      catch (e) { log.warn('failed to apply triage severity', { incidentId: incident.id, err: errMsg(e) }); }
    }
    if (s.suggestedAgentId && s.suggestedAgentId !== incident.assignedAgent) {
      try {
        // assignedTo (free-form label) + assignedAgent (stable id) are
        // both updated so the UI and the workload tracker agree.
        this.deps.incidentManager.update(incident.id, { assignedTo: s.suggestedAgentName ?? s.suggestedAgentId });
        // assignAgent is a separate IncidentManager method; if not
        // available we fall back to the patch above which still pins
        // the human-readable label.
        const im = this.deps.incidentManager as unknown as { assignAgent?: (id: string, agentId: string, agentName?: string | null, source?: string) => void };
        if (typeof im.assignAgent === 'function') {
          im.assignAgent(incident.id, s.suggestedAgentId, s.suggestedAgentName, 'auto-triage');
        }
      } catch (e) { log.warn('failed to apply triage assignee', { incidentId: incident.id, err: errMsg(e) }); }
    }
  }

  /** Default LLM path — only invoked when no `modelOverride` was set.
   *  Returns a TriageSuggestion or throws; callers handle the throw. */
  private async invokeModel(ctx: TriageContext): Promise<TriageSuggestion> {
    const provider = await this.deps.aiFactory.getDefaultProvider();
    const prompt = this.buildPrompt(ctx);
    const response = await provider.chat({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 800,
    });
    return this.parseModelOutput(response.content);
  }

  private buildPrompt(ctx: TriageContext): string {
    const { incident, asset, recentChanges, recurringProblem, relevantKb, candidateAgents } = ctx;
    const lines: string[] = [];
    lines.push('INCIDENT TO TRIAGE');
    lines.push(`  title: ${incident.title}`);
    lines.push(`  description: ${incident.description || '(none)'}`);
    lines.push(`  current severity: ${incident.severity}`);
    lines.push(`  source: ${incident.source}`);
    lines.push(`  sourceRef: ${incident.sourceRef ?? '(none)'}`);
    lines.push(`  serverId: ${incident.serverId ?? '(none)'}`);
    if (asset) {
      lines.push('\nAFFECTED ASSET');
      lines.push('  ' + JSON.stringify(asset).slice(0, 600));
    }
    if (recentChanges.length > 0) {
      lines.push('\nRECENT CHANGES (last ' + this.opts.changeWindowDays + ' days)');
      for (const ch of recentChanges.slice(0, 10)) {
        lines.push('  ' + JSON.stringify(ch).slice(0, 400));
      }
    }
    if (recurringProblem) {
      lines.push('\nRECURRING PROBLEM MATCH');
      lines.push('  ' + JSON.stringify(recurringProblem).slice(0, 600));
    }
    if (relevantKb.length > 0) {
      lines.push('\nRELEVANT KNOWLEDGE');
      for (const a of relevantKb) lines.push(`  - [${a.id}] ${a.title} (usefulCount=${a.usefulCount})`);
    }
    if (candidateAgents.length > 0) {
      lines.push('\nCANDIDATE AGENTS');
      for (const a of candidateAgents.slice(0, 15)) {
        lines.push(`  - id=${a.id} name="${a.name}" role=${a.role ?? '?'} skills=[${(a.skills ?? []).join(',')}]`);
      }
    }
    lines.push('\nReturn ONLY valid JSON with this shape:');
    lines.push('{');
    lines.push('  "severity": "critical|high|medium|low",');
    lines.push('  "categories": ["network"|"disk"|"cpu"|"memory"|"service"|"security"|"application"|"database"|"unknown"],');
    lines.push('  "suggestedAgentId": "<agent id or null>",');
    lines.push('  "suggestedAgentName": "<agent name or null>",');
    lines.push('  "estimatedResolutionMinutes": <integer>,');
    lines.push('  "confidence": <number in [0,1]>,');
    lines.push('  "reasoning": "<one short paragraph>"');
    lines.push('}');
    return lines.join('\n');
  }

  private parseModelOutput(raw: string): TriageSuggestion {
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(clean) as Partial<TriageSuggestion>;
    return {
      severity: (parsed.severity ?? 'medium') as IncidentSeverity,
      categories: Array.isArray(parsed.categories) ? parsed.categories as TriageCategory[] : ['unknown'],
      suggestedAgentId: parsed.suggestedAgentId ?? null,
      suggestedAgentName: parsed.suggestedAgentName ?? null,
      estimatedResolutionMinutes: typeof parsed.estimatedResolutionMinutes === 'number' ? parsed.estimatedResolutionMinutes : 60,
      confidence: clamp01(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning supplied.',
    };
  }

  /** Coerce the model's output into safe types — clamp confidence,
   *  drop invalid categories, resolve agent ids against the org. */
  private coerceSuggestion(s: TriageSuggestion, ctx: TriageContext): TriageSuggestion {
    const validSeverities: IncidentSeverity[] = ['critical', 'high', 'medium', 'low'];
    const severity: IncidentSeverity = validSeverities.includes(s.severity) ? s.severity : ctx.incident.severity;
    const categories = (s.categories.length > 0 ? s.categories : ['unknown'] as TriageCategory[])
      .map(c => (VALID_CATEGORIES.includes(c) ? c : 'unknown'))
      .filter((c, i, arr) => arr.indexOf(c) === i)
      .slice(0, 5) as TriageCategory[];

    // Resolve agent id against the organization. The model sometimes
    // returns a name in the id slot; tolerate both.
    let suggestedAgentId: string | null = null;
    let suggestedAgentName: string | null = null;
    if (s.suggestedAgentId || s.suggestedAgentName) {
      const wanted = (s.suggestedAgentId ?? s.suggestedAgentName ?? '').toLowerCase();
      const match = ctx.candidateAgents.find(a => a.id.toLowerCase() === wanted || a.name.toLowerCase() === wanted);
      if (match) {
        suggestedAgentId = match.id;
        suggestedAgentName = match.name;
      } else if (s.suggestedAgentName) {
        suggestedAgentName = s.suggestedAgentName;
      }
    }

    return {
      severity,
      categories,
      suggestedAgentId,
      suggestedAgentName,
      estimatedResolutionMinutes: Math.max(1, Math.round(s.estimatedResolutionMinutes || 60)),
      confidence: clamp01(s.confidence),
      reasoning: (s.reasoning ?? '').slice(0, 2000),
    };
  }
}

const SYSTEM_PROMPT =
  'You are an SRE triage analyst. Read the incident, the affected asset, recent changes, ' +
  'recurring problem context, and relevant knowledge-base hits, then produce a structured ' +
  'triage decision. Always reply with one JSON object — no markdown, no commentary.';

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

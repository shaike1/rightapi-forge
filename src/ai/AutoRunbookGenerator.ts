// AutoRunbookGenerator — turn natural-language prompts (or post-incident
// resolution notes) into structured runbook drafts with audit + decision
// tracking. Distinct from the simpler `RunbookGenerator` in this dir,
// which is a one-shot LLM wrapper used by the existing
// /api/runbooks/generate endpoint.
//
// Two entry points:
//   1. fromPrompt(text)     — chat-driven creation: "Create a runbook
//      for when nginx goes down on vps1". The LLM produces a template
//      with trigger config, ordered steps, and approval gates.
//   2. fromResolvedIncident(incident, timeline) — invoked when an
//      operator manually resolves an incident. The generator looks at
//      the resolution note + timeline and proposes a runbook that
//      would automate the fix next time.
//
// Output policy:
//   • Generated templates are saved as `enabled: false` — an operator
//     must explicitly flip the switch before any auto-execution path
//     picks them up.
//   • Steps are coerced to the allowed types. Anything outside the
//     whitelist is replaced with a notification step explaining the
//     omission.
//
// Decisions land in AiDecisionStore (kind='runbook-generate') so the AI
// Insights dashboard can surface "drafts proposed today" alongside
// triage/resolve/predict stats.

import { v4 as uuidv4 } from 'uuid';
import type { AIProviderFactory } from './factory.js';
import type { AiDecisionStore } from './AiDecisionStore.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'runbook-generator' });

export type GeneratedStepType =
  | 'command' | 'check_metric' | 'action' | 'wait'
  | 'condition' | 'escalate' | 'notification' | 'approval' | 'resolve';

const VALID_STEP_TYPES: GeneratedStepType[] = [
  'command', 'check_metric', 'action', 'wait',
  'condition', 'escalate', 'notification', 'approval', 'resolve',
];

export interface GeneratedRunbookStep {
  id: string;
  type: GeneratedStepType;
  description: string;
  /** Free-form params — the existing RunbookEngine reads these per type
   *  (e.g. command.shell, command.target, check_metric.threshold). */
  params?: Record<string, unknown>;
}

export interface GeneratedRunbookDraft {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  triggerType: 'manual' | 'incident_match' | 'schedule';
  triggerConfig?: Record<string, unknown>;
  steps: GeneratedRunbookStep[];
  enabled: boolean;
  /** Reason / explanation surfaced in the chat preview card. */
  reasoning: string;
  /** [0,1]. Self-reported by the LLM. */
  confidence: number;
}

export interface AutoRunbookGeneratorDeps {
  aiFactory: AIProviderFactory;
  decisionStore: AiDecisionStore;
  /** Optional saver. When set, `save=true` in fromPrompt() actually
   *  persists the template via this hook. Without it the result is
   *  returned to the caller but never persisted. */
  saveTemplate?: (t: GeneratedRunbookDraft) => { id: string } | void;
  /** Existing runbook ids so the generator can dedupe (returns the
   *  existing entry rather than minting a clashing one). */
  listExistingIds?: () => string[];
  auditLog?: (entry: { actor: string; actorType: string; action: string; resource: string; resourceId?: string; outcome: 'success' | 'failure'; severity: 'info' | 'warning'; details?: Record<string, unknown> }) => void;
}

export interface AutoRunbookGeneratorOptions {
  enabled?: boolean;
  /** When set, bypasses the LLM and returns this draft. Used by tests
   *  to assert the persistence + decision-store paths deterministically. */
  modelOverride?: (input: { prompt: string; context?: Record<string, unknown> }) => Promise<GeneratedRunbookDraft>;
}

export interface PromptInput {
  /** Free-form description, e.g. "when nginx goes down on vps1 restart it". */
  prompt: string;
  /** Optional context the chat layer can supply — known server,
   *  preferred category, etc. */
  context?: Record<string, unknown>;
  /** When true, persist the draft (disabled) via deps.saveTemplate.
   *  Defaults to false — the chat flow shows a preview first. */
  save?: boolean;
  /** Who requested the draft. Surfaced on the audit log entry. */
  actor?: string;
}

export class AutoRunbookGenerator {
  private deps: AutoRunbookGeneratorDeps;
  private opts: Required<Omit<AutoRunbookGeneratorOptions, 'modelOverride'>> & Pick<AutoRunbookGeneratorOptions, 'modelOverride'>;

  constructor(deps: AutoRunbookGeneratorDeps, opts: AutoRunbookGeneratorOptions = {}) {
    this.deps = deps;
    this.opts = {
      enabled:       opts.enabled ?? true,
      modelOverride: opts.modelOverride,
    };
  }

  getConfig(): { enabled: boolean } { return { enabled: this.opts.enabled }; }
  updateConfig(patch: Partial<{ enabled: boolean }>): void {
    if (patch.enabled !== undefined) this.opts.enabled = !!patch.enabled;
  }

  /** Main entry point — chat-driven runbook creation. Returns the draft
   *  template (never auto-applied); when `save=true` the disabled draft
   *  is also persisted. */
  async fromPrompt(input: PromptInput): Promise<GeneratedRunbookDraft> {
    if (!this.opts.enabled) throw new Error('AutoRunbookGenerator is disabled');
    const draft = this.opts.modelOverride
      ? await this.opts.modelOverride({ prompt: input.prompt, context: input.context })
      : await this.invokeModel(input);
    const sanitized = this.coerce(draft);
    let savedId: string | undefined;
    if (input.save && this.deps.saveTemplate) {
      try {
        const r = this.deps.saveTemplate(sanitized) ?? {};
        savedId = (r as any).id ?? sanitized.id;
      } catch (e) {
        log.warn('saveTemplate threw', { err: errMsg(e) });
      }
    }
    this.deps.decisionStore.insert({
      id: `runbook-gen-${uuidv4()}`,
      kind: 'runbook-generate',
      incidentId: typeof input.context?.incidentId === 'string' ? input.context.incidentId : null,
      confidence: sanitized.confidence,
      reasoning: sanitized.reasoning,
      autoApplied: !!savedId,
      payload: {
        templateId: sanitized.id,
        name: sanitized.name,
        steps: sanitized.steps.length,
        savedAsDisabled: !!savedId,
        promptPreview: input.prompt.slice(0, 200),
      },
    });
    this.deps.auditLog?.({
      actor: input.actor ?? 'chat-user',
      actorType: 'user',
      action: savedId ? 'runbook-gen.saved' : 'runbook-gen.previewed',
      resource: 'runbook',
      resourceId: sanitized.id,
      outcome: 'success',
      severity: 'info',
      details: { name: sanitized.name, steps: sanitized.steps.length, enabled: sanitized.enabled },
    });
    return sanitized;
  }

  /** Post-incident hook — looks at the manually-resolved incident and
   *  proposes a runbook from the resolution note + timeline. Always
   *  saves as disabled draft so an operator can review and enable. */
  async fromResolvedIncident(input: {
    incident: { id: string; title: string; description?: string; severity: string; sourceRef?: string | null; serverId?: string | null; resolvedBy?: string };
    timeline?: Array<{ type: string; message: string; actor: string; timestamp: string }>;
  }): Promise<GeneratedRunbookDraft | null> {
    if (!this.opts.enabled) return null;
    const resolutionNotes = (input.timeline ?? [])
      .filter(t => t.type === 'note' || t.type === 'resolved')
      .map(t => `[${t.actor}] ${t.message}`)
      .join('\n');
    const prompt = [
      `Incident ${input.incident.id} was just resolved manually.`,
      `Title: ${input.incident.title}`,
      `Description: ${input.incident.description || '(none)'}`,
      `Source: ${input.incident.sourceRef ?? '(none)'}`,
      `Resolution notes:\n${resolutionNotes || '(none)'}`,
      '',
      'Propose a runbook that would automate this fix next time. ' +
      'Keep it conservative — prefer reversible checks and require human approval ' +
      'before destructive steps.',
    ].join('\n');
    try {
      return await this.fromPrompt({
        prompt,
        save: false,
        actor: input.incident.resolvedBy ?? 'post-incident-suggest',
        context: { incidentId: input.incident.id, serverId: input.incident.serverId },
      });
    } catch (e) {
      log.warn('fromResolvedIncident failed', { incidentId: input.incident.id, err: errMsg(e) });
      return null;
    }
  }

  private async invokeModel(input: PromptInput): Promise<GeneratedRunbookDraft> {
    const provider = await this.deps.aiFactory.getDefaultProvider();
    const existing = (this.deps.listExistingIds?.() ?? []).slice(0, 30).join(', ');
    const system = [
      'You are an SRE runbook author. Given a natural-language description ' +
      'of an operational fix, produce a single structured runbook template.',
      '',
      'Output ONE JSON object with this exact shape:',
      '{',
      '  "id": "<kebab-case-id>",',
      '  "name": "<short title>",',
      '  "description": "<one paragraph>",',
      '  "category": "infrastructure|monitoring|security|deployment|networking|database|application",',
      '  "tags": ["..."] ,',
      '  "triggerType": "manual|incident_match|schedule",',
      '  "triggerConfig": { ... }   /* shape matches triggerType; omit for manual */,',
      '  "steps": [',
      '    { "id":"step-1", "type":"check_metric|command|action|wait|condition|escalate|notification|approval|resolve",',
      '      "description":"...", "params": { ... } }',
      '  ],',
      '  "reasoning": "<short explanation of why this sequence>",',
      '  "confidence": <number in [0,1]>',
      '}',
      '',
      'Rules:',
      '- Use ONLY the listed step types. Anything else is rejected.',
      '- Prefer non-destructive checks before destructive actions.',
      '- Insert an "approval" step before any destructive command (rm -rf, drop, restart of critical service).',
      '- The id must be kebab-case and stable.',
      '- Never output markdown, prose, or code fences. JSON only.',
      existing ? `Existing runbook ids (avoid clashes): ${existing}` : '',
    ].filter(Boolean).join('\n');
    const response = await provider.chat({
      system,
      messages: [{ role: 'user', content: input.prompt }],
      temperature: 0.2,
      maxTokens: 1500,
    });
    return this.parseModelOutput(response.content);
  }

  private parseModelOutput(raw: string): GeneratedRunbookDraft {
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(clean) as Partial<GeneratedRunbookDraft>;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : `rb-${uuidv4().slice(0, 8)}`,
      name: typeof parsed.name === 'string' ? parsed.name : 'Untitled runbook',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      category: typeof parsed.category === 'string' ? parsed.category : 'infrastructure',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
      triggerType: ['manual', 'incident_match', 'schedule'].includes(String(parsed.triggerType))
        ? (parsed.triggerType as GeneratedRunbookDraft['triggerType']) : 'manual',
      triggerConfig: typeof parsed.triggerConfig === 'object' && parsed.triggerConfig !== null ? parsed.triggerConfig as Record<string, unknown> : undefined,
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s, i) => this.coerceStep(s as any, i)) : [],
      enabled: false,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      confidence: clamp01(typeof parsed.confidence === 'number' ? parsed.confidence : 0.5),
    };
  }

  private coerceStep(s: any, idx: number): GeneratedRunbookStep {
    const original = s?.type;
    const type = VALID_STEP_TYPES.includes(original) ? (original as GeneratedStepType) : 'notification';
    const id = typeof s?.id === 'string' && s.id ? s.id : `step-${idx + 1}`;
    const description = typeof s?.description === 'string' ? s.description : 'Untitled step';
    if (!VALID_STEP_TYPES.includes(original)) {
      return {
        id, type: 'notification',
        description: `Skipped invalid step type "${String(original ?? '(empty)')}": ${description}`,
        params: { reason: 'invalid_step_type', original },
      };
    }
    return { id, type, description, params: typeof s?.params === 'object' && s.params !== null ? s.params : undefined };
  }

  /** Final pass: validate step types, dedupe step ids, enforce
   *  kebab-case template id, always set enabled=false, ensure at least
   *  one step exists. Runs on every path — model output AND override —
   *  so invalid step types can't sneak through a test-only short-circuit. */
  private coerce(draft: GeneratedRunbookDraft): GeneratedRunbookDraft {
    const id = toKebab(draft.id || draft.name || 'untitled');
    const usedStepIds = new Set<string>();
    const steps: GeneratedRunbookStep[] = [];
    for (const [i, s] of draft.steps.entries()) {
      const validated = this.coerceStep(s as any, i);
      let stepId = toKebab(validated.id || `step-${i + 1}`);
      let n = 1;
      while (usedStepIds.has(stepId)) { stepId = `${toKebab(validated.id || 'step')}-${++n}`; }
      usedStepIds.add(stepId);
      steps.push({ ...validated, id: stepId });
    }
    if (steps.length === 0) {
      steps.push({
        id: 'step-1',
        type: 'notification',
        description: 'Empty draft — generator returned no actionable steps. Edit before enabling.',
      });
    }
    return {
      ...draft,
      id, steps,
      enabled: false,   // disabled by policy regardless of model output
    };
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function toKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'untitled';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// PostMortemGenerator — turns a resolved Incident into a structured
// PostMortem row.
//
// Triggered from the IncidentManager.onResolved hook (server.ts wires
// it). Reads the full incident + its timeline, asks the AI to extract a
// structured summary (root cause, actions taken, resolution, lessons,
// prevention), and persists the result via PostMortemStore.
//
// Severity gate: low-severity incidents skip generation. They're already
// noisy in the existing review channels and the LLM cost / token budget
// is better spent on the cases an operator would actually re-read.
//
// Idempotency: if a post-mortem already exists for this incident id,
// generate() is a no-op. This lets callers fire it multiple times safely
// (e.g. on resolve + on a manual /api/incidents/:id/regenerate-mortem).
//
// Failure modes:
//   - AI provider down → log + return null, do NOT throw. We never want
//     a slow / failing LLM to back up the resolve pipeline.
//   - Malformed JSON → fall back to a heuristic post-mortem built from
//     the timeline (still structured, no AI text). That keeps the KB
//     populated even when the model is misbehaving.

import type { AIProviderFactory } from '../ai/factory.js';
import type { IncidentManager } from './IncidentManager.js';
import type { Incident, TimelineEntry } from '../persistence/SqliteStore.js';
import { PostMortemStore, deriveIncidentType, type PostMortem } from '../persistence/PostMortemStore.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'post-mortem-generator' });

/** Severities we generate post-mortems for. 'low' is excluded by design
 *  — see header. Operators can override per-deploy via
 *  POST_MORTEM_MIN_SEVERITY=low if they want full coverage. */
const DEFAULT_INCLUDED_SEVERITIES = new Set<string>(['medium', 'high', 'critical']);

export interface PostMortemGeneratorOpts {
  /** Override the default severity gate. */
  includedSeverities?: string[];
  /** Skip the AI call entirely; only emit the heuristic post-mortem.
   *  Useful in tests and when an operator wants pure timeline-based
   *  summaries. */
  skipAi?: boolean;
  /** Max tokens for the AI response. The structured payload is small;
   *  1500 is plenty for the longest reasonable post-mortem. */
  maxTokens?: number;
  /** Override the AI model the factory picks. Default: the factory's
   *  configured default (typically claude-sonnet-4-6 via omniroute). */
  preferredPlatform?: 'claude' | 'openai' | 'ollama' | 'moonshot' | 'glm' | 'minimax';
  /** Broadcast hook so the UI can react when a new post-mortem lands. */
  broadcast?: (event: { type: string; data: unknown }) => void;
}

export class PostMortemGenerator {
  private readonly includedSeverities: Set<string>;
  private readonly skipAi: boolean;
  private readonly maxTokens: number;
  private readonly preferredPlatform?: PostMortemGeneratorOpts['preferredPlatform'];
  private readonly broadcast?: PostMortemGeneratorOpts['broadcast'];

  /** Generation in flight, by incident id. Stops a re-fire on the same
   *  incident from kicking off a second AI call. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly aiFactory: AIProviderFactory,
    private readonly incidents: IncidentManager,
    private readonly store: PostMortemStore,
    opts: PostMortemGeneratorOpts = {},
  ) {
    this.includedSeverities = new Set(opts.includedSeverities ?? Array.from(DEFAULT_INCLUDED_SEVERITIES));
    this.skipAi = opts.skipAi ?? false;
    this.maxTokens = opts.maxTokens ?? 1500;
    this.preferredPlatform = opts.preferredPlatform;
    this.broadcast = opts.broadcast;
  }

  /** Entry point — called by the IncidentManager.onResolved hook. The
   *  return promise resolves with the persisted PostMortem (or null when
   *  generation was skipped / failed). Errors are swallowed; callers
   *  treat null as "no post-mortem was produced, move on". */
  async generate(incident: Incident): Promise<PostMortem | null> {
    if (!this.includedSeverities.has(incident.severity)) {
      log.info('skipping post-mortem — severity below threshold', {
        incidentId: incident.id, severity: incident.severity,
      });
      return null;
    }
    if (this.inFlight.has(incident.id)) {
      log.info('skipping post-mortem — generation already in flight', { incidentId: incident.id });
      return null;
    }
    // Idempotency — return the existing one rather than creating a duplicate.
    const existing = this.store.byIncident(incident.id);
    if (existing.length > 0) {
      log.info('post-mortem already exists for incident — skipping', {
        incidentId: incident.id, postMortemId: existing[0].id,
      });
      return existing[0];
    }

    this.inFlight.add(incident.id);
    try {
      const timeline = this.incidents.getTimeline(incident.id);
      const durationMinutes = this.computeDurationMinutes(incident);
      const incidentType = deriveIncidentType({ title: incident.title, sourceRef: incident.sourceRef ?? null });

      let aiResult: AiPostMortemPayload | null = null;
      let aiModel: string | null = null;
      if (!this.skipAi) {
        const ai = await this.callAi(incident, timeline).catch(err => {
          log.warn('post-mortem AI call failed; will fall back to heuristic', {
            incidentId: incident.id,
            err: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
        if (ai) {
          aiResult = ai.payload;
          aiModel = ai.model;
        }
      }

      const fallback = this.heuristicPostMortem(incident, timeline);
      const final: AiPostMortemPayload = aiResult ?? fallback;

      const tags = uniqueTags([
        incidentType,
        incident.severity,
        ...(incident.serverId ? [incident.serverId] : []),
        ...(final.tags ?? []),
      ]);

      const pm = this.store.insert({
        incidentId: incident.id,
        serverId: incident.serverId ?? null,
        incidentType,
        title: incident.title,
        severity: incident.severity,
        rootCause: clamp(final.rootCause, 1500),
        actionsTaken: (final.actionsTaken ?? []).map(s => clamp(s, 600)),
        resolution: clamp(final.resolution, 1500),
        durationMinutes,
        lessons: (final.lessons ?? []).map(s => clamp(s, 500)),
        prevention: (final.prevention ?? []).map(s => clamp(s, 500)),
        tags,
        aiModel,
      });

      log.info('post-mortem written', {
        incidentId: incident.id,
        postMortemId: pm.id,
        durationMinutes,
        incidentType,
        aiModel,
      });
      this.broadcast?.({ type: 'post_mortem_created', data: { incidentId: incident.id, postMortemId: pm.id } });
      return pm;
    } catch (err) {
      log.error('post-mortem generation threw', {
        incidentId: incident.id,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return null;
    } finally {
      this.inFlight.delete(incident.id);
    }
  }

  /** Synchronous fire-and-forget wrapper for use from the IncidentManager
   *  onResolved hook. Discards the result; errors only log. */
  handle(incident: Incident): void {
    this.generate(incident).catch(err => {
      log.error('generate() rejected unexpectedly', {
        incidentId: incident.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── AI call ──────────────────────────────────────────────────────────────

  private async callAi(
    incident: Incident,
    timeline: TimelineEntry[],
  ): Promise<{ payload: AiPostMortemPayload; model: string } | null> {
    const provider = this.preferredPlatform
      ? await this.aiFactory.getProvider(this.preferredPlatform)
      : await this.aiFactory.getDefaultProvider();

    const prompt = this.buildPrompt(incident, timeline);

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an SRE post-incident-review author. Always respond with valid JSON only — no markdown, no code fences, no prose outside the JSON.',
      maxTokens: this.maxTokens,
      temperature: 0.2,
    });

    const cleaned = response.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      log.warn('post-mortem AI returned non-JSON; falling back to heuristic', {
        incidentId: incident.id,
        preview: cleaned.slice(0, 200),
      });
      return null;
    }

    return {
      payload: {
        rootCause: stringField(parsed.rootCause, 'AI did not provide a root cause.'),
        actionsTaken: arrayField(parsed.actionsTaken),
        resolution: stringField(parsed.resolution, 'AI did not provide a resolution summary.'),
        lessons: arrayField(parsed.lessons),
        prevention: arrayField(parsed.prevention),
        tags: arrayField(parsed.tags),
      },
      model: response.model ?? provider.name ?? 'unknown',
    };
  }

  private buildPrompt(incident: Incident, timeline: TimelineEntry[]): string {
    const tlExcerpt = timeline.slice(0, 60).map(t => {
      const msg = (t.message || '').replace(/\s+/g, ' ').slice(0, 400);
      return `[${t.timestamp}] (${t.type}/${t.actor}) ${msg}`;
    }).join('\n');

    return [
      `Write a structured post-incident review for the resolved incident below.`,
      ``,
      `INCIDENT`,
      `  id:        ${incident.id}`,
      `  title:     ${incident.title}`,
      `  severity:  ${incident.severity}`,
      `  source:    ${incident.source}${incident.sourceRef ? ` (${incident.sourceRef})` : ''}`,
      `  server:    ${incident.serverId ?? 'unknown'}`,
      `  opened:    ${incident.createdAt}`,
      `  resolved:  ${incident.resolvedAt ?? 'unknown'}`,
      `  duration:  ${this.computeDurationMinutes(incident)} minutes`,
      incident.description ? `  details:   ${incident.description.slice(0, 800)}` : '',
      ``,
      `TIMELINE (chronological — first 60 entries)`,
      tlExcerpt || '(empty)',
      ``,
      `Return ONLY this JSON object, no other text:`,
      `{`,
      `  "rootCause": "string — what actually caused the incident, cited from the timeline",`,
      `  "actionsTaken": ["string — each diagnostic or remediation step that was tried, in order"],`,
      `  "resolution": "string — what specifically fixed it (or, if nothing fixed it, how it ended)",`,
      `  "lessons": ["string — short declarative sentences a future agent can apply when seeing similar incidents"],`,
      `  "prevention": ["string — concrete suggestions (runbook updates, alert tweaks, capacity changes)"],`,
      `  "tags": ["string — keywords future searches will use to find this post-mortem"]`,
      `}`,
      ``,
      `Cite concrete values from the timeline. Do not invent numbers. Keep each string under ~300 chars.`,
    ].filter(Boolean).join('\n');
  }

  // ── Heuristic fallback ───────────────────────────────────────────────────
  //
  // Used when the AI call fails or skipAi is set. We extract enough
  // structure from the timeline to be useful — actions taken come from
  // note/updated entries, resolution comes from the resolved entry,
  // root cause is a best-effort phrase pulled from the description.

  private heuristicPostMortem(incident: Incident, timeline: TimelineEntry[]): AiPostMortemPayload {
    const resolvedEntry = timeline.find(t => t.type === 'resolved');
    const actions = timeline
      .filter(t => t.type === 'note' || t.type === 'updated')
      .map(t => `${t.actor}: ${t.message.replace(/\s+/g, ' ').slice(0, 200)}`)
      .slice(0, 20);
    const rootCause = (incident.description || '').trim() || `Resolved ${incident.severity} incident — no structured root cause captured.`;
    const resolution = resolvedEntry?.message?.replace(/\s+/g, ' ').slice(0, 400)
      ?? 'Resolved without an explicit resolution note.';
    return {
      rootCause,
      actionsTaken: actions,
      resolution,
      lessons: [],
      prevention: [],
      tags: [],
    };
  }

  private computeDurationMinutes(incident: Incident): number {
    const start = Date.parse(incident.createdAt);
    const end = incident.resolvedAt ? Date.parse(incident.resolvedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return Math.max(0, Math.round((end - start) / 60000));
  }
}

interface AiPostMortemPayload {
  rootCause: string;
  actionsTaken: string[];
  resolution: string;
  lessons: string[];
  prevention: string[];
  tags?: string[];
}

function stringField(v: unknown, fallback: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return fallback;
}

function arrayField(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string | number | boolean => x != null && typeof x !== 'object')
    .map(x => String(x).trim())
    .filter(s => s.length > 0);
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
  }
  return out;
}

function clamp(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

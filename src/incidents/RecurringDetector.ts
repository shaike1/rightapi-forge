// RecurringDetector — turns repeated incidents into a single "problem" record.
//
// On every new incident (and on a 5-minute sweep) the detector looks for
// patterns:
//   - same sourceRef prefix (e.g. five `disk:%` incidents in a week)
//   - same server + similar title (Levenshtein / shared keywords)
//
// When the threshold is crossed, a Problem row is created (or extended)
// in ProblemStore and an AI root-cause analysis is kicked off via the
// Anthropic SDK (same omniroute + cc/claude-sonnet-4-6 pattern that
// PostMortemGenerator and ChatBotService use).
//
// The detector is intentionally pure-data on the read side: it never
// mutates incidents, only writes to ProblemStore. Errors in the AI
// call don't block problem creation — the structured fields stay null
// until a later re-analyze call succeeds.

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../observability/Logger.js';
import type {
  Incident, IncidentSeverity, IncidentStatus, TimelineEntry,
} from '../persistence/SqliteStore.js';
import type { IncidentManager } from './IncidentManager.js';
import type { PostMortemStore } from '../persistence/PostMortemStore.js';
import type {
  ProblemStore, Problem, AiConfidence,
} from './ProblemStore.js';

const log = createLogger({ component: 'recurring-detector' });

// ── Tuning ────────────────────────────────────────────────────────────

interface DetectorConfig {
  /** Minimum incidents that must match the same pattern within the
   *  window before a Problem is created. Default 3. */
  minCount: number;
  /** Look-back window in days. Default 7. */
  windowDays: number;
  /** Title-similarity threshold (0..1). Two titles are "similar" when
   *  their normalised Levenshtein distance is ≤ this value. Default
   *  0.30 — the spec's "less than 30% of title length". */
  titleSimilarityThreshold: number;
  /** Max linked incidents to send to the AI prompt. */
  aiMaxIncidents: number;
  /** Max related post-mortems to include in the prompt. */
  aiMaxPostMortems: number;
}

function configFromEnv(env: NodeJS.ProcessEnv = process.env): DetectorConfig {
  return {
    minCount: Math.max(2, Number(env.RECURRING_MIN_COUNT ?? 3)),
    windowDays: Math.max(1, Number(env.RECURRING_WINDOW_DAYS ?? 7)),
    titleSimilarityThreshold: clamp01(Number(env.RECURRING_TITLE_SIMILARITY ?? 0.30)),
    aiMaxIncidents: Math.max(3, Number(env.RECURRING_AI_MAX_INCIDENTS ?? 5)),
    aiMaxPostMortems: Math.max(0, Number(env.RECURRING_AI_MAX_POSTMORTEMS ?? 3)),
  };
}

// ── Public types ──────────────────────────────────────────────────────

export interface DetectorResult {
  /** The problem this incident was linked to, if any. */
  problem?: Problem;
  /** True when the detector created a new problem (rather than linking
   *  to an existing one). Used by the caller to decide whether to fire
   *  the AI analysis + notify plugins. */
  created: boolean;
  /** Number of incidents now linked to the problem. */
  occurrences: number;
}

export interface RecurringDetectorDeps {
  incidents: IncidentManager;
  problems: ProblemStore;
  postMortems?: PostMortemStore;
  /** Anthropic SDK config — same shape as ChatBotService accepts. When
   *  unset, the detector still groups incidents but skips the AI call.
   *  rootCause/suggestedFix stay null on the Problem row until an
   *  operator triggers re-analysis. */
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  /** Optional config override — defaults come from env vars. */
  config?: Partial<DetectorConfig>;
  /** Notification hook fired only on the first creation. Wired in
   *  server.ts to PluginManager.notifyProblemCreated + broadcast. */
  onProblemCreated?: (problem: Problem, incidents: Incident[]) => void;
  /** Audit log writer — every problem creation + analysis is logged. */
  audit?: (action: string, detail: string) => void;
}

// ── The detector ──────────────────────────────────────────────────────

const ACTIVE_STATUSES: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>(['open', 'investigating', 'mitigating', 'resolved']);

export class RecurringDetector {
  private readonly cfg: DetectorConfig;
  private readonly anthropic: Anthropic | null;
  private readonly anthropicModel: string;

  constructor(private readonly deps: RecurringDetectorDeps) {
    this.cfg = { ...configFromEnv(), ...deps.config };
    if (deps.anthropicApiKey) {
      this.anthropic = new Anthropic({
        apiKey: deps.anthropicApiKey,
        ...(deps.anthropicBaseUrl ? { baseURL: deps.anthropicBaseUrl } : {}),
      });
      this.anthropicModel = deps.anthropicModel || 'claude-sonnet-4-6';
    } else {
      this.anthropic = null;
      this.anthropicModel = '';
    }
  }

  // ─── Detection entry point ────────────────────────────────────────────

  /** Called from IncidentManager.onCreated. Returns the linked-or-
   *  created problem if the incident is part of a recurrence; otherwise
   *  returns null. Errors are swallowed + logged — a misbehaving
   *  detector must never block incident creation. */
  async checkIncident(incident: Incident): Promise<DetectorResult | null> {
    try {
      return await this.checkIncidentInner(incident);
    } catch (e) {
      log.error('checkIncident threw', {
        incidentId: incident.id,
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  private async checkIncidentInner(incident: Incident): Promise<DetectorResult | null> {
    // 1. Existing problem with a sourceRef pattern that matches?
    if (incident.sourceRef) {
      const matched = this.deps.problems.findBySourcePattern(incident.sourceRef, {
        serverId: incident.serverId ?? null,
      });
      if (matched) {
        return this.attachToExisting(matched, incident);
      }
    }
    // 2. Existing server-scoped problem with a similar title?
    if (incident.serverId) {
      const candidates = this.deps.problems.listOpenProblemsForServer(incident.serverId);
      for (const c of candidates) {
        if (this.titlesSimilar(c.title, incident.title)) {
          return this.attachToExisting(c, incident);
        }
      }
    }
    // 3. No existing problem — look for matching historical incidents to
    // see if we've crossed the recurrence threshold.
    const matches = this.findRecurrencePeers(incident);
    if (matches.length + 1 < this.cfg.minCount) return null;
    return this.createProblem(incident, matches);
  }

  /** Periodic sweep — finds recurrence patterns the per-create check
   *  may have missed because of close-timing edge cases. Called from
   *  the server's 5-minute tick. Idempotent. */
  async sweep(): Promise<{ scanned: number; newProblems: number }> {
    const sinceMs = Date.now() - this.cfg.windowDays * 86400 * 1000;
    const candidates = this.deps.incidents.list({}).filter(i =>
      ACTIVE_STATUSES.has(i.status) &&
      Date.parse(i.createdAt) >= sinceMs &&
      !this.deps.problems.findProblemForIncident(i.id),
    );
    let newProblems = 0;
    for (const inc of candidates) {
      const r = await this.checkIncident(inc);
      if (r?.created) newProblems++;
    }
    return { scanned: candidates.length, newProblems };
  }

  // ─── Grouping logic ───────────────────────────────────────────────────

  private async attachToExisting(problem: Problem, incident: Incident): Promise<DetectorResult> {
    this.deps.problems.linkIncident(problem.id, incident.id, incident.createdAt);
    const ids = this.deps.problems.getLinkedIncidents(problem.id);
    log.info('attached incident to existing problem', {
      problemId: problem.id, incidentId: incident.id, occurrences: ids.length,
    });
    this.deps.audit?.(
      'problems.link',
      `problem=${problem.id} incident=${incident.id} occurrences=${ids.length}`,
    );
    return { problem, created: false, occurrences: ids.length };
  }

  /** Find resolved + active incidents in the window that match this one
   *  by sourceRef prefix OR by (serverId + similar title). Excludes the
   *  incident itself. */
  private findRecurrencePeers(incident: Incident): Incident[] {
    const sinceMs = Date.now() - this.cfg.windowDays * 86400 * 1000;
    const all = this.deps.incidents.list({}).filter(i =>
      i.id !== incident.id && Date.parse(i.createdAt) >= sinceMs,
    );
    const matches: Incident[] = [];
    const seen = new Set<string>();
    const sourcePrefix = this.sourceRefPrefix(incident.sourceRef);
    for (const peer of all) {
      if (seen.has(peer.id)) continue;
      // Skip peers already pinned to a problem — we don't pull
      // already-grouped incidents into a new one.
      if (this.deps.problems.findProblemForIncident(peer.id)) continue;
      const peerPrefix = this.sourceRefPrefix(peer.sourceRef);
      const sourceHit = !!(sourcePrefix && peerPrefix && sourcePrefix === peerPrefix);
      const titleHit = !!(incident.serverId && peer.serverId === incident.serverId &&
        this.titlesSimilar(incident.title, peer.title));
      if (sourceHit || titleHit) {
        matches.push(peer);
        seen.add(peer.id);
      }
    }
    return matches;
  }

  private async createProblem(incident: Incident, peers: Incident[]): Promise<DetectorResult> {
    const all = [incident, ...peers];
    // Determine the strongest severity across peers (so a critical
    // recurrence isn't silenced because the latest incident was logged
    // as medium).
    const severity = strongestSeverity(all.map(i => i.severity));
    const allShareServer = all.every(i => i.serverId && i.serverId === incident.serverId)
      ? incident.serverId
      : null;
    const sourcePrefix = this.sourceRefPrefix(incident.sourceRef);
    const sourceRefPattern = sourcePrefix ? sourcePrefix + ':%' : null;

    const firstSeenAt = all.map(i => i.createdAt).sort()[0];
    const lastSeenAt  = all.map(i => i.createdAt).sort().slice(-1)[0];
    const title = problemTitle(incident, sourcePrefix, allShareServer);
    const description = problemDescription(all, this.cfg);

    const problem = this.deps.problems.create({
      title,
      description,
      severity,
      sourceRefPattern,
      serverId: allShareServer,
      firstSeenAt,
      lastSeenAt,
    });
    for (const i of all) {
      this.deps.problems.linkIncident(problem.id, i.id, i.createdAt);
    }
    log.warn('recurring pattern detected — created problem', {
      problemId: problem.id, occurrences: all.length, severity,
      sourceRefPattern, serverId: allShareServer,
    });
    this.deps.audit?.(
      'problems.create',
      `problem=${problem.id} occurrences=${all.length} severity=${severity} ` +
      (sourceRefPattern ? `pattern=${sourceRefPattern}` : `server=${allShareServer ?? '?'}`),
    );
    this.deps.onProblemCreated?.(problem, all);

    // Fire-and-forget AI analysis. The detector returns immediately so
    // the caller's onCreated path stays fast.
    this.analyzeAsync(problem.id).catch(e =>
      log.warn('AI analysis failed', { problemId: problem.id, err: e instanceof Error ? e.message : String(e) }),
    );

    return { problem, created: true, occurrences: all.length };
  }

  // ─── AI analysis ──────────────────────────────────────────────────────

  /** Public so the API's POST /:id/analyze can re-run. Returns the
   *  updated Problem with rootCause/suggestedFix populated (or with
   *  aiRaw set to an error message when the call fails). */
  async analyze(problemId: string): Promise<Problem | null> {
    const problem = this.deps.problems.get(problemId);
    if (!problem) return null;
    if (!this.anthropic) {
      // Detector configured without an Anthropic key — just record that
      // analysis was skipped so the UI shows a clean state.
      return this.deps.problems.update(problemId, {
        aiRaw: JSON.stringify({ skipped: true, reason: 'no anthropic api key configured' }),
      });
    }
    const linked = this.deps.problems.getLinkedIncidents(problemId)
      .map(id => this.deps.incidents.get(id))
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, this.cfg.aiMaxIncidents);
    const postMortems = this.collectPostMortems(linked);
    const prompt = this.buildPrompt(problem, linked, postMortems);

    try {
      const response = await this.anthropic.messages.create({
        model: this.anthropicModel,
        max_tokens: 1500,
        temperature: 0.2,
        system: 'You are an SRE root-cause analyst. Always respond with valid JSON only — no markdown fences, no prose outside the JSON.',
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('\n');
      const parsed = parseAiPayload(text);
      this.deps.audit?.('problems.analyze.ok', `problem=${problemId} confidence=${parsed.confidence}`);
      return this.deps.problems.update(problemId, {
        rootCause: parsed.rootCause,
        suggestedFix: parsed.suggestedFix,
        aiConfidence: parsed.confidence,
        aiRaw: JSON.stringify(parsed),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('analyze() AI call failed', { problemId, err: msg });
      this.deps.audit?.('problems.analyze.error', `problem=${problemId} err=${msg}`);
      return this.deps.problems.update(problemId, {
        aiRaw: JSON.stringify({ error: msg, at: new Date().toISOString() }),
      });
    }
  }

  private analyzeAsync(problemId: string): Promise<unknown> {
    return this.analyze(problemId);
  }

  private collectPostMortems(linked: Incident[]): Array<{ title: string; rootCause: string; resolution: string }> {
    if (!this.deps.postMortems) return [];
    const out: Array<{ title: string; rootCause: string; resolution: string }> = [];
    for (const inc of linked) {
      const pms = this.deps.postMortems.byIncident(inc.id);
      for (const pm of pms) {
        out.push({ title: pm.title, rootCause: pm.rootCause, resolution: pm.resolution });
        if (out.length >= this.cfg.aiMaxPostMortems) return out;
      }
    }
    return out;
  }

  private buildPrompt(
    problem: Problem,
    linked: Array<Incident & { timeline?: TimelineEntry[] }>,
    postMortems: Array<{ title: string; rootCause: string; resolution: string }>,
  ): string {
    const lines: string[] = [];
    lines.push(`A recurring problem has been detected. ${linked.length} incidents match the same pattern over the recurrence window.`);
    lines.push('');
    lines.push(`Problem id: ${problem.id}`);
    lines.push(`Title: ${problem.title}`);
    lines.push(`Severity: ${problem.severity}`);
    if (problem.sourceRefPattern) lines.push(`Source ref pattern: ${problem.sourceRefPattern}`);
    if (problem.serverId) lines.push(`Server: ${problem.serverId}`);
    lines.push('');
    lines.push('## Linked incidents');
    for (const inc of linked) {
      lines.push(`### ${inc.id} — ${inc.title}`);
      lines.push(`severity=${inc.severity}, source=${inc.source}, sourceRef=${inc.sourceRef ?? '—'}, server=${inc.serverId ?? '—'}, createdAt=${inc.createdAt}`);
      if (inc.description?.trim()) lines.push(`description: ${inc.description.trim().slice(0, 300)}`);
      const timeline = this.deps.incidents.getTimeline(inc.id);
      if (timeline.length) {
        const tail = timeline.slice(-5).map(t => `  - ${t.actor}: ${t.message.slice(0, 200)}`).join('\n');
        lines.push('timeline tail:\n' + tail);
      }
      lines.push('');
    }
    if (postMortems.length > 0) {
      lines.push('## Relevant past post-mortems');
      for (const pm of postMortems) {
        lines.push(`### ${pm.title}`);
        lines.push(`rootCause: ${pm.rootCause.slice(0, 400)}`);
        lines.push(`resolution: ${pm.resolution.slice(0, 400)}`);
        lines.push('');
      }
    }
    lines.push('## Output');
    lines.push('Respond with STRICT JSON only, no markdown, no prose:');
    lines.push(JSON.stringify({
      rootCause: 'string — the shared underlying issue',
      suggestedFix: 'string — a PERMANENT fix, not the band-aid each individual incident gets',
      preventionRunbook: [
        { type: 'command', description: 'Check current value', command: 'df -h' },
        { type: 'check_metric', description: 'Verify cleanup', metric: 'disk', operator: '<', threshold: 85 },
      ],
      confidence: 'high | medium | low',
    }, null, 2));
    lines.push('');
    lines.push('Respond in the language the incident descriptions use (Hebrew or English).');
    return lines.join('\n');
  }

  // ─── Pure helpers (exported via _testing for unit tests) ──────────────

  /** SQL-LIKE prefix derived from an incident's sourceRef. We split on
   *  the first ":" — `disk:/data` and `disk:/var` both bucket under
   *  `disk`. Returns null for empty/unparseable refs. */
  private sourceRefPrefix(sourceRef: string | null | undefined): string | null {
    return sourceRefPrefix(sourceRef);
  }

  private titlesSimilar(a: string, b: string): boolean {
    return titleSimilarity(a, b) <= this.cfg.titleSimilarityThreshold;
  }
}

// ── Pure helpers (top-level so tests can import without instantiating) ─

export function sourceRefPrefix(sourceRef: string | null | undefined): string | null {
  if (!sourceRef) return null;
  const colon = sourceRef.indexOf(':');
  if (colon <= 0) return null;
  return sourceRef.slice(0, colon).toLowerCase();
}

/** Return normalised Levenshtein distance (0..1). Identical → 0, fully
 *  different → 1. Caller compares against a configured threshold
 *  (lower = stricter). */
export function titleSimilarity(a: string, b: string): number {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (!na || !nb) return 1;
  if (na === nb) return 0;
  const dist = levenshtein(na, nb);
  const denom = Math.max(na.length, nb.length);
  return dist / denom;
}

/** Lowercase + collapse runs of digits/whitespace. Lets "Disk full on
 *  web01" and "Disk full on web02" fingerprint identically. */
function normaliseTitle(s: string): string {
  return s.toLowerCase()
    .replace(/inc-[a-z0-9]+/gi, '')
    .replace(/\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** O(a*b) Levenshtein — fine for chat-bot-sized strings. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function strongestSeverity(severities: IncidentSeverity[]): IncidentSeverity {
  if (severities.length === 0) return 'medium';
  const order: IncidentSeverity[] = ['low', 'medium', 'high', 'critical'];
  let max = 0;
  for (const s of severities) max = Math.max(max, order.indexOf(s));
  return order[max];
}

function problemTitle(incident: Incident, sourcePrefix: string | null, serverId: string | null): string {
  if (sourcePrefix && serverId) return `Recurring ${sourcePrefix} on ${serverId}`;
  if (sourcePrefix) return `Recurring ${sourcePrefix}`;
  if (serverId) return `Recurring "${normaliseTitle(incident.title).slice(0, 60)}" on ${serverId}`;
  return `Recurring: ${incident.title.slice(0, 80)}`;
}

function problemDescription(all: Incident[], cfg: DetectorConfig): string {
  return [
    `${all.length} incidents matching the same pattern in the last ${cfg.windowDays} day(s).`,
    'Linked incidents:',
    ...all.slice(0, 10).map(i => `- ${i.id} [${i.severity}] ${i.title} (${i.createdAt})`),
  ].join('\n');
}

interface AiPayload {
  rootCause: string;
  suggestedFix: string;
  preventionRunbook?: Array<Record<string, unknown>>;
  confidence: AiConfidence;
}

function parseAiPayload(raw: string): AiPayload {
  const stripped = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const m = stripped.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI response is not JSON');
    parsed = JSON.parse(m[0]);
  }
  const confidence: AiConfidence = ['high', 'medium', 'low'].includes(parsed.confidence)
    ? parsed.confidence : 'low';
  return {
    rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : '',
    suggestedFix: typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix : '',
    preventionRunbook: Array.isArray(parsed.preventionRunbook) ? parsed.preventionRunbook : undefined,
    confidence,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.30;
  return Math.min(1, Math.max(0, n));
}

export const _testing = { sourceRefPrefix, titleSimilarity, strongestSeverity, parseAiPayload };

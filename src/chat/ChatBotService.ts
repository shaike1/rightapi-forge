// ChatBotService — natural-language chat over the operator dashboard.
//
// A user types a message in the floating chat widget; this service uses
// the platform's AI proxy (Anthropic SDK via omniroute) to classify the
// intent, then runs one of:
//
//   - report_incident    → create an Incident through IncidentManager
//   - check_status       → look up a specific incident by id
//   - list_incidents     → return text + IncidentCard[] for the dashboard
//   - list_servers       → return text + ServerCard[] (with latest metrics)
//   - general            → stream a free-form Claude answer about the platform
//
// Two surface shapes:
//   - Deterministic intents (DB-backed) return a single ChatReply.
//   - AI-generated text (general, image-attachment vision) streams chunks
//     through the optional onChunk callback the server provides; the final
//     ChatReply still carries cards/suggestions for finalisation.
//
// Per-session history (sessionId → recent turns) lives in memory. Watcher
// sets track which session subscribed to which incident — the server
// forwards incident lifecycle events into notifyIncidentChange and we
// push a chat:update to the right session.
//
// Push notifications: when a client asks "what's happening with INC-xxx",
// we remember the (sessionId → incidentId) pair. When the IncidentManager
// emits an update for that incident, the service sends a chat:update event
// to that session.

import Anthropic from '@anthropic-ai/sdk';
import type { AIProviderFactory } from '../ai/factory.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { ServerRegistry, MonitoredServer } from '../monitoring/ServerRegistry.js';
import type { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';
import type { Incident } from '../persistence/SqliteStore.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'chatbot' });

// ── Public surface ────────────────────────────────────────────────────

export interface ChatBotDeps {
  aiFactory: AIProviderFactory;
  incidents: IncidentManager;
  servers: ServerRegistry;
  /** Optional — when present, server cards carry the latest CPU/memory/disk
   *  readings. When omitted, cards still render with status + last-seen. */
  metrics?: MetricsHistoryStore | null;
  /** Optional — when present, free-form questions consult the KB before
   *  the LLM call. A strongly-curated match (useful_count ≥ threshold) is
   *  returned directly. Three lower-confidence matches are injected into
   *  the system prompt as grounding context. Without this dep the chat
   *  service falls back to the prior LLM-only behaviour. */
  knowledgeStore?: {
    search: (q: string, opts?: { limit?: number; status?: 'draft' | 'published' | 'archived' }) => Array<{ id: string; title: string; content: string; usefulCount: number }>;
    topMatchForAutoReply: (q: string, opts?: { minUsefulCount?: number }) => { id: string; title: string; content: string; usefulCount: number } | null;
  };
  /** Optional — required for streaming general answers and image-attachment
   *  vision. When unset the service falls back to a deterministic help blurb
   *  for `general` and rejects image attachments with a friendly note. */
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  /** Optional retry + circuit breaker wrapper around the Anthropic SDK.
   *  When set, the chat path runs through this and falls back to the
   *  deterministic help blurb when the breaker is open. Without it,
   *  Anthropic SDK calls fire directly. */
  aiProxyGuard?: { run<T>(label: string, fn: () => Promise<T>): Promise<T> };
  /** Optional natural-language runbook generator. When present, the
   *  create_runbook intent produces a structured preview card. Without
   *  it, the intent falls back to a deterministic "please configure
   *  the runbook generator" message. */
  runbookGenerator?: {
    fromPrompt(input: { prompt: string; save?: boolean; actor?: string; context?: Record<string, unknown> }): Promise<{
      id: string;
      name: string;
      description: string;
      category: string;
      tags: string[];
      steps: Array<{ id: string; type: string; description: string }>;
      enabled: boolean;
      reasoning: string;
      confidence: number;
    }>;
  };
}

export interface Attachment {
  /** Filename hint — purely cosmetic; used in card captions / logs. */
  name: string;
  /** MIME type. Images go through Claude vision; text files are inlined. */
  type: string;
  /** Base64-encoded content (no data: prefix). */
  data: string;
}

/** Identity carried by chat requests — populated server-side from the
 *  authenticated WebSocket session. When unset (e.g. legacy unauth call
 *  in tests) the service degrades to anonymous behaviour: no name in the
 *  greeting, no role-gated refusals. */
export interface ChatUser {
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  email?: string;
}

export interface ChatRequest {
  sessionId: string;
  text: string;
  attachment?: Attachment;
  user?: ChatUser;
}

export interface ChatActionRequest {
  sessionId: string;
  action: 'escalate' | 'resolve';
  targetId: string;
  reason?: string;
  user?: ChatUser;
}

// ── Rich card shapes ──────────────────────────────────────────────────

export interface IncidentCard {
  kind: 'incident';
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: string;
  assignedTo: string | null;
  createdAt: string;
}

export interface ServerCard {
  kind: 'server';
  id: string;
  name: string;
  host: string | null;
  status: 'ok' | 'error' | 'unknown';
  enabled: boolean;
  lastSeen: string | null;
  metrics?: { cpu?: number; memory?: number; disk?: number };
}

export type ChatCard = IncidentCard | ServerCard;

export interface ChatReply {
  /** Natural-language answer to display in the bubble. May be empty when
   *  the entire body is conveyed through cards. */
  text: string;
  /** Filled when the action produced or referenced an incident — the
   *  widget renders the id as a clickable link to /app/incidents/:id. */
  incidentId?: string;
  /** Structured cards rendered below the text (incident rows, server tiles). */
  cards?: ChatCard[];
  /** Suggested follow-up phrases shown as chips below the message. */
  suggestions?: string[];
}

export interface ChatPushEvent {
  sessionId: string;
  text: string;
  incidentId: string;
}

export type ChatPushSender = (event: ChatPushEvent) => void;

/** Options passed by the WebSocket layer. When `onChunk` is supplied the
 *  service may stream the AI-text portion via the callback; the returned
 *  ChatReply still carries the full text plus any cards/suggestions. */
export interface HandleOpts {
  onChunk?: (chunk: string) => void;
}

// ── Intent shape from the LLM ─────────────────────────────────────────

type Intent =
  | 'report_incident'
  | 'check_status'
  | 'list_incidents'
  | 'list_servers'
  | 'create_runbook'
  | 'general';

interface ClassifiedIntent {
  intent: Intent;
  title?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  serverId?: string;
  description?: string;
  incidentId?: string;
  question?: string;
  /** create_runbook: natural-language description of the runbook. */
  runbookPrompt?: string;
}

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_HISTORY_TURNS = 12;
const LIST_INCIDENTS_INLINE = 10;
const LIST_SERVERS_INLINE = 12;
const INCIDENT_ID_RE = /\bINC-[A-Z0-9]{4,12}\b/i;

/** Suggestion presets — kept in one place so future copy edits are easy. */
const SUGGESTIONS_GREETING = ['קריאות פתוחות', 'סטטוס שרתים', 'פתח קריאה חדשה'];
const SUGGESTIONS_AFTER_REPORT = ['סטטוס הקריאה', 'קריאות פתוחות', 'escalate'];
const SUGGESTIONS_AFTER_STATUS = ['escalate', 'resolve', 'קריאות פתוחות'];
const SUGGESTIONS_AFTER_LIST    = ['סטטוס שרתים', 'פתח קריאה חדשה'];
const SUGGESTIONS_AFTER_SERVERS = ['קריאות פתוחות', 'פתח קריאה חדשה'];
const SUGGESTIONS_AFTER_RUNBOOK = ['save runbook', 'edit runbook', 'cancel'];
/** Read-only intents viewers can run. Everything else (create incident,
 *  escalate, resolve, create runbook) requires operator+. */
const VIEWER_ALLOWED_INTENTS: ReadonlySet<Intent> = new Set(['check_status', 'list_incidents', 'list_servers', 'general']);

/** Hebrew refusal copy — surfaced verbatim by the widget. Phrase the
 *  reason so the operator sees what role they actually have. */
function viewerRefusal(reason: string): string {
  return `אין לך הרשאה לפעולה הזו (${reason}). נסה לפנות למשתמש עם תפקיד operator או admin.`;
}

const ALLOWED_IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class ChatBotService {
  private readonly history = new Map<string, HistoryTurn[]>();
  private readonly watching = new Map<string, Set<string>>();
  private readonly watchers = new Map<string, Set<string>>();
  private pushSender: ChatPushSender | null = null;
  private readonly anthropic: Anthropic | null;
  private readonly anthropicModel: string;

  constructor(private readonly deps: ChatBotDeps) {
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

  setPushSender(sender: ChatPushSender | null): void {
    this.pushSender = sender;
  }

  notifyIncidentChange(incident: { id: string; title: string; status: string; severity: string }): void {
    const sessions = this.watchers.get(incident.id);
    if (!sessions || sessions.size === 0) return;
    if (!this.pushSender) return;
    const text = `Update on ${incident.id}: status is now "${incident.status}" (severity: ${incident.severity}).`;
    for (const sessionId of sessions) {
      try {
        this.pushSender({ sessionId, text, incidentId: incident.id });
      } catch (e) {
        log.warn('push sender threw', {
          sessionId,
          incidentId: incident.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  forgetSession(sessionId: string): void {
    this.history.delete(sessionId);
    const watched = this.watching.get(sessionId);
    if (watched) {
      for (const incidentId of watched) {
        const set = this.watchers.get(incidentId);
        if (set) {
          set.delete(sessionId);
          if (set.size === 0) this.watchers.delete(incidentId);
        }
      }
      this.watching.delete(sessionId);
    }
  }

  async handle(req: ChatRequest, opts: HandleOpts = {}): Promise<ChatReply> {
    let text = (req.text || '').trim();
    if (!text && !req.attachment) {
      return {
        text: 'Say something — I can create incidents, check status, or answer questions about the platform.',
        suggestions: SUGGESTIONS_GREETING,
      };
    }

    // Classify the attachment shape before anything else. Three buckets:
    //   - image/* → vision streaming
    //   - text/*, application/json → decoded base64 inlined into the user
    //     message, then run through normal classification
    //   - anything else (PDFs, binaries) → rejected with a friendly note
    //     so the classifier never sees an opaque payload it can't reason about.
    const att = req.attachment;
    if (att) {
      const kind = classifyAttachment(att.type);
      if (kind === 'unsupported') {
        const reply: ChatReply = {
          text: `Sorry, "${att.type || 'that file type'}" isn't supported. Send a PNG/JPEG/GIF/WebP image, or a small text/JSON file.`,
          suggestions: SUGGESTIONS_GREETING,
        };
        this.appendTurn(req.sessionId, 'user', text || `(${att.name})`);
        this.appendTurn(req.sessionId, 'assistant', reply.text);
        return reply;
      }
      if (kind === 'text') {
        const decoded = decodeBase64Text(att.data);
        // Truncate so a multi-MB log dump can't dwarf the classifier prompt.
        const clipped = decoded.length > 4000 ? decoded.slice(0, 4000) + '\n…(truncated)' : decoded;
        text = text
          ? `${text}\n\nAttached file "${att.name}":\n${clipped}`
          : `Attached file "${att.name}":\n${clipped}`;
      }
    }

    this.appendTurn(req.sessionId, 'user', text || `(${att?.name ?? 'attachment'})`);

    // Image attachment shortcut: route straight to vision streaming. The
    // classifier doesn't see images, so we'd otherwise drop the user's
    // attachment on the floor.
    if (att && classifyAttachment(att.type) === 'image') {
      const reply = await this.actVision(text, att, opts.onChunk).catch(e => {
        log.warn('vision call failed', {
          sessionId: req.sessionId,
          err: e instanceof Error ? e.message : String(e),
        });
        return {
          text: `I couldn't process the image (${e instanceof Error ? e.message : 'unknown error'}). You can still describe what you see and I'll open an incident if needed.`,
          suggestions: SUGGESTIONS_GREETING,
        } as ChatReply;
      });
      this.appendTurn(req.sessionId, 'assistant', reply.text);
      return reply;
    }

    let intent: ClassifiedIntent;
    try {
      intent = await this.classify(text, req.sessionId);
    } catch (e) {
      log.warn('intent classification failed; falling back to heuristic', {
        sessionId: req.sessionId,
        err: e instanceof Error ? e.message : String(e),
      });
      intent = this.heuristicIntent(text);
    }

    // Role gate: viewers can read everything but not create incidents.
    // The chat:action handler enforces the same rule on Escalate/Resolve.
    // We refuse before any DB write — this is the only path that creates
    // an Incident from chat input.
    if (req.user && req.user.role === 'viewer' && !VIEWER_ALLOWED_INTENTS.has(intent.intent)) {
      const reply: ChatReply = {
        text: viewerRefusal(`intent=${intent.intent}, role=viewer`),
        suggestions: SUGGESTIONS_GREETING,
      };
      this.appendTurn(req.sessionId, 'assistant', reply.text);
      return reply;
    }

    const reply = await this.act(intent, req.sessionId, text, opts, req.user);
    this.appendTurn(req.sessionId, 'assistant', reply.text);
    return reply;
  }

  /** chat:action — operator clicked Escalate / Resolve on an incident card.
   *  Viewers can't perform either; we refuse in Hebrew and surface the
   *  current role so the operator knows why. */
  async handleAction(req: ChatActionRequest): Promise<ChatReply> {
    if (req.user && req.user.role === 'viewer') {
      return {
        text: viewerRefusal(`action=${req.action}, role=viewer`),
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    if (req.action === 'escalate') {
      const updated = this.deps.incidents.escalate(
        req.targetId,
        req.reason ?? 'Escalated from chat widget',
      );
      if (!updated) {
        return { text: `No incident with id ${req.targetId}.`, suggestions: SUGGESTIONS_GREETING };
      }
      this.watch(req.sessionId, updated.id);
      return {
        text: `Escalated ${updated.id} to ${updated.severity}. Status is now ${updated.status}.`,
        incidentId: updated.id,
        cards: [this.toIncidentCard(updated)],
        suggestions: ['resolve', 'קריאות פתוחות'],
      };
    }
    if (req.action === 'resolve') {
      const updated = this.deps.incidents.resolve(
        req.targetId,
        req.reason ?? 'Resolved from chat widget',
      );
      if (!updated) {
        return { text: `No incident with id ${req.targetId}.`, suggestions: SUGGESTIONS_GREETING };
      }
      return {
        text: `Resolved ${updated.id}. ✅`,
        incidentId: updated.id,
        cards: [this.toIncidentCard(updated)],
        suggestions: ['קריאות פתוחות', 'סטטוס שרתים'],
      };
    }
    return { text: `Unknown action: ${(req as any).action}.` };
  }

  // ── Intent classification ────────────────────────────────────────────

  private async classify(text: string, sessionId: string): Promise<ClassifiedIntent> {
    const provider = await this.deps.aiFactory.getDefaultProvider();
    const servers = this.deps.servers.list({ enabled: true });
    const serverList = servers.length === 0
      ? '(none configured)'
      : servers.map(s => `- ${s.id} ("${s.name}"${s.host ? `, host=${s.host}` : ''})`).join('\n');

    const system = [
      'You are the intent classifier for an IT operations chat assistant called RightAPI Forge.',
      'The assistant supports English and Hebrew. Users speak naturally in either.',
      'Your only job: classify the user message and return a single JSON object.',
      '',
      'Possible intents:',
      '- report_incident: user is reporting a new problem they want tracked (e.g. "server is down", "השרת לא עונה", "פתח קריאה חדשה")',
      '- check_status: user is asking about a specific existing incident, usually mentioning an INC-xxxx id ("status of INC-1234", "מה קורה עם INC-1234", "סטטוס הקריאה" when an id is in recent context)',
      '- list_incidents: user wants a summary of open/active incidents ("show open incidents", "קריאות פתוחות", "what is open right now")',
      '- list_servers: user is asking which servers are monitored ("which servers", "אילו שרתים", "סטטוס שרתים")',
      '- create_runbook: user wants to author an automation runbook in natural language ("create a runbook for X", "make a runbook when nginx goes down", "automate the disk-cleanup procedure")',
      '- general: anything else — questions about the platform, capabilities, or small talk',
      '',
      'For report_incident, also extract:',
      '  - title: short summary (max 80 chars) translated to English',
      '  - severity: one of "low" | "medium" | "high" | "critical" (default "medium"; "down"/"outage" → "high"; "critical"/"production down" → "critical")',
      '  - serverId: pick from the list below if the user names or hints at one; omit if none matches',
      '  - description: longer text the user wrote (verbatim, in their language)',
      'For check_status, extract incidentId — uppercase, format INC-XXXX.',
      'For create_runbook, copy the user description into "runbookPrompt".',
      'For general, copy the user message into "question".',
      '',
      'Monitored servers:',
      serverList,
      '',
      'Return STRICT JSON only — no markdown, no prose, no code fences.',
      'Schema: {"intent": "...", "title"?: "...", "severity"?: "...", "serverId"?: "...", "description"?: "...", "incidentId"?: "...", "question"?: "...", "runbookPrompt"?: "..."}',
    ].join('\n');

    const history = this.history.get(sessionId) ?? [];
    const recent = history.slice(-MAX_HISTORY_TURNS).map(t => ({
      role: t.role as 'user' | 'assistant',
      content: t.content,
    }));
    const response = await provider.chat({
      messages: recent.length > 0 ? recent : [{ role: 'user', content: text }],
      system,
      maxTokens: 400,
      temperature: 0.1,
    });
    return this.parseIntent(response.content);
  }

  private parseIntent(raw: string): ClassifiedIntent {
    const stripped = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed: any;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      const m = stripped.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('classifier returned non-JSON');
      parsed = JSON.parse(m[0]);
    }
    const intent = String(parsed.intent || 'general') as Intent;
    if (!['report_incident', 'check_status', 'list_incidents', 'list_servers', 'create_runbook', 'general'].includes(intent)) {
      return { intent: 'general', question: parsed.question || '' };
    }
    return {
      intent,
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200) : undefined,
      severity: ['low', 'medium', 'high', 'critical'].includes(parsed.severity) ? parsed.severity : undefined,
      serverId: typeof parsed.serverId === 'string' ? parsed.serverId : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      incidentId: typeof parsed.incidentId === 'string' ? parsed.incidentId.toUpperCase() : undefined,
      question: typeof parsed.question === 'string' ? parsed.question : undefined,
      runbookPrompt: typeof parsed.runbookPrompt === 'string' ? parsed.runbookPrompt : undefined,
    };
  }

  private heuristicIntent(text: string): ClassifiedIntent {
    const lower = text.toLowerCase();
    const idMatch = text.match(INCIDENT_ID_RE);
    if (idMatch) return { intent: 'check_status', incidentId: idMatch[0].toUpperCase() };
    // create_runbook heuristic must run BEFORE the "down/incident" branch
    // so phrases like "create a runbook for when nginx goes down" route to
    // generation instead of opening a placeholder incident.
    if (/(create|make|author|generate|draft|write|build|automate).*runbook|runbook.*(for|when)/i.test(text)) {
      return { intent: 'create_runbook', runbookPrompt: text };
    }
    if (/(open incidents?|active incidents?|פתוח|פתוחות|קריאות)/i.test(text)) return { intent: 'list_incidents' };
    if (/(servers?|hosts?|שרתים|שרת)/i.test(lower)) return { intent: 'list_servers' };
    if (/(down|broken|crashed|לא עובד|נפל|תקלה|לא עונה|outage|incident|alert)/i.test(text)) {
      return { intent: 'report_incident', title: text.slice(0, 80), severity: 'medium', description: text };
    }
    return { intent: 'general', question: text };
  }

  // ── Action dispatch ──────────────────────────────────────────────────

  private async act(intent: ClassifiedIntent, sessionId: string, rawText: string, opts: HandleOpts, user?: ChatUser): Promise<ChatReply> {
    switch (intent.intent) {
      case 'report_incident': return this.actReport(intent, rawText);
      case 'check_status':    return this.actCheck(intent, sessionId);
      case 'list_incidents':  return this.actList();
      case 'list_servers':    return this.actServers();
      case 'create_runbook':  return this.actCreateRunbook(intent, rawText, user);
      case 'general':         return this.actGeneral(intent.question ?? rawText, opts.onChunk, user);
    }
  }

  /** Natural-language runbook drafting. Returns a preview message and
   *  an `incidentId`-style hint via the runbookId field so the chat
   *  widget can render a card and offer "save"/"edit" actions. */
  private async actCreateRunbook(intent: ClassifiedIntent, rawText: string, user?: ChatUser): Promise<ChatReply> {
    if (!this.deps.runbookGenerator) {
      return {
        text: 'Runbook generation is not configured on this RightAPI Forge instance. Ask an admin to enable AUTO_RUNBOOK_GEN_ENABLED.',
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    const prompt = (intent.runbookPrompt?.trim() || intent.description?.trim() || rawText.trim()) || '';
    if (prompt.length < 8) {
      return {
        text: 'Tell me what the runbook should do — e.g. "Create a runbook for when nginx goes down on vps1".',
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    try {
      const draft = await this.deps.runbookGenerator.fromPrompt({
        prompt, save: false, actor: user?.username,
      });
      const stepSummary = draft.steps.map((s, i) => `${i + 1}. [${s.type}] ${s.description}`).join('\n');
      return {
        text: [
          `Drafted runbook **${draft.name}** (id: \`${draft.id}\`, category: ${draft.category}).`,
          '',
          draft.description,
          '',
          stepSummary,
          '',
          `Confidence: ${(draft.confidence * 100).toFixed(0)}%. The draft is saved as **disabled** — review and enable it from the Runbooks page.`,
        ].join('\n'),
        suggestions: SUGGESTIONS_AFTER_RUNBOOK,
      };
    } catch (e) {
      log.warn('actCreateRunbook threw', { err: e instanceof Error ? e.message : String(e) });
      return {
        text: 'I had trouble generating that runbook. Try rephrasing — include the service or symptom and the host.',
        suggestions: SUGGESTIONS_GREETING,
      };
    }
  }

  private actReport(intent: ClassifiedIntent, rawText: string): ChatReply {
    const title = (intent.title && intent.title.trim()) || rawText.slice(0, 80);
    const severity = intent.severity ?? 'medium';
    let serverId: string | null = null;
    if (intent.serverId) {
      const candidate = this.deps.servers.get(intent.serverId);
      if (candidate) serverId = candidate.id;
    }
    const incident = this.deps.incidents.create({
      title,
      description: intent.description ?? rawText,
      severity,
      source: 'manual',
      sourceRef: 'chat-widget',
      serverId,
    });
    const sevLabel = severity[0].toUpperCase() + severity.slice(1);
    return {
      text: `Opened incident ${incident.id} — "${title}" at ${sevLabel} severity${serverId ? ` on server "${serverId}"` : ''}. I'll let you know when its status changes.`,
      incidentId: incident.id,
      cards: [this.toIncidentCard(incident)],
      suggestions: SUGGESTIONS_AFTER_REPORT,
    };
  }

  private actCheck(intent: ClassifiedIntent, sessionId: string): ChatReply {
    const id = intent.incidentId?.toUpperCase();
    if (!id) {
      return {
        text: "I couldn't find an incident id in that message — try something like \"status of INC-AB12CD34\".",
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    const inc = this.deps.incidents.get(id);
    if (!inc) {
      return {
        text: `No incident with id ${id} — it may have been closed and removed, or the id has a typo.`,
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    this.watch(sessionId, id);
    const timelineTail = inc.timeline.slice(-3).map(t => `- ${t.actor}: ${t.message}`).join('\n');
    const assigned = inc.assignedAgent ? ` (assigned agent: ${inc.assignedAgent.slice(0, 8)})` : (inc.assignedTo ? ` (assigned to ${inc.assignedTo})` : ' (unassigned)');
    const body = [
      `${id}: ${inc.title}`,
      `Status: ${inc.status}, severity: ${inc.severity}${assigned}.`,
      `Opened ${inc.createdAt}, updated ${inc.updatedAt}.`,
      timelineTail ? `Latest activity:\n${timelineTail}` : 'No timeline entries yet.',
      "I'll ping you here if its status changes.",
    ].join('\n');
    return {
      text: body,
      incidentId: id,
      cards: [this.toIncidentCard(inc)],
      suggestions: SUGGESTIONS_AFTER_STATUS,
    };
  }

  private actList(): ChatReply {
    const active = this.deps.incidents.list({}).filter(i =>
      i.status === 'open' || i.status === 'investigating' || i.status === 'mitigating'
    );
    if (active.length === 0) {
      return {
        text: 'No active incidents right now. Things look quiet.',
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    const shown = active.slice(0, LIST_INCIDENTS_INLINE);
    const head = `${active.length} active incident${active.length === 1 ? '' : 's'}${active.length > shown.length ? ` (showing ${shown.length})` : ''}:`;
    return {
      text: head,
      cards: shown.map(i => this.toIncidentCard(i)),
      suggestions: SUGGESTIONS_AFTER_LIST,
    };
  }

  private actServers(): ChatReply {
    const servers = this.deps.servers.list({});
    if (servers.length === 0) {
      return {
        text: 'No servers are configured. Add one from the Servers page.',
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    const shown = servers.slice(0, LIST_SERVERS_INLINE);
    return {
      text: `Monitoring ${servers.length} server${servers.length === 1 ? '' : 's'}${servers.length > shown.length ? ` (showing ${shown.length})` : ''}:`,
      cards: shown.map(s => this.toServerCard(s)),
      suggestions: SUGGESTIONS_AFTER_SERVERS,
    };
  }

  private async actGeneral(question: string, onChunk?: (chunk: string) => void, user?: ChatUser): Promise<ChatReply> {
    // Knowledge Base lookup. A highly-upvoted match short-circuits the
    // LLM call entirely — same answer, zero tokens. Lower-confidence
    // matches drop into the system prompt as grounding context so the
    // LLM can cite them naturally. The whole block is opt-in via deps.
    const kbAuto = this.deps.knowledgeStore?.topMatchForAutoReply(question, { minUsefulCount: 5 });
    if (kbAuto) {
      log.info('[chat] KB direct hit', { articleId: kbAuto.id, usefulCount: kbAuto.usefulCount });
      const text = `📘 **From the knowledge base** — _${kbAuto.title}_ (${kbAuto.usefulCount} confirmed helpful)\n\n${kbAuto.content}`;
      // Stream the canned text in one chunk so the widget's typing
      // indicator still resolves and downstream WS clients update.
      if (onChunk) onChunk(text);
      return { text, suggestions: SUGGESTIONS_GREETING };
    }
    const kbHits = this.deps.knowledgeStore?.search(question, { limit: 3 }) ?? [];

    // No Anthropic SDK configured → fall back to a deterministic help blurb
    // so the widget still does something useful when proxies are unreachable.
    if (!this.anthropic) return this.fallbackGeneral(user);

    const servers = this.deps.servers.list({});
    const active = this.deps.incidents.list({}).filter(i =>
      i.status === 'open' || i.status === 'investigating' || i.status === 'mitigating'
    );
    // Greet by name when we know who's asking. The model is told to use the
    // name naturally rather than forcing a "Hello X" prefix on every reply
    // (that gets repetitive across a session). Role is also surfaced so the
    // assistant won't suggest actions the user can't perform.
    const userLine = user
      ? `You are talking to ${user.username} (role: ${user.role}${user.email ? `, email: ${user.email}` : ''}). If it's natural to address them by name, do so.`
      : '';
    // Truncate KB content per match so we don't blow the system-prompt
    // budget when the user's KB has long markdown articles. 600 chars is
    // enough to convey the gist; the LLM can cite the article id and
    // let the user click through for the rest.
    const kbBlock = kbHits.length > 0
      ? [
          '',
          'Relevant knowledge-base articles — cite them when answering, by id:',
          ...kbHits.map(a => `- ${a.id} · "${a.title}" (${a.usefulCount} useful)\n  ${a.content.slice(0, 600).replace(/\n+/g, ' ')}`),
        ].join('\n')
      : '';
    const system = [
      'You are RightAPI Forge, the conversational assistant inside the itops-agents IT-ops dashboard.',
      'RightAPI Forge: self-hosted Express + WebSocket server with autonomous AI agents that monitor servers, manage incidents, run runbooks, and integrate Jira / Teams / IRC.',
      'Answer briefly (2–4 sentences). If asked something operational, point the user at the dashboard pages (Incidents, Servers, Runbooks, Monitoring).',
      "Respond in the user's language — Hebrew or English.",
      userLine,
      '',
      `Monitored servers (${servers.length}): ${servers.map(s => s.id).join(', ') || '(none)'}.`,
      `Active incidents: ${active.length}.`,
      kbBlock,
    ].filter(Boolean).join('\n');

    let fullText = '';
    // Route the streaming call through the AI proxy guard when the
    // host server wired one in. The guard short-circuits with
    // AIProxyBreakerOpenError after 5 consecutive failures inside a
    // 30s window; that surfaces as a catch below which falls back
    // to the deterministic help blurb. Without a guard we still call
    // the SDK directly — legacy behaviour preserved for tests.
    const callAnthropic = async (): Promise<void> => {
      const stream = await this.anthropic!.messages.create({
        model: this.anthropicModel,
        max_tokens: 600,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: question }],
        stream: true,
      });
      for await (const event of stream as AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          const chunk = event.delta.text;
          fullText += chunk;
          if (onChunk) onChunk(chunk);
        }
      }
    };
    try {
      if (this.deps.aiProxyGuard) {
        await this.deps.aiProxyGuard.run('chat:general', callAnthropic);
      } else {
        await callAnthropic();
      }
    } catch (e) {
      log.warn('general streaming failed; falling back to deterministic help', {
        err: e instanceof Error ? e.message : String(e),
      });
      return this.fallbackGeneral();
    }
    return {
      text: fullText.trim() || this.fallbackGeneral().text,
      suggestions: SUGGESTIONS_GREETING,
    };
  }

  private fallbackGeneral(user?: ChatUser): ChatReply {
    const greet = user ? `Hi ${user.username} — ` : '';
    return {
      text: [
        `${greet}I can help with the IT-ops dashboard. Try:`,
        '- "open incidents" / "קריאות פתוחות" — list active incidents',
        '- "status of INC-XXXX" — drill into one incident',
        '- "report: <something is broken>" — open a new incident',
        '- "which servers are monitored?" — list monitored hosts',
      ].join('\n'),
      suggestions: SUGGESTIONS_GREETING,
    };
  }

  // ── Vision / attachment streaming ────────────────────────────────────

  private async actVision(text: string, attachment: Attachment, onChunk?: (chunk: string) => void): Promise<ChatReply> {
    // handle() already gates on classifyAttachment === 'image', so the
    // MIME is one of the four Anthropic-supported types when we get here.
    if (!this.anthropic) {
      return {
        text: "Image analysis isn't configured on this instance (no Anthropic API key). Tell me what you see and I can open an incident manually.",
        suggestions: SUGGESTIONS_GREETING,
      };
    }
    const userText = text.trim() || 'What do you see in this screenshot? If there is an error or failure, suggest an incident.';
    const system = [
      'You are RightAPI Forge, the IT-ops chat assistant. The user attached a screenshot.',
      'Describe what you see in 2–4 sentences. If the image shows an obvious error, failure, alert, or downtime, end with a final line in the form:',
      '  INCIDENT_SUGGESTED: <short English title under 80 chars>',
      'Otherwise omit that line entirely. Never invent server names — only mention ones visible in the image.',
      "Respond in the user's language.",
    ].join('\n');

    let fullText = '';
    const stream = await this.anthropic.messages.create({
      model: this.anthropicModel,
      max_tokens: 800,
      temperature: 0.2,
      system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: attachment.type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: attachment.data } },
          { type: 'text', text: userText },
        ],
      }],
      stream: true,
    });
    for await (const event of stream as AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        const chunk = event.delta.text;
        fullText += chunk;
        if (onChunk) onChunk(chunk);
      }
    }
    const m = /INCIDENT_SUGGESTED:\s*(.+?)\s*$/m.exec(fullText);
    const incidentTitle = m ? m[1].trim().slice(0, 80) : null;
    const cleanText = m ? fullText.replace(/INCIDENT_SUGGESTED:[^\n]*\n?/g, '').trim() : fullText.trim();
    return {
      text: cleanText,
      suggestions: incidentTitle
        ? [`report: ${incidentTitle}`, 'קריאות פתוחות', 'סטטוס שרתים']
        : SUGGESTIONS_GREETING,
    };
  }

  // ── Card builders ────────────────────────────────────────────────────

  private toIncidentCard(inc: Incident): IncidentCard {
    return {
      kind: 'incident',
      id: inc.id,
      title: inc.title,
      severity: inc.severity,
      status: inc.status,
      assignedTo: inc.assignedTo,
      createdAt: inc.createdAt,
    };
  }

  private toServerCard(s: MonitoredServer): ServerCard {
    const card: ServerCard = {
      kind: 'server',
      id: s.id,
      name: s.name,
      host: s.host,
      status: s.lastCheckStatus,
      enabled: s.enabled,
      lastSeen: s.lastSeen,
    };
    if (this.deps.metrics) {
      try {
        const samples = this.deps.metrics.latest(s.id);
        // Reduce to a single CPU/memory/disk percent — for disk, pick the
        // highest dimension so the card surfaces the most-pressured mount.
        let cpu: number | undefined;
        let memory: number | undefined;
        let disk: number | undefined;
        for (const samp of samples) {
          if (samp.metricType === 'cpu')    cpu    = samp.value;
          if (samp.metricType === 'memory') memory = samp.value;
          if (samp.metricType === 'disk')   disk = disk === undefined ? samp.value : Math.max(disk, samp.value);
        }
        if (cpu !== undefined || memory !== undefined || disk !== undefined) {
          card.metrics = { ...(cpu !== undefined ? { cpu } : {}), ...(memory !== undefined ? { memory } : {}), ...(disk !== undefined ? { disk } : {}) };
        }
      } catch (e) {
        log.warn('metrics latest() threw — card will skip metrics', {
          serverId: s.id, err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return card;
  }

  // ── Session bookkeeping ──────────────────────────────────────────────

  private watch(sessionId: string, incidentId: string): void {
    let set = this.watching.get(sessionId);
    if (!set) { set = new Set(); this.watching.set(sessionId, set); }
    set.add(incidentId);
    let rev = this.watchers.get(incidentId);
    if (!rev) { rev = new Set(); this.watchers.set(incidentId, rev); }
    rev.add(sessionId);
  }

  private appendTurn(sessionId: string, role: 'user' | 'assistant', content: string): void {
    let arr = this.history.get(sessionId);
    if (!arr) { arr = []; this.history.set(sessionId, arr); }
    arr.push({ role, content });
    if (arr.length > MAX_HISTORY_TURNS * 2) {
      arr.splice(0, arr.length - MAX_HISTORY_TURNS * 2);
    }
  }

  // ── Test hooks ───────────────────────────────────────────────────────

  _historyFor(sessionId: string): ReadonlyArray<HistoryTurn> {
    return this.history.get(sessionId) ?? [];
  }
  _watchersOf(incidentId: string): ReadonlySet<string> {
    return this.watchers.get(incidentId) ?? new Set();
  }
}

/** Buckets used by handle(): drives the three-way attachment branch. */
function classifyAttachment(mime: string): 'image' | 'text' | 'unsupported' {
  if (ALLOWED_IMAGE_MEDIA.has(mime)) return 'image';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'unsupported';
}

function decodeBase64Text(data: string): string {
  try {
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

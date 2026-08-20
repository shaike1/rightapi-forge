// OpenClaw chat-gateway notifier.
//
// OpenClaw exposes an OpenAI-compatible /v1/chat/completions endpoint that
// fans messages out to whatever chat channels the user has connected
// (Telegram, WhatsApp, Slack, IRC, …). We use it as a one-way notification
// channel for Beacon — fire-and-forget, never block incident creation.

import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';
import { logger } from '../utils/logger.js';

export type NotificationSeverity = IncidentSeverity | 'info';

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  critical: '🚨',
  high:     '🔴',
  medium:   '🟠',
  low:      '🟡',
  info:     'ℹ️',
};

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info:     0,
  low:      1,
  medium:   2,
  high:     3,
  critical: 4,
};

const REQUEST_TIMEOUT_MS = 8000;

function parseMinSeverity(raw: string | undefined): NotificationSeverity {
  const v = (raw ?? 'medium').toLowerCase();
  if (v in SEVERITY_RANK) return v as NotificationSeverity;
  logger.warn('[OpenClaw] unknown OPENCLAW_MIN_SEVERITY, falling back to medium', { value: raw });
  return 'medium';
}

export class OpenClawIntegration {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly minSeverity: NotificationSeverity;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl     = (env.OPENCLAW_URL ?? '').replace(/\/+$/, '');
    this.token       = env.OPENCLAW_GATEWAY_TOKEN ?? '';
    this.enabled     = (env.OPENCLAW_ENABLED ?? 'false').toLowerCase() === 'true';
    this.model       = env.OPENCLAW_MODEL ?? 'openclaw/default';
    this.minSeverity = parseMinSeverity(env.OPENCLAW_MIN_SEVERITY);
  }

  isConfigured(): boolean {
    return this.enabled && this.baseUrl.length > 0 && this.token.length > 0;
  }

  /** True when `severity` is at or above the configured floor. */
  passesSeverityFilter(severity: NotificationSeverity): boolean {
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[this.minSeverity];
  }

  /** Format an incident as a chat message and dispatch it. Fire-and-forget:
   *  the returned promise resolves to true on success and false on any
   *  failure, but callers should not await it on hot paths. */
  async sendAlert(incident: Incident): Promise<boolean> {
    const sev = (incident.severity ?? 'medium') as NotificationSeverity;
    if (!this.passesSeverityFilter(sev)) {
      logger.debug('[OpenClaw] skipping alert below minimum severity', {
        incidentId: incident.id,
        severity: sev,
        min: this.minSeverity,
      });
      return false;
    }
    const emoji = SEVERITY_EMOJI[sev] ?? SEVERITY_EMOJI.info;
    const lines: string[] = [
      `${emoji} *Incident ${incident.id}* — ${sev.toUpperCase()}`,
      incident.title,
    ];
    if (incident.description) {
      const desc = incident.description.length > 500
        ? incident.description.slice(0, 500) + '…'
        : incident.description;
      lines.push('', desc);
    }
    if (incident.source) lines.push('', `Source: ${incident.source}`);
    return this.send(lines.join('\n'));
  }

  /** Structured escalation alert — sent by EscalationPipeline when an
   *  incident has exhausted automated remediation and needs a human.
   *  Severity filter is bypassed at L4 (critical urgency by definition)
   *  but still applied at L3 so low-severity incidents don't spam chat. */
  async sendEscalationAlert(
    level: number,
    incident: Incident,
    ctx: {
      agentName?: string;
      agentActions?: string[];
      agentIterations?: number;
      remediatorKind?: string | null;
      remediatorActions?: string[];
      currentMetrics?: string;
      reason?: string;
      ageMinutes?: number;
    } = {},
  ): Promise<boolean> {
    const sev = (incident.severity ?? 'medium') as NotificationSeverity;
    // L4 always notifies — the whole point is that we're past the
    // configured-floor stage and need eyes on it. L3 still honours the
    // floor so low-severity churn doesn't reach chat.
    if (level < 4 && !this.passesSeverityFilter(sev)) {
      logger.debug('[OpenClaw] skipping escalation alert below minimum severity', {
        incidentId: incident.id, level, severity: sev, min: this.minSeverity,
      });
      return false;
    }
    const urgencyPrefix = level >= 4 ? '🆘 URGENT' : '🚨 ESCALATION';
    const lines: string[] = [
      `${urgencyPrefix} Level ${level}: ${incident.title}`,
      `Incident: ${incident.id}`,
      `Severity: ${sev.toUpperCase()}`,
    ];
    if (typeof ctx.ageMinutes === 'number') {
      lines.push(`Age: ${ctx.ageMinutes} minutes`);
    }
    lines.push('', 'What happened:');
    if (ctx.agentName) {
      const iter = typeof ctx.agentIterations === 'number' ? ` (${ctx.agentIterations} ReAct iterations)` : '';
      lines.push(`- Agent ${ctx.agentName} attempted fix${iter}`);
    } else {
      lines.push('- No agent picked up the incident');
    }
    if (ctx.agentActions?.length) {
      for (const a of ctx.agentActions.slice(0, 4)) lines.push(`  • ${a}`);
    }
    if (ctx.remediatorKind) {
      lines.push(`- Auto-remediation: ${ctx.remediatorKind}`);
      if (ctx.remediatorActions?.length) {
        for (const a of ctx.remediatorActions.slice(0, 4)) lines.push(`  • ${a}`);
      }
    } else {
      lines.push('- Auto-remediation: no matching recipe');
    }
    if (ctx.currentMetrics) {
      lines.push('', 'Current state:', ctx.currentMetrics);
    }
    if (ctx.reason) {
      lines.push('', `Reason: ${ctx.reason}`);
    }
    lines.push('', 'Action needed: Manual intervention required');
    return this.send(lines.join('\n'));
  }

  /** De-escalation notification — sent when an incident that previously
   *  reached L3+ is resolved. Lets the human channel that was paged know
   *  they don't have to investigate. */
  async sendResolutionNotice(
    incident: Incident,
    note?: string,
  ): Promise<boolean> {
    const lines: string[] = [
      `✅ Resolved: ${incident.title}`,
      `Incident: ${incident.id}`,
    ];
    if (note) lines.push('', note);
    return this.send(lines.join('\n'));
  }

  /** Generic notification — title + body + severity emoji. */
  async sendNotification(
    title: string,
    message: string,
    severity: NotificationSeverity = 'info'
  ): Promise<boolean> {
    if (!this.passesSeverityFilter(severity)) {
      logger.debug('[OpenClaw] skipping notification below minimum severity', {
        title, severity, min: this.minSeverity,
      });
      return false;
    }
    const emoji = SEVERITY_EMOJI[severity] ?? SEVERITY_EMOJI.info;
    return this.send(`${emoji} *${title}*\n${message}`);
  }

  private async send(content: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const url = `${this.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // OpenClaw's gateway only emits a response when stream=true. With
      // stream=false the server hangs the connection until the LLM run
      // completes server-side, which can be tens of seconds (or never,
      // observed in practice). For fire-and-forget notifications we
      // don't care about the body — we use streaming so headers arrive
      // immediately, then drop the response without consuming the SSE
      // stream.
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content }],
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn('[OpenClaw] non-2xx response', {
          status: resp.status,
          body: body.slice(0, 200),
        });
        return false;
      }
      // Cancel the body so the underlying connection can be released
      // promptly — we don't read it.
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      logger.debug('[OpenClaw] notification delivered', { status: resp.status });
      return true;
    } catch (e) {
      logger.error('[OpenClaw] send failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

let singleton: OpenClawIntegration | null = null;
export function getOpenClaw(): OpenClawIntegration {
  if (!singleton) singleton = new OpenClawIntegration();
  return singleton;
}

// Direct Telegram bot alerting.
//
// Operators want a fast path from "incident opened" to "phone buzzes"
// that doesn't depend on the OpenClaw chat gateway being up. This
// module talks to the Telegram Bot API directly:
//
//   POST https://api.telegram.org/bot<TOKEN>/sendMessage
//
// Three event types are surfaced:
//   - sendAlert(incident)                — high/critical incident opened
//   - sendEscalation(incident, level, ctx) — pipeline reached L3 or L4
//   - sendResolution(incident, …)        — incident resolved (any source)
//
// Severity gating: TELEGRAM_ALERT_MIN_SEVERITY (default "high"). The
// floor only applies to sendAlert + sendResolution. sendEscalation
// bypasses it whenever level >= 4 — those are by definition urgent.
//
// Message format: Telegram HTML parse_mode. We escape user-supplied
// strings (incident titles, descriptions, agent names) defensively
// because they can contain '<', '>', and '&' from system-monitor
// generated text. Bot-API replies are read but only logged.

import type { Incident, IncidentSeverity } from '../persistence/SqliteStore.js';
import { logger } from '../utils/logger.js';

export type NotificationSeverity = IncidentSeverity | 'info';

const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  info:     0,
  low:      1,
  medium:   2,
  high:     3,
  critical: 4,
};

const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  critical: '🚨',
  high:     '🔴',
  medium:   '🟠',
  low:      '🟡',
  info:     'ℹ️',
};

/** Per-message timeout. Telegram is normally fast; if the API is
 *  blocked or rate-limiting us, we don't want a notification to hang
 *  the incident pipeline. */
const REQUEST_TIMEOUT_MS = 8000;

/** Chars Telegram HTML parse_mode requires escaped in text content. */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseMinSeverity(raw: string | undefined): NotificationSeverity {
  const v = (raw ?? 'high').toLowerCase();
  if (v in SEVERITY_RANK) return v as NotificationSeverity;
  logger.warn('[Telegram] unknown TELEGRAM_ALERT_MIN_SEVERITY, defaulting to high', { value: raw });
  return 'high';
}

function ageMinutes(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

export interface TelegramEscalationContext {
  agentName?: string;
  /** One-line summaries of the actions taken before escalating. */
  agentActions?: string[];
  agentIterations?: number;
  remediatorKind?: string | null;
  remediatorActions?: string[];
  reason?: string;
}

/** Test-injectable fetch surface — defaults to the global fetch but
 *  the constructor can swap in a stub for unit tests. */
export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export class TelegramAlerter {
  private readonly enabled: boolean;
  private readonly token: string;
  private readonly chatId: string;
  private readonly minSeverityRank: number;
  private readonly fetchFn: FetchFn;

  constructor(env: NodeJS.ProcessEnv = process.env, fetchFn: FetchFn = fetch) {
    this.token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
    this.chatId = (env.TELEGRAM_CHAT_ID ?? '').trim();
    const flag = (env.TELEGRAM_ALERT_ENABLED ?? '').toLowerCase();
    // Only treat as enabled when explicitly set true AND we have creds.
    // Avoids surprise outbound calls when an operator drops in a bot
    // token to test connectivity without arming alerts.
    this.enabled = (flag === 'true' || flag === '1' || flag === 'yes')
      && this.token.length > 0
      && this.chatId.length > 0;
    this.minSeverityRank = SEVERITY_RANK[parseMinSeverity(env.TELEGRAM_ALERT_MIN_SEVERITY)];
    this.fetchFn = fetchFn;
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  /** True iff `severity` is at or above the configured floor. */
  passesSeverityFilter(severity: NotificationSeverity): boolean {
    return SEVERITY_RANK[severity] >= this.minSeverityRank;
  }

  // ── Public dispatch surface ────────────────────────────────────────

  /** Incident opened — operator-facing alert. Skipped when below the
   *  configured severity floor. */
  async sendAlert(incident: Incident, serverName?: string): Promise<boolean> {
    const sev = (incident.severity ?? 'medium') as NotificationSeverity;
    if (!this.passesSeverityFilter(sev)) {
      logger.debug('[Telegram] alert below min severity — skipping', {
        incidentId: incident.id, severity: sev,
      });
      return false;
    }
    const lines = [
      `${SEVERITY_EMOJI[sev]} <b>ALERT: ${htmlEscape(incident.title)}</b>`,
      `Server: ${htmlEscape(serverName ?? incident.serverId ?? '—')}`,
      `Severity: <b>${sev.toUpperCase()}</b>`,
      `Status: ${htmlEscape(incident.status)}`,
      `Age: ${ageMinutes(incident.createdAt)}m`,
    ];
    if (incident.description?.trim()) {
      const desc = incident.description.length > 400
        ? incident.description.slice(0, 400) + '…'
        : incident.description;
      lines.push('', htmlEscape(desc));
    }
    return this.send(lines.join('\n'));
  }

  /** Pipeline escalated to L3 or L4. L4 always sends; lower levels
   *  honour the severity floor so chat doesn't get woken up for noisy
   *  audit incidents. */
  async sendEscalation(
    incident: Incident,
    level: number,
    ctx: TelegramEscalationContext = {},
    serverName?: string,
  ): Promise<boolean> {
    const sev = (incident.severity ?? 'medium') as NotificationSeverity;
    if (level < 4 && !this.passesSeverityFilter(sev)) {
      logger.debug('[Telegram] escalation below min severity — skipping', {
        incidentId: incident.id, level, severity: sev,
      });
      return false;
    }
    const prefix = level >= 4 ? '🆘' : '⬆️';
    const lines = [
      `${prefix} <b>ESCALATED L${level}: ${htmlEscape(incident.title)}</b>`,
      `Server: ${htmlEscape(serverName ?? incident.serverId ?? '—')}`,
      `Severity: <b>${sev.toUpperCase()}</b>`,
      `Age: ${ageMinutes(incident.createdAt)}m`,
    ];
    if (ctx.agentName) {
      const iter = typeof ctx.agentIterations === 'number' ? ` (${ctx.agentIterations} iterations)` : '';
      lines.push('', `Agent <i>${htmlEscape(ctx.agentName)}</i> could not resolve${iter}.`);
    }
    const actionsTried: string[] = [];
    if (ctx.remediatorKind) actionsTried.push(`auto-remediator (${ctx.remediatorKind})`);
    if (ctx.agentActions?.length) actionsTried.push(...ctx.agentActions.slice(0, 3));
    if (actionsTried.length > 0) {
      lines.push(`Actions tried: ${htmlEscape(actionsTried.join('; '))}`);
    }
    if (ctx.reason) {
      lines.push(`Reason: ${htmlEscape(ctx.reason)}`);
    }
    lines.push('', 'Action needed: <b>manual intervention</b>');
    return this.send(lines.join('\n'));
  }

  /** ExecutionGuard paused a standard/risky action for operator approval. */
  async sendApprovalRequest(action: string, summary: string, tokenId: string): Promise<boolean> {
    const lines = [
      '<b>APPROVAL REQUIRED</b>',
      `Action: <code>${htmlEscape(action)}</code>`,
      '',
      htmlEscape(summary),
      '',
      `ID: <code>${htmlEscape(tokenId)}</code>`,
      'Approve via dashboard: /app/approvals',
    ];
    return this.send(lines.join('\n'));
  }

  /** Incident resolved. Skipped below the severity floor — operators
   *  don't want a "resolved" ping for every minor incident. */
  async sendResolution(
    incident: Incident,
    opts: { durationMs?: number; resolvedBy?: string; serverName?: string } = {},
  ): Promise<boolean> {
    const sev = (incident.severity ?? 'medium') as NotificationSeverity;
    if (!this.passesSeverityFilter(sev)) return false;
    const durationMin = typeof opts.durationMs === 'number'
      ? Math.round(opts.durationMs / 60_000)
      : (incident.resolvedAt ? ageMinutes(incident.createdAt) : ageMinutes(incident.createdAt));
    const lines = [
      `✅ <b>RESOLVED: ${htmlEscape(incident.title)}</b>`,
      `Server: ${htmlEscape(opts.serverName ?? incident.serverId ?? '—')}`,
      `Duration: ${durationMin}m`,
      `Resolved by: ${htmlEscape(opts.resolvedBy ?? incident.assignedTo ?? 'auto')}`,
    ];
    return this.send(lines.join('\n'));
  }

  // ── HTTP ───────────────────────────────────────────────────────────

  private async send(text: string): Promise<boolean> {
    if (!this.enabled) {
      logger.debug('[Telegram] alerter not configured — skipping send');
      return false;
    }
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          // Disable web-page previews so a URL in the description doesn't
          // generate an unwanted preview card.
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        logger.warn('[Telegram] non-2xx', {
          status: resp.status, body: body.slice(0, 300),
        });
        return false;
      }
      // Drain body so the connection can be released.
      try { await resp.text(); } catch { /* ignore */ }
      logger.debug('[Telegram] delivered', { status: resp.status });
      return true;
    } catch (e) {
      logger.error('[Telegram] send failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

let singleton: TelegramAlerter | null = null;

/** Process-wide instance. Tests can construct their own. */
export function getTelegram(): TelegramAlerter {
  if (!singleton) singleton = new TelegramAlerter();
  return singleton;
}

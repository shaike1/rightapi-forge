// EmailService — event-driven SMTP notifications for RightAPI Forge.
//
// Distinct from SmtpService.ts, which reads its config from a JSON file
// at /data/itops-agents/smtp-config.json and is administered via the UI.
// EmailService takes its config from env vars at process start, so it
// works in headless deployments (CI, fresh containers) without a UI
// round-trip. The two coexist: a future migration can fold SmtpService's
// admin UI into this service, but until then they're independent paths.
//
// Surface:
//   - sendInvite(email, token, tenantName)        — admin invite tokens
//   - sendIncidentOpened(recipients, incident)    — new incident
//   - sendIncidentResolved(recipients, incident)  — closed incident
//   - sendAlertTriggered(recipients, alert)       — critical alerts
//
// Graceful fallback: when SMTP_HOST is unset (or any required field is
// missing) the service stays in disabled mode. Every public method logs
// a single warning the first time it would have sent and otherwise
// no-ops. It NEVER throws — a misconfigured mail server must not break
// invite creation, incident handling, or alerting.
//
// Branding: simple HTML wrapper with the RightAPI Forge accent colour
// (#306EF0 from client/src/index.css). The link in invite emails uses
// PUBLIC_URL so the invitee lands on the right host.

import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'email' });

export interface EmailServiceConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  /** Public base URL for links (used by invite emails). Defaults to
   *  PUBLIC_URL env, else http://localhost:19123. */
  publicUrl: string;
}

/** Minimal shape of an incident — kept local so this module doesn't take
 *  a runtime import from persistence. Any object with these fields works. */
export interface EmailIncident {
  id: string;
  title: string;
  description?: string | null;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
  assignedTo?: string | null;
}

/** Minimal shape of an alert. */
export interface EmailAlert {
  id?: string;
  title: string;
  message: string;
  severity: string;
  source?: string;
  firedAt?: string | Date;
}

const ACCENT = '#306EF0';
const TEXT = '#363737';
const TEXT2 = '#6B7280';
const BORDER = '#E5E7EB';
const BG_SOFT = '#F7F7F7';

export class EmailService {
  private transport: Transporter | null = null;
  private config: EmailServiceConfig | null = null;
  private warned = false;

  constructor(cfg?: Partial<EmailServiceConfig>) {
    const host = cfg?.host ?? process.env.SMTP_HOST ?? '';
    const portRaw = cfg?.port ?? process.env.SMTP_PORT;
    const port = portRaw ? Number(portRaw) : 587;
    const user = cfg?.user ?? process.env.SMTP_USER ?? '';
    const pass = cfg?.pass ?? process.env.SMTP_PASS ?? '';
    const from = cfg?.from ?? process.env.SMTP_FROM ?? '';
    const publicUrl = cfg?.publicUrl ?? process.env.PUBLIC_URL ?? 'http://localhost:19123';

    if (!host || !from) {
      // Stay disabled. First send attempt will log a warning.
      return;
    }

    this.config = { host, port, user, pass, from, publicUrl };
    try {
      this.transport = nodemailer.createTransport({
        host,
        port,
        // 465 = implicit TLS; everything else = STARTTLS upgrade.
        secure: port === 465,
        auth: user ? { user, pass } : undefined,
      });
      log.info('Email service configured', { host, port, from });
    } catch (e: any) {
      log.warn('Email service init failed — emails disabled', {
        err: e?.message ?? String(e),
      });
      this.transport = null;
      this.config = null;
    }
  }

  isEnabled(): boolean {
    return this.transport !== null && this.config !== null;
  }

  private warnOnce(reason: string): void {
    if (this.warned) return;
    this.warned = true;
    log.warn(`Email send skipped — ${reason}. Set SMTP_HOST, SMTP_FROM (and optionally SMTP_PORT/SMTP_USER/SMTP_PASS) to enable.`);
  }

  private async send(to: string | string[], subject: string, html: string, text: string): Promise<void> {
    if (!this.transport || !this.config) {
      this.warnOnce('SMTP not configured');
      return;
    }
    const recipients = Array.isArray(to)
      ? to.filter(r => typeof r === 'string' && r.trim().length > 0)
      : (to && to.trim().length > 0 ? [to] : []);
    if (recipients.length === 0) {
      log.debug('Email send skipped — no recipients', { subject });
      return;
    }
    try {
      await this.transport.sendMail({
        from: this.config.from,
        to: recipients.join(', '),
        subject,
        text,
        html,
      });
      log.info('Email sent', { subject, to: recipients.length });
    } catch (e: any) {
      log.warn('Email send failed', {
        subject,
        err: e?.message ?? String(e),
      });
    }
  }

  async sendInvite(email: string, token: string, tenantName: string): Promise<void> {
    const publicUrl = this.config?.publicUrl ?? process.env.PUBLIC_URL ?? '';
    const joinUrl = `${publicUrl.replace(/\/$/, '')}/app/join?token=${encodeURIComponent(token)}`;
    const subject = `You've been invited to ${tenantName} on RightAPI Forge`;
    const html = wrap(`
      <h1 style="margin:0 0 16px;font-size:22px;color:${TEXT}">You're invited</h1>
      <p style="margin:0 0 16px;color:${TEXT}">
        You've been invited to join <strong>${esc(tenantName)}</strong> on
        RightAPI Forge - a governed AI operations platform.
      </p>
      <p style="margin:0 0 24px;color:${TEXT2};font-size:14px">
        Click the button below to accept the invite and create your account.
      </p>
      <p style="margin:0 0 24px">
        <a href="${esc(joinUrl)}"
           style="display:inline-block;background:${ACCENT};color:#fff;
                  text-decoration:none;padding:12px 24px;border-radius:8px;
                  font-weight:600">
          Accept invite
        </a>
      </p>
      <p style="margin:0 0 8px;color:${TEXT2};font-size:13px">
        If the button doesn't work, copy and paste this URL:
      </p>
      <p style="margin:0 0 24px;word-break:break-all;font-size:13px;color:${TEXT2}">
        <a href="${esc(joinUrl)}" style="color:${ACCENT}">${esc(joinUrl)}</a>
      </p>
      <p style="margin:0;color:${TEXT2};font-size:12px">
        This invite is single-use and will expire. If you weren't expecting
        this email, you can safely ignore it.
      </p>
    `);
    const text = [
      `You've been invited to join ${tenantName} on RightAPI Forge.`,
      '',
      `Accept the invite: ${joinUrl}`,
      '',
      `This invite is single-use and will expire.`,
    ].join('\n');
    await this.send(email, subject, html, text);
  }

  async sendIncidentOpened(recipients: string | string[], incident: EmailIncident): Promise<void> {
    const sev = (incident.severity || 'unknown').toUpperCase();
    const subject = `[${sev}] Incident opened: ${incident.title}`;
    const url = this.incidentUrl(incident.id);
    const html = wrap(`
      <h1 style="margin:0 0 16px;font-size:22px;color:${TEXT}">
        ${severityBadge(incident.severity)} Incident opened
      </h1>
      <h2 style="margin:0 0 16px;font-size:18px;color:${TEXT}">
        ${esc(incident.title)}
      </h2>
      ${incidentTable(incident)}
      ${incident.description ? `
        <p style="margin:16px 0 8px;color:${TEXT2};font-size:13px;text-transform:uppercase;letter-spacing:0.05em">Description</p>
        <div style="background:${BG_SOFT};border:1px solid ${BORDER};border-radius:8px;padding:12px;color:${TEXT};font-size:14px;white-space:pre-wrap">${esc(incident.description)}</div>
      ` : ''}
      <p style="margin:24px 0 0">
        <a href="${esc(url)}"
           style="display:inline-block;background:${ACCENT};color:#fff;
                  text-decoration:none;padding:10px 20px;border-radius:8px;
                  font-weight:600">
          View incident
        </a>
      </p>
    `);
    const text = [
      `Incident opened: ${incident.title}`,
      `Severity: ${sev}`,
      `Status: ${incident.status}`,
      `Created: ${incident.createdAt}`,
      incident.assignedTo ? `Assigned to: ${incident.assignedTo}` : '',
      '',
      incident.description ? `Description:\n${incident.description}\n` : '',
      `View: ${url}`,
    ].filter(Boolean).join('\n');
    await this.send(recipients, subject, html, text);
  }

  async sendIncidentResolved(recipients: string | string[], incident: EmailIncident): Promise<void> {
    const subject = `[RESOLVED] ${incident.title}`;
    const url = this.incidentUrl(incident.id);
    const duration = incident.resolvedAt && incident.createdAt
      ? formatDuration(Date.parse(incident.resolvedAt) - Date.parse(incident.createdAt))
      : null;
    const html = wrap(`
      <h1 style="margin:0 0 16px;font-size:22px;color:${TEXT}">
        ✅ Incident resolved
      </h1>
      <h2 style="margin:0 0 16px;font-size:18px;color:${TEXT}">
        ${esc(incident.title)}
      </h2>
      ${incidentTable(incident)}
      ${duration ? `
        <p style="margin:16px 0 0;color:${TEXT}">
          <strong>Time to resolve:</strong> ${esc(duration)}
        </p>
      ` : ''}
      <p style="margin:24px 0 0">
        <a href="${esc(url)}"
           style="display:inline-block;background:${ACCENT};color:#fff;
                  text-decoration:none;padding:10px 20px;border-radius:8px;
                  font-weight:600">
          View incident
        </a>
      </p>
    `);
    const text = [
      `Incident resolved: ${incident.title}`,
      `Severity: ${incident.severity}`,
      `Created: ${incident.createdAt}`,
      incident.resolvedAt ? `Resolved: ${incident.resolvedAt}` : '',
      duration ? `Time to resolve: ${duration}` : '',
      '',
      `View: ${url}`,
    ].filter(Boolean).join('\n');
    await this.send(recipients, subject, html, text);
  }

  async sendAlertTriggered(recipients: string | string[], alert: EmailAlert): Promise<void> {
    const sev = (alert.severity || 'critical').toUpperCase();
    const subject = `[${sev}] Alert: ${alert.title}`;
    const firedAt = alert.firedAt
      ? (alert.firedAt instanceof Date ? alert.firedAt.toISOString() : String(alert.firedAt))
      : new Date().toISOString();
    const html = wrap(`
      <h1 style="margin:0 0 16px;font-size:22px;color:${TEXT}">
        ${severityBadge(alert.severity)} Alert triggered
      </h1>
      <h2 style="margin:0 0 16px;font-size:18px;color:${TEXT}">
        ${esc(alert.title)}
      </h2>
      <div style="background:${BG_SOFT};border:1px solid ${BORDER};border-radius:8px;padding:12px;color:${TEXT};font-size:14px;white-space:pre-wrap;margin:0 0 16px">${esc(alert.message)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:${TEXT}">
        <tr><td style="padding:6px 0;color:${TEXT2};width:120px">Severity</td><td style="padding:6px 0">${esc(sev)}</td></tr>
        ${alert.source ? `<tr><td style="padding:6px 0;color:${TEXT2}">Source</td><td style="padding:6px 0">${esc(alert.source)}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:${TEXT2}">Fired at</td><td style="padding:6px 0">${esc(firedAt)}</td></tr>
      </table>
    `);
    const text = [
      `Alert triggered: ${alert.title}`,
      `Severity: ${sev}`,
      alert.source ? `Source: ${alert.source}` : '',
      `Fired at: ${firedAt}`,
      '',
      alert.message,
    ].filter(Boolean).join('\n');
    await this.send(recipients, subject, html, text);
  }

  private incidentUrl(id: string): string {
    const base = (this.config?.publicUrl ?? process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
    return `${base}/app/incidents/${encodeURIComponent(id)}`;
  }
}

// ── HTML helpers ─────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrap(inner: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${BG_SOFT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:${BG_SOFT};padding:24px 0">
    <tr>
      <td align="center">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;background:#fff;border:1px solid ${BORDER};border-radius:12px">
          <tr>
            <td style="padding:24px 28px;border-bottom:1px solid ${BORDER}">
              <div style="font-size:14px;font-weight:700;color:${ACCENT};letter-spacing:0.04em">RIGHTAPI FORGE</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px">
              ${inner}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;border-top:1px solid ${BORDER};color:${TEXT2};font-size:12px">
              Automated notification from RightAPI Forge. Do not reply to this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>`;
}

function severityBadge(severity: string): string {
  const s = (severity || '').toLowerCase();
  const colour =
    s === 'critical' ? '#EF4444' :
    s === 'high'     ? '#E8734A' :
    s === 'warning'  ? '#F59E0B' :
    s === 'medium'   ? '#F59E0B' :
    s === 'low'      ? '#06B6D4' :
                       '#6B7280';
  return `<span style="display:inline-block;background:${colour};color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:0.05em">${esc(severity.toUpperCase())}</span>`;
}

function incidentTable(incident: EmailIncident): string {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;color:${TEXT}">
    <tr><td style="padding:6px 0;color:${TEXT2};width:120px">ID</td><td style="padding:6px 0;font-family:monospace">${esc(incident.id)}</td></tr>
    <tr><td style="padding:6px 0;color:${TEXT2}">Severity</td><td style="padding:6px 0">${severityBadge(incident.severity)}</td></tr>
    <tr><td style="padding:6px 0;color:${TEXT2}">Status</td><td style="padding:6px 0">${esc(incident.status)}</td></tr>
    <tr><td style="padding:6px 0;color:${TEXT2}">Created</td><td style="padding:6px 0">${esc(incident.createdAt)}</td></tr>
    ${incident.assignedTo ? `<tr><td style="padding:6px 0;color:${TEXT2}">Assigned to</td><td style="padding:6px 0">${esc(incident.assignedTo)}</td></tr>` : ''}
  </table>`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `${d}d ${hr}h` : `${d}d`;
}

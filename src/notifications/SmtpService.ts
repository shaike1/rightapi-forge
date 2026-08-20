import * as fs from 'fs';
import * as path from 'path';
import nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;  // true = TLS (port 465), false = STARTTLS (port 587)
  user: string;
  pass: string;
  from: string;    // e.g. "RightAPI Forge <alerts@example.com>"
  to: string[];    // default recipients
  enabled: boolean;
}

const MASKED_PASS = '••••••';

export class SmtpService {
  private config: SmtpConfig | null = null;
  private configPath = '/data/itops-agents/smtp-config.json';

  loadConfig(): SmtpConfig | null {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      this.config = JSON.parse(data) as SmtpConfig;
      return this.config;
    } catch {
      return null;
    }
  }

  saveConfig(cfg: SmtpConfig): void {
    this.config = cfg;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2), 'utf8');
  }

  /** Return config with password masked for API responses. */
  maskedConfig(): SmtpConfig | null {
    const cfg = this.loadConfig();
    if (!cfg) return null;
    return { ...cfg, pass: cfg.pass ? MASKED_PASS : '' };
  }

  /** Resolve the real password when the client sends back the masked placeholder. */
  resolvePassword(submitted: string): string {
    if (submitted === MASKED_PASS) {
      return this.loadConfig()?.pass ?? '';
    }
    return submitted;
  }

  private createTransport(cfg: SmtpConfig) {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.loadConfig();
    if (!cfg) return { ok: false, error: 'No SMTP configuration found' };
    if (!cfg.host) return { ok: false, error: 'SMTP host is not configured' };
    try {
      const transport = this.createTransport(cfg);
      await transport.verify();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Connection failed' };
    }
  }

  async sendAlert(subject: string, body: string, toOverride?: string[]): Promise<void> {
    const cfg = this.loadConfig();
    if (!cfg || !cfg.enabled) return;
    const recipients = toOverride && toOverride.length > 0 ? toOverride : cfg.to;
    if (!recipients || recipients.length === 0) return;
    const transport = this.createTransport(cfg);
    await transport.sendMail({
      from: cfg.from,
      to: recipients.join(', '),
      subject,
      text: body,
      html: `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
    });
  }

  async sendHtmlReport(subject: string, html: string, toOverride?: string[]): Promise<void> {
    const cfg = this.loadConfig();
    if (!cfg || !cfg.enabled) return;
    const recipients = toOverride && toOverride.length > 0 ? toOverride : cfg.to;
    if (!recipients || recipients.length === 0) return;
    const transport = this.createTransport(cfg);
    await transport.sendMail({
      from: cfg.from,
      to: recipients.join(', '),
      subject,
      html,
    });
  }

  async sendIncidentAlert(incident: any): Promise<void> {
    const subject = `[${(incident.severity || 'unknown').toUpperCase()}] Incident: ${incident.title}`;
    const body = [
      'Incident Alert',
      '==============',
      `Title:       ${incident.title}`,
      `Severity:    ${incident.severity}`,
      `Status:      ${incident.status}`,
      `Description: ${incident.description || '(none)'}`,
      `Created At:  ${incident.createdAt}`,
      '',
      'This is an automated alert from RightAPI Forge.',
    ].join('\n');
    await this.sendAlert(subject, body);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

import fs from 'fs';
import path from 'path';
import { retryFetch } from '../utils/retryFetch.js';
import { logger } from '../utils/logger.js';

export interface SlackConfig {
  webhookUrl: string;
  channel: string;
  enabled: boolean;
  events: {
    incidentCreated: boolean;
    incidentResolved: boolean;
    alertFired: boolean;
    agentError: boolean;
  };
}

const CONFIG_PATH = process.env.SLACK_CONFIG_PATH || '/data/itops-agents/slack-config.json';

const DEFAULT_CONFIG: SlackConfig = {
  webhookUrl: '',
  channel: '#alerts',
  enabled: false,
  events: {
    incidentCreated: true,
    incidentResolved: true,
    alertFired: true,
    agentError: false,
  },
};

export class SlackService {
  private config: SlackConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig(): SlackConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw, events: { ...DEFAULT_CONFIG.events, ...(raw.events ?? {}) } };
      }
    } catch (e) {
      logger.error('[SlackService] Failed to load config:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
    return { ...DEFAULT_CONFIG, events: { ...DEFAULT_CONFIG.events } };
  }

  saveConfig(config: SlackConfig): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.config = config;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  maskedConfig(): SlackConfig {
    const cfg = { ...this.config, events: { ...this.config.events } };
    if (cfg.webhookUrl && cfg.webhookUrl.length > 20) {
      cfg.webhookUrl = cfg.webhookUrl.slice(0, 20) + '...';
    }
    return cfg;
  }

  resolveWebhookUrl(masked: string): string {
    if (masked.endsWith('...')) return this.config.webhookUrl;
    return masked;
  }

  async sendMessage(text: string, blocks?: unknown[]): Promise<void> {
    if (!this.config.enabled || !this.config.webhookUrl) return;
    const payload = JSON.stringify({
      text,
      channel: this.config.channel,
      ...(blocks ? { blocks } : {}),
    });
    await this._post(this.config.webhookUrl, payload);
  }

  private async _post(url: string, body: string): Promise<void> {
    const response = await retryFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) {
      throw new Error(`Slack webhook returned HTTP ${response.status}`);
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.sendMessage('RightAPI Forge Slack integration is working!');
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  async notifyIncident(incident: {
    id: string;
    title: string;
    severity: string;
    status: string;
  }): Promise<void> {
    if (!this.config.enabled) return;
    const emoji =
      incident.severity === 'critical' ? '🔴' :
      incident.severity === 'high' ? '🟠' :
      incident.severity === 'medium' ? '🟡' : '🟢';
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${incident.title}*\n*Severity:* ${incident.severity} | *Status:* ${incident.status} | *ID:* \`${incident.id}\``,
        },
      },
    ];
    await this.sendMessage(`${emoji} Incident: ${incident.title}`, blocks).catch(e =>
      logger.error('[SlackService] notifyIncident failed:', { err: e.message }),
    );
  }

  async notifyAlert(rule: { name: string; metric: string; threshold: number; operator: string }, value: number): Promise<void> {
    if (!this.config.enabled) return;
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *Alert: ${rule.name}*\n*Condition:* \`${rule.metric} ${rule.operator} ${rule.threshold}\` | *Current value:* \`${value}\``,
        },
      },
    ];
    await this.sendMessage(`⚠️ Alert fired: ${rule.name}`, blocks).catch(e =>
      logger.error('[SlackService] notifyAlert failed:', { err: e.message }),
    );
  }
}

import fs from 'fs';
import path from 'path';
import { retryFetch } from '../utils/retryFetch.js';
import { logger } from '../utils/logger.js';

export interface DiscordConfig {
  webhookUrl: string;
  channelName: string;
  enabled: boolean;
  events: {
    incidentCreated: boolean;
    incidentResolved: boolean;
    alertFired: boolean;
    agentError: boolean;
    taskCompleted: boolean;
  };
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

const CONFIG_PATH = process.env.DISCORD_CONFIG_PATH || '/data/itops-agents/discord-config.json';

const SEVERITY_COLORS: Record<string, number> = {
  critical: 15158332,  // 0xE74C3C red
  high:     15105570,  // 0xE67E22 orange
  medium:   15844367,  // 0xF1C40F yellow
  low:       3066993,  // 0x2ECC71 green
  info:      3447003,  // 0x3498DB blue
};

const DEFAULT_CONFIG: DiscordConfig = {
  webhookUrl: '',
  channelName: '#incidents',
  enabled: false,
  events: {
    incidentCreated: true,
    incidentResolved: true,
    alertFired: true,
    agentError: false,
    taskCompleted: false,
  },
};

export class DiscordService {
  private config: DiscordConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig(): DiscordConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return { ...DEFAULT_CONFIG, ...raw, events: { ...DEFAULT_CONFIG.events, ...(raw.events ?? {}) } };
      }
    } catch (e) {
      logger.error('[DiscordService] Failed to load config:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
    return { ...DEFAULT_CONFIG, events: { ...DEFAULT_CONFIG.events } };
  }

  saveConfig(config: DiscordConfig): void {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.config = config;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  /** Return config with webhook URL masked — show only last 8 chars. */
  getConfig(): DiscordConfig {
    const cfg = { ...this.config, events: { ...this.config.events } };
    if (cfg.webhookUrl && cfg.webhookUrl.length > 8) {
      cfg.webhookUrl = '...' + cfg.webhookUrl.slice(-8);
    }
    return cfg;
  }

  maskedConfig(): DiscordConfig {
    return this.getConfig();
  }

  resolveWebhookUrl(masked: string): string {
    if (masked.startsWith('...')) return this.config.webhookUrl;
    return masked;
  }

  async sendEmbed(embed: DiscordEmbed): Promise<void> {
    if (!this.config.enabled || !this.config.webhookUrl) return;
    const payload = JSON.stringify({
      username: 'RightAPI Forge',
      ...(process.env.DISCORD_AVATAR_URL ? { avatar_url: process.env.DISCORD_AVATAR_URL } : {}),
      embeds: [embed],
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
      throw new Error(`Discord webhook returned HTTP ${response.status}`);
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.sendEmbed({
        title: 'RightAPI Forge Discord integration is working!',
        description: 'Discord notifications from RightAPI Forge are configured correctly.',
        color: SEVERITY_COLORS.info,
        footer: { text: 'RightAPI Forge | ' + new Date().toISOString() },
        timestamp: new Date().toISOString(),
      });
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
      incident.severity === 'high'     ? '🟠' :
      incident.severity === 'medium'   ? '🟡' : '🟢';
    const color = SEVERITY_COLORS[incident.severity] ?? SEVERITY_COLORS.info;
    const isResolved = incident.status === 'resolved';

    if (isResolved && !this.config.events.incidentResolved) return;
    if (!isResolved && !this.config.events.incidentCreated) return;

    await this.sendEmbed({
      title: `${emoji} ${isResolved ? 'Incident Resolved' : 'New Incident'}: ${incident.title}`,
      color,
      fields: [
        { name: 'Severity', value: incident.severity, inline: true },
        { name: 'Status',   value: incident.status,   inline: true },
        { name: 'ID',       value: `\`${incident.id}\``, inline: true },
      ],
      footer: { text: 'RightAPI Forge | ' + new Date().toISOString() },
      timestamp: new Date().toISOString(),
    }).catch(e => logger.error('[DiscordService] notifyIncident failed:', { err: e.message }));
  }

  async notifyAlert(rule: { name: string; metric: string; threshold: number; operator: string }, value: number): Promise<void> {
    if (!this.config.enabled || !this.config.events.alertFired) return;
    await this.sendEmbed({
      title: `⚠️ Alert: ${rule.name}`,
      description: rule.metric
        ? `**Condition:** \`${rule.metric} ${rule.operator} ${rule.threshold}\`\n**Current Value:** \`${value}\``
        : rule.name,
      color: SEVERITY_COLORS.high,
      footer: { text: 'RightAPI Forge Alert Engine | ' + new Date().toISOString() },
      timestamp: new Date().toISOString(),
    }).catch(e => logger.error('[DiscordService] notifyAlert failed:', { err: e.message }));
  }

  async notifyTaskCompleted(task: {
    id: string;
    title: string;
    status: 'completed' | 'failed';
  }): Promise<void> {
    if (!this.config.enabled || !this.config.events.taskCompleted) return;
    const success = task.status === 'completed';
    await this.sendEmbed({
      title: `${success ? '✅' : '❌'} Task ${success ? 'Completed' : 'Failed'}: ${task.title}`,
      color: success ? SEVERITY_COLORS.low : SEVERITY_COLORS.critical,
      fields: [
        { name: 'Task ID', value: `\`${task.id}\``, inline: true },
        { name: 'Status',  value: task.status,      inline: true },
      ],
      footer: { text: 'RightAPI Forge | ' + new Date().toISOString() },
      timestamp: new Date().toISOString(),
    }).catch(e => logger.error('[DiscordService] notifyTaskCompleted failed:', { err: e.message }));
  }
}

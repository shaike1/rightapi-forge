/**
 * TeamsConfigStore — persists MS Teams integration configuration
 * File: /data/itops-agents/teams-config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';

export interface TeamsChannelConfig {
  webhookUrl: string;
  enabled: boolean;
}

export interface TeamsConfig {
  enabled: boolean;
  defaultWebhookUrl: string;
  outgoingWebhookSecret: string;   // HMAC secret from Teams outgoing webhook setup (base64)
  channels: {
    incident:   TeamsChannelConfig;
    alert:      TeamsChannelConfig;
    sla:        TeamsChannelConfig;
    escalation: TeamsChannelConfig;
  };
}

const DEFAULT_CONFIG: TeamsConfig = {
  enabled: false,
  defaultWebhookUrl: '',
  outgoingWebhookSecret: '',
  channels: {
    incident:   { webhookUrl: '', enabled: true },
    alert:      { webhookUrl: '', enabled: true },
    sla:        { webhookUrl: '', enabled: true },
    escalation: { webhookUrl: '', enabled: true },
  },
};

export class TeamsConfigStore {
  private configPath: string;
  private _config: TeamsConfig;

  constructor(configPath = '/data/itops-agents/teams-config.json') {
    this.configPath = configPath;
    this._config = this.load();
  }

  private load(): TeamsConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<TeamsConfig>;
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          channels: { ...DEFAULT_CONFIG.channels, ...(parsed.channels ?? {}) },
        };
      }
    } catch (err) {
      logger.error('[TeamsConfigStore] Failed to load config:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    }
    return { ...DEFAULT_CONFIG, channels: { ...DEFAULT_CONFIG.channels } };
  }

  get config(): TeamsConfig {
    return this._config;
  }

  save(config: TeamsConfig): void {
    this._config = config;
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
      logger.error('[TeamsConfigStore] Failed to save config:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      throw err;
    }
  }

  /** Get webhook URL for a specific event type — falls back to default */
  getWebhookUrl(type: keyof TeamsConfig['channels']): string | null {
    if (!this._config.enabled) return null;
    const ch = this._config.channels[type];
    if (ch?.enabled && ch.webhookUrl) return ch.webhookUrl;
    if (this._config.defaultWebhookUrl) return this._config.defaultWebhookUrl;
    return null;
  }

  masked(): TeamsConfig {
    const c = JSON.parse(JSON.stringify(this._config)) as TeamsConfig;
    if (c.outgoingWebhookSecret) c.outgoingWebhookSecret = '••••••••';
    return c;
  }
}

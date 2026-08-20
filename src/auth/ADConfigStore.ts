/**
 * ADConfigStore — persists AD/LDAP configuration to disk
 * File: /data/itops-agents/ad-config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ADConfig } from './ADAuthManager.js';
import { logger } from '../utils/logger.js';

const DEFAULT_CONFIG: ADConfig = {
  ldap: {
    enabled: false,
    url: '',
    bindDN: '',
    bindPassword: '',
    baseDN: '',
    userFilter: '(sAMAccountName={{username}})',
    tlsRejectUnauthorized: true,
    timeout: 5000,
  },
  azure: {
    enabled: false,
    tenantId: '',
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  },
  groupRoleMap: {},
  defaultRole: 'viewer',
  requireAD: false,
};

export class ADConfigStore {
  private configPath: string;
  private _config: ADConfig;

  constructor(configPath = '/data/itops-agents/ad-config.json') {
    this.configPath = configPath;
    this._config = this.load();
  }

  private load(): ADConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      }
    } catch (err) {
      logger.error('[ADConfigStore] Failed to load config:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    }
    return { ...DEFAULT_CONFIG };
  }

  get config(): ADConfig {
    return this._config;
  }

  save(config: ADConfig): void {
    this._config = config;
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
      logger.error('[ADConfigStore] Failed to save config:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      throw err;
    }
  }

  /** Return config with sensitive fields masked for API responses */
  masked(): ADConfig {
    const c = JSON.parse(JSON.stringify(this._config)) as ADConfig;
    if (c.ldap?.bindPassword) c.ldap.bindPassword = '••••••••';
    if (c.azure?.clientSecret) c.azure.clientSecret = '••••••••';
    return c;
  }
}

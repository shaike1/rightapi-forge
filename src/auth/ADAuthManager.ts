/**
 * ADAuthManager — orchestrates LDAP, Azure AD, and local auth
 *
 * Login priority:
 *   1. LDAP (on-prem AD) — if configured and enabled
 *   2. Azure AD (OIDC)   — handled separately via redirect flow; token injected via azureLogin()
 *   3. Local (AuthService scrypt) — always available as fallback for local admin accounts
 *
 * Group → Role mapping:
 *   adGroupRoleMap: { 'IT-Admins': 'admin', 'IT-Ops': 'operator', 'IT-Helpdesk': 'viewer' }
 *   Falls back to 'viewer' if no group matches.
 *   Local admin users always use their stored role regardless of AD groups.
 */

import { LDAPProvider, LDAPConfig, LDAPUserInfo } from './LDAPProvider.js';
import { AzureADProvider, AzureADConfig, AzureUserInfo } from './AzureADProvider.js';
import { logger } from '../utils/logger.js';

export interface ADConfig {
  ldap?: LDAPConfig & { enabled: boolean };
  azure?: AzureADConfig & { enabled: boolean };
  groupRoleMap: Record<string, 'admin' | 'operator' | 'viewer'>;
  defaultRole: 'admin' | 'operator' | 'viewer';
  // If true, local accounts only work if no AD provider is configured/reachable
  requireAD?: boolean;
}

export type ADAuthRole = 'admin' | 'operator' | 'viewer';

export interface ADAuthResult {
  success: boolean;
  username: string;
  displayName: string;
  email: string;
  role: ADAuthRole;
  source: 'ldap' | 'azure' | 'local';
  groups?: string[];
  error?: string;
}

export class ADAuthManager {
  private ldap: LDAPProvider | null = null;
  private azure: AzureADProvider | null = null;

  constructor(private config: ADConfig) {
    if (config.ldap?.enabled) {
      this.ldap = new LDAPProvider(config.ldap);
    }
    if (config.azure?.enabled) {
      this.azure = new AzureADProvider(config.azure);
    }
  }

  /** Reload config at runtime (e.g. after settings update) */
  reload(config: ADConfig): void {
    this.config = config;
    this.ldap = config.ldap?.enabled ? new LDAPProvider(config.ldap) : null;
    this.azure = config.azure?.enabled ? new AzureADProvider(config.azure) : null;
  }

  get isLDAPEnabled(): boolean { return !!this.ldap; }
  get isAzureEnabled(): boolean { return !!this.azure; }
  get azureProvider(): AzureADProvider | null { return this.azure; }

  /** Map AD group memberships to the highest-privilege role */
  resolveRole(groups: string[]): ADAuthRole {
    const priority: ADAuthRole[] = ['admin', 'operator', 'viewer'];
    let best: ADAuthRole = this.config.defaultRole;

    for (const group of groups) {
      const mapped = this.config.groupRoleMap[group];
      if (mapped && priority.indexOf(mapped) < priority.indexOf(best)) {
        best = mapped;
      }
    }
    return best;
  }

  /**
   * Try LDAP authentication.
   * Returns null if LDAP is not configured; throws on connection errors.
   */
  async tryLDAP(username: string, password: string): Promise<ADAuthResult | null> {
    if (!this.ldap) return null;

    let userInfo: LDAPUserInfo | null;
    try {
      userInfo = await this.ldap.authenticate(username, password);
    } catch (err: any) {
      logger.error('[LDAP] Connection error:', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      throw new Error(`LDAP connection failed: ${err?.message}`);
    }

    if (!userInfo) return null;

    return {
      success: true,
      username: userInfo.username,
      displayName: userInfo.displayName,
      email: userInfo.email,
      role: this.resolveRole(userInfo.groups),
      source: 'ldap',
      groups: userInfo.groups,
    };
  }

  /**
   * Process a completed Azure AD OIDC callback.
   * callbackParams: the query params from the callback URL.
   */
  async handleAzureCallback(callbackParams: Record<string, string>): Promise<ADAuthResult> {
    if (!this.azure) throw new Error('Azure AD not configured');

    let userInfo: AzureUserInfo;
    try {
      userInfo = await this.azure.handleCallback(callbackParams);
    } catch (err: any) {
      return {
        success: false,
        username: '',
        displayName: '',
        email: '',
        role: 'viewer',
        source: 'azure',
        error: err?.message ?? 'Azure AD callback failed',
      };
    }

    return {
      success: true,
      username: userInfo.username,
      displayName: userInfo.displayName,
      email: userInfo.email,
      role: this.resolveRole(userInfo.groups),
      source: 'azure',
      groups: userInfo.groups,
    };
  }

  /** Test all configured providers */
  async testConnections(): Promise<Record<string, { ok: boolean; message: string }>> {
    const results: Record<string, { ok: boolean; message: string }> = {};

    if (this.ldap) {
      results.ldap = await this.ldap.testConnection();
    }
    if (this.azure) {
      results.azure = await this.azure.testConnection();
    }
    if (!this.ldap && !this.azure) {
      results.none = { ok: false, message: 'No AD providers configured' };
    }

    return results;
  }
}

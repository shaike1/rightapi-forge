/**
 * AzureADProvider — Azure Active Directory (Entra ID) authentication via OIDC
 * Uses openid-client v6 API (discovery + authorizationCodeGrant)
 */

import * as oidc from 'openid-client';

export interface AzureADConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
  groupsClaim?: string;
}

export interface AzureUserInfo {
  oid: string;
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}

// State store for PKCE (keyed by state param)
const stateStore = new Map<string, {
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of stateStore.entries()) {
    if (v.expiresAt < now) stateStore.delete(k);
  }
}, 5 * 60 * 1000);

export class AzureADProvider {
  private config_oidc: oidc.Configuration | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private config: AzureADConfig) {}

  private async init(): Promise<void> {
    if (this.config_oidc) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const issuerUrl = new URL(`https://login.microsoftonline.com/${this.config.tenantId}/v2.0`);
      this.config_oidc = await oidc.discovery(issuerUrl, this.config.clientId, this.config.clientSecret);
    })();

    return this.initPromise;
  }

  async getAuthorizationUrl(): Promise<string> {
    await this.init();
    const cfg = this.config_oidc!;

    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

    stateStore.set(state, {
      nonce,
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const scopes = this.config.scopes ?? ['openid', 'profile', 'email', 'offline_access'];

    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: this.config.redirectUri,
      scope: scopes.join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return url.href;
  }

  async handleCallback(callbackParams: Record<string, string>): Promise<AzureUserInfo> {
    await this.init();
    const cfg = this.config_oidc!;

    const state = callbackParams.state;
    const stored = stateStore.get(state);
    if (!stored) throw new Error('Invalid or expired OAuth state');
    stateStore.delete(state);

    const currentUrl = new URL(this.config.redirectUri);
    for (const [k, v] of Object.entries(callbackParams)) {
      currentUrl.searchParams.set(k, v);
    }

    const tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, {
      pkceCodeVerifier: stored.codeVerifier,
      expectedNonce: stored.nonce,
      expectedState: state,
    });

    const claims = tokens.claims();
    if (!claims) throw new Error('No ID token claims');

    let userinfo: Record<string, unknown> = {};
    try {
      userinfo = await oidc.fetchUserInfo(cfg, tokens.access_token!, `https://login.microsoftonline.com/${this.config.tenantId}/oidc/userinfo`) as Record<string, unknown>;
    } catch { /* ignore — claims from ID token are sufficient */ }

    const username = String(claims['preferred_username'] ?? claims['upn'] ?? claims['email'] ?? claims['sub']);
    const displayName = String(claims['name'] ?? userinfo['name'] ?? username);
    const email = String(claims['email'] ?? userinfo['email'] ?? '');

    const groupClaim = this.config.groupsClaim ?? 'groups';
    const rawGroups: string[] = (claims[groupClaim] as string[] | undefined)
      ?? (userinfo[groupClaim] as string[] | undefined)
      ?? [];

    return {
      oid: String(claims['sub']),
      username,
      displayName,
      email,
      groups: rawGroups,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      this.config_oidc = null;
      this.initPromise = null;
      await this.init();
      return { ok: true, message: `Azure AD tenant ${this.config.tenantId} reachable` };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }
}


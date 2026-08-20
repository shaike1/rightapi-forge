// Concrete Rotator that mints a new API key by POSTing to a
// configurable URL.
//
// Why generic: every IdP / secret manager / internal key service has
// its own API. We don't try to support all of them — we expose one
// clean abstraction (POST → JSON body → parse the secret out) and
// give operators the hooks they need to wire their own service.
//
// Wiring example (server.ts):
//
//   rotationManager.registerRotator('api-key', new GenericApiKeyRotator({
//     endpoint: process.env.API_KEY_ROTATOR_URL!,
//     bearerToken: process.env.API_KEY_ROTATOR_TOKEN,
//     extractSecret: body => body.access_token,
//     extractExpiry: body => body.expires_at,
//   }).rotate);
//
// The rotator never logs the new secret. The CredentialRotationManager
// stores it via the vault's encrypted path; logs only carry credential
// id + name + expiry.

import type { Rotator, RotationResult } from '../CredentialRotationManager.js';
import type { CredentialRecordMeta } from '../CredentialVault.js';
import { createLogger } from '../../observability/Logger.js';

const log = createLogger({ component: 'rotator-api-key' });

export interface GenericApiKeyRotatorConfig {
  /** URL the rotator POSTs to. Required. */
  endpoint: string;
  /** Bearer token for authenticating to the rotation endpoint. Optional —
   *  some IdPs accept anonymous rotation requests. */
  bearerToken?: string;
  /** Extra headers (content-type defaults to application/json). */
  headers?: Record<string, string>;
  /** Body builder. Receives the credential meta + current secret;
   *  returns the JSON body to POST. Default: minimal `{ id, name }`. */
  buildRequestBody?: (meta: CredentialRecordMeta, currentSecret: string | null) => unknown;
  /** Pull the new secret out of the response JSON. Default: looks for
   *  `secret`, then `access_token`, then `key`. */
  extractSecret?: (responseBody: unknown) => string;
  /** Pull the new expiry (ISO timestamp) from the response. Default:
   *  looks for `expires_at`, then `expiry`. Optional. */
  extractExpiry?: (responseBody: unknown) => string | undefined;
  /** Override fetch — used by tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Wall-clock timeout per rotation attempt. Default 15s. */
  timeoutMs?: number;
}

export class GenericApiKeyRotator {
  private readonly cfg: Required<Omit<GenericApiKeyRotatorConfig, 'bearerToken' | 'headers'>> & {
    bearerToken?: string;
    headers: Record<string, string>;
  };

  constructor(cfg: GenericApiKeyRotatorConfig) {
    if (!cfg.endpoint) throw new Error('GenericApiKeyRotator: endpoint is required');
    this.cfg = {
      endpoint: cfg.endpoint,
      bearerToken: cfg.bearerToken,
      headers: cfg.headers ?? {},
      buildRequestBody: cfg.buildRequestBody ?? ((meta) => ({ id: meta.id, name: meta.name, agentId: meta.agentId })),
      extractSecret: cfg.extractSecret ?? defaultExtractSecret,
      extractExpiry: cfg.extractExpiry ?? defaultExtractExpiry,
      fetchImpl: cfg.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch),
      timeoutMs: cfg.timeoutMs ?? 15_000,
    };
  }

  /** The Rotator function the manager calls. Bound so callers can pass
   *  it directly: `manager.registerRotator('api-key', rotator.rotate)`. */
  rotate: Rotator = async (meta, currentSecret) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...this.cfg.headers,
      };
      if (this.cfg.bearerToken) headers.authorization = `Bearer ${this.cfg.bearerToken}`;
      const body = JSON.stringify(this.cfg.buildRequestBody(meta, currentSecret));

      const res = await this.cfg.fetchImpl(this.cfg.endpoint, {
        method: 'POST', headers, body, signal: ac.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      if (!res.ok) {
        // Surface a useful message but don't dump the whole body — it
        // may contain the new secret on success-with-different-status.
        throw new Error(`rotation endpoint returned ${res.status}`);
      }
      const secret = this.cfg.extractSecret(parsed);
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error('response did not contain a usable secret');
      }
      const result: RotationResult = { secret };
      const expiry = this.cfg.extractExpiry(parsed);
      if (expiry) result.expiresAt = expiry;
      log.info('api-key rotated', { credentialId: meta.id, name: meta.name, expiresAt: result.expiresAt });
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

function defaultExtractSecret(body: unknown): string {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.secret === 'string')       return o.secret;
    if (typeof o.access_token === 'string') return o.access_token;
    if (typeof o.key === 'string')          return o.key;
  }
  throw new Error('rotation response missing secret/access_token/key field');
}

function defaultExtractExpiry(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (typeof o.expires_at === 'string') return o.expires_at;
    if (typeof o.expiry === 'string')     return o.expiry;
  }
  return undefined;
}

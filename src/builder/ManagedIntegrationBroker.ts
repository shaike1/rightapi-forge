import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Agent } from 'undici';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import type { ManagedIntegrationRegistry } from './ManagedIntegrationRegistry.js';

interface CapabilityGrant {
  version: 1; tenantId: string; projectId: string; connectionRef: string; capability: string;
  actor: string; issuedAt: number; expiresAt: number; nonce: string;
}

export interface BrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
type BrokerFetch = (input: string, init: RequestInit & { dispatcher?: Agent }) => Promise<Response>;

export class ManagedIntegrationBroker {
  private db: Database.Database;
  constructor(
    private registry: ManagedIntegrationRegistry,
    dbPath: string,
    private signingKey: string,
    private fetchImpl: BrokerFetch = fetch as BrokerFetch,
    private lookup: Lookup = hostname => dns.lookup(hostname, { all: true, verbatim: true }),
  ) {
    if (signingKey.length < 32) throw new Error('integration signing key must contain at least 32 characters');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath); applyStandardPragmas(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS builder_integration_calls (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, connection_ref TEXT NOT NULL,
      capability TEXT NOT NULL, actor TEXT NOT NULL, status INTEGER NOT NULL, outcome TEXT NOT NULL,
      duration_ms INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builder_integration_calls ON builder_integration_calls(tenant_id, project_id, created_at DESC);`);
  }

  issue(input: { tenantId: string; projectId: string; connectionRef: string; capability: string; actor: string; ttlSeconds?: number }): { grant: string; expiresAt: string } {
    const resolved = this.registry.resolveCapability(input.tenantId, input.connectionRef, input.capability);
    if (!resolved) throw new Error('managed connection or approved capability not found');
    const now = Date.now(); const ttl = Math.min(Math.max(input.ttlSeconds ?? 300, 30), 900);
    const payload: CapabilityGrant = { version: 1, tenantId: input.tenantId, projectId: input.projectId,
      connectionRef: input.connectionRef, capability: input.capability, actor: input.actor,
      issuedAt: now, expiresAt: now + ttl * 1000, nonce: crypto.randomBytes(16).toString('base64url') };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { grant: `${encoded}.${sign(encoded, this.signingKey)}`, expiresAt: new Date(payload.expiresAt).toISOString() };
  }

  async invoke(input: { grant: string; tenantId: string; projectId: string; actor: string; body?: unknown }): Promise<BrokerResponse> {
    const started = Date.now(); let payload: CapabilityGrant | undefined;
    try {
      payload = verify(input.grant, this.signingKey);
      if (payload.expiresAt < Date.now()) throw new Error('capability grant expired');
      if (payload.tenantId !== input.tenantId || payload.projectId !== input.projectId) throw new Error('capability grant scope mismatch');
      const resolved = this.registry.resolveCapability(payload.tenantId, payload.connectionRef, payload.capability);
      if (!resolved) throw new Error('managed connection or approved capability not found');
      const operation = parseCapability(payload.capability);
      const request = connectionRequest(resolved.connection.provider, resolved.credentials, operation);
      const addresses = await publicAddresses(request.url, this.lookup);
      const selected = addresses[0];
      const dispatcher = new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family) } });
      try {
        const response = await this.fetchImpl(request.url, {
          method: operation.method,
          headers: request.headers,
          ...(operation.method === 'GET' || operation.method === 'DELETE' || input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          redirect: 'manual', signal: AbortSignal.timeout(15_000), dispatcher,
        });
        if (response.status >= 300 && response.status < 400) throw new Error('integration redirects are blocked');
        const body = await boundedBody(response, 1_048_576);
        const result = { status: response.status, headers: responseHeaders(response.headers), body };
        this.audit(payload, input.actor, response.status, response.ok ? 'success' : 'upstream_error', Date.now() - started);
        return result;
      } finally { await dispatcher.close(); }
    } catch (error) {
      if (payload) this.audit(payload, input.actor, 0, error instanceof Error ? error.message.slice(0, 200) : 'broker_error', Date.now() - started);
      throw error;
    }
  }

  calls(tenantId: string, projectId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT id,connection_ref AS connectionRef,capability,actor,status,outcome,
      duration_ms AS durationMs,created_at AS createdAt FROM builder_integration_calls
      WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT 200`).all(tenantId, projectId) as Array<Record<string, unknown>>;
  }

  close(): void { this.db.close(); }
  private audit(grant: CapabilityGrant, actor: string, status: number, outcome: string, duration: number): void {
    this.db.prepare(`INSERT INTO builder_integration_calls
      (id,tenant_id,project_id,connection_ref,capability,actor,status,outcome,duration_ms,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`broker-call-${crypto.randomBytes(8).toString('hex')}`, grant.tenantId, grant.projectId,
        grant.connectionRef, grant.capability, actor, status, outcome, duration, new Date().toISOString());
  }
}

function parseCapability(value: string): { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string } {
  const match = value.match(/^(GET|POST|PUT|PATCH|DELETE) (\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?)$/);
  if (!match || match[2].includes('..') || match[2].includes('//')) throw new Error('capability must be a fixed HTTP method and safe absolute path');
  return { method: match[1] as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: match[2] };
}

function connectionRequest(provider: string, credentials: Record<string, string>, operation: { method: string; path: string }): { url: string; headers: Record<string, string> } {
  const baseUrl = provider === 'github' ? 'https://api.github.com' : provider === 'slack' ? 'https://slack.com/api' : credentials.baseUrl;
  if (!baseUrl || !['http', 'custom', 'github', 'slack'].includes(provider)) throw new Error(`provider does not support HTTP capability brokering: ${provider}`);
  const base = new URL(baseUrl); const target = new URL(operation.path, `${base.origin}${base.pathname.replace(/\/$/, '')}/`);
  if (target.origin !== base.origin) throw new Error('capability target escaped the managed connection origin');
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'ITOPS-Managed-Integration/1.0' };
  for (const [key, value] of Object.entries(credentials)) if (key.toLowerCase().startsWith('header:')) headers[key.slice(7).toLowerCase()] = value;
  if (provider === 'github' && credentials.token) headers.authorization = `Bearer ${credentials.token}`;
  if (provider === 'slack' && credentials.token) headers.authorization = `Bearer ${credentials.token}`;
  return { url: target.toString(), headers };
}

async function publicAddresses(url: string, lookup: Lookup): Promise<Array<{ address: string; family: number }>> {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('managed integrations require HTTPS');
  if (!target.hostname || target.username || target.password) throw new Error('invalid managed integration target');
  const addresses = net.isIP(target.hostname) ? [{ address: target.hostname, family: net.isIP(target.hostname) }] : await lookup(target.hostname);
  if (!addresses.length || addresses.some(item => isPrivate(item.address))) throw new Error('managed integration target resolves to a private or reserved address');
  return addresses;
}

function isPrivate(address: string): boolean {
  if (address.includes(':')) {
    const value = address.toLowerCase();
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivate(mapped[1]);
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff') || value.startsWith('2001:db8:');
  }
  const parts = address.split('.').map(Number); const [a, b, c] = parts;
  return parts.length !== 4 || parts.some(item => !Number.isInteger(item) || item < 0 || item > 255)
    || a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 168].includes(b))
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

async function boundedBody(response: Response, limit: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') || 0); if (declared > limit) throw new Error('integration response exceeded size limit');
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > limit) { await reader.cancel(); throw new Error('integration response exceeded size limit'); } chunks.push(value); }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (!text) return null; if ((response.headers.get('content-type') || '').includes('application/json')) { try { return JSON.parse(text); } catch { throw new Error('integration returned invalid JSON'); } }
  return text;
}

function responseHeaders(headers: Headers): Record<string, string> { const output: Record<string, string> = {}; for (const key of ['content-type', 'etag', 'x-request-id']) { const value = headers.get(key); if (value) output[key] = value; } return output; }
function sign(value: string, key: string): string { return crypto.createHmac('sha256', key).update(value).digest('base64url'); }
function verify(token: string, key: string): CapabilityGrant {
  const [encoded, supplied] = token.split('.'); if (!encoded || !supplied) throw new Error('invalid capability grant');
  const expected = Buffer.from(sign(encoded, key)); const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('invalid capability grant');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CapabilityGrant;
  if (payload.version !== 1 || !payload.nonce) throw new Error('invalid capability grant'); return payload;
}

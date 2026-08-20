// CloudflareDnsService — manages proxied CNAME records for tenant
// subdomains so each tenant's `{slug}-itops.example.com` resolves
// through the shared Cloudflare Tunnel.
//
// Why this is a separate service:
//   • Registration must not fail when DNS provisioning is misconfigured
//     or Cloudflare is degraded — we log and continue (tenant rows
//     exist with status=active either way; an operator can repair).
//   • The wildcard `*.example.com` is in use by another service, so
//     each new tenant needs its own explicit record.
//
// Env vars (read once at construction):
//   CLOUDFLARE_API_TOKEN  — token with DNS:Edit on the zone
//   CLOUDFLARE_ZONE_ID    — zone id for example.com
//   CLOUDFLARE_TUNNEL_CNAME — `<tunnel-id>.cfargotunnel.com` target
//   CLOUDFLARE_DNS_SUBDOMAIN_SUFFIX — default `-itops`; the slug is
//     prefixed (e.g. `acme` → `acme-itops.example.com`)
//   CLOUDFLARE_DNS_ZONE_NAME — default `example.com`

import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'cloudflare-dns' });

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareDnsConfig {
  apiToken: string;
  zoneId: string;
  tunnelCname: string;
  zoneName: string;
  subdomainSuffix: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface CreateRecordResult {
  ok: boolean;
  recordId?: string;
  hostname: string;
  /** Set when `ok` is false. */
  error?: string;
  /** True when an equivalent record already existed — we treat this
   *  as success (idempotent). */
  alreadyExisted?: boolean;
}

export interface DeleteRecordResult {
  ok: boolean;
  hostname: string;
  error?: string;
  /** True when no matching record existed — treated as success. */
  notFound?: boolean;
}

interface CloudflareApiEnvelope<T> {
  result: T;
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
}

interface CloudflareDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

export class CloudflareDnsService {
  private readonly cfg: CloudflareDnsConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: CloudflareDnsConfig) {
    this.cfg = cfg;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Build the hostname for a given tenant slug. Exposed so callers
   *  (audit logs, error messages) can refer to the same value the
   *  service would create. */
  hostnameFor(slug: string): string {
    return `${slug}${this.cfg.subdomainSuffix}.${this.cfg.zoneName}`;
  }

  /** Create a proxied CNAME for the given slug. Returns ok=true on
   *  success or when the record already exists with the right target.
   *  Never throws — callers can log+continue. */
  async createRecord(slug: string, opts?: { comment?: string }): Promise<CreateRecordResult> {
    const hostname = this.hostnameFor(slug);
    const body = {
      type: 'CNAME',
      name: hostname,
      content: this.cfg.tunnelCname,
      proxied: true,
      ttl: 1,
      comment: opts?.comment ?? `itops tenant: ${slug}`,
    };
    try {
      const res = await this.fetchImpl(`${CF_API_BASE}/zones/${this.cfg.zoneId}/dns_records`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
      const data = await safeJson<CloudflareApiEnvelope<CloudflareDnsRecord>>(res);
      if (data?.success && data.result?.id) {
        log.info('Created CNAME', { hostname, recordId: data.result.id });
        return { ok: true, hostname, recordId: data.result.id };
      }
      // 81053 = "A, AAAA, or CNAME record with that host already exists".
      // Treat as success if the existing record already points at our
      // tunnel; otherwise surface the conflict.
      const dup = data?.errors?.find(e => e.code === 81053);
      if (dup) {
        const existing = await this.findRecord(hostname);
        if (existing && existing.content === this.cfg.tunnelCname) {
          log.info('CNAME already exists with correct target', { hostname, recordId: existing.id });
          return { ok: true, hostname, recordId: existing.id, alreadyExisted: true };
        }
        const msg = existing
          ? `Record exists but points at ${existing.content}, not ${this.cfg.tunnelCname}`
          : dup.message;
        log.warn('CNAME create conflict', { hostname, msg });
        return { ok: false, hostname, error: msg };
      }
      const errMsg = data?.errors?.map(e => `${e.code}:${e.message}`).join('; ') ?? `HTTP ${res.status}`;
      log.warn('CNAME create failed', { hostname, error: errMsg });
      return { ok: false, hostname, error: errMsg };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      log.warn('CNAME create threw', { hostname, error });
      return { ok: false, hostname, error };
    }
  }

  /** Delete the CNAME for the given slug. Returns ok=true when the
   *  record was deleted or didn't exist. Never throws. */
  async deleteRecord(slug: string): Promise<DeleteRecordResult> {
    const hostname = this.hostnameFor(slug);
    try {
      const existing = await this.findRecord(hostname);
      if (!existing) {
        log.info('CNAME delete: nothing to do', { hostname });
        return { ok: true, hostname, notFound: true };
      }
      const res = await this.fetchImpl(
        `${CF_API_BASE}/zones/${this.cfg.zoneId}/dns_records/${existing.id}`,
        { method: 'DELETE', headers: this.headers() },
      );
      const data = await safeJson<CloudflareApiEnvelope<{ id: string }>>(res);
      if (data?.success) {
        log.info('Deleted CNAME', { hostname, recordId: existing.id });
        return { ok: true, hostname };
      }
      const errMsg = data?.errors?.map(e => `${e.code}:${e.message}`).join('; ') ?? `HTTP ${res.status}`;
      log.warn('CNAME delete failed', { hostname, error: errMsg });
      return { ok: false, hostname, error: errMsg };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      log.warn('CNAME delete threw', { hostname, error });
      return { ok: false, hostname, error };
    }
  }

  /** Look up a record by hostname. Returns undefined when not found
   *  or on API error. */
  async findRecord(hostname: string): Promise<CloudflareDnsRecord | undefined> {
    const url = `${CF_API_BASE}/zones/${this.cfg.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`;
    try {
      const res = await this.fetchImpl(url, { headers: this.headers() });
      const data = await safeJson<CloudflareApiEnvelope<CloudflareDnsRecord[]>>(res);
      if (data?.success && Array.isArray(data.result) && data.result.length > 0) {
        return data.result[0];
      }
    } catch {
      // fall through to undefined
    }
    return undefined;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.cfg.apiToken}`,
      'Content-Type': 'application/json',
    };
  }
}

async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

/** Read config from env. Returns undefined when either required var
 *  is missing — callers should treat this as "DNS provisioning
 *  disabled" and skip silently. */
export function cloudflareDnsConfigFromEnv(): CloudflareDnsConfig | undefined {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
  if (!apiToken || !zoneId) return undefined;
  const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID?.trim();
  const tunnelCname = (process.env.CLOUDFLARE_TUNNEL_CNAME?.trim())
    || (tunnelId ? `${tunnelId}.cfargotunnel.com` : '');
  if (!tunnelCname) return undefined;
  return {
    apiToken,
    zoneId,
    tunnelCname,
    zoneName: process.env.CLOUDFLARE_DNS_ZONE_NAME?.trim() || 'example.com',
    subdomainSuffix: process.env.CLOUDFLARE_DNS_SUBDOMAIN_SUFFIX ?? '-itops',
  };
}

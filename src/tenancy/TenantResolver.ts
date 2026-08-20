// TenantResolver — turns an inbound request's hostname + JWT claims +
// X-Tenant-ID header into a single decision: which tenant is this
// request acting on?
//
// Priority order (highest first):
//   1. Custom domain    — full hostname matches tenants.custom_domain.
//   2. Subdomain        — hostname is <slug>-<apex-label>.<root-domain>,
//                         where <apex-label>.<root-domain> equals
//                         TENANT_BASE_DOMAIN (e.g. itops.example.com).
//   3. JWT tid claim    — the authenticated principal's tenant.
//   4. X-Tenant-ID      — superadmin / admin override.
//   5. SYSTEM fallback  — pre-multitenant single-tenant default.
//
// Why the flat <slug>-itops.example.com pattern (vs. nested
// <slug>.itops.example.com): Cloudflare's free Universal SSL covers
// only a single wildcard level (*.example.com). The nested form
// would need the $10/mo Advanced Certificate. Flattening keeps every
// tenant inside the single free wildcard.
//
// Cross-check rule: if BOTH a subdomain (or custom domain) AND a JWT
// tenant are present, they MUST match. A mismatch is a privilege-
// boundary violation — the resolver returns `mismatch=true` and the
// middleware turns that into 403. The exception is superadmin, who
// can drive any subdomain.
//
// Reserved slug list: tenant slugs matching one of the reserved names
// (e.g. www, api, app, admin) are rejected so we don't shadow infra
// hostnames like www-itops.example.com. The Beacon apex itself —
// itops.example.com — has no slug prefix, so it naturally falls
// through to the JWT/system path.

import type { TenantStore, TenantRecord } from './TenantStore.js';
import { SYSTEM_TENANT_ID } from './TenantContext.js';

export interface TenantResolutionInput {
  /** Full hostname from the Host header — already lowercased + port-stripped. */
  hostname: string;
  /** Tenant carried in the JWT `tid` claim, if any. */
  jwtTenantId?: string;
  /** Role of the authenticated principal, if any. Superadmin bypasses
   *  the cross-check rule. */
  jwtRole?: string;
  /** X-Tenant-ID header value, if present. */
  headerTenantId?: string;
}

export interface TenantResolutionConfig {
  /** Beacon's apex hostname. The first label is the "apex label"; the
   *  rest is the root domain. Tenant subdomains are
   *  `<slug>-<apexLabel>.<rootDomain>`. When unset, the subdomain path
   *  is disabled and the resolver falls through to JWT.
   *  Example: 'itops.example.com' — then 'acme-itops.example.com'
   *  resolves to tenant slug 'acme'. */
  baseDomain?: string;
  /** Slug values that are NEVER treated as tenant slugs. Default list
   *  covers infra/marketing labels we don't want shadowed (e.g.
   *  www-itops.example.com). */
  reservedSubdomains?: string[];
}

export interface TenantResolution {
  /** Final tenant. Always non-null — falls back to system on every
   *  unauthenticated / no-context path. */
  tenant: TenantRecord;
  /** Which signal won. */
  source: 'custom_domain' | 'subdomain' | 'jwt' | 'header' | 'system';
  /** True when subdomain/custom_domain and JWT tenant disagree AND the
   *  JWT principal isn't a superadmin. The middleware converts this to
   *  HTTP 403. */
  mismatch: boolean;
  mismatchReason?: string;
}

const DEFAULT_RESERVED: string[] = [
  'www', 'api', 'app', 'admin', 'static', 'cdn', 'mail', 'docs',
];

export class TenantResolver {
  private baseDomain: string | undefined;
  /** First label of baseDomain — e.g. 'itops' for 'itops.example.com'. */
  private apexLabel: string | undefined;
  /** Everything after the apex label — e.g. 'example.com'. */
  private rootDomain: string | undefined;
  private reservedSubdomains: Set<string>;

  constructor(
    private readonly tenants: TenantStore,
    cfg: TenantResolutionConfig = {},
  ) {
    this.baseDomain = cfg.baseDomain?.toLowerCase().replace(/\.$/, '') || undefined;
    if (this.baseDomain) {
      const dot = this.baseDomain.indexOf('.');
      if (dot > 0) {
        this.apexLabel = this.baseDomain.slice(0, dot);
        this.rootDomain = this.baseDomain.slice(dot + 1);
      }
    }
    this.reservedSubdomains = new Set((cfg.reservedSubdomains ?? DEFAULT_RESERVED).map(s => s.toLowerCase()));
  }

  /** Resolve the tenant for one request. Pure function: no side effects,
   *  no I/O beyond TenantStore reads. */
  async resolve(input: TenantResolutionInput): Promise<TenantResolution> {
    const hostname = (input.hostname || '').toLowerCase().replace(/\.$/, '').split(':')[0];

    // 1. Custom domain — exact match against tenants.custom_domain.
    if (hostname) {
      const t = await Promise.resolve(this.tenants.getByCustomDomain(hostname));
      if (t) return this.checkAgainstJwt(t, 'custom_domain', input);
    }

    // 2. Subdomain — only attempted when a base domain is configured
    //    and the hostname is a strict subdomain of it.
    const slug = this.extractSubdomainSlug(hostname);
    if (slug) {
      const t = await Promise.resolve(this.tenants.getBySlug(slug));
      if (t) return this.checkAgainstJwt(t, 'subdomain', input);
      // Subdomain present but doesn't match any tenant — treat as a
      // typo rather than allowing it to silently fall through. The
      // middleware returns 404 on this. The system fallback still
      // applies only when no host-based signal was attempted.
      return {
        tenant: (await Promise.resolve(this.tenants.ensureSystem())),
        source: 'system',
        mismatch: true,
        mismatchReason: `No tenant with slug "${slug}"`,
      };
    }

    // 3. JWT claim. Most common path for the legacy single-tenant
    //    deployments where everything resolves to SYSTEM_TENANT_ID
    //    via the JWT.
    if (input.jwtTenantId) {
      const t = await Promise.resolve(this.tenants.get(input.jwtTenantId));
      if (t) return { tenant: t, source: 'jwt', mismatch: false };
    }

    // 4. X-Tenant-ID header — only honoured for admin or superadmin.
    if (input.headerTenantId && (input.jwtRole === 'superadmin' || input.jwtRole === 'admin')) {
      const t = await Promise.resolve(this.tenants.get(input.headerTenantId));
      if (t) return { tenant: t, source: 'header', mismatch: false };
    }

    // 5. System fallback.
    const sys = await Promise.resolve(this.tenants.ensureSystem());
    return { tenant: sys, source: 'system', mismatch: false };
  }

  /** Exposed for tests + diagnostics. Returns the slug a hostname
   *  would resolve to, or null when no extraction is possible.
   *  Pattern: `<slug>-<apexLabel>.<rootDomain>` (e.g.
   *  `acme-itops.example.com` → 'acme'). */
  extractSubdomainSlug(hostname: string): string | null {
    if (!this.baseDomain || !this.apexLabel || !this.rootDomain) return null;
    if (!hostname || hostname === this.baseDomain) return null;
    if (!hostname.endsWith('.' + this.rootDomain)) return null;
    const prefix = hostname.slice(0, hostname.length - this.rootDomain.length - 1);
    // Single leftmost label only. Nested subdomains (a.b.example.com)
    // aren't covered by the single-level Universal SSL wildcard, so we
    // reject them to avoid silent TLS failures.
    if (prefix.includes('.')) return null;
    // Must follow the flat tenant pattern: `<slug>-<apexLabel>`.
    const suffix = '-' + this.apexLabel;
    if (!prefix.endsWith(suffix)) return null;
    const slug = prefix.slice(0, prefix.length - suffix.length).toLowerCase();
    if (!slug) return null;
    if (this.reservedSubdomains.has(slug)) return null;
    // Slug must be URL-safe — alphanumerics + hyphens.
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
    return slug;
  }

  private checkAgainstJwt(tenant: TenantRecord, source: 'custom_domain' | 'subdomain', input: TenantResolutionInput): TenantResolution {
    if (!input.jwtTenantId) {
      // Host-derived tenant is fine when there's no JWT — the user is
      // probably on the login page for this tenant.
      return { tenant, source, mismatch: false };
    }
    if (input.jwtTenantId === tenant.id) {
      return { tenant, source, mismatch: false };
    }
    // Superadmin bypass — they intentionally operate across tenants.
    if (input.jwtRole === 'superadmin') {
      return { tenant, source, mismatch: false };
    }
    return {
      tenant,
      source,
      mismatch: true,
      mismatchReason: `JWT principal belongs to tenant "${input.jwtTenantId}" but request was made on tenant "${tenant.id}" (${source}="${tenant.slug}")`,
    };
  }
}

export function isSystemTenant(t: TenantRecord): boolean {
  return t.id === SYSTEM_TENANT_ID;
}

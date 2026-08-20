// Express middleware that opens a tenant scope for the duration of a
// request. Delegates the actual resolution to TenantResolver — see
// TenantResolver.ts for the priority order (custom_domain >
// subdomain > JWT > X-Tenant-ID > system).
//
// Behaviour:
//   • Suspended tenants → HTTP 423.
//   • JWT/host mismatch (non-superadmin) → HTTP 403.
//   • Unknown subdomain → HTTP 404 with a helpful message so a typo
//     doesn't silently leak into the system tenant.
//   • Everything else: runWithTenant() wraps next() so every async
//     hop in the handler observes getCurrentTenantId() = the resolved
//     tenant.
//
// Subdomain detection requires TENANT_BASE_DOMAIN. When that env var
// is unset (the legacy default), the resolver skips the subdomain
// path entirely and behaves exactly like the old JWT-only middleware.

import type { Request, Response, NextFunction } from 'express';
import type { TenantStore } from './TenantStore.js';
import { TenantResolver, type TenantResolutionConfig } from './TenantResolver.js';
import { runWithTenant, SYSTEM_TENANT_ID, type TenantContext } from './TenantContext.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

export function createTenantMiddleware(tenants: TenantStore, cfg: TenantResolutionConfig = {}) {
  const resolver = new TenantResolver(tenants, cfg);
  return async function tenantMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const subject = req.auth as { tenantId?: string; apiKeyTenantId?: string; role?: string } | undefined;
    const jwtTenantId = subject?.tenantId ?? subject?.apiKeyTenantId;
    const hostname = (req.hostname || req.header('host') || '').toLowerCase();

    const resolution = await resolver.resolve({
      hostname,
      jwtTenantId: jwtTenantId && jwtTenantId !== SYSTEM_TENANT_ID ? jwtTenantId : undefined,
      jwtRole: subject?.role,
      headerTenantId: (req.header('x-tenant-id') || '').trim() || undefined,
    });

    if (resolution.tenant.status === 'suspended') {
      res.status(423).json({ error: `Tenant "${resolution.tenant.id}" is suspended` });
      return;
    }

    if (resolution.mismatch) {
      // Two flavours: subdomain references unknown tenant (404 — typo)
      // vs subdomain references a tenant the principal doesn't belong
      // to (403 — privilege boundary). Distinguish via the reason text
      // that TenantResolver populates.
      if (resolution.source === 'system' && resolution.mismatchReason?.includes('No tenant with slug')) {
        res.status(404).json({ error: resolution.mismatchReason });
        return;
      }
      res.status(403).json({ error: resolution.mismatchReason ?? 'Tenant mismatch' });
      return;
    }

    const ctx: TenantContext = {
      tenantId: resolution.tenant.id,
      tenantName: resolution.tenant.name,
      actingAsTenantId: resolution.tenant.id,
    };
    req.tenant = ctx;
    runWithTenant(ctx, () => { next(); });
  };
}

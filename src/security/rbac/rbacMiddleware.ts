// Express middleware that enforces an RbacPermission on a route.
//
// Use:   app.get('/api/foo', requirePermission('agents.read'), handler);
// Stack: requireAuth → tenantMiddleware → requirePermission(...).
//
// Resolution strategy:
//   - Read req.auth (populated by the existing authMiddleware) for the
//     userId. JWT users use `username`; API key users use
//     `apikey:<keyId>` so the two namespaces don't collide.
//   - Read tenantId from getCurrentTenantId() (populated by
//     tenantMiddleware).
//   - Ask RbacService.resolve(userId, tenantId).
//   - Reject with 403 + an audit-friendly reason when the permission
//     is missing.
//
// We also expose checkPermission(req, perm) for handlers that need a
// programmatic check (e.g. branching: if user has X, expose Y too).

import type { Request, Response, NextFunction } from 'express';
import { getCurrentTenantId } from '../../tenancy/index.js';
import { hasPermission, type RbacPermission } from './RbacTypes.js';
import type { RbacService } from './RbacService.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Populated by requirePermission() / checkPermission() so handlers
       *  can read what the request resolved to without a second DB hop. */
      rbac?: {
        userId: string;
        effectiveRole: string;
        permissions: string[];
        fromFallback: boolean;
      };
    }
  }
}

export function createRbacMiddleware(rbac: RbacService) {
  function userIdFromReq(req: Request): string {
    const auth = req.auth;
    if (!auth) return 'anonymous';
    if (auth.source === 'apikey' && auth.apiKeyId) return `apikey:${auth.apiKeyId}`;
    return auth.username;
  }

  /** Build a route guard requiring `permission`. */
  function requirePermission(permission: RbacPermission) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (!req.auth) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const userId = userIdFromReq(req);
        const tenantId = getCurrentTenantId();
        const resolved = await rbac.resolve(userId, tenantId);
        req.rbac = {
          userId,
          effectiveRole: resolved.effectiveRole,
          permissions: Array.from(resolved.permissions),
          fromFallback: resolved.fromFallback,
        };
        if (!hasPermission(resolved.permissions, permission)) {
          res.status(403).json({
            error: `Missing RBAC permission: ${permission}`,
            tenant: tenantId,
            effectiveRole: resolved.effectiveRole,
            fromFallback: resolved.fromFallback,
          });
          return;
        }
        next();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `RBAC resolution failed: ${msg}` });
      }
    };
  }

  /** Programmatic check — returns the resolved set without throwing. */
  async function checkPermission(req: Request, permission: RbacPermission): Promise<boolean> {
    if (!req.auth) return false;
    const userId = userIdFromReq(req);
    const tenantId = getCurrentTenantId();
    const resolved = await rbac.resolve(userId, tenantId);
    return hasPermission(resolved.permissions, permission);
  }

  return { requirePermission, checkPermission };
}

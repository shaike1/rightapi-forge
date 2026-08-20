import type { Request, Response, NextFunction } from 'express';
import type { AuthService, Permission, UserRole } from './AuthService.js';
import type { ApiKeyService } from './ApiKeyService.js';
import type { AuditLog } from './AuditLog.js';

// Extend Express Request to include auth info
declare global {
  namespace Express {
    interface Request {
      auth?: {
        username: string;
        role: UserRole;
        source: 'jwt' | 'apikey';
        apiKeyId?: string;
        /** Tenant the principal belongs to. For JWT this comes from the
         *  validated user record (or the 'tid' claim as fallback); for
         *  API keys it comes from the key's tenant binding. Either way
         *  the tenant middleware reads `tenantId` first, falling back to
         *  apiKeyTenantId for backwards compatibility with the older
         *  path. */
        tenantId?: string;
        /** Tenant the API key was bound to. Read by the tenant
         *  middleware when scoping the request. Undefined for JWT auth
         *  (which falls back to the system tenant unless an admin
         *  overrides via X-Tenant-ID). */
        apiKeyTenantId?: string;
      };
    }
  }
}

export function createAuthMiddleware(
  authService: AuthService,
  apiKeyService: ApiKeyService,
  auditLog: AuditLog
) {
  /**
   * requireAuth — validates JWT or API key, attaches req.auth
   */
  function requireAuth(permission?: Permission) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const authHeader = req.header('authorization') || '';
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      let username = 'anonymous';
      let role: UserRole = 'viewer';
      let source: 'jwt' | 'apikey' = 'jwt';
      let apiKeyId: string | undefined;

      // Try API key first (X-API-Key header or itops_ bearer token)
      const apiKeyHeader = req.header('x-api-key');
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const rawApiKey = apiKeyHeader || (bearerToken?.startsWith('itops_') ? bearerToken : undefined);

      if (rawApiKey) {
        const result = apiKeyService.validate(rawApiKey);
        if (!result.valid || !result.apiKey) {
          auditLog.log({ action: 'auth.apikey.fail', username: 'unknown', role: 'viewer', resource: req.path, method: req.method, ip, success: false, detail: result.reason });
          res.status(401).json({ error: result.reason || 'Invalid API key' });
          return;
        }
        username = result.apiKey.createdBy;
        role = result.apiKey.role;
        source = 'apikey';
        apiKeyId = result.apiKey.id;

        // Check scoped permissions
        if (permission && result.apiKey.scopes.length > 0 && !result.apiKey.scopes.includes(permission)) {
          auditLog.log({ action: 'auth.apikey.denied', username, role, resource: req.path, method: req.method, ip, success: false, detail: `Missing scope: ${permission}` });
          res.status(403).json({ error: `API key missing scope: ${permission}` });
          return;
        }
      } else if (bearerToken) {
        // Try JWT
        const validation = authService.validateToken(bearerToken);
        if (!validation.valid) {
          auditLog.log({ action: 'auth.jwt.fail', username: 'unknown', role: 'viewer', resource: req.path, method: req.method, ip, success: false, detail: validation.reason });
          res.status(401).json({ error: validation.reason || 'Unauthorized' });
          return;
        }
        username = validation.username!;
        role = validation.role as UserRole;
        source = 'jwt';
        // tenantId is captured into req.auth below — done once so both
        // JWT and API-key paths emit the same shape.
        (req as any)._jwtTenantId = validation.tenantId;
      } else {
        auditLog.log({ action: 'auth.missing', username: 'anonymous', role: 'viewer', resource: req.path, method: req.method, ip, success: false });
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      // Check role-level permission
      if (permission && !authService.hasPermission(role, permission)) {
        auditLog.log({ action: 'auth.permission.denied', username, role, resource: req.path, method: req.method, ip, success: false, detail: `Missing: ${permission}` });
        res.status(403).json({ error: `Missing permission: ${permission}` });
        return;
      }

      const apiKeyTenantId = source === 'apikey'
        ? (apiKeyService.validate(rawApiKey!).apiKey?.tenantId ?? 'system')
        : undefined;
      const jwtTenantId = (req as any)._jwtTenantId as string | undefined;
      req.auth = {
        username, role, source, apiKeyId,
        // tenantId is the authoritative scope for this request. JWT path
        // takes it from the validated user record; API-key path from
        // the key's tenant binding. Falls back to 'system' so any
        // legacy code path still resolves to the default tenant.
        tenantId: jwtTenantId ?? apiKeyTenantId ?? 'system',
        apiKeyTenantId: apiKeyTenantId ?? 'system',
      };
      auditLog.log({ action: 'auth.ok', username, role, resource: req.path, method: req.method, ip, success: true });
      next();
    };
  }

  /**
   * requireRole — shorthand for role-based access
   */
  function requireRole(...roles: UserRole[]) {
    return (req: Request, res: Response, next: NextFunction): void => {
      requireAuth()(req, res, () => {
        if (!req.auth || !roles.includes(req.auth.role)) {
          res.status(403).json({ error: `Required role: ${roles.join(' or ')}` });
          return;
        }
        next();
      });
    };
  }

  return { requireAuth, requireRole };
}

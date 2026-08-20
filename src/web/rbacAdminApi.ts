// /api/rbac/{permissions,roles,assignments,whoami} — RBAC administration.
// Extracted from server.ts.
//
// Routes (mount at /api/rbac, layered AFTER the users+api-keys router
// already mounted there from ./rbacApi.ts; Express falls through the
// first router for paths it doesn't match):
//   GET    /permissions          settings.manage
//   GET    /roles                settings.manage
//   POST   /roles                settings.manage
//   DELETE /roles/:id            settings.manage
//   GET    /assignments          settings.manage
//   POST   /assignments          settings.manage
//   DELETE /assignments          settings.manage
//   GET    /whoami               (any authenticated)
//
// File name avoids collision with ./rbacApi.ts which is the
// users+api-keys CRUD surface mounted at the same prefix.

import { Router, type Request, type Response, type RequestHandler } from 'express';

interface RbacServiceLike {
  listRoles: () => Promise<any[]>;
  upsertCustomRole: (role: {
    id: string;
    name: string;
    description?: string;
    inheritsFrom: 'super_admin' | 'tenant_admin' | 'operator' | 'viewer';
    extraPermissions: string[];
  }) => Promise<any>;
  deleteCustomRole: (id: string) => Promise<boolean>;
  listAssignments: (filter: { userId?: string; tenantId?: string }) => Promise<any[]>;
  assign: (userId: string, tenantId: string, roleId: string) => Promise<any>;
  unassign: (userId: string, tenantId: string, roleId: string) => Promise<boolean>;
  resolve: (userId: string, tenantId: string) => Promise<{ effectiveRole: string; permissions: Set<string>; fromFallback: boolean }>;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface RbacAdminApiDeps {
  rbacService: RbacServiceLike;
  requirePermission: (perm: string) => RequestHandler;
  validateAuth: AuthCheck;
}

export function createRbacAdminRouter(deps: RbacAdminApiDeps): Router {
  const router = Router();
  const { rbacService, requirePermission, validateAuth } = deps;

  router.get('/permissions', requirePermission('settings.manage'), async (_req: Request, res: Response) => {
    const { PERMISSIONS, ROLES } = await import('../security/rbac/RbacTypes.js');
    res.json({ permissions: PERMISSIONS, roles: ROLES });
  });

  router.get('/roles', requirePermission('settings.manage'), async (_req: Request, res: Response) => {
    const roles = await rbacService.listRoles();
    res.json({ roles });
  });

  router.post('/roles', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    try {
      const { id, name, description, inheritsFrom, extraPermissions } = req.body || {};
      if (typeof id !== 'string' || typeof name !== 'string' || typeof inheritsFrom !== 'string') {
        res.status(400).json({ error: 'id, name, inheritsFrom required' });
        return;
      }
      const role = await rbacService.upsertCustomRole({
        id, name, description,
        inheritsFrom: inheritsFrom as 'super_admin' | 'tenant_admin' | 'operator' | 'viewer',
        extraPermissions: Array.isArray(extraPermissions) ? extraPermissions : [],
      });
      res.json({ success: true, role });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete('/roles/:id', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    const ok = await rbacService.deleteCustomRole(req.params.id);
    if (!ok) { res.status(409).json({ error: 'role not found or built-in' }); return; }
    res.json({ success: true });
  });

  router.get('/assignments', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    const assignments = await rbacService.listAssignments({
      userId: req.query.userId as string | undefined,
      tenantId: req.query.tenantId as string | undefined,
    });
    res.json({ assignments });
  });

  router.post('/assignments', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    try {
      const { userId, tenantId, roleId } = req.body || {};
      if (!userId || !tenantId || !roleId) {
        res.status(400).json({ error: 'userId, tenantId, roleId required' });
        return;
      }
      const assignment = await rbacService.assign(userId, tenantId, roleId);
      res.json({ success: true, assignment });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.delete('/assignments', requirePermission('settings.manage'), async (req: Request, res: Response) => {
    const userId = req.query.userId as string | undefined;
    const tenantId = req.query.tenantId as string | undefined;
    const roleId = req.query.roleId as string | undefined;
    if (!userId || !tenantId || !roleId) {
      res.status(400).json({ error: 'userId, tenantId, roleId query params required' });
      return;
    }
    const ok = await rbacService.unassign(userId, tenantId, roleId);
    res.json({ success: ok });
  });

  /** Resolve the current caller's effective permissions — useful for the
   *  dashboard to decide which buttons to render. Always returns the
   *  caller's resolution; a caller cannot ask about other users here. */
  router.get('/whoami', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined);
    if (!auth.ok) { res.status(401).json({ error: auth.reason || 'Unauthorized' }); return; }
    const userId = auth.username!;
    const tenantId = (req as any).tenant?.tenantId ?? 'system';
    const resolved = await rbacService.resolve(userId, tenantId);
    res.json({
      userId, tenantId,
      effectiveRole: resolved.effectiveRole,
      permissions: Array.from(resolved.permissions),
      fromFallback: resolved.fromFallback,
    });
  });

  return router;
}

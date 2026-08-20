import { Router, Request, Response } from 'express';
import type { AuthService, UserRole, Permission } from '../security/AuthService.js';
import type { ApiKeyService } from '../security/ApiKeyService.js';
import type { AuditLog } from '../security/AuditLog.js';

export function createRbacRouter(authService: AuthService, apiKeyService: ApiKeyService, auditLog: AuditLog): Router {
  const router = Router();

  // ── Users ──────────────────────────────────────
  router.get('/users', (_req: Request, res: Response) => {
    res.json(authService.listUsers());
  });

  router.post('/users', (req: Request, res: Response) => {
    const { username, password, role, active } = req.body;
    if (!username || !password || !role) {
      res.status(400).json({ error: 'username, password, and role are required' });
      return;
    }
    if (!['admin', 'operator', 'viewer'].includes(role)) {
      res.status(400).json({ error: 'Invalid role. Must be admin, operator, or viewer' });
      return;
    }
    const user = authService.createOrUpdateUser({ username, password, role, active });
    auditLog.log({ action: 'user.create', username: req.auth?.username || 'system', role: req.auth?.role || 'admin', resource: `/users/${username}`, method: 'POST', ip: req.ip || 'unknown', success: true });
    res.json(user);
  });

  router.put('/users/:username', (req: Request, res: Response) => {
    const { password, role, active } = req.body;
    const user = authService.updateUser(req.params.username, { password, role, active });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    auditLog.log({ action: 'user.update', username: req.auth?.username || 'system', role: req.auth?.role || 'admin', resource: `/users/${req.params.username}`, method: 'PUT', ip: req.ip || 'unknown', success: true });
    res.json(user);
  });

  router.delete('/users/:username', (req: Request, res: Response) => {
    // Prevent self-delete
    if (req.auth?.username === req.params.username) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }
    const deleted = authService.deleteUser(req.params.username);
    if (!deleted) { res.status(404).json({ error: 'User not found' }); return; }
    auditLog.log({ action: 'user.delete', username: req.auth?.username || 'system', role: req.auth?.role || 'admin', resource: `/users/${req.params.username}`, method: 'DELETE', ip: req.ip || 'unknown', success: true });
    res.json({ success: true });
  });

  // ── API Keys ──────────────────────────────────
  router.get('/api-keys', (_req: Request, res: Response) => {
    res.json(apiKeyService.list());
  });

  router.post('/api-keys', (req: Request, res: Response) => {
    const { name, role, scopes, expiresInDays } = req.body;
    if (!name || !role) {
      res.status(400).json({ error: 'name and role are required' });
      return;
    }
    const result = apiKeyService.create({
      name,
      role,
      scopes,
      createdBy: req.auth?.username || 'system',
      expiresInDays
    });
    auditLog.log({ action: 'apikey.create', username: req.auth?.username || 'system', role: req.auth?.role || 'admin', resource: `/api-keys/${result.id}`, method: 'POST', ip: req.ip || 'unknown', success: true, detail: `name=${name}` });
    res.json(result);
  });

  router.post('/api-keys/:id/revoke', (req: Request, res: Response) => {
    const success = apiKeyService.revoke(req.params.id);
    if (!success) { res.status(404).json({ error: 'API key not found' }); return; }
    auditLog.log({ action: 'apikey.revoke', username: req.auth?.username || 'system', role: req.auth?.role || 'admin', resource: `/api-keys/${req.params.id}`, method: 'POST', ip: req.ip || 'unknown', success: true });
    res.json({ success: true });
  });

  router.delete('/api-keys/:id', (req: Request, res: Response) => {
    const deleted = apiKeyService.delete(req.params.id);
    if (!deleted) { res.status(404).json({ error: 'API key not found' }); return; }
    auditLog.log({ action: 'apikey.delete', username: req.auth?.username || 'system', role: req.auth?.role || 'admin', resource: `/api-keys/${req.params.id}`, method: 'DELETE', ip: req.ip || 'unknown', success: true });
    res.json({ success: true });
  });

  // ── Audit Log ─────────────────────────────────
  router.get('/audit', (req: Request, res: Response) => {
    const { username, action, resource, success, since, limit } = req.query;
    const entries = auditLog.query({
      username: username as string,
      action: action as string,
      resource: resource as string,
      success: success === 'true' ? true : success === 'false' ? false : undefined,
      since: since as string,
      limit: limit ? parseInt(limit as string, 10) : undefined
    });
    res.json(entries);
  });

  router.get('/audit/stats', (_req: Request, res: Response) => {
    res.json(auditLog.getStats());
  });

  // ── Permissions info ──────────────────────────
  router.get('/permissions', (_req: Request, res: Response) => {
    const roles: UserRole[] = ['admin', 'operator', 'viewer'];
    const allPerms: Permission[] = [
      'config.write', 'credentials.read', 'credentials.write',
      'approvals.read', 'approvals.manage', 'audit.read',
      'tools.execute.safe', 'tools.execute.privileged',
      'agent_bus.read', 'agent_bus.write',
      'users.read', 'users.manage',
      'security.read', 'security.write',
      'delegations.read', 'delegations.write'
    ];
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of roles) {
      matrix[role] = {};
      for (const perm of allPerms) {
        matrix[role][perm] = authService.hasPermission(role, perm);
      }
    }
    res.json({ roles, permissions: allPerms, matrix });
  });

  // ── Current user info ─────────────────────────
  router.get('/me', (req: Request, res: Response) => {
    res.json({
      username: req.auth?.username,
      role: req.auth?.role,
      source: req.auth?.source
    });
  });

  return router;
}

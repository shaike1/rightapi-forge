// Auth users + roles CRUD — extracted from server.ts.
//
// Routes (mount at /api/auth):
//   GET    /me                              (any authenticated)
//   GET    /users                           (users.read)
//   POST   /users                           (users.manage)
//   PATCH  /users/:username                 (users.manage)
//   DELETE /users/:username                 (users.manage)
//   GET    /roles                           (users.manage)
//   POST   /roles                           (users.manage)
//   PUT    /roles/:id                       (users.manage)
//   DELETE /roles/:id                       (users.manage)
//   PUT    /users/:username/role            (users.manage)
//
// The login / logout / Azure-AD / settings/* routes intentionally remain
// in server.ts for now — they have LDAP fallback + AD redirect logic that's
// higher-leverage to break on extraction. Extract them in a follow-up.
//
// Dependencies are passed in rather than imported so this module doesn't
// reach back into server.ts's internals.

import { Router, type Request, type Response } from 'express';
import type Database from 'better-sqlite3';
import type { AuthService, UserRole } from '../security/AuthService.js';
import type { AuditLog } from '../security/AuditLog.js';

export interface AuthUsersApiDeps {
  authService: AuthService;
  /** Better-sqlite3 instance owning the `roles` and `user_roles` tables.
   *  Owned by server.ts; passed here so we don't duplicate the connection. */
  rolesDb: Database.Database;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string; role?: UserRole };
  /** Optional — when present, mutating routes emit audit entries so the
   *  /api/audit feed shows who-changed-what. Marked optional so existing
   *  call sites (and tests) without an AuditLog still compile. */
  auditLog?: AuditLog;
}

interface RoleRow {
  id: number;
  name: string;
  permissions: string;
  created_at: string;
}

export function createAuthUsersRouter(deps: AuthUsersApiDeps): Router {
  const router = Router();

  function requireAdmin(req: Request, res: Response): { ok: boolean; username?: string; role?: UserRole } {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'users.manage');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return { ok: false };
    }
    return { ok: true, username: auth.username, role: auth.role };
  }

  function audit(req: Request, actor: { username?: string; role?: UserRole } | null, action: string, success: boolean, detail?: string): void {
    if (!deps.auditLog) return;
    deps.auditLog.log({
      action,
      username: actor?.username || 'anonymous',
      role: (actor?.role as string) || 'unknown',
      resource: req.path,
      method: req.method,
      ip: req.ip || '',
      success,
      ...(detail ? { detail } : {}),
    });
  }

  function roleWithCount(row: RoleRow) {
    const count = (
      deps.rolesDb.prepare('SELECT COUNT(*) as n FROM user_roles WHERE role_id = ?').get(row.id) as { n: number }
    ).n;
    return {
      id: row.id,
      name: row.name,
      permissions: JSON.parse(row.permissions) as string[],
      usersCount: count,
      createdAt: row.created_at,
    };
  }

  // ── /me ─────────────────────────────────────────────────────────────
  router.get('/me', (req, res) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason || 'Unauthorized' });
      return;
    }
    // Surface the canonical user record so the SPA can display the email
    // alongside the username/role badge. AD-managed accounts without a
    // local record still get a minimal payload from the token claims.
    const view = auth.username ? deps.authService.getUser(auth.username) : null;
    res.json({
      authenticated: true,
      username: auth.username,
      role: auth.role,
      ...(view?.email ? { email: view.email } : {}),
    });
  });

  // ── Users CRUD ──────────────────────────────────────────────────────
  router.get('/users', (req, res) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'users.read');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return;
    }
    const users = deps.authService.listUsers().map(u => {
      const ur = deps.rolesDb
        .prepare(
          'SELECT r.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.username = ?',
        )
        .get(u.username) as { id: number; name: string } | undefined;
      return { ...u, id: u.username, assignedRoleId: ur?.id ?? null, assignedRoleName: ur?.name ?? null };
    });
    res.json({ users });
  });

  router.post('/users', (req, res) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'users.manage');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      audit(req, auth, 'users.create.denied', false, auth.reason);
      return;
    }
    const { username, password, role, email, active } = req.body || {};
    if (!username || !password || !role) {
      res.status(400).json({ error: 'username, password, role are required' });
      return;
    }
    if (!['admin', 'operator', 'viewer'].includes(String(role))) {
      res.status(400).json({ error: 'role must be admin, operator, or viewer' });
      return;
    }
    const user = deps.authService.createOrUpdateUser({
      username: String(username),
      password: String(password),
      role: role as UserRole,
      email: typeof email === 'string' && email.trim() ? email.trim() : undefined,
      active: active === undefined ? true : !!active,
    });
    audit(req, auth, 'users.create', true, `target=${user.username} role=${user.role}`);
    res.json({ success: true, user });
  });

  router.patch('/users/:username', (req, res) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'users.manage');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      audit(req, auth, 'users.update.denied', false, auth.reason);
      return;
    }
    const updates = req.body || {};
    if (updates.role !== undefined && !['admin', 'operator', 'viewer'].includes(String(updates.role))) {
      res.status(400).json({ error: 'role must be admin, operator, or viewer' });
      return;
    }
    const updated = deps.authService.updateUser(req.params.username, {
      password: updates.password ? String(updates.password) : undefined,
      role: updates.role as UserRole | undefined,
      email: updates.email === null
        ? ''
        : (typeof updates.email === 'string' ? updates.email.trim() : undefined),
      active: updates.active === undefined ? undefined : !!updates.active,
    });
    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      audit(req, auth, 'users.update.notfound', false, `target=${req.params.username}`);
      return;
    }
    const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined).join(',');
    audit(req, auth, 'users.update', true, `target=${updated.username} changed=${changedFields}`);
    res.json({ success: true, user: updated });
  });

  router.delete('/users/:username', (req, res) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'users.manage');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      audit(req, auth, 'users.delete.denied', false, auth.reason);
      return;
    }
    if (req.params.username === auth.username) {
      res.status(400).json({ error: 'You cannot delete your own account' });
      return;
    }
    const deleted = deps.authService.deleteUser(req.params.username);
    audit(req, auth, deleted ? 'users.delete' : 'users.delete.notfound', deleted, `target=${req.params.username}`);
    res.json({ success: deleted });
  });

  // ── Roles CRUD ──────────────────────────────────────────────────────
  router.get('/roles', (req, res) => {
    if (!requireAdmin(req, res).ok) return;
    const rows = deps.rolesDb.prepare('SELECT * FROM roles ORDER BY name').all() as RoleRow[];
    res.json({ roles: rows.map(roleWithCount) });
  });

  router.post('/roles', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor.ok) return;
    const { name, permissions } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const perms = Array.isArray(permissions) ? permissions : [];
    try {
      const result = deps.rolesDb
        .prepare('INSERT INTO roles (name, permissions) VALUES (?, ?)')
        .run(name.trim(), JSON.stringify(perms));
      const row = deps.rolesDb.prepare('SELECT * FROM roles WHERE id = ?').get(result.lastInsertRowid) as RoleRow;
      audit(req, actor, 'roles.create', true, `name=${row.name}`);
      res.json({ success: true, role: roleWithCount(row) });
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE')) {
        res.status(409).json({ error: 'Role name already exists' });
        return;
      }
      res.status(500).json({ error: err?.message });
    }
  });

  router.put('/roles/:id', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor.ok) return;
    const id = Number(req.params.id);
    const { name, permissions } = req.body || {};
    const row = deps.rolesDb.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }
    const newName = name && typeof name === 'string' && name.trim() ? name.trim() : row.name;
    const newPerms = Array.isArray(permissions) ? permissions : (JSON.parse(row.permissions) as string[]);
    try {
      deps.rolesDb
        .prepare('UPDATE roles SET name = ?, permissions = ? WHERE id = ?')
        .run(newName, JSON.stringify(newPerms), id);
      const updated = deps.rolesDb.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow;
      audit(req, actor, 'roles.update', true, `id=${id} name=${updated.name}`);
      res.json({ success: true, role: roleWithCount(updated) });
    } catch (err: any) {
      if (err?.message?.includes('UNIQUE')) {
        res.status(409).json({ error: 'Role name already exists' });
        return;
      }
      res.status(500).json({ error: err?.message });
    }
  });

  router.delete('/roles/:id', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor.ok) return;
    const id = Number(req.params.id);
    const row = deps.rolesDb.prepare('SELECT id, name FROM roles WHERE id = ?').get(id) as { id: number; name: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }
    deps.rolesDb.prepare('DELETE FROM roles WHERE id = ?').run(id);
    audit(req, actor, 'roles.delete', true, `id=${id} name=${row.name}`);
    res.json({ success: true });
  });

  // ── User → Role assignment ──────────────────────────────────────────
  router.put('/users/:username/role', (req, res) => {
    const actor = requireAdmin(req, res);
    if (!actor.ok) return;
    const { username } = req.params;
    const { roleId } = req.body || {};
    const user = deps.authService.listUsers().find(u => u.username === username);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    deps.rolesDb.prepare('DELETE FROM user_roles WHERE username = ?').run(username);
    if (roleId !== null && roleId !== undefined) {
      const role = deps.rolesDb.prepare('SELECT id FROM roles WHERE id = ?').get(Number(roleId));
      if (!role) {
        res.status(404).json({ error: 'Role not found' });
        return;
      }
      deps.rolesDb
        .prepare('INSERT OR REPLACE INTO user_roles (username, role_id) VALUES (?, ?)')
        .run(username, Number(roleId));
    }
    audit(req, actor, 'users.role.assign', true, `target=${username} roleId=${roleId ?? 'null'}`);
    res.json({ success: true });
  });

  return router;
}

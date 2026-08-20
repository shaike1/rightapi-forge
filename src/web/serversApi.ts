// /api/servers — CRUD + SSH connectivity test for the ServerRegistry.
//
// Routes (mounted at /api/servers):
//   GET    /              — list every server (enabled + disabled)
//   GET    /:id           — one server
//   POST   /              — create a remote server (local row is seeded)
//   PUT    /:id           — partial update; mutating the local row's
//                            identity fields is rejected at the registry
//   DELETE /:id           — remove a remote server (local is protected)
//   POST   /:id/test      — run a short echo via the executor and stamp
//                            last_seen / last_check_status on success
//
// Auth: same shape as the other server.ts routers. We accept the bearer
// token used by the rest of the API; an absent header gets a 401.

import { Router, type Request, type Response } from 'express';
import type { ServerRegistry, CreateServerInput, UpdateServerInput } from '../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface ServersApiDeps {
  registry: ServerRegistry;
  executor: RemoteExecutor;
  validateAuth: AuthCheck;
  logError: (msg: string, ctx: Record<string, unknown>) => void;
}

function requireAuth(deps: ServersApiDeps, req: Request, res: Response, permission: string): boolean {
  const r = deps.validateAuth(req.headers.authorization, permission);
  if (!r.ok) {
    res.status(401).json({ error: r.reason || 'unauthorized' });
    return false;
  }
  return true;
}

/** Common write-input validation. Returns a normalised CreateServerInput
 *  or sends a 4xx and returns null. */
function readWriteInput(body: any, res: Response, partial: boolean): CreateServerInput | null {
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'request body must be a JSON object' });
    return null;
  }
  const { id, name, host, sshUser, sshPort, sshKeyPath, tags, sshOptions, enabled } = body;
  if (!partial) {
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return null;
    }
    if (typeof host !== 'string' || !host.trim()) {
      res.status(400).json({ error: 'host is required for remote servers' });
      return null;
    }
    if (typeof sshUser !== 'string' || !sshUser.trim()) {
      res.status(400).json({ error: 'sshUser is required for remote servers' });
      return null;
    }
  }
  if (sshPort !== undefined && (typeof sshPort !== 'number' || sshPort < 1 || sshPort > 65535)) {
    res.status(400).json({ error: 'sshPort must be 1..65535' });
    return null;
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some(t => typeof t !== 'string'))) {
    res.status(400).json({ error: 'tags must be a string array' });
    return null;
  }
  if (sshOptions !== undefined && (sshOptions === null || typeof sshOptions !== 'object' || Array.isArray(sshOptions))) {
    res.status(400).json({ error: 'sshOptions must be an object of key=value strings' });
    return null;
  }
  return {
    id: typeof id === 'string' ? id : undefined,
    name: typeof name === 'string' ? name : '',
    host: typeof host === 'string' ? host : undefined,
    sshUser: typeof sshUser === 'string' ? sshUser : undefined,
    sshPort: typeof sshPort === 'number' ? sshPort : undefined,
    sshKeyPath: typeof sshKeyPath === 'string' ? sshKeyPath : undefined,
    tags: Array.isArray(tags) ? tags : undefined,
    sshOptions: sshOptions && typeof sshOptions === 'object' ? sshOptions : undefined,
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
  };
}

export function createServersRouter(deps: ServersApiDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    res.json({ servers: deps.registry.list() });
  });

  router.get('/:id', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    const s = deps.registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'server not found' });
    res.json({ server: s });
  });

  router.post('/', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const input = readWriteInput(req.body, res, false);
    if (!input) return;
    try {
      // Operators can't create a row with id="local" — that slot is
      // reserved for the seeded nsenter entry. Block here so we don't
      // accidentally clobber it on upsert.
      if (input.id === 'local') {
        return res.status(409).json({ error: 'id "local" is reserved for the seeded local server' });
      }
      const existing = input.id ? deps.registry.get(input.id) : null;
      if (existing) return res.status(409).json({ error: `server "${input.id}" already exists` });
      const s = deps.registry.upsert({ ...input, isLocal: false, enabled: input.enabled ?? true });
      res.status(201).json({ server: s });
    } catch (e: any) {
      deps.logError('servers create failed', { err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/:id', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const input = readWriteInput(req.body, res, true);
    if (!input) return;
    const patch: UpdateServerInput = {
      name: input.name && input.name.length > 0 ? input.name : undefined,
      host: input.host,
      sshUser: input.sshUser,
      sshPort: input.sshPort,
      sshKeyPath: input.sshKeyPath,
      tags: input.tags,
      sshOptions: input.sshOptions,
      enabled: input.enabled,
    };
    try {
      const updated = deps.registry.update(req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'server not found' });
      res.json({ server: updated });
    } catch (e: any) {
      deps.logError('servers update failed', { id: req.params.id, err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const s = deps.registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'server not found' });
    if (s.isLocal) return res.status(400).json({ error: 'cannot delete the local server' });
    deps.registry.delete(req.params.id);
    res.json({ ok: true });
  });

  router.post('/:id/test', async (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const s = deps.registry.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'server not found' });
    try {
      const r = await deps.executor.testConnectivity(s);
      deps.registry.recordCheck(s.id, r.ok ? 'ok' : 'error');
      res.json({ ok: r.ok, detail: r.detail, durationMs: r.durationMs });
    } catch (e: any) {
      deps.registry.recordCheck(s.id, 'error');
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

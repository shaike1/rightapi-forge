// /api/credentials/* — credential vault + rotation management.
// Extracted from server.ts.
//
// Routes (mount at /api/credentials):
//   GET  /usage                  audit.read
//   GET  /rotation/status        credentials.read
//   POST /rotation/run           admin.write
//   PUT  /:id/lifecycle          credentials.write
//   POST /                       credentials.write
//   DELETE /:id                  credentials.write
//   GET  /:agentId               credentials.read
//
// Route order is deliberate: specific paths (/usage, /rotation/*)
// come BEFORE the catch-all /:agentId GET. The vault never echoes
// secrets back; create/update/delete emit credential lifecycle
// events on the eventBus (without including the secret).

import { Router, type Request, type Response } from 'express';

interface CredentialVaultLike {
  listByAgent: (agentId: string) => unknown[];
  setLifecycle: (id: string, lifecycle: { kind?: string; expiresAt?: string; rotationIntervalDays?: number }) => any | null;
  upsert: (input: { id?: string; agentId: string; name: string; scope: string; secret: string }) => { id: string; agentId: string; name: string; scope: string; kind?: string };
  delete: (id: string) => boolean;
}

interface RotationManagerLike {
  getStatus: () => unknown;
  runOnce: () => Promise<unknown>;
}

interface ExecutionAuditRecordLike {
  credentialDecision?: string;
  reason?: string;
}

interface ExecutionAuditStoreLike {
  list: (limit?: number) => ExecutionAuditRecordLike[];
}

interface EventBusLike {
  publish: (event: {
    aggregateType: string;
    aggregateId: string;
    type: string;
    actor: string;
    data?: Record<string, unknown>;
  }) => Promise<unknown> | void;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface CredentialsApiDeps {
  credentialVault: CredentialVaultLike;
  rotationManager: RotationManagerLike;
  executionAuditStore: ExecutionAuditStoreLike;
  eventBus: EventBusLike;
  /** Constants from ../events module — passed in to keep this file
   *  free of imports beyond Express. */
  eventTypes: {
    CREDENTIAL_CREATED: string;
    CREDENTIAL_UPDATED: string;
    CREDENTIAL_DELETED: string;
  };
  aggregateTypes: { CREDENTIAL: string };
  validateAuth: AuthCheck;
}

export function createCredentialsRouter(deps: CredentialsApiDeps): Router {
  const router = Router();
  const {
    credentialVault,
    rotationManager,
    executionAuditStore,
    eventBus,
    eventTypes,
    aggregateTypes,
    validateAuth,
  } = deps;

  router.get('/usage', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const records = executionAuditStore.list(500);
    const total = records.length;
    const allow = records.filter(r => r.credentialDecision === 'allow').length;
    const deny = records.filter(r => r.credentialDecision === 'deny').length;
    const notChecked = records.filter(r => r.credentialDecision === 'not_checked').length;
    const errorCount = records.filter(r => r.credentialDecision === 'error').length;
    const denyReasons: Record<string, number> = {};
    records.filter(r => r.credentialDecision === 'deny' && r.reason).forEach(r => {
      const key = (r.reason || 'unknown').slice(0, 80);
      denyReasons[key] = (denyReasons[key] || 0) + 1;
    });
    const topDenyReasons = Object.entries(denyReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
    res.json({ total, allow, deny, notChecked, error: errorCount, topDenyReasons });
  });

  router.get('/rotation/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'credentials.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    res.json(rotationManager.getStatus());
  });

  router.post('/rotation/run', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const result = await rotationManager.runOnce();
    res.json({ success: true, result });
  });

  router.put('/:id/lifecycle', (req: Request, res: Response) => {
    try {
      const auth = validateAuth(req.header('authorization') || undefined, 'credentials.write');
      if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
      const { kind, expiresAt, rotationIntervalDays } = req.body || {};
      const updated = credentialVault.setLifecycle(req.params.id, { kind, expiresAt, rotationIntervalDays });
      if (!updated) { res.status(404).json({ error: 'credential not found' }); return; }
      res.json({ success: true, credential: updated });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const auth = validateAuth(req.header('authorization') || undefined, 'credentials.write');
      if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
      const { agentId, name, scope, secret, id } = req.body || {};
      if (!agentId || !name || !scope || !secret) {
        res.status(400).json({ error: 'agentId, name, scope, secret are required' });
        return;
      }
      const meta = credentialVault.upsert({ id, agentId, name, scope, secret });
      // Emit a credential lifecycle event. We never include the secret —
      // the event log is durable; secrets must never end up there.
      void eventBus.publish({
        aggregateType: aggregateTypes.CREDENTIAL,
        aggregateId: meta.id,
        type: id ? eventTypes.CREDENTIAL_UPDATED : eventTypes.CREDENTIAL_CREATED,
        actor: auth.username || 'api',
        data: { agentId: meta.agentId, name: meta.name, scope: meta.scope, kind: meta.kind },
      });
      res.json({ success: true, credential: meta });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'credentials.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const deleted = credentialVault.delete(req.params.id);
    if (deleted) {
      void eventBus.publish({
        aggregateType: aggregateTypes.CREDENTIAL,
        aggregateId: req.params.id,
        type: eventTypes.CREDENTIAL_DELETED,
        actor: auth.username || 'api',
      });
    }
    res.json({ success: deleted });
  });

  // /:agentId comes LAST so it doesn't shadow /usage and /rotation/*.
  router.get('/:agentId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'credentials.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    res.json({
      agentId: req.params.agentId,
      credentials: credentialVault.listByAgent(req.params.agentId),
    });
  });

  return router;
}

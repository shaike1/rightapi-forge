// /api/security/* — security posture surface (read-only). Extracted
// from server.ts.
//
// Routes (mount at /api/security):
//   GET /status                  (security.read)
//   GET /rate-limit              (no auth — preserved 1:1 with inline)
//   GET /audit                   (no auth — preserved 1:1 with inline)
//   GET /audit/export.csv        (audit.read; supports ?token=)
//
// /status returns a deeply nested snapshot built from many module-level
// constants in server.ts (env-var sources, weak-secret flags, OTel SLO
// thresholds, backup directory paths). Rather than threading 20+ deps
// through this file, we accept a getStatus() thunk and let server.ts
// assemble the object inline. That keeps the router slim and the auth
// gate uniform.
//
// Several of these endpoints have unauthenticated reads in the inline
// blocks. We preserve that 1:1 — hardening them belongs in a follow-up
// so the diff stays reviewable.
//
// This file previously contained an unused createSecurityRouter()
// targeting AuditLogger / ComplianceEngine / SecretManager — never wired
// into server.ts. That earlier design has been removed in favor of this
// extraction.

import { Router, type Request, type Response } from 'express';

type AuthResult = { ok: boolean; reason?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;
type TokenAuthCheck = (token: string | undefined, permission?: string) => AuthResult;

interface ExecutionAuditRecord {
  id: string;
  timestamp: string;
  agentId?: string;
  command: string;
  skillId?: string;
  taskId?: string;
  status: string;
  reason?: string;
}

interface ExecutionAuditStoreLike {
  list: (limit?: number) => ExecutionAuditRecord[];
}

export interface SecurityApiDeps {
  /** Returns the full /status snapshot. Built in server.ts because it
   *  pulls in ~20 module-level constants we don't want to thread here. */
  getStatus: () => unknown;
  executionAuditStore: ExecutionAuditStoreLike;
  validateAuth: AuthCheck;
  validateAuthToken: TokenAuthCheck;
}

export function createSecurityRouter(deps: SecurityApiDeps): Router {
  const router = Router();
  const { getStatus, executionAuditStore, validateAuth, validateAuthToken } = deps;

  // In-memory rate-limit counter — same as the inline block. Currently
  // unused outside this endpoint; retained for parity.
  const rateLimitCounter = new Map<string, number>();

  router.get('/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return;
    }
    res.json(getStatus());
  });

  // No auth on this endpoint — matches inline behavior. Returns a static
  // description of the rate-limit policy, not actual usage data.
  router.get('/rate-limit', (_req: Request, res: Response) => {
    res.json({
      enabled: true,
      requestsPerMinute: 60,
      burst: 10,
      currentUsage: rateLimitCounter.size,
      rules: [
        { endpoint: '/api/auth/login', limit: 5, window: 60000 },
        { endpoint: '/api/agents', limit: 30, window: 60000 },
        { endpoint: '/api/task-queue', limit: 20, window: 60000 },
        { endpoint: '*', limit: 60, window: 60000 },
      ],
    });
  });

  // No auth on the JSON audit feed — matches inline behavior. The CSV
  // export DOES auth-check below.
  router.get('/audit', (req: Request, res: Response) => {
    const { from, to, type, limit: limitQ, offset: offsetQ } = req.query as Record<string, string>;
    const limit = Math.min(parseInt(limitQ || '100', 10), 500);
    const offset = parseInt(offsetQ || '0', 10);

    let records = executionAuditStore.list(2000).map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      user: r.agentId || 'system',
      action: r.command,
      resource: r.skillId || r.taskId || '—',
      result: (r.status === 'allowed' ? 'success' : 'failure') as 'success' | 'failure',
      type: r.taskId ? 'agent' : 'settings',
      details: r.reason || '',
    }));

    if (from) {
      const fromTime = new Date(from).getTime();
      records = records.filter(r => new Date(r.timestamp).getTime() >= fromTime);
    }
    if (to) {
      const toTime = new Date(to).getTime();
      records = records.filter(r => new Date(r.timestamp).getTime() <= toTime);
    }
    if (type && type !== 'all') {
      records = records.filter(r => r.type === type);
    }

    const total = records.length;
    const events = records.slice(offset, offset + limit);
    res.json({ events, total, limit, offset });
  });

  router.get('/audit/export.csv', (req: Request, res: Response) => {
    const { from, to, type } = req.query as Record<string, string>;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const auth = queryToken
      ? validateAuthToken(queryToken, 'audit.read')
      : validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }

    let records = executionAuditStore.list(2000).map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      user: r.agentId || 'system',
      action: r.command,
      resource: r.skillId || r.taskId || '',
      result: r.status === 'allowed' ? 'success' : 'failure',
      type: r.taskId ? 'agent' : 'settings',
      details: r.reason || '',
    }));

    if (from) {
      const fromTime = new Date(from).getTime();
      records = records.filter(r => new Date(r.timestamp).getTime() >= fromTime);
    }
    if (to) {
      const toTime = new Date(to).getTime();
      records = records.filter(r => new Date(r.timestamp).getTime() <= toTime);
    }
    if (type && type !== 'all') {
      records = records.filter(r => r.type === type);
    }

    const escCsv = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'timestamp,type,user,action,resource,details\n';
    const rows = records.map(r =>
      [r.timestamp, r.type, r.user, r.action, r.resource, r.details].map(escCsv).join(','),
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
    res.send(header + rows);
  });

  return router;
}

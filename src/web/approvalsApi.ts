// /api/approvals/* — one-time approval-token issuance, revocation,
// status lookup, and ledger view. Extracted from server.ts.
//
// Routes (mount at /api/approvals):
//   POST /tokens               approvals.manage
//   POST /revoke               approvals.manage
//   GET  /status/:tokenId      approvals.read
//   GET  /ledger               approvals.read
//
// The minted tokens drive the approval gates in
// /api/delegations/:id/transition and /api/tasks/:id/rollback/apply.

import { Router, type Request, type Response } from 'express';
import type { ApprovalTokenLedger } from '../security/ApprovalTokenLedger.js';

interface ApprovalTokenServiceLike {
  mint: (opts: {
    command: string;
    agentId: string;
    approver: string;
    reason?: string;
    ttlSeconds?: number;
  }) => unknown;
}

interface ToolPolicyLike {
  requiresApproval: boolean;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface ApprovalsApiDeps {
  approvalTokenService: ApprovalTokenServiceLike;
  approvalTokenLedger: ApprovalTokenLedger;
  getToolPolicy: (command: string) => ToolPolicyLike | undefined;
  validateAuth: AuthCheck;
}

export function createApprovalsRouter(deps: ApprovalsApiDeps): Router {
  const router = Router();
  const { approvalTokenService, approvalTokenLedger, getToolPolicy, validateAuth } = deps;

  router.post('/tokens', (req: Request, res: Response) => {
    try {
      const auth = validateAuth(req.header('authorization') || undefined, 'approvals.manage');
      if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
      const { command, agentId, ttlSeconds, reason } = req.body || {};
      if (!command || !agentId) {
        res.status(400).json({ error: 'command and agentId are required' });
        return;
      }
      const policy = getToolPolicy(String(command));
      if (!policy) {
        res.status(404).json({ error: `No policy defined for command '${command}'` });
        return;
      }
      if (!policy.requiresApproval) {
        res.status(400).json({ error: `Command '${command}' does not require approval token` });
        return;
      }

      const minted = approvalTokenService.mint({
        command: String(command),
        agentId: String(agentId),
        approver: auth.username || 'operator',
        reason: reason ? String(reason) : undefined,
        ttlSeconds: ttlSeconds ? Number(ttlSeconds) : undefined,
      });
      res.json({ success: true, approval: minted });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/revoke', (req: Request, res: Response) => {
    try {
      const auth = validateAuth(req.header('authorization') || undefined, 'approvals.manage');
      if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
      const { tokenId, reason } = req.body || {};
      if (!tokenId) {
        res.status(400).json({ error: 'tokenId is required' });
        return;
      }
      const record = approvalTokenLedger.revoke({
        tokenId: String(tokenId),
        revokedBy: auth.username || 'operator',
        reason: reason ? String(reason) : undefined,
      });
      res.json({ success: true, revocation: record });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/status/:tokenId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'approvals.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const status = approvalTokenLedger.getStatus(req.params.tokenId);
    res.json(status);
  });

  router.get('/ledger', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'approvals.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json(approvalTokenLedger.list(limit));
  });

  return router;
}

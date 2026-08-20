// /api/autonomy/* — observability + manual trigger surface for the
// autonomy orchestrator (the closed-loop coordinator that wires
// crystallization → SkillManager and pattern-detection → SDK).
//
// Routes (mount at /api/autonomy):
//   GET  /status       audit.read   — snapshot of the orchestrator
//                                     (cooldowns, daily SDK budget,
//                                     pattern window size, last scan)
//   POST /scan         admin.write  — manually trigger one scan pass.
//                                     Useful for verification + ops
//                                     when the periodic timer is off.

import { Router, type Request, type Response } from 'express';
import type { AutonomyOrchestrator } from '../autonomy/AutonomyOrchestrator.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface AutonomyApiDeps {
  orchestrator: AutonomyOrchestrator;
  validateAuth: AuthCheck;
}

export function createAutonomyRouter(deps: AutonomyApiDeps): Router {
  const router = Router();
  const { orchestrator, validateAuth } = deps;

  router.get('/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason ?? 'Forbidden' }); return; }
    res.json(orchestrator.getStatus());
  });

  router.post('/scan', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason ?? 'Forbidden' }); return; }
    try {
      const summary = await orchestrator.scan();
      res.json(summary);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'scan failed' });
    }
  });

  return router;
}

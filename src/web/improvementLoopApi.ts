// Improvement-loop control surface — extracted from server.ts.
//
// Two routes: GET /status (audit.read) and POST /tick (admin.write).
// Mount with: app.use('/api/improvement-loop', createImprovementLoopRouter({...}))
//
// validateAuth is passed in rather than imported so this module doesn't
// depend on server.ts's internals. Same pattern as the other createXxxRouter
// modules in src/web/.

import { Router, type Request, type Response } from 'express';
import type { ImprovementLoop } from '../improvement/ImprovementLoop.js';

export interface ImprovementLoopApiDeps {
  improvementLoop: ImprovementLoop;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string };
}

export function createImprovementLoopRouter(deps: ImprovementLoopApiDeps): Router {
  const router = Router();

  router.get('/status', (req: Request, res: Response) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason ?? 'Forbidden' });
      return;
    }
    res.json(deps.improvementLoop.getStatus());
  });

  router.post('/tick', async (req: Request, res: Response) => {
    const auth = deps.validateAuth(req.header('authorization') || undefined, 'admin.write');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason ?? 'Forbidden' });
      return;
    }
    try {
      const summary = await deps.improvementLoop.tick();
      res.json(summary);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'tick failed' });
    }
  });

  return router;
}

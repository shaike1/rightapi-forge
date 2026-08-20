// /api/crystallized-skills/* — list + lifecycle controls for skills
// the platform learned from successful resolutions. Extracted from
// server.ts.
//
// Routes (mount at /api/crystallized-skills):
//   GET  /              workflows.read
//   GET  /stats         workflows.read
//   GET  /:id           workflows.read
//   POST /:id/approve   workflows.write
//   POST /:id/reject    workflows.write
//   POST /:id/promote   workflows.write
//
// Lifecycle (approve/reject/promote) mirrors what the AutoPromotion
// engine drives automatically — these routes are the manual override.

import { Router, type Request, type Response, type RequestHandler } from 'express';

interface CrystallizationServiceLike {
  listSkills: (opts?: {
    status?: 'draft' | 'approved' | 'active' | 'rejected';
    agentId?: string;
    tag?: string;
    limit?: number;
  }) => Promise<any[]>;
  getSkill: (id: string) => Promise<any | null>;
  approve: (id: string) => Promise<any | null>;
  reject: (id: string, _unused?: undefined, reason?: string) => Promise<any | null>;
  promote: (id: string) => Promise<any | null>;
}

export interface CrystallizedSkillsApiDeps {
  crystallizationService: CrystallizationServiceLike;
  requirePermission: (perm: string) => RequestHandler;
}

export function createCrystallizedSkillsRouter(deps: CrystallizedSkillsApiDeps): Router {
  const router = Router();
  const { crystallizationService, requirePermission } = deps;

  router.get('/', requirePermission('workflows.read'), async (req: Request, res: Response) => {
    const status = req.query.status as 'draft' | 'approved' | 'active' | 'rejected' | undefined;
    const agentId = req.query.agentId as string | undefined;
    const tag = req.query.tag as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const skills = await crystallizationService.listSkills({ status, agentId, tag, limit });
    res.json({ skills });
  });

  router.get('/stats', requirePermission('workflows.read'), async (_req: Request, res: Response) => {
    const all = await crystallizationService.listSkills({ limit: 1000 });
    const byStatus: Record<string, number> = { draft: 0, approved: 0, active: 0, rejected: 0 };
    let totalUsage = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let avgConfidence = 0;
    for (const s of all) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      totalUsage += s.usageCount;
      avgConfidence += s.confidenceScore;
      for (const u of s.recentUsage) {
        if (u.outcome === 'success') totalSuccess++;
        else if (u.outcome === 'failed') totalFailed++;
      }
    }
    res.json({
      counts: byStatus,
      total: all.length,
      totalUsage,
      avgConfidence: all.length > 0 ? avgConfidence / all.length : 0,
      successRate: (totalSuccess + totalFailed) > 0 ? totalSuccess / (totalSuccess + totalFailed) : null,
    });
  });

  router.get('/:id', requirePermission('workflows.read'), async (req: Request, res: Response) => {
    const skill = await crystallizationService.getSkill(req.params.id);
    if (!skill) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ skill });
  });

  router.post('/:id/approve', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    try {
      const updated = await crystallizationService.approve(req.params.id);
      if (!updated) { res.status(404).json({ error: 'not found' }); return; }
      res.json({ success: true, skill: updated });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post('/:id/reject', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    const reason = (req.body?.reason as string | undefined) ?? undefined;
    const updated = await crystallizationService.reject(req.params.id, undefined, reason);
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ success: true, skill: updated });
  });

  router.post('/:id/promote', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    try {
      const updated = await crystallizationService.promote(req.params.id);
      if (!updated) { res.status(404).json({ error: 'not found' }); return; }
      res.json({ success: true, skill: updated });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  return router;
}

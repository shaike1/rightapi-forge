// /api/schedules/* — cron-fired schedule CRUD + run history + pause/resume
// + run-now. Extracted from server.ts.
//
// Routes (mount at /api/schedules):
//   GET    /                  workflows.read
//   POST   /                  workflows.write
//   GET    /upcoming          workflows.read
//   GET    /:id               workflows.read
//   DELETE /:id               workflows.write
//   POST   /:id/pause         workflows.write
//   POST   /:id/resume        workflows.write
//   POST   /:id/run           workflows.execute
//   GET    /:id/runs          workflows.read
//
// All gated by `requirePermission` middleware (the RBAC middleware
// produced by createRbacMiddleware). The schedule engine and the
// store factory's schedules accessor are passed in as deps.

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { buildSchedule } from '../scheduling/ScheduledTaskTypes.js';
import type { ScheduleEngine } from '../scheduling/ScheduleEngine.js';

interface SchedulesStoreLike {
  list: (filter?: { status?: 'enabled' | 'paused' }) => any[] | Promise<any[]>;
  get: (id: string) => any | Promise<any>;
  listRuns: (filter: { scheduleId: string; limit?: number }) => any[] | Promise<any[]>;
}

export interface SchedulesApiDeps {
  schedulesStore: SchedulesStoreLike;
  scheduleEngine: ScheduleEngine;
  requirePermission: (perm: string) => RequestHandler;
}

export function createSchedulesRouter(deps: SchedulesApiDeps): Router {
  const router = Router();
  const { schedulesStore, scheduleEngine, requirePermission } = deps;

  router.get('/', requirePermission('workflows.read'), async (req: Request, res: Response) => {
    const status = req.query.status as 'enabled' | 'paused' | undefined;
    const schedules = await Promise.resolve(schedulesStore.list({ status }));
    res.json({ schedules });
  });

  router.post('/', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    try {
      const { id, name, cron, action, description, status, tenantId } = req.body || {};
      if (!id || !name || !cron || !action) {
        res.status(400).json({ error: 'id, name, cron, action are required' });
        return;
      }
      const task = buildSchedule({ id, name, cron, action, description, status, tenantId });
      const saved = await scheduleEngine.upsert(task);
      res.json({ success: true, schedule: saved });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get('/upcoming', requirePermission('workflows.read'), async (_req: Request, res: Response) => {
    const all = await Promise.resolve(schedulesStore.list({ status: 'enabled' }));
    const upcoming = all
      .filter((s: any) => s.nextRunAt)
      .sort((a: any, b: any) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
      .slice(0, 50);
    res.json({ upcoming });
  });

  router.get('/:id', requirePermission('workflows.read'), async (req: Request, res: Response) => {
    const s = await Promise.resolve(schedulesStore.get(req.params.id));
    if (!s) { res.status(404).json({ error: 'schedule not found' }); return; }
    res.json({ schedule: s });
  });

  router.delete('/:id', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    const ok = await scheduleEngine.delete(req.params.id);
    res.json({ success: ok });
  });

  router.post('/:id/pause', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    const ok = await scheduleEngine.setStatus(req.params.id, 'paused');
    if (!ok) { res.status(404).json({ error: 'schedule not found' }); return; }
    res.json({ success: true });
  });

  router.post('/:id/resume', requirePermission('workflows.write'), async (req: Request, res: Response) => {
    const ok = await scheduleEngine.setStatus(req.params.id, 'enabled');
    if (!ok) { res.status(404).json({ error: 'schedule not found' }); return; }
    res.json({ success: true });
  });

  router.post('/:id/run', requirePermission('workflows.execute'), async (req: Request, res: Response) => {
    try {
      const run = await scheduleEngine.runNow(req.params.id);
      res.json({ success: run.outcome !== 'failed', run });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get('/:id/runs', requirePermission('workflows.read'), async (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 50;
    const runs = await Promise.resolve(schedulesStore.listRuns({ scheduleId: req.params.id, limit }));
    res.json({ runs });
  });

  return router;
}

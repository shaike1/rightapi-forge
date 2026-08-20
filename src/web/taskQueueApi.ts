// /api/task-queue routes — extracted from server.ts.
//
// Routes (mount at /api/task-queue):
//   GET    /                  (no auth — read-only queue snapshot)
//   GET    /stats             (no auth — task counts by status)
//   PUT    /:taskId/status    (tools.execute.privileged)
//   PATCH  /:taskId           (no auth — reassign agent; matches inline behavior)
//   POST   /                  (no auth — create task; matches inline behavior)
//
// The legacy `/api/task-queuestats` (no slash) endpoint is mounted at the
// app root, not under this prefix — see taskQueueStatsHandler below for
// the shared handler that server.ts wires into both paths.
//
// Important: the inline blocks for these routes did not all auth-check.
// We preserve that 1:1 — it's a pure refactor. If you want to harden
// the unauthenticated routes, do it in a follow-up so the diff is
// reviewable.

import { Router, type Request, type Response } from 'express';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { TaskStatus } from '../types/index.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface TaskQueueApiDeps {
  taskManager: TaskManager;
  buildPayload: () => unknown;
  validateAuth: AuthCheck;
}

/** Shared handler used by both /api/task-queue/stats and the legacy
 *  /api/task-queuestats alias. server.ts wires the alias separately. */
export function buildTaskQueueStats(taskManager: TaskManager) {
  const stats = taskManager.getStatistics();
  return {
    total: stats.total || 0,
    pending: stats.pending || 0,
    inProgress: stats.in_progress || 0,
    completed: stats.completed || 0,
    failed: stats.failed || 0,
    assigned: stats.assigned || 0,
    cancelled: stats.cancelled || 0,
    dropped: stats.dropped || 0,
    rollingBack: stats.rolling_back || 0,
    rolledBack: stats.rolled_back || 0,
  };
}

export function createTaskQueueRouter(deps: TaskQueueApiDeps): Router {
  const router = Router();
  const { taskManager, buildPayload, validateAuth } = deps;

  router.get('/', (_req: Request, res: Response) => {
    res.json(buildPayload());
  });

  router.get('/stats', (_req: Request, res: Response) => {
    res.json(buildTaskQueueStats(taskManager));
  });

  router.put('/:taskId/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return;
    }
    const rawStatus = String(req.body?.status || '').trim().toLowerCase();
    const normalizedStatus = ({
      'in-progress': 'in_progress',
      'rolling-back': 'rolling_back',
      'rolled-back': 'rolled_back',
    } as Record<string, TaskStatus>)[rawStatus] || (rawStatus as TaskStatus);
    const allowedStatuses: TaskStatus[] = [
      'pending',
      'assigned',
      'in_progress',
      'completed',
      'failed',
      'blocked',
      'cancelled',
      'dropped',
      'rolling_back',
      'rolled_back',
    ];
    if (!allowedStatuses.includes(normalizedStatus)) {
      res.status(400).json({ error: `Invalid status. Allowed values: ${allowedStatuses.join(', ')}` });
      return;
    }
    try {
      const task = taskManager.updateTaskStatus(req.params.taskId, normalizedStatus);
      res.json({ success: true, task });
    } catch (error) {
      const message = (error as Error).message;
      res.status(message.includes('not found') ? 404 : 500).json({ error: message });
    }
  });

  /** PATCH /:taskId — reassign task to a different agent. */
  router.patch('/:taskId', (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const { assignedTo } = req.body || {};
      if (!assignedTo || typeof assignedTo !== 'string') {
        res.status(400).json({ error: '`assignedTo` (agent id) is required' });
        return;
      }
      taskManager.assignAgentToTask(assignedTo, taskId);
      const task = taskManager.getTask(taskId);
      res.json({ success: true, task });
    } catch (error) {
      const message = (error as Error).message;
      res.status(message.includes('not found') ? 404 : 500).json({ error: message });
    }
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const task = taskManager.createTask(req.body);
      res.json(task);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

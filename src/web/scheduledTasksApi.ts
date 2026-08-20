// /api/scheduled-tasks/* — simple in-process scheduler CRUD with a
// custom mini-cron syntax ("every 5m", "every 1h", "hourly", "daily",
// "daily 09:00"). Extracted from server.ts.
//
// Routes (mount at /api/scheduled-tasks):
//   GET    /                  (no auth)
//   POST   /                  (no auth — captures auth.username if present
//                              for createdBy attribution)
//   PUT    /:taskId           (no auth)
//   DELETE /:taskId           (no auth)
//   POST   /:taskId/run       (no auth — fires the task immediately)
//
// State (`scheduledTasks` array) is owned by server.ts because the
// scheduler tick loop iterates it directly. We pass it in by reference
// — the router mutates it via push/splice. Same with the helper
// functions; they live in server.ts today.
//
// Behavior preserved 1:1: the cron syntax validation, auth.username
// fallback to "anonymous" for createdBy, and the validation error
// messages all match the inline blocks exactly.

import { Router, type Request, type Response } from 'express';

export interface ScheduledTask {
  id: string;
  name: string;
  agentId: string;
  message: string;
  cronExpr: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  lastRun?: string;
  lastResult?: string;
  lastOk?: boolean;
  nextRun?: string;
  runCount: number;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface ScheduledTasksApiDeps {
  /** Owned by server.ts — the scheduler tick loop iterates this. We
   *  receive it by reference and mutate via push/splice/find. */
  scheduledTasks: ScheduledTask[];
  parseCronToMs: (expr: string) => number;
  getNextRunTime: (task: ScheduledTask) => string;
  generateTaskId: () => string;
  executeScheduledTask: (task: ScheduledTask) => Promise<void>;
  validateAuth: AuthCheck;
}

export function createScheduledTasksRouter(deps: ScheduledTasksApiDeps): Router {
  const router = Router();
  const {
    scheduledTasks,
    parseCronToMs,
    getNextRunTime,
    generateTaskId,
    executeScheduledTask,
    validateAuth,
  } = deps;

  router.get('/', (_req: Request, res: Response) => {
    res.json({ tasks: scheduledTasks });
  });

  router.post('/', (req: Request, res: Response) => {
    const { name, agentId, message, cronExpr, enabled } = req.body;
    if (!name || !agentId || !message || !cronExpr) {
      res.status(400).json({ error: 'name, agentId, message, cronExpr are required' });
      return;
    }
    const ms = parseCronToMs(cronExpr);
    if (ms <= 0 && !cronExpr.trim().toLowerCase().match(/^daily\s+\d{1,2}:\d{2}$/)) {
      res.status(400).json({ error: "Invalid cronExpr. Use: 'every 5m', 'every 1h', 'hourly', 'daily', 'daily 09:00'" });
      return;
    }

    const auth = validateAuth(req.header('authorization') || undefined);
    const task: ScheduledTask = {
      id: generateTaskId(),
      name,
      agentId,
      message,
      cronExpr,
      enabled: enabled !== false,
      createdBy: auth.username || 'anonymous',
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    task.nextRun = getNextRunTime(task);
    scheduledTasks.push(task);
    res.json({ success: true, task });
  });

  router.put('/:taskId', (req: Request, res: Response) => {
    const task = scheduledTasks.find(t => t.id === req.params.taskId);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

    const { name, message, cronExpr, enabled } = req.body;
    if (name !== undefined) task.name = name;
    if (message !== undefined) task.message = message;
    if (cronExpr !== undefined) {
      const ms = parseCronToMs(cronExpr);
      if (ms <= 0 && !cronExpr.trim().toLowerCase().match(/^daily\s+\d{1,2}:\d{2}$/)) {
        res.status(400).json({ error: 'Invalid cronExpr' });
        return;
      }
      task.cronExpr = cronExpr;
      task.nextRun = getNextRunTime(task);
    }
    if (enabled !== undefined) task.enabled = enabled;
    res.json({ success: true, task });
  });

  router.delete('/:taskId', (req: Request, res: Response) => {
    const idx = scheduledTasks.findIndex(t => t.id === req.params.taskId);
    if (idx === -1) { res.status(404).json({ error: 'Task not found' }); return; }
    const removed = scheduledTasks.splice(idx, 1)[0];
    res.json({ success: true, removed });
  });

  router.post('/:taskId/run', async (req: Request, res: Response) => {
    const task = scheduledTasks.find(t => t.id === req.params.taskId);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    await executeScheduledTask(task);
    res.json({ success: true, task });
  });

  return router;
}

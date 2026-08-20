// /api/maintenance — CRUD + manual-trigger + history for scheduled
// maintenance jobs. Shaped after serversApi to keep auth + validation
// patterns consistent across the API surface.
//
// Routes (mounted at /api/maintenance):
//   GET    /                — list every job
//   GET    /:id             — one job
//   POST   /                — create
//   PUT    /:id             — partial update (cron / command / serverIds / enabled / …)
//   DELETE /:id             — delete (seeded jobs included — operator's call)
//   POST   /:id/run         — run immediately; returns 202 with accepted=true
//                              when queued, 409 when already running
//   GET    /:id/history     — last 20 runs (?limit=N up to 100)
//
// Auth: matches serversApi — security.read for GETs, security.write for
// mutating + run endpoints. The router has no module-internal state; all
// effects flow through the injected store + scheduler.

import { Router, type Request, type Response } from 'express';
import { CronParser } from '../scheduling/CronParser.js';
import type { MaintenanceStore, CreateJobInput, UpdateJobInput } from '../maintenance/MaintenanceStore.js';
import type { MaintenanceScheduler } from '../maintenance/MaintenanceScheduler.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface MaintenanceApiDeps {
  store: MaintenanceStore;
  scheduler: MaintenanceScheduler;
  validateAuth: AuthCheck;
  logError: (msg: string, ctx: Record<string, unknown>) => void;
}

function requireAuth(deps: MaintenanceApiDeps, req: Request, res: Response, permission: string): boolean {
  const r = deps.validateAuth(req.headers.authorization, permission);
  if (!r.ok) {
    res.status(401).json({ error: r.reason || 'unauthorized' });
    return false;
  }
  return true;
}

/** Validate create/update body. Returns a normalised CreateJobInput on
 *  success, or sends a 4xx and returns null. `partial=true` skips the
 *  required-field checks (for PUT). */
function readJobInput(body: any, res: Response, partial: boolean): CreateJobInput | null {
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'request body must be a JSON object' });
    return null;
  }
  const { id, name, description, serverIds, schedule, command, enabled, timeoutMs } = body;

  if (!partial) {
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name is required' });
      return null;
    }
    if (typeof schedule !== 'string' || !schedule.trim()) {
      res.status(400).json({ error: 'schedule is required' });
      return null;
    }
    if (typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: 'command is required' });
      return null;
    }
  }
  if (schedule !== undefined && typeof schedule === 'string') {
    const v = CronParser.validate(schedule);
    if (!v.valid) {
      res.status(400).json({ error: `invalid cron expression: ${v.error}` });
      return null;
    }
  }
  if (serverIds !== undefined) {
    if (!Array.isArray(serverIds) || serverIds.some(s => typeof s !== 'string')) {
      res.status(400).json({ error: 'serverIds must be a string array (empty = all enabled servers)' });
      return null;
    }
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || timeoutMs <= 0 || timeoutMs > 60 * 60_000)) {
    res.status(400).json({ error: 'timeoutMs must be a positive number under 1h' });
    return null;
  }
  return {
    id: typeof id === 'string' ? id : undefined,
    name: typeof name === 'string' ? name : '',
    description: typeof description === 'string' ? description : undefined,
    serverIds: Array.isArray(serverIds) ? serverIds : undefined,
    schedule: typeof schedule === 'string' ? schedule : '',
    command: typeof command === 'string' ? command : '',
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  };
}

export function createMaintenanceRouter(deps: MaintenanceApiDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    res.json({ jobs: deps.store.list() });
  });

  router.get('/:id', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    const j = deps.store.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'job not found' });
    res.json({ job: j });
  });

  router.post('/', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const input = readJobInput(req.body, res, false);
    if (!input) return;
    try {
      const j = deps.store.create({ ...input, seeded: false });
      // Stamp nextRunAt so the next 60s tick picks it up without waiting
      // for the next recomputeAllNextRuns().
      deps.scheduler.recomputeAllNextRuns();
      const fresh = deps.store.get(j.id) ?? j;
      res.status(201).json({ job: fresh });
    } catch (e: any) {
      deps.logError('maintenance create failed', { err: e.message });
      res.status(/already exists/.test(e.message) ? 409 : 500).json({ error: e.message });
    }
  });

  router.put('/:id', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const input = readJobInput(req.body, res, true);
    if (!input) return;
    const patch: UpdateJobInput = {
      name: input.name && input.name.length > 0 ? input.name : undefined,
      description: input.description,
      serverIds: input.serverIds,
      schedule: input.schedule && input.schedule.length > 0 ? input.schedule : undefined,
      command: input.command && input.command.length > 0 ? input.command : undefined,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
    };
    try {
      const updated = deps.store.update(req.params.id, patch);
      if (!updated) return res.status(404).json({ error: 'job not found' });
      deps.scheduler.recomputeAllNextRuns();
      const fresh = deps.store.get(updated.id) ?? updated;
      res.json({ job: fresh });
    } catch (e: any) {
      deps.logError('maintenance update failed', { id: req.params.id, err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    const ok = deps.store.delete(req.params.id);
    if (!ok) return res.status(404).json({ error: 'job not found' });
    res.json({ ok: true });
  });

  router.post('/:id/run', async (req, res) => {
    if (!requireAuth(deps, req, res, 'security.write')) return;
    try {
      const r = await deps.scheduler.runNow(req.params.id);
      if (!r.accepted) {
        // 404 for "not found", 409 for "still running", 503 when scheduler
        // is disabled — keeps the contract explicit so the UI can act.
        const status =
          r.reason === 'job not found' ? 404 :
          r.reason === 'job already running' ? 409 :
          r.reason === 'maintenance scheduler disabled' ? 503 :
          400;
        return res.status(status).json({ accepted: false, reason: r.reason });
      }
      res.status(202).json({ accepted: true });
    } catch (e: any) {
      deps.logError('maintenance run failed', { id: req.params.id, err: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/:id/history', (req, res) => {
    if (!requireAuth(deps, req, res, 'security.read')) return;
    const job = deps.store.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100));
    res.json({ runs: deps.store.listRuns(req.params.id, limit) });
  });

  return router;
}

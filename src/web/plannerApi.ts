import { Router, Request, Response } from 'express';
import { GoalPlanner } from '../planner/GoalPlanner.js';
import { PlanStore } from '../planner/PlanStore.js';
import { PlanExecutor } from '../planner/PlanExecutor.js';
import type { AIProviderFactory } from '../ai/factory.js';

let plannerApi: Router | null = null;
let sharedExecutor: PlanExecutor | null = null;

// SSE clients map: planId -> Set<Response>
const sseClients = new Map<string, Set<Response>>();

function broadcastPlanEvent(planId: string, data: any) {
  const clients = sseClients.get(planId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

export function createPlannerApi(aiFactory: AIProviderFactory, dbPath?: string): Router {
  if (plannerApi) return plannerApi;

  const planner = new GoalPlanner(aiFactory);
  const store = new PlanStore(dbPath);
  const executor = new PlanExecutor(planner, store);
  sharedExecutor = executor;

  // Forward executor events to SSE clients
  executor.on('event', (evt) => {
    broadcastPlanEvent(evt.planId, evt);
    // Also broadcast to wildcard listeners (for list view)
    broadcastPlanEvent('*', evt);
  });

  const router = Router();

  // POST /api/planner/plans — create and start a new plan
  router.post('/plans', async (req: Request, res: Response) => {
    const { goal, createdBy } = req.body as { goal?: string; createdBy?: string };
    if (!goal?.trim()) {
      res.status(400).json({ error: 'goal is required' });
      return;
    }

    try {
      // Decompose the goal into a plan
      const agents = (req.body.agents as string[]) || [];
      const skills = (req.body.skills as string[]) || [];
      const plan = await planner.decompose(goal.trim(), { availableAgents: agents, availableSkills: skills });
      plan.createdBy = createdBy;
      plan.status = 'planning';
      store.save(plan);

      // Start execution in background
      plan.status = 'running';
      store.save(plan);
      executor.execute(plan).catch(() => {});

      res.status(201).json(plan);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/planner/plans — list all plans
  router.get('/plans', (_req: Request, res: Response) => {
    res.json(store.list());
  });

  // GET /api/planner/plans/:id — get a specific plan
  router.get('/plans/:id', (req: Request, res: Response) => {
    const plan = store.get(req.params.id);
    if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }
    res.json(plan);
  });

  // DELETE /api/planner/plans/:id — delete a plan
  router.delete('/plans/:id', (req: Request, res: Response) => {
    store.delete(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/planner/plans/:id/pause — pause execution
  router.post('/plans/:id/pause', (req: Request, res: Response) => {
    executor.pause(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/planner/plans/:id/retry — re-run failed plan
  router.post('/plans/:id/retry', async (req: Request, res: Response) => {
    const plan = store.get(req.params.id);
    if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }
    // Reset failed nodes back to pending
    for (const node of plan.nodes) {
      if (node.status === 'failed') {
        node.status = 'pending';
        node.error = undefined;
        node.retries = 0;
      }
    }
    plan.status = 'running';
    plan.updatedAt = new Date();
    store.save(plan);
    executor.execute(plan).catch(() => {});
    res.json(plan);
  });

  // GET /api/planner/plans/:id/events — SSE stream for live updates
  router.get('/plans/:id/events', (req: Request, res: Response) => {
    const planId = req.params.id;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!sseClients.has(planId)) sseClients.set(planId, new Set());
    sseClients.get(planId)!.add(res);

    // Send current state immediately
    const plan = store.get(planId);
    if (plan) res.write(`data: ${JSON.stringify({ type: 'snapshot', plan })}\n\n`);

    req.on('close', () => {
      sseClients.get(planId)?.delete(res);
    });
  });

  // GET /api/planner/events — SSE stream for all plans
  router.get('/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!sseClients.has('*')) sseClients.set('*', new Set());
    sseClients.get('*')!.add(res);

    req.on('close', () => {
      sseClients.get('*')?.delete(res);
    });
  });

  plannerApi = router;
  return router;
}

import { Router, Request, Response } from 'express';
import type { AIProviderFactory } from '../ai/factory.js';
import { NLPTaskCreator } from '../ai/NLPTaskCreator.js';
import { WorkloadPredictor } from '../ai/WorkloadPredictor.js';

export function createAIAssistantRouter(
  aiFactory: AIProviderFactory,
  getTasks: () => any[],
  getAgents: () => any[]
): Router {
  const router = Router();
  const nlpCreator = new NLPTaskCreator(aiFactory);
  const workloadPredictor = new WorkloadPredictor(aiFactory);

  // POST /api/ai/parse-task
  // Parse natural language into a structured task
  router.post('/parse-task', async (req: Request, res: Response) => {
    try {
      const { input } = req.body || {};
      if (!input?.trim()) {
        return res.status(400).json({ error: 'input is required' });
      }
      const agents = getAgents().map(a => a.name || a.id);
      const parsed = await nlpCreator.parse(input.trim(), agents);
      return res.json({ parsed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
  });

  // POST /api/ai/suggest-tasks
  // Get proactive task suggestions based on current ops state
  router.post('/suggest-tasks', async (req: Request, res: Response) => {
    try {
      const tasks = getTasks();
      const agents = getAgents();
      const workload: Record<string, number> = {};
      for (const agent of agents) {
        const name = agent.name || agent.id;
        workload[name] = tasks.filter(
          t => t.assignedAgent === name && t.status === 'in-progress'
        ).length;
      }
      const suggestions = await nlpCreator.suggest({
        currentTasks: tasks.slice(-20),
        agentWorkload: workload,
      });
      return res.json({ suggestions });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
  });

  // POST /api/ai/workload-predict
  // Predict workload and get assignment recommendation
  router.post('/workload-predict', async (req: Request, res: Response) => {
    try {
      const { task } = req.body || {};
      const agents = getAgents();
      const tasks = getTasks();
      const prediction = await workloadPredictor.predict(agents, tasks, task || null);
      return res.json({ prediction });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
  });

  // GET /api/ai/workload-snapshot
  // Quick workload snapshot without LLM (based on live data)
  router.get('/workload-snapshot', (req: Request, res: Response) => {
    const agents = getAgents();
    const tasks = getTasks();
    const snapshot = agents.map(a => {
      const name = a.name || a.id;
      const active = tasks.filter(t => t.assignedAgent === name && t.status === 'in-progress').length;
      const completed = tasks.filter(t => t.assignedAgent === name && t.status === 'completed').length;
      const pending = tasks.filter(t => t.assignedAgent === name && t.status === 'pending').length;
      const load = Math.min(100, active * 25 + pending * 10);
      return {
        name,
        status: a.status || 'active',
        activeTasks: active,
        completedTasks: completed,
        pendingTasks: pending,
        loadPercent: load,
        recommendation: load > 75 ? 'overloaded' : load > 40 ? 'busy' : load > 0 ? 'available' : 'idle',
      };
    });
    return res.json({ snapshot, taskCount: tasks.length });
  });

  // GET /api/ai/status
  router.get('/status', async (req: Request, res: Response) => {
    const platforms = aiFactory.getAvailablePlatforms();
    let defaultProvider = null;
    try {
      const p = await aiFactory.getDefaultProvider();
      defaultProvider = p.name;
    } catch {
      defaultProvider = null;
    }
    return res.json({
      availableProviders: platforms,
      defaultProvider,
      features: ['parse-task', 'suggest-tasks', 'workload-predict', 'workload-snapshot'],
    });
  });

  return router;
}

import { Router } from 'express';
import fs from 'fs';
import { logger } from '../utils/logger.js';

const router = Router();

interface TaskRecord {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  agentId?: string;
  priority?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

interface AgentRecord {
  id: string;
  name: string;
  role?: string;
  status?: string;
}

function loadJson<T>(path: string, fallback: T): T {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, 'utf8')) as T;
  } catch (e) { logger.error('[leaderboardApi] load error', { path, e }); }
  return fallback;
}

function avgDuration(tasks: TaskRecord[]): number | null {
  const durations = tasks
    .filter(t => t.createdAt && t.completedAt)
    .map(t => (new Date(t.completedAt!).getTime() - new Date(t.createdAt!).getTime()) / 60000);
  if (!durations.length) return null;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

// GET /api/leaderboard — ranked agent performance
router.get('/', (req, res) => {
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const agentsPath = process.env.AGENTS_PATH || '/data/itops-agents/agents.json';

  const rawTasks = loadJson<any>(tasksPath, { tasks: [] });
  const rawAgents = loadJson<any>(agentsPath, { agents: [] });

  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);
  const agents: AgentRecord[] = Array.isArray(rawAgents) ? rawAgents : (rawAgents.agents ?? []);

  const entries = agents.map(agent => {
    const agentTasks = tasks.filter(t =>
      (t.assignedTo === agent.id || t.assignedTo === agent.name || t.agentId === agent.id)
    );
    const completed = agentTasks.filter(t => t.status === 'completed' || t.status === 'done');
    const failed = agentTasks.filter(t => t.status === 'failed' || t.status === 'error');
    const inProgress = agentTasks.filter(t => t.status === 'in-progress' || t.status === 'active');
    const total = agentTasks.length;

    const successRate = total > 0 ? (completed.length / total) * 100 : 0;
    const avgCompletionMinutes = avgDuration(completed);

    // Score: 60% success rate + 30% volume (capped at 20 tasks) + 10% speed bonus
    const speedBonus = avgCompletionMinutes !== null ? Math.max(0, 100 - avgCompletionMinutes / 10) : 50;
    const score = Math.round(successRate * 0.6 + Math.min(completed.length / 20, 1) * 100 * 0.3 + speedBonus * 0.1);

    // Priority handling: bonus for high/critical tasks
    const criticalCompleted = completed.filter(t => t.priority === 'critical' || t.priority === 'high').length;

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role ?? 'Agent',
      status: agent.status ?? 'unknown',
      stats: {
        total,
        completed: completed.length,
        failed: failed.length,
        inProgress: inProgress.length,
        successRate: Math.round(successRate * 10) / 10,
        avgCompletionMinutes: avgCompletionMinutes !== null ? Math.round(avgCompletionMinutes) : null,
        criticalCompleted,
      },
      score,
    };
  });

  // Sort by score desc
  entries.sort((a, b) => b.score - a.score);

  // Add rank
  const ranked = entries.map((e, i) => ({ rank: i + 1, ...e }));

  res.json({ leaderboard: ranked, total: ranked.length, generatedAt: new Date().toISOString() });
});

// GET /api/leaderboard/agent/:id — single agent detail
router.get('/agent/:id', (req, res) => {
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const agentsPath = process.env.AGENTS_PATH || '/data/itops-agents/agents.json';

  const rawTasks = loadJson<any>(tasksPath, { tasks: [] });
  const rawAgents = loadJson<any>(agentsPath, { agents: [] });

  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);
  const agents: AgentRecord[] = Array.isArray(rawAgents) ? rawAgents : (rawAgents.agents ?? []);

  const agent = agents.find(a => a.id === req.params.id || a.name === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const agentTasks = tasks.filter(t =>
    t.assignedTo === agent.id || t.assignedTo === agent.name || t.agentId === agent.id
  );

  // Task timeline — last 7 days
  const now = Date.now();
  const days: Record<string, { completed: number; failed: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().split('T')[0];
    days[d] = { completed: 0, failed: 0 };
  }
  agentTasks.forEach(t => {
    const day = (t.completedAt || t.updatedAt || '').split('T')[0];
    if (days[day]) {
      if (t.status === 'completed' || t.status === 'done') days[day].completed++;
      if (t.status === 'failed' || t.status === 'error') days[day].failed++;
    }
  });

  res.json({
    agent,
    tasks: agentTasks,
    timeline: Object.entries(days).map(([date, v]) => ({ date, ...v })),
  });
});

export default router;

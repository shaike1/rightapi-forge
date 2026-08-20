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
  dueDate?: string;
}

interface AgentRecord {
  id: string;
  name: string;
  role?: string;
  status?: string;
}

function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    }
  } catch (e) { logger.error('[analyticsApi] load error', { filePath, e }); }
  return fallback;
}

function durationMinutes(start: string | undefined, end: string | undefined): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (isNaN(ms) || ms < 0) return null;
  return ms / 60000;
}

// GET /api/analytics/overview
router.get('/overview', (req, res) => {
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const agentsPath = process.env.AGENTS_PATH || '/data/itops-agents/agents.json';

  const rawTasks = loadJsonFile<any>(tasksPath, { tasks: [] });
  const rawAgents = loadJsonFile<any>(agentsPath, { agents: [] });

  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);
  const agents: AgentRecord[] = Array.isArray(rawAgents) ? rawAgents : (rawAgents.agents ?? []);

  const total = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'done').length;
  const inProgress = tasks.filter(t => t.status === 'in-progress' || t.status === 'active').length;
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'todo').length;
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'error').length;

  const completionRate = total > 0 ? (completed / total) * 100 : 0;
  const errorRate = total > 0 ? (failed / total) * 100 : 0;

  // Completion durations
  const durations = tasks
    .filter(t => (t.status === 'completed' || t.status === 'done') && t.createdAt && t.completedAt)
    .map(t => durationMinutes(t.createdAt, t.completedAt))
    .filter((d): d is number => d !== null);

  const avgDurationMinutes = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;

  // Overdue tasks
  const now = new Date();
  const overdue = tasks.filter(t => {
    if (!t.dueDate) return false;
    if (t.status === 'completed' || t.status === 'done') return false;
    return new Date(t.dueDate) < now;
  }).length;

  res.json({
    tasks: { total, completed, inProgress, pending, failed, overdue },
    rates: { completionRate: +completionRate.toFixed(1), errorRate: +errorRate.toFixed(1) },
    performance: { avgDurationMinutes: avgDurationMinutes !== null ? +avgDurationMinutes.toFixed(1) : null },
    agents: { total: agents.length, active: agents.filter(a => a.status === 'active' || a.status === 'idle').length },
  });
});

// GET /api/analytics/agents
router.get('/agents', (req, res) => {
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const agentsPath = process.env.AGENTS_PATH || '/data/itops-agents/agents.json';

  const rawTasks = loadJsonFile<any>(tasksPath, { tasks: [] });
  const rawAgents = loadJsonFile<any>(agentsPath, { agents: [] });

  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);
  const agents: AgentRecord[] = Array.isArray(rawAgents) ? rawAgents : (rawAgents.agents ?? []);

  const agentStats = agents.map(agent => {
    const agentTasks = tasks.filter(t => t.agentId === agent.id || t.assignedTo === agent.id || t.assignedTo === agent.name);
    const completed = agentTasks.filter(t => t.status === 'completed' || t.status === 'done').length;
    const failed = agentTasks.filter(t => t.status === 'failed' || t.status === 'error').length;
    const total = agentTasks.length;

    const durations = agentTasks
      .filter(t => (t.status === 'completed' || t.status === 'done') && t.createdAt && t.completedAt)
      .map(t => durationMinutes(t.createdAt, t.completedAt))
      .filter((d): d is number => d !== null);

    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;

    // Efficiency score: weighted formula
    const completionRate = total > 0 ? completed / total : 0;
    const errorPenalty = total > 0 ? failed / total : 0;
    const speedBonus = avgDuration !== null ? Math.max(0, 1 - avgDuration / 120) * 0.2 : 0;
    const efficiencyScore = Math.round(Math.max(0, Math.min(100,
      (completionRate * 0.7 - errorPenalty * 0.3 + speedBonus) * 100
    )));

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role ?? 'Unknown',
      status: agent.status ?? 'unknown',
      tasks: { total, completed, failed, active: agentTasks.filter(t => t.status === 'in-progress' || t.status === 'active').length },
      avgDurationMinutes: avgDuration !== null ? +avgDuration.toFixed(1) : null,
      efficiencyScore,
      completionRate: total > 0 ? +(completed / total * 100).toFixed(1) : 0,
    };
  });

  // Sort by efficiency score descending
  agentStats.sort((a, b) => b.efficiencyScore - a.efficiencyScore);

  res.json(agentStats);
});

// GET /api/analytics/trends?days=7
router.get('/trends', (req, res) => {
  const days = Math.min(parseInt(req.query.days as string ?? '7', 10), 30);
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const rawTasks = loadJsonFile<any>(tasksPath, { tasks: [] });
  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);

  const now = new Date();
  const buckets: Array<{ date: string; completed: number; created: number; failed: number }> = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const created = tasks.filter(t => t.createdAt?.slice(0, 10) === dateStr).length;
    const completed = tasks.filter(t => t.completedAt?.slice(0, 10) === dateStr && (t.status === 'completed' || t.status === 'done')).length;
    const failed = tasks.filter(t => t.updatedAt?.slice(0, 10) === dateStr && (t.status === 'failed' || t.status === 'error')).length;

    buckets.push({ date: dateStr, completed, created, failed });
  }

  res.json(buckets);
});

// GET /api/analytics/sla
router.get('/sla', (_req, res) => {
  const slaPath = process.env.SLA_SNAPSHOT_PATH || '/data/itops-agents/sla-snapshots.json';
  const raw = loadJsonFile<any>(slaPath, { snapshots: [] });
  const snapshots = raw.snapshots ?? raw ?? [];

  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return res.json({ complianceRate: null, breaches: 0, snapshots: [] });
  }

  const latest = snapshots[snapshots.length - 1];
  const summary = latest?.summary ?? {};
  const total = (summary.delegationCreated ?? 0);
  const breaches = (summary.overdueEscalations ?? 0) + (summary.stalledEscalations ?? 0);
  const complianceRate = total > 0 ? +((1 - breaches / Math.max(breaches, total)) * 100).toFixed(1) : 100;

  res.json({
    complianceRate,
    breaches,
    total,
    lastSnapshot: latest?.timestamp ?? null,
    topAgents: latest?.topAgents ?? [],
    snapshots: snapshots.slice(-20),
  });
});

// GET /api/analytics/export/csv
router.get('/export/csv', (req, res) => {
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const rawTasks = loadJsonFile<any>(tasksPath, { tasks: [] });
  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);

  const header = 'id,title,status,assignedTo,priority,createdAt,completedAt,durationMinutes\n';
  const rows = tasks.map(t => {
    const dur = durationMinutes(t.createdAt, t.completedAt);
    const esc = (s: string | undefined) => `"${(s ?? '').replace(/"/g, '""')}"`;
    return [t.id, esc(t.title), t.status, esc(t.assignedTo), t.priority ?? '', t.createdAt ?? '', t.completedAt ?? '', dur !== null ? dur.toFixed(1) : ''].join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="itops-tasks-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(header + rows);
});

// GET /api/analytics/export/agents-csv
router.get('/export/agents-csv', async (req, res) => {
  // Reuse agents endpoint logic inline
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const agentsPath = process.env.AGENTS_PATH || '/data/itops-agents/agents.json';
  const rawTasks = loadJsonFile<any>(tasksPath, { tasks: [] });
  const rawAgents = loadJsonFile<any>(agentsPath, { agents: [] });
  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);
  const agents: AgentRecord[] = Array.isArray(rawAgents) ? rawAgents : (rawAgents.agents ?? []);

  const header = 'id,name,role,status,totalTasks,completed,failed,avgDurationMinutes,efficiencyScore,completionRate\n';
  const rows = agents.map(agent => {
    const agentTasks = tasks.filter(t => t.agentId === agent.id || t.assignedTo === agent.id || t.assignedTo === agent.name);
    const completed = agentTasks.filter(t => t.status === 'completed' || t.status === 'done').length;
    const failed = agentTasks.filter(t => t.status === 'failed' || t.status === 'error').length;
    const total = agentTasks.length;
    const durations = agentTasks.filter(t => t.createdAt && t.completedAt).map(t => durationMinutes(t.createdAt, t.completedAt)).filter((d): d is number => d !== null);
    const avgDur = durations.length > 0 ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1) : '';
    const cr = total > 0 ? completed / total : 0;
    const score = Math.round(Math.max(0, Math.min(100, cr * 70)));
    return [agent.id, `"${agent.name}"`, agent.role ?? '', agent.status ?? '', total, completed, failed, avgDur, score, total > 0 ? (cr * 100).toFixed(1) : '0'].join(',');
  }).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="itops-agents-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(header + rows);
});

export default router;


// Exported helper for periodic alert evaluation
export function computeMetricsForAlerts(): Record<string, number> {
  const tasksPath = process.env.TASKS_PATH || '/data/itops-agents/tasks.json';
  const slaPath = process.env.SLA_SNAPSHOT_PATH || '/data/itops-agents/sla-snapshots.json';

  const rawTasks = loadJsonFile<any>(tasksPath, { tasks: [] });
  const tasks: TaskRecord[] = Array.isArray(rawTasks) ? rawTasks : (rawTasks.tasks ?? []);

  const total = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'done').length;
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'error').length;
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'todo').length;
  const now = new Date();
  const overdue = tasks.filter(t => {
    if (!t.dueDate || t.status === 'completed' || t.status === 'done') return false;
    return new Date(t.dueDate) < now;
  }).length;

  const task_completion_rate = total > 0 ? (completed / total) * 100 : 0;
  const agent_error_rate = total > 0 ? (failed / total) * 100 : 0;

  const rawSla = loadJsonFile<any>(slaPath, { snapshots: [] });
  const snapshots = rawSla.snapshots ?? rawSla ?? [];
  let sla_breach_rate = 0;
  if (Array.isArray(snapshots) && snapshots.length > 0) {
    const latest = snapshots[snapshots.length - 1];
    const summary = latest?.summary ?? {};
    const slaTotal = summary.delegationCreated ?? 0;
    const breaches = (summary.overdueEscalations ?? 0) + (summary.stalledEscalations ?? 0);
    sla_breach_rate = slaTotal > 0 ? (breaches / slaTotal) * 100 : 0;
  }

  return { task_completion_rate, agent_error_rate, pending_tasks: pending, overdue_tasks: overdue, sla_breach_rate };
}

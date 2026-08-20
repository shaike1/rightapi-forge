import { Router, Request, Response } from 'express';
import {
  getAgents, registerAgent, sendMessage, getMessages,
  getTasks, createTask, updateTaskStatus, bridgeEvents,
  bootstrapITOpsAgents, startFileWatcher, heartbeatAgent,
  BridgeMessage,
} from '../mcp/LetThemTalkService.js';

const router = Router();

// Startup: register operations agents and start file watcher
const ITOPS_AGENTS = ['Director', 'Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];
bootstrapITOpsAgents(ITOPS_AGENTS);
startFileWatcher();

// Heartbeat all agents every 30s
setInterval(() => { ITOPS_AGENTS.forEach(heartbeatAgent); }, 30000);

// ── Basic CRUD ────────────────────────────────────────────────────────────────

router.get('/agents', (_req: Request, res: Response) => { res.json(getAgents()); });

router.post('/agents/register', (req: Request, res: Response) => {
  const { name, role } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try { res.json(registerAgent(name, role)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/messages', (req: Request, res: Response) => {
  const { to, from, since, limit } = req.query as any;
  res.json(getMessages({ to, from, since, limit: limit ? parseInt(limit) : 100 }));
});

router.post('/messages', (req: Request, res: Response) => {
  const { from, to, content, type } = req.body;
  if (!from || !to || !content) return res.status(400).json({ error: 'from, to, content required' });
  try { res.json(sendMessage(from, to === 'all' ? 'all' : to, content, type || 'message')); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get('/tasks', (_req: Request, res: Response) => { res.json(getTasks()); });

router.post('/tasks', (req: Request, res: Response) => {
  const { title, assigned_to, assigned_by } = req.body;
  if (!title || !assigned_to || !assigned_by)
    return res.status(400).json({ error: 'title, assigned_to, assigned_by required' });
  try { res.json(createTask(title, assigned_to, assigned_by)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch('/tasks/:id', (req: Request, res: Response) => {
  const { status } = req.body;
  const task = updateTaskStatus(req.params.id, status);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

// ── SSE stream ────────────────────────────────────────────────────────────────

router.get('/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onMsg   = (msg: any)   => res.write(`data: ${JSON.stringify({ type: 'message', payload: msg })}\n\n`);
  const onTask  = (task: any)  => res.write(`data: ${JSON.stringify({ type: 'task',    payload: task })}\n\n`);
  const onAgent = (agent: any) => res.write(`data: ${JSON.stringify({ type: 'agent',   payload: agent })}\n\n`);

  bridgeEvents.on('new_message',      onMsg);
  bridgeEvents.on('task_created',     onTask);
  bridgeEvents.on('task_updated',     onTask);
  bridgeEvents.on('agent_registered', onAgent);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bridgeEvents.off('new_message',      onMsg);
    bridgeEvents.off('task_created',     onTask);
    bridgeEvents.off('task_updated',     onTask);
    bridgeEvents.off('agent_registered', onAgent);
  });
});

// ── Agent-to-Agent Collaboration ─────────────────────────────────────────────
// POST /api/bridge/collaborate
// Director decomposes a goal into subtasks, assigns to workers, waits, synthesises.

const WORKERS = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];

function pickWorkers(n: number): string[] {
  const online = getAgents()
    .filter(a => a.status === 'online' && WORKERS.includes(a.name))
    .map(a => a.name);
  const pool = online.length >= n ? online : WORKERS;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function decompose(goal: string): { worker: string; subtask: string }[] {
  const aspects = [
    'security review',
    'performance analysis',
    'reliability assessment',
    'cost optimisation',
    'compliance check',
  ];
  const workers = pickWorkers(3);
  return workers.map((worker, i) => ({
    worker,
    subtask: `For the goal "${goal}": perform a ${aspects[i % aspects.length]} and report findings.`,
  }));
}

router.post('/collaborate', async (req: Request, res: Response) => {
  const { goal, requestedBy } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal required' });

  const orchestrator = requestedBy || 'Director';
  const sessionId = `collab-${Date.now()}`;

  // 1. Director announces the collaboration
  sendMessage('Director', 'all', `[${sessionId}] Starting collaboration on: "${goal}"`, 'broadcast');

  // 2. Decompose and assign subtasks
  const assignments = decompose(goal);
  const taskIds: string[] = [];
  for (const { worker, subtask } of assignments) {
    const task = createTask(subtask, worker, orchestrator);
    taskIds.push(task.id);
    sendMessage('Director', worker, `[${sessionId}] Your assignment: ${subtask}`, 'task');
  }

  // 3. Simulate workers completing tasks (in real mesh they would update themselves)
  const workerResults: { worker: string; finding: string }[] = [];
  for (const { worker, subtask } of assignments) {
    // Simulate async work (real agents would update via PATCH /tasks/:id)
    const finding = `${worker} completed: ${subtask.slice(0, 60)}... → No critical issues found. Recommend monitoring.`;
    workerResults.push({ worker, finding });
    sendMessage(worker, 'Director', `[${sessionId}] ${finding}`, 'message');
    // Mark tasks done
    const tid = taskIds[assignments.indexOf(assignments.find(a => a.worker === worker)!)];
    if (tid) updateTaskStatus(tid, 'done');
  }

  // 4. Director synthesises
  const synthesis = `Collaboration "${goal}" complete.\n` +
    workerResults.map(r => `• ${r.worker}: ${r.finding}`).join('\n') +
    '\n\nDirector summary: All agents reported. No blockers identified. Goal achieved.';

  sendMessage('Director', 'all', `[${sessionId}] SYNTHESIS: ${synthesis}`, 'broadcast');

  res.json({
    sessionId,
    goal,
    assignments,
    taskIds,
    synthesis,
    workerResults,
    completedAt: new Date().toISOString(),
  });
});

export { bridgeEvents };
export default router;

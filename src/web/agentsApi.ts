// /api/agents/* — core CRUD + skill assignment + memory + history.
// Extracted from server.ts.
//
// Routes (mount at /api/agents):
//   GET    /detail/:agentId               (no auth — preserved 1:1)
//   GET    /                              (no auth — preserved 1:1)
//   GET    /health                        (security.read)
//   GET    /analytics                     (no auth — preserved 1:1)
//   GET    /compare                       (no auth — preserved 1:1)
//   POST   /:agentId/skills               (tools.execute.privileged)
//   DELETE /:agentId/skills/:skillId      (tools.execute.privileged)
//   GET    /:agentId/history              (no auth — preserved 1:1)
//   GET    /:id/memory                    (no auth — preserved 1:1)
//   DELETE /:id/memory                    (no auth — preserved 1:1)
//   POST   /:id/memory/teach              (no auth — preserved 1:1)
//   DELETE /:agentId                      (tools.execute.privileged)
//   POST   /                              (no auth — preserved 1:1)
//   PATCH  /:agentId                      (tools.execute.privileged)
//
// Routes deliberately NOT extracted in this commit (they keep their
// inline registrations; Express falls through the router for paths
// it doesn't match):
//   GET  /capabilities                    — uses buildAgentCapabilityMatrix
//   GET  /metrics                         — uses buildAgentPerformanceMetrics
//   GET  /:agentId/tasks                  — taskManager-side surface
//   *    /:agentId/personality/*          — uses requirePermission middleware
//   *    /:id/ltm/*                       — separate long-term-memory store
//   *    /:id/message[/stream]            — chat / streaming, heavy deps
//   *    /:id/conversations               — chat history
//   *    /:id/{logs,activity}             — observability surfaces
//
// Route order matters: the catch-all DELETE/PATCH /:agentId routes
// MUST come last so they don't shadow more specific paths like
// /:agentId/skills.

import { Router, type Request, type Response } from 'express';
import type { OrganizationManager } from '../agents/Organization.js';
import type { AgentWorkloadTracker } from '../agents/AgentWorkloadTracker.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { OrchestratorService } from '../orchestrator/OrchestratorService.js';
import type { SqliteAgentMemoryStore } from '../persistence/SqliteStore.js';
import type { Task, AIPlatform } from '../types/index.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface AgentsApiDeps {
  organization: OrganizationManager;
  skillManager: SkillManager;
  taskManager: TaskManager;
  orchestratorService: OrchestratorService;
  agentMemoryStore: SqliteAgentMemoryStore;
  /** Optional — when wired, agents in GET / include their idle/busy
   *  state and current incident so the AgentsPage and Mission Control
   *  panel render real workload instead of a hardcoded 'active'. */
  workloadTracker?: AgentWorkloadTracker;
  /** Persists the org tree to disk after a write. Server.ts owns the
   *  path so we don't thread ORG_FILE through here. */
  saveOrganization: () => void;
  log: (msg: string) => void;
  validateAuth: AuthCheck;
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'dropped', 'rolled_back'];

function getTaskDurationMs(t: Task): number | null {
  if (!TERMINAL_STATUSES.includes(t.status)) return null;
  const created = t.createdAt instanceof Date ? t.createdAt : new Date(String(t.createdAt));
  const updated = t.updatedAt instanceof Date ? t.updatedAt : new Date(String(t.updatedAt));
  const ms = updated.getTime() - created.getTime();
  return ms > 0 ? ms : null;
}

export function createAgentsRouter(deps: AgentsApiDeps): Router {
  const router = Router();
  const {
    organization,
    skillManager,
    taskManager,
    orchestratorService,
    agentMemoryStore,
    workloadTracker,
    saveOrganization,
    log,
    validateAuth,
  } = deps;

  // ── Specific-path GETs (must come before /:agentId catch-alls) ────
  router.get('/detail/:agentId', (req: Request, res: Response) => {
    const agent = organization.getAgent(req.params.agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const config = agent.config || agent;
    res.json({
      id: config.id || agent.id,
      name: config.name,
      role: config.role,
      type: config.role,
      aiPlatform: config.aiPlatform,
      skills: config.skills || [],
      scope: config.scope || [],
      systemPrompt: (agent as any).systemPrompt || (config as any).systemPrompt || '',
      description: (config as any).description || '',
      domainKeywords: (config as any).domainKeywords || [],
      status: config.status || 'active',
    });
  });

  // Returns the org tree (legacy shape — director/sysadmins/specialists)
  // alongside a flat `agents` array tagged with idle/busy + current
  // incident from the workload tracker. AgentsPage and Mission Control
  // both read the flat array so the page stops rendering the hardcoded
  // "all agents are 'active'" placeholder.
  router.get('/', (_req: Request, res: Response) => {
    const tree = organization.getAgentTree() as { director?: any; sysadmins?: any[]; specialists?: any[]; error?: string };
    if (tree?.error) {
      res.json({ ...tree, agents: [] });
      return;
    }
    type Flat = {
      id: string;
      name: string;
      role: string;
      type: string;
      status: 'idle' | 'busy';
      skills: string[];
      currentIncidentId?: string;
      currentIncidentTitle?: string;
      busyStartedAt?: string;
    };
    const enrich = (raw: { id?: string; name?: string; role?: string; skills?: string[] }, role: string): Flat | null => {
      if (!raw?.id) return null;
      const id = String(raw.id);
      const wl = workloadTracker?.getStatus(id);
      const skills = Array.isArray(raw.skills) ? raw.skills.map(String) : [];
      return {
        id,
        name: String(raw.name || id),
        role: String(raw.role || role),
        type: String(raw.role || role),
        status: wl?.status === 'busy' ? 'busy' : 'idle',
        skills,
        currentIncidentId: wl?.currentIncidentId,
        currentIncidentTitle: wl?.currentIncidentTitle,
        busyStartedAt: wl?.startedAt,
      };
    };
    const flat: Flat[] = [];
    if (tree.director) {
      const d = enrich(tree.director, 'director');
      if (d) flat.push(d);
    }
    for (const sa of Array.isArray(tree.sysadmins) ? tree.sysadmins : []) {
      const f = enrich(sa, 'sysadmin');
      if (f) flat.push(f);
    }
    for (const sp of Array.isArray(tree.specialists) ? tree.specialists : []) {
      const f = enrich(sp, 'specialist');
      if (f) flat.push(f);
    }
    res.json({ ...tree, agents: flat });
  });

  router.get('/health', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const STUCK_THRESHOLD_MINUTES = Number(process.env.AGENT_STUCK_THRESHOLD_MINUTES || '30');
      const allAgents = organization.getAllAgents();
      const allTasks = taskManager.getAllTasks();
      const orchestratorStatus = orchestratorService.getStatus();
      const stuckTaskIds = new Set((orchestratorStatus.stuckEntries || []).map((e: { taskId: string }) => e.taskId));

      const agentHealthItems = allAgents.map(agent => {
        const agentTasks = allTasks.filter(t => t.assignedTo === agent.id || t.ownerId === agent.id);
        const activeTasks = agentTasks.filter(t => t.status === 'in_progress' || t.status === 'pending');
        const stuckTasks = activeTasks.filter(t => stuckTaskIds.has(t.id));

        let lastSeen: string | null = null;
        for (const t of agentTasks) {
          const ts = t.updatedAt instanceof Date ? t.updatedAt.toISOString() : String(t.updatedAt);
          if (!lastSeen || ts > lastSeen) lastSeen = ts;
        }

        const lastSeenMs = lastSeen ? Date.parse(lastSeen) : null;
        const idleMinutes = lastSeenMs ? Math.round((Date.now() - lastSeenMs) / 60_000) : null;

        let health: 'ok' | 'idle' | 'stuck' | 'unknown' = 'unknown';
        if (stuckTasks.length > 0) {
          health = 'stuck';
        } else if (idleMinutes !== null && idleMinutes > STUCK_THRESHOLD_MINUTES && activeTasks.length > 0) {
          health = 'idle';
        } else if (idleMinutes !== null) {
          health = 'ok';
        }

        return {
          agentId: agent.id,
          name: agent.name,
          status: (agent as { status?: string }).status || 'unknown',
          health,
          lastSeen,
          idleMinutes,
          taskCount: agentTasks.length,
          activeTaskCount: activeTasks.length,
          stuckTaskCount: stuckTasks.length,
          stuckTaskIds: stuckTasks.map(t => t.id),
        };
      });

      const totalStuck = agentHealthItems.reduce((s, a) => s + a.stuckTaskCount, 0);
      const totalIdle = agentHealthItems.filter(a => a.health === 'idle').length;
      res.json({
        checkedAt: new Date().toISOString(),
        stuckThresholdMinutes: STUCK_THRESHOLD_MINUTES,
        summary: { total: agentHealthItems.length, stuck: totalStuck, idle: totalIdle },
        agents: agentHealthItems,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── Performance analytics ─────────────────────────────────────────
  // No auth in the inline block — preserved 1:1.
  router.get('/analytics', (req: Request, res: Response) => {
    const agentId = req.query.agentId as string | undefined;
    const period = Math.max(1, Math.min(90, parseInt(String(req.query.period || '7'), 10)));
    const cutoff = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    let tasks = taskManager.getAllTasks().filter(t => {
      const created = t.createdAt instanceof Date ? t.createdAt : new Date(String(t.createdAt));
      return created >= cutoff;
    });

    if (agentId) {
      tasks = tasks.filter(t => t.assignedTo === agentId || t.ownerId === agentId);
    }

    const completedCount = tasks.filter(t => t.status === 'completed').length;
    const failedCount = tasks.filter(t => t.status === 'failed').length;
    const durations = tasks.map(getTaskDurationMs).filter((d): d is number => d !== null);
    const avgDurationMs = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    const dateMap = new Map<string, { completed: number; failed: number; durations: number[] }>();
    for (let i = 0; i < period; i++) {
      const d = new Date(Date.now() - (period - 1 - i) * 24 * 60 * 60 * 1000);
      dateMap.set(d.toISOString().slice(0, 10), { completed: 0, failed: 0, durations: [] });
    }
    for (const t of tasks) {
      const created = t.createdAt instanceof Date ? t.createdAt : new Date(String(t.createdAt));
      const key = created.toISOString().slice(0, 10);
      if (!dateMap.has(key)) continue;
      const entry = dateMap.get(key)!;
      if (t.status === 'completed') entry.completed++;
      else if (t.status === 'failed') entry.failed++;
      const dur = getTaskDurationMs(t);
      if (dur !== null) entry.durations.push(dur);
    }
    const timeSeries = Array.from(dateMap.entries()).map(([date, d]) => ({
      date,
      completed: d.completed,
      failed: d.failed,
      avgDuration: d.durations.length > 0
        ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length)
        : 0,
    }));

    const categoryMap = new Map<string, { count: number; completed: number }>();
    for (const t of tasks) {
      const cat = t.category || 'unknown';
      if (!categoryMap.has(cat)) categoryMap.set(cat, { count: 0, completed: 0 });
      const entry = categoryMap.get(cat)!;
      entry.count++;
      if (t.status === 'completed') entry.completed++;
    }
    const taskTypes = Array.from(categoryMap.entries()).map(([type, d]) => ({
      type,
      count: d.count,
      successRate: d.count > 0 ? Math.round((d.completed / d.count) * 100) / 100 : 0,
    }));

    const slowestTasks = tasks
      .map(t => ({ task: t, duration: getTaskDurationMs(t) }))
      .filter(x => x.duration !== null)
      .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
      .slice(0, 5)
      .map(x => ({
        taskId: x.task.id,
        type: x.task.category || 'unknown',
        durationMs: x.duration!,
        status: x.task.status,
        createdAt: x.task.createdAt instanceof Date
          ? x.task.createdAt.toISOString()
          : String(x.task.createdAt),
      }));

    res.json({
      agentId: agentId || 'all',
      period,
      summary: {
        totalTasks: tasks.length,
        completedTasks: completedCount,
        failedTasks: failedCount,
        successRate: tasks.length > 0
          ? Math.round((completedCount / tasks.length) * 100) / 100
          : 0,
        avgDurationMs,
      },
      timeSeries,
      taskTypes,
      slowestTasks,
    });
  });

  router.get('/compare', (req: Request, res: Response) => {
    const period = Math.max(1, Math.min(90, parseInt(String(req.query.period || '7'), 10)));
    const cutoff = new Date(Date.now() - period * 24 * 60 * 60 * 1000);

    const allTasks = taskManager.getAllTasks().filter(t => {
      const created = t.createdAt instanceof Date ? t.createdAt : new Date(String(t.createdAt));
      return created >= cutoff;
    });

    const agents = organization.getAllAgents();
    const agentStats = agents.map(agent => {
      const tasks = allTasks.filter(t => t.assignedTo === agent.id || t.ownerId === agent.id);
      const completedCount = tasks.filter(t => t.status === 'completed').length;
      const failedCount = tasks.filter(t => t.status === 'failed').length;
      const durations = tasks.map(getTaskDurationMs).filter((d): d is number => d !== null);
      const avgDurationMs = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;
      return {
        agentId: agent.id,
        agentName: (agent as any).config?.name || agent.id,
        role: agent.role,
        totalTasks: tasks.length,
        completedTasks: completedCount,
        failedTasks: failedCount,
        successRate: tasks.length > 0
          ? Math.round((completedCount / tasks.length) * 100) / 100
          : 0,
        avgDurationMs,
      };
    });

    res.json({ period, agents: agentStats });
  });

  // ── Skill assignment ──────────────────────────────────────────────
  router.post('/:agentId/skills', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const agentId = String(req.params.agentId || '');
    const skillId = String(req.body?.skillId || '').trim();
    if (!agentId || !skillId) {
      res.status(400).json({ error: 'agentId and skillId are required' });
      return;
    }
    const agent = organization.getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const skill = skillManager.get(skillId);
    if (!skill) { res.status(404).json({ error: 'Skill not found' }); return; }
    agent.assignSkill(skillId);
    saveOrganization();
    res.json({ success: true, agent: agent.toJSON() });
  });

  router.delete('/:agentId/skills/:skillId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const agentId = String(req.params.agentId || '');
    const skillId = String(req.params.skillId || '').trim();
    if (!agentId || !skillId) {
      res.status(400).json({ error: 'agentId and skillId are required' });
      return;
    }
    const agent = organization.getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    agent.removeSkill(skillId);
    saveOrganization();
    res.json({ success: true, agent: agent.toJSON() });
  });

  // ── History (chat-style backlog from Agent class) ─────────────────
  router.get('/:agentId/history', (req: Request, res: Response) => {
    const agent = organization.getAgent(req.params.agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json({
      agentId: agent.id,
      agentName: agent.name,
      messages: agent.getHistory(),
    });
  });

  // ── Memory (sqlite-backed agent-memory store) ─────────────────────
  router.get('/:id/memory', (req: Request, res: Response) => {
    const agentId = req.params.id;
    const agent = organization.getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const facts = agentMemoryStore.getFacts(agentId);
    const resolutions = agentMemoryStore.listResolutions(agentId);
    const stats = agentMemoryStore.getMemoryStats(agentId);
    res.json({ facts, resolutions, stats });
  });

  router.delete('/:id/memory', (req: Request, res: Response) => {
    const agentId = req.params.id;
    const agent = organization.getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    agentMemoryStore.clearAll(agentId);
    res.json({ success: true });
  });

  router.post('/:id/memory/teach', (req: Request, res: Response) => {
    const agentId = req.params.id;
    const agent = organization.getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const fact = typeof req.body?.fact === 'string' ? req.body.fact.trim() : '';
    if (!fact) { res.status(400).json({ error: 'fact is required' }); return; }
    agentMemoryStore.rememberFact(agentId, fact);
    res.json({ success: true });
  });

  // ── Create ────────────────────────────────────────────────────────
  // No auth in the inline block — preserved 1:1.
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { name, role, platform, specialty } = req.body;
      let agent;

      if (role === 'director') {
        agent = await organization.createDirector(platform);
      } else if (role === 'sysadmin') {
        agent = await organization.createSysAdmin(name, platform);
      } else if (role === 'specialist') {
        agent = await organization.createSpecialist(name, specialty || 'general', platform);
      }

      if (agent && req.body.systemPrompt) {
        (agent as any).systemPrompt = req.body.systemPrompt;
        (agent.config as any).systemPrompt = req.body.systemPrompt;
      }
      if (agent && req.body.description) {
        (agent.config as any).description = req.body.description;
      }
      if (agent && Array.isArray(req.body.domainKeywords)) {
        (agent.config as any).domainKeywords = req.body.domainKeywords;
      }

      res.json(agent);

      // שמור את הארגון לקובץ
      saveOrganization();
      log('💾 Organization saved');
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── Catch-all /:agentId routes — MUST come last ───────────────────
  router.delete('/:agentId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const deleted = organization.deleteAgent(req.params.agentId);
    if (!deleted) {
      res.status(404).json({ error: 'Agent not found or cannot be deleted' });
      return;
    }
    saveOrganization();
    res.json({ success: true, agentId: req.params.agentId });
  });

  router.patch('/:agentId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const agentId = String(req.params.agentId || '');
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const agent = organization.getAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name) {
      agent.config.name = name;
    }
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim() : '';
    if (platform) {
      if (!['claude', 'openai', 'ollama'].includes(platform)) {
        res.status(400).json({ error: 'Unsupported platform' });
        return;
      }
      agent.config.aiPlatform = platform as AIPlatform;
    }
    const specialty = typeof req.body?.specialty === 'string' ? req.body.specialty.trim().toLowerCase() : '';
    if (specialty && agent.config.role === 'specialist') {
      const existing = Array.isArray(agent.config.skills) ? agent.config.skills : [];
      const remaining = existing.filter(skill => skill && skill !== existing[0]);
      agent.config.skills = [specialty].concat(remaining);
    }
    // Phase 34: Custom system prompt and domain keywords
    const systemPrompt = typeof req.body?.systemPrompt === 'string' ? req.body.systemPrompt : undefined;
    if (systemPrompt !== undefined) {
      (agent as any).systemPrompt = systemPrompt;
      (agent.config as any).systemPrompt = systemPrompt;
    }
    const domainKeywords = req.body?.domainKeywords;
    if (Array.isArray(domainKeywords)) {
      (agent.config as any).domainKeywords = domainKeywords;
    }
    const description = typeof req.body?.description === 'string' ? req.body.description : undefined;
    if (description !== undefined) {
      (agent.config as any).description = description;
    }

    saveOrganization();
    res.json({ success: true, agent: agent.toJSON() });
  });

  return router;
}

import { Router, type NextFunction } from "express";
import type { Request, Response } from "express";

export type MissionControlActivitySeverity = "info" | "warning" | "error";

interface MissionControlTaskInput {
  id?: string;
  title?: string;
  status?: string;
  ownerId?: string;
  assignedTo?: string;
  createdAt?: string;
  updatedAt?: string;
  priority?: string;
  category?: string;
}

interface MissionControlThreadInput {
  threadId?: string;
  messageCount?: number;
  lastStatus?: string;
  ownerAgentId?: string;
  lastMessageAt?: string;
}

interface BuildMissionControlActivityEventsInput {
  tasks?: MissionControlTaskInput[];
  threads?: MissionControlThreadInput[];
  agentsById?: Map<string, string>;
  options?: {
    agentId?: string;
    severity?: MissionControlActivitySeverity;
    limit?: unknown;
  };
}

interface MissionControlActivityEvent {
  id: string;
  type: "task" | "thread";
  severity: MissionControlActivitySeverity;
  message: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  metadata?: Record<string, unknown>;
}

const router = Router();

const VALID_SEVERITIES = new Set<MissionControlActivitySeverity>(["info", "warning", "error"]);

function normalizeSeverity(value: unknown): MissionControlActivitySeverity | undefined {
  if (typeof value !== "string") return undefined;
  if (VALID_SEVERITIES.has(value as MissionControlActivitySeverity)) {
    return value as MissionControlActivitySeverity;
  }
  return undefined;
}

function parseTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function getTaskSeverity(status: string): MissionControlActivitySeverity {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "failed" || normalized === "error") return "error";
  if (normalized === "blocked" || normalized === "pending" || normalized === "assigned") return "warning";
  return "info";
}

function getThreadSeverity(lastStatus: string): MissionControlActivitySeverity {
  const normalized = String(lastStatus || "").toLowerCase();
  if (normalized === "failed" || normalized === "error") return "error";
  if (normalized === "sent" || normalized === "delivered") return "warning";
  return "info";
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(Math.floor(parsed), 200);
}

function createAgentNameMap(): Map<string, string> {
  const tree = (globalThis as any).organization?.getAgentTree?.();
  const map = new Map<string, string>();

  if (tree?.director?.id) {
    map.set(String(tree.director.id), String(tree.director.name || tree.director.id));
  }

  for (const agent of tree?.sysadmins || []) {
    if (!agent?.id) continue;
    map.set(String(agent.id), String(agent.name || agent.id));
  }

  for (const agent of tree?.specialists || []) {
    if (!agent?.id) continue;
    map.set(String(agent.id), String(agent.name || agent.id));
  }

  return map;
}

export function buildMissionControlActivityEvents(input: BuildMissionControlActivityEventsInput): MissionControlActivityEvent[] {
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const threads = Array.isArray(input.threads) ? input.threads : [];
  const agentsById = input.agentsById || new Map<string, string>();
  const agentIdFilter = typeof input.options?.agentId === "string" ? input.options.agentId : undefined;
  const severityFilter = normalizeSeverity(input.options?.severity);
  const limit = normalizeLimit(input.options?.limit);

  const taskEvents: MissionControlActivityEvent[] = tasks
    .filter((task) => task && task.id)
    .map((task) => {
      const ownerId = String(task.assignedTo || task.ownerId || "").trim() || undefined;
      const severity = getTaskSeverity(String(task.status || ""));
      const timestamp = parseTimestamp(task.updatedAt || task.createdAt);

      return {
        id: `task:${task.id}:${timestamp}`,
        type: "task",
        severity,
        message: `${task.title || "Task"} is ${task.status || "updated"}`,
        timestamp,
        agentId: ownerId,
        agentName: ownerId ? agentsById.get(ownerId) : undefined,
        metadata: {
          taskId: task.id,
          priority: task.priority,
          category: task.category,
          status: task.status
        }
      };
    });

  const threadEvents: MissionControlActivityEvent[] = threads
    .filter((thread) => thread && thread.threadId)
    .map((thread) => {
      const ownerId = String(thread.ownerAgentId || "").trim() || undefined;
      const severity = getThreadSeverity(String(thread.lastStatus || ""));
      const timestamp = parseTimestamp(thread.lastMessageAt);
      const count = Number.isFinite(thread.messageCount) ? Number(thread.messageCount) : 0;

      return {
        id: `thread:${thread.threadId}:${timestamp}`,
        type: "thread",
        severity,
        message: `Thread ${thread.threadId} has ${count} message${count === 1 ? "" : "s"}`,
        timestamp,
        agentId: ownerId,
        agentName: ownerId ? agentsById.get(ownerId) : undefined,
        metadata: {
          threadId: thread.threadId,
          messageCount: count,
          lastStatus: thread.lastStatus
        }
      };
    });

  const combined = [...taskEvents, ...threadEvents]
    .filter((event) => !agentIdFilter || event.agentId === agentIdFilter)
    .filter((event) => !severityFilter || event.severity === severityFilter)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);

  return combined;
}

const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized - Please login" });
    return;
  }
  next();
};

router.get("/dashboard", requireAuth, (_req: Request, res: Response) => {
  const allTasks = (globalThis as any).taskManager?.getAllTasks?.() || [];
  const now = Date.now();
  const day = 86400000;

  res.json({
    boards: { totalBoards: 3, activeBoards: 2, archivedBoards: 1 },
    activity: {
      recentCount: allTasks.length,
      last24Hours: allTasks.filter((task: any) => now - new Date(task.createdAt).getTime() < day).length,
      last7Days: allTasks.filter((task: any) => now - new Date(task.createdAt).getTime() < day * 7).length
    },
    approvals: { pending: 0, approved: 5, rejected: 2 },
    gateways: { total: 2, online: 1, offline: 1 }
  });
});

router.get("/agents", requireAuth, (_req: Request, res: Response) => {
  const org = (globalThis as any).organization;
  const tracker = (globalThis as any).agentWorkloadTracker as
    | { getStatus: (id: string) => { status: 'idle' | 'busy'; currentIncidentId?: string; currentIncidentTitle?: string; startedAt?: string } }
    | undefined;
  const tree = org?.getAgentTree?.();

  if (!tree) {
    res.json({ agents: [] });
    return;
  }

  type FlatAgent = {
    id: string;
    name: string;
    role: string;
    status: 'idle' | 'busy';
    skills: number;
    currentIncidentId?: string;
    currentIncidentTitle?: string;
    busyStartedAt?: string;
  };
  const flatten: FlatAgent[] = [];

  const push = (raw: { id?: string; name?: string; skills?: unknown[] }, role: string, fallbackName: string) => {
    if (!raw?.id) return;
    const id = String(raw.id);
    const wl = tracker?.getStatus?.(id);
    flatten.push({
      id,
      name: String(raw.name || fallbackName),
      role,
      status: wl?.status === 'busy' ? 'busy' : 'idle',
      skills: Array.isArray(raw.skills) ? raw.skills.length : 0,
      currentIncidentId: wl?.currentIncidentId,
      currentIncidentTitle: wl?.currentIncidentTitle,
      busyStartedAt: wl?.startedAt,
    });
  };

  if (tree.director) push(tree.director, 'director', 'IT Director');
  for (const agent of Array.isArray(tree.sysadmins) ? tree.sysadmins : []) push(agent, 'sysadmin', 'SysAdmin');
  for (const agent of Array.isArray(tree.specialists) ? tree.specialists : []) push(agent, 'specialist', 'Specialist');

  res.json({ agents: flatten });
});

router.get("/tasks", requireAuth, (_req: Request, res: Response) => {
  const tasks = (globalThis as any).taskManager?.getAllTasks?.() || [];
  res.json({
    tasks: tasks.map((task: any) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      category: task.category,
      assignedTo: task.assignedTo,
      createdAt: task.createdAt
    }))
  });
});

router.post("/actions", requireAuth, (req: Request, res: Response) => {
  const { action, data } = req.body || {};
  if (action === "create-task") {
    const taskManager = (globalThis as any).taskManager;
    if (taskManager?.createTask) {
      const task = taskManager.createTask({
        title: data.title || "New Task",
        description: data.description || "",
        priority: data.priority || "medium",
        category: data.category || "general",
        ownerId: "dashboard"
      });
      res.json({ success: true, taskId: task.id });
      return;
    }
  }
  res.json({ success: false, error: "Unknown action" });
});

router.get("/skills", requireAuth, (_req: Request, res: Response) => {
  const skills = (globalThis as any).skillManager?.getAll?.() || [];
  res.json({
    skills: skills.map((skill: any) => ({
      id: skill.id,
      name: skill.name,
      category: skill.category,
      commands: skill.commands?.length || 0,
      enabled: skill.enabled
    }))
  });
});

router.get("/logs", requireAuth, (_req: Request, res: Response) => {
  res.json({
    logs: [
      { level: "info", message: "System running", timestamp: new Date().toISOString() },
      { level: "info", message: "Dashboard connected", timestamp: new Date().toISOString() }
    ]
  });
});

router.get("/activity", requireAuth, (req: Request, res: Response) => {
  const taskManager = (globalThis as any).taskManager;
  const agentBus = (globalThis as any).agentBus;

  const tasks = taskManager?.getAllTasks?.() || [];
  const threads = (agentBus?.listThreads?.({ limit: 200 }) || []).map((thread: any) => ({
    threadId: thread.threadId,
    messageCount: thread.messageCount,
    lastStatus: thread.lastStatus,
    ownerAgentId: Array.isArray(thread.participants) ? thread.participants[0] : undefined,
    lastMessageAt: thread.lastMessageAt
  }));

  const events = buildMissionControlActivityEvents({
    tasks,
    threads,
    agentsById: createAgentNameMap(),
    options: {
      agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
      severity: normalizeSeverity(req.query.severity),
      limit: req.query.limit
    }
  });

  res.json({ events });
});

export default router;

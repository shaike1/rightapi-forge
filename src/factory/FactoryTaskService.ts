import fs from "fs";
import path from "path";

export type FactoryTaskState =
  | "proposed"
  | "specified"
  | "ready"
  | "in_progress"
  | "in_review"
  | "in_qa"
  | "releasable"
  | "released";

export interface GateResult {
  gate: string;
  result: "pass" | "fail";
  notes: string;
  actor: string;
  timestamp: string;
}

export interface FactoryTask {
  id: string;
  title: string;
  description: string;
  state: FactoryTaskState;
  gateResults: GateResult[];
  createdAt: string;
  updatedAt: string;
  actor: string;
}

interface FactoryTaskFile {
  version: number;
  tasks: FactoryTask[];
}

const VALID_TRANSITIONS: Record<FactoryTaskState, FactoryTaskState[]> = {
  proposed: ["specified"],
  specified: ["ready"],
  ready: ["in_progress"],
  in_progress: ["in_review"],
  in_review: ["in_qa", "in_progress"],
  in_qa: ["releasable", "in_progress"],
  releasable: ["released"],
  released: []
};

const VALID_STATES = new Set<FactoryTaskState>([
  "proposed",
  "specified",
  "ready",
  "in_progress",
  "in_review",
  "in_qa",
  "releasable",
  "released"
]);

function getDefaultTasksPath(): string {
  return process.env.FACTORY_TASKS_PATH || "/data/itops-agents/factory-tasks.json";
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeState(value: unknown): FactoryTaskState {
  if (typeof value === "string" && VALID_STATES.has(value as FactoryTaskState)) {
    return value as FactoryTaskState;
  }
  return "proposed";
}

function normalizeTask(raw: FactoryTask): FactoryTask {
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const gateResults = Array.isArray(raw.gateResults)
    ? raw.gateResults.map((g) => ({
        gate: String(g?.gate || ""),
        result: g?.result === "fail" ? "fail" as const : "pass" as const,
        notes: String(g?.notes || ""),
        actor: String(g?.actor || ""),
        timestamp: typeof g?.timestamp === "string" ? g.timestamp : updatedAt
      }))
    : [];

  return {
    id: String(raw.id || `ft-${randomId()}`),
    title: String(raw.title || "Untitled task"),
    description: String(raw.description || ""),
    state: normalizeState(raw.state),
    gateResults,
    createdAt,
    updatedAt,
    actor: String(raw.actor || "")
  };
}

export class FactoryTaskService {
  private static instance: FactoryTaskService;
  private readonly tasks = new Map<string, FactoryTask>();
  private readonly tasksPath: string;

  private constructor(options?: { tasksPath?: string }) {
    this.tasksPath = options?.tasksPath || getDefaultTasksPath();
    this.load();
  }

  static getInstance(): FactoryTaskService {
    if (!FactoryTaskService.instance) FactoryTaskService.instance = new FactoryTaskService();
    return FactoryTaskService.instance;
  }

  create(title: string, description: string, actor: string): FactoryTask {
    const now = nowIso();
    const task: FactoryTask = {
      id: `ft-${randomId()}`,
      title: String(title),
      description: String(description),
      state: "proposed",
      gateResults: [],
      createdAt: now,
      updatedAt: now,
      actor: String(actor)
    };
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  get(id: string): FactoryTask | undefined {
    return this.tasks.get(id);
  }

  list(state?: FactoryTaskState): FactoryTask[] {
    const all = [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (state === undefined) return all;
    return all.filter((t) => t.state === state);
  }

  transition(id: string, toState: FactoryTaskState, actor: string): FactoryTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    if (task.state === toState) {
      throw new Error(`Task already in state: ${toState}`);
    }

    const allowed = VALID_TRANSITIONS[task.state];
    if (!allowed.includes(toState)) {
      throw new Error(
        `Invalid transition: ${task.state} → ${toState}. Allowed: [${allowed.join(", ")}]`
      );
    }

    task.state = toState;
    task.actor = String(actor);
    task.updatedAt = nowIso();
    this.tasks.set(id, task);
    this.save();
    return task;
  }

  recordGateResult(
    id: string,
    gate: string,
    result: "pass" | "fail",
    notes: string,
    actor: string
  ): FactoryTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    if (!gate || gate.trim() === "") throw new Error("Missing required field: gate");
    if (!actor || actor.trim() === "") throw new Error("Missing required field: actor");

    const gateResult: GateResult = {
      gate: String(gate),
      result,
      notes: String(notes),
      actor: String(actor),
      timestamp: nowIso()
    };

    task.gateResults.push(gateResult);
    task.updatedAt = nowIso();
    this.tasks.set(id, task);
    this.save();
    return task;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.tasksPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.tasksPath, "utf8")) as FactoryTaskFile;
      for (const rawTask of parsed.tasks || []) {
        const task = normalizeTask(rawTask);
        this.tasks.set(task.id, task);
      }
    } catch {
      this.tasks.clear();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.tasksPath), { recursive: true });
    const payload: FactoryTaskFile = {
      version: 1,
      tasks: this.list()
    };
    fs.writeFileSync(this.tasksPath, JSON.stringify(payload, null, 2), "utf8");
  }
}

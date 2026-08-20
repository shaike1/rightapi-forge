import fs from "fs";
import path from "path";
import { logger } from '../utils/logger.js';

export type WorkflowStageStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface WorkflowTemplate {
  id: string;
  name: string;
  trigger: string;
  stages: string[];
  scheduleInterval?: number;   // run every N minutes (0 or absent = disabled)
  lastScheduledAt?: string;    // ISO timestamp of last scheduled run start
}

export interface WorkflowRun {
  id: string;
  templateId: string;
  taskId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  currentStageIndex: number;
  status: "active" | "completed" | "failed";
  stages: Array<{
    name: string;
    status: WorkflowStageStatus;
    owner?: string;
    notes?: string;
    updatedAt: string;
  }>;
}

interface WorkflowRunFile {
  version: number;
  runs: WorkflowRun[];
  lastRecovery?: WorkflowRecoveryReport;
}

export interface DriftedRun {
  id: string;
  name: string;
  currentStage: string;
  lastUpdateAgeMs: number;
  isDrifted: boolean;
  isStuck: boolean;
}

export interface WorkflowSweepResult {
  totalActive: number;
  driftedCount: number;
  stuckCount: number;
  oldestRunAgeMs: number;
  driftedRuns: DriftedRun[];
  sweptAt: string;
  lastRecovery?: WorkflowRecoveryReport;
}

export type WorkflowRecoveryDecision =
  | { action: "keep" }
  | { action: "completed" | "failed"; reason: string };

export interface WorkflowRecoveryReport {
  scanned: number;
  completed: number;
  failed: number;
  deduplicated: number;
  changedRunIds: string[];
  recoveredAt: string;
}

const DEFAULT_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "incident-response",
    name: "Incident Response",
    trigger: "alert|outage|incident",
    stages: ["triage", "assign", "mitigate", "validate", "postmortem"]
  },
  {
    id: "change-deploy",
    name: "Change and Deploy",
    trigger: "deploy|release|change",
    stages: ["plan", "review", "execute", "verify", "rollback_or_close"]
  }
];

const DEFAULT_TEMPLATE_IDS = new Set(DEFAULT_TEMPLATES.map((t) => t.id));

const VALID_STAGE_STATUSES = new Set<WorkflowStageStatus>([
  "pending",
  "in_progress",
  "done",
  "failed",
  "skipped"
]);

function getDefaultRunsPath(): string {
  return process.env.WORKFLOW_RUNS_PATH || "/data/itops-agents/workflow-runs.json";
}

function getDefaultMaxRuns(): number {
  const rawMaxRuns = Number(process.env.WORKFLOW_MAX_RUNS || "2000");
  return Number.isFinite(rawMaxRuns) && rawMaxRuns > 0
    ? Math.min(Math.floor(rawMaxRuns), 10_000)
    : 2000;
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStageStatus(value: unknown, fallback: WorkflowStageStatus): WorkflowStageStatus {
  if (typeof value === "string" && VALID_STAGE_STATUSES.has(value as WorkflowStageStatus)) {
    return value as WorkflowStageStatus;
  }
  return fallback;
}

function normalizeRun(raw: WorkflowRun): WorkflowRun {
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const stages = Array.isArray(raw.stages)
    ? raw.stages.map((stage) => ({
        name: String(stage?.name || "unknown"),
        status: normalizeStageStatus(stage?.status, "pending"),
        owner: typeof stage?.owner === "string" && stage.owner.trim() ? stage.owner.trim() : undefined,
        notes: typeof stage?.notes === "string" && stage.notes.trim() ? stage.notes : undefined,
        updatedAt: typeof stage?.updatedAt === "string" ? stage.updatedAt : updatedAt
      }))
    : [];

  const normalized: WorkflowRun = {
    id: String(raw.id || `wf-${randomId()}`),
    templateId: String(raw.templateId || "unknown"),
    taskId: String(raw.taskId || ""),
    title: String(raw.title || "Untitled workflow run"),
    createdAt,
    updatedAt,
    currentStageIndex: Number.isFinite(raw.currentStageIndex)
      ? Math.max(0, Math.min(Math.floor(raw.currentStageIndex), Math.max(stages.length - 1, 0)))
      : 0,
    status: raw.status === "failed" || raw.status === "completed" ? raw.status : "active",
    stages
  };

  return normalized;
}

export class WorkflowEngine {
  private static instance: WorkflowEngine;
  private readonly templates = new Map<string, WorkflowTemplate>();
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly runsPath: string;
  private readonly maxRuns: number;
  private readonly templatesPath: string;
  private lastRecoveryReport?: WorkflowRecoveryReport;

  private constructor(options?: { runsPath?: string; maxRuns?: number }) {
    DEFAULT_TEMPLATES.forEach((template) => this.templates.set(template.id, template));
    this.runsPath = options?.runsPath || getDefaultRunsPath();
    this.maxRuns = options?.maxRuns || getDefaultMaxRuns();
    this.templatesPath = process.env.WORKFLOW_TEMPLATES_PATH || '/data/itops-agents/workflow-templates.json';
    this.load();
    this._loadCustomTemplates();
  }

  static getInstance(): WorkflowEngine {
    if (!WorkflowEngine.instance) WorkflowEngine.instance = new WorkflowEngine();
    return WorkflowEngine.instance;
  }

  listTemplates(): WorkflowTemplate[] {
    return [...this.templates.values()];
  }

  listRuns(): WorkflowRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  startRun(input: { templateId: string; taskId: string; title: string }): WorkflowRun {
    const template = this.templates.get(input.templateId);
    if (!template) throw new Error(`Unknown template: ${input.templateId}`);

    const existing = [...this.runs.values()].find(run =>
      run.status === "active" && run.templateId === input.templateId && run.taskId === String(input.taskId)
    );
    if (existing) return existing;

    const now = nowIso();
    const run: WorkflowRun = {
      id: `wf-${randomId()}`,
      templateId: template.id,
      taskId: String(input.taskId),
      title: String(input.title),
      createdAt: now,
      updatedAt: now,
      currentStageIndex: 0,
      status: "active",
      stages: template.stages.map((name, index) => ({
        name,
        status: index === 0 ? "in_progress" : "pending",
        updatedAt: now
      }))
    };

    this.runs.set(run.id, run);
    this.normalizeRunState(run.id);
    this.trimAndSave();
    return run;
  }

  updateStage(
    runId: string,
    stageName: string,
    patch: { status: WorkflowStageStatus; owner?: string; notes?: string }
  ): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const stageIndex = run.stages.findIndex((stage) => stage.name === stageName);
    if (stageIndex === -1) throw new Error(`Stage not found: ${stageName}`);

    const now = nowIso();
    run.stages[stageIndex] = {
      ...run.stages[stageIndex],
      status: patch.status,
      owner: typeof patch.owner === "string" && patch.owner.trim() ? patch.owner.trim() : run.stages[stageIndex].owner,
      notes: typeof patch.notes === "string" ? patch.notes.trim() || undefined : run.stages[stageIndex].notes,
      updatedAt: now
    };

    if (patch.status === "done") {
      const nextIndex = stageIndex + 1;
      if (nextIndex < run.stages.length && run.stages[nextIndex].status === "pending") {
        run.stages[nextIndex] = {
          ...run.stages[nextIndex],
          status: "in_progress",
          updatedAt: now
        };
        // Notify that the next stage is now active
        if (this._onStageActive) {
          try { this._onStageActive(runId, run.stages[nextIndex].name, run.stages[nextIndex].owner); }
          catch (e) { logger.error('[WorkflowEngine] onStageActive callback error:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }
        }
      }
    }

    if (patch.status === "in_progress") {
      run.currentStageIndex = stageIndex;
      // Notify that this stage is now active (direct in_progress transition)
      if (this._onStageActive) {
        try { this._onStageActive(runId, run.stages[stageIndex].name, run.stages[stageIndex].owner); }
        catch (e) { logger.error('[WorkflowEngine] onStageActive callback error:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }); }
      }
    }

    const normalized = this.normalizeRunState(runId);
    this.save();
    return normalized;
  }

  reconcileRun(runId: string): WorkflowRun {
    const normalized = this.normalizeRunState(runId);
    this.save();
    return normalized;
  }

  recoverActiveRuns(classify: (run: WorkflowRun) => WorkflowRecoveryDecision): WorkflowRecoveryReport {
    const active = [...this.runs.values()]
      .filter(run => run.status === "active")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const seen = new Set<string>();
    const report: WorkflowRecoveryReport = {
      scanned: active.length, completed: 0, failed: 0, deduplicated: 0,
      changedRunIds: [], recoveredAt: nowIso(),
    };

    for (const run of active) {
      const key = `${run.templateId}\u0000${run.taskId}`;
      let decision: WorkflowRecoveryDecision;
      if (seen.has(key)) {
        decision = { action: "failed", reason: "Superseded duplicate active workflow run" };
        report.deduplicated++;
      } else {
        seen.add(key);
        try { decision = classify(run); } catch { decision = { action: "keep" }; }
      }
      if (decision.action === "keep") continue;
      this.terminalizeRun(run, decision.action, decision.reason, report.recoveredAt);
      report[decision.action]++;
      report.changedRunIds.push(run.id);
    }
    if (report.changedRunIds.length > 0 || !this.lastRecoveryReport) {
      this.lastRecoveryReport = report;
      this.save();
    }
    return report;
  }

  private terminalizeRun(run: WorkflowRun, status: "completed" | "failed", reason: string, timestamp: string): void {
    if (status === "completed") {
      run.stages = run.stages.map(stage => stage.status === "done" || stage.status === "skipped"
        ? stage
        : { ...stage, status: "skipped", notes: appendNote(stage.notes, reason), updatedAt: timestamp });
      run.currentStageIndex = Math.max(0, run.stages.length - 1);
    } else if (run.stages.length > 0) {
      const index = Math.min(run.currentStageIndex, run.stages.length - 1);
      run.stages[index] = {
        ...run.stages[index], status: "failed", notes: appendNote(run.stages[index].notes, reason), updatedAt: timestamp,
      };
      run.currentStageIndex = index;
    }
    run.status = status;
    run.updatedAt = timestamp;
    this.runs.set(run.id, run);
  }

  private normalizeRunState(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.stages.length === 0) {
      run.status = "completed";
      run.currentStageIndex = 0;
      run.updatedAt = nowIso();
      this.runs.set(runId, run);
      return run;
    }

    const now = nowIso();
    const failedIndex = run.stages.findIndex((stage) => stage.status === "failed");
    if (failedIndex >= 0) {
      for (let i = 0; i < run.stages.length; i += 1) {
        if (i !== failedIndex && run.stages[i].status === "in_progress") {
          run.stages[i] = {
            ...run.stages[i],
            status: "pending",
            updatedAt: now
          };
        }
      }
      run.status = "failed";
      run.currentStageIndex = failedIndex;
      run.updatedAt = now;
      this.runs.set(runId, run);
      return run;
    }

    const allDone = run.stages.every((stage) => stage.status === "done" || stage.status === "skipped");
    if (allDone) {
      run.status = "completed";
      run.currentStageIndex = Math.max(0, run.stages.length - 1);
      run.updatedAt = now;
      this.runs.set(runId, run);
      return run;
    }

    let inProgressIndex = run.stages.findIndex((stage) => stage.status === "in_progress");

    if (inProgressIndex === -1) {
      inProgressIndex = run.stages.findIndex((stage) => stage.status === "pending");
      if (inProgressIndex >= 0) {
        run.stages[inProgressIndex] = {
          ...run.stages[inProgressIndex],
          status: "in_progress",
          updatedAt: now
        };
      }
    }

    if (inProgressIndex >= 0) {
      for (let i = 0; i < run.stages.length; i += 1) {
        if (i !== inProgressIndex && run.stages[i].status === "in_progress") {
          run.stages[i] = {
            ...run.stages[i],
            status: "pending",
            updatedAt: now
          };
        }
      }
      run.currentStageIndex = inProgressIndex;
    }

    run.status = "active";
    run.updatedAt = now;
    this.runs.set(runId, run);
    return run;
  }

  private trimAndSave(): void {
    if (this.runs.size > this.maxRuns) {
      const sortedIds = [...this.runs.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((run) => run.id);

      const removeCount = this.runs.size - this.maxRuns;
      for (const id of sortedIds.slice(0, removeCount)) {
        this.runs.delete(id);
      }
    }

    this.save();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.runsPath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.runsPath, "utf8")) as WorkflowRunFile;
      this.lastRecoveryReport = parsed.lastRecovery;
      for (const rawRun of parsed.runs || []) {
        const run = normalizeRun(rawRun);
        this.runs.set(run.id, run);
      }
    } catch {
      this.runs.clear();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.runsPath), { recursive: true });
    const payload: WorkflowRunFile = {
      version: 1,
      runs: this.listRuns(),
      lastRecovery: this.lastRecoveryReport,
    };
    fs.writeFileSync(this.runsPath, JSON.stringify(payload, null, 2), "utf8");
  }

  sweep(thresholdMinutes?: number): WorkflowSweepResult {
    const envMinutes = Number(process.env.WORKFLOW_DRIFT_THRESHOLD_MINUTES || "30");
    const resolvedMinutes =
      typeof thresholdMinutes === "number" && Number.isFinite(thresholdMinutes) && thresholdMinutes > 0
        ? thresholdMinutes
        : Number.isFinite(envMinutes) && envMinutes > 0
        ? envMinutes
        : 30;

    const thresholdMs = resolvedMinutes * 60 * 1000;
    const now = Date.now();
    const activeRuns = [...this.runs.values()].filter((run) => run.status === "active");

    const driftedRuns: DriftedRun[] = [];
    let oldestRunAgeMs = 0;

    for (const run of activeRuns) {
      const lastUpdateAgeMs = now - new Date(run.updatedAt).getTime();
      if (lastUpdateAgeMs > oldestRunAgeMs) {
        oldestRunAgeMs = lastUpdateAgeMs;
      }

      const isDrifted = lastUpdateAgeMs > thresholdMs;
      const isStuck = lastUpdateAgeMs > 2 * thresholdMs;
      const currentStage = run.stages[run.currentStageIndex]?.name ?? "unknown";

      if (isDrifted) {
        driftedRuns.push({ id: run.id, name: run.title, currentStage, lastUpdateAgeMs, isDrifted, isStuck });
      }
    }

    return {
      totalActive: activeRuns.length,
      driftedCount: driftedRuns.length,
      stuckCount: driftedRuns.filter((r) => r.isStuck).length,
      oldestRunAgeMs,
      driftedRuns,
      sweptAt: new Date().toISOString(),
      lastRecovery: this.lastRecoveryReport,
    };
  }

  /** Register a callback invoked whenever a workflow stage transitions to in_progress. */
  setStageActiveCallback(cb: (runId: string, stageName: string, owner: string | undefined) => void): void {
    this._onStageActive = cb;
  }

  // ─── Scheduled Triggers ────────────────────────────────────────────────────

  private _schedulerTimer?: NodeJS.Timeout;
  private _onStageActive?: (runId: string, stageName: string, owner: string | undefined) => void;

  /** Start the 60-second scheduler tick. Idempotent — safe to call multiple times. */
  startScheduler(): void {
    if (this._schedulerTimer) return;
    // Seed lastScheduledAt for templates that have a schedule, so first tick
    // does not immediately fire (avoids surprise run on container restart).
    for (const tpl of this.templates.values()) {
      if (tpl.scheduleInterval && tpl.scheduleInterval > 0 && !tpl.lastScheduledAt) {
        tpl.lastScheduledAt = new Date().toISOString();
      }
    }
    this._schedulerTimer = setInterval(() => {
      try { this._checkSchedules(); } catch (e) {
        logger.error('[WorkflowEngine] Scheduler tick error:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      }
    }, 60_000);
    logger.info('[WorkflowEngine] Scheduler started (60s tick)');
  }

  stopScheduler(): void {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = undefined;
      logger.info('[WorkflowEngine] Scheduler stopped');
    }
  }

  private _checkSchedules(): void {
    const now = Date.now();
    for (const tpl of this.templates.values()) {
      if (!tpl.scheduleInterval || tpl.scheduleInterval <= 0) continue;
      const lastMs = tpl.lastScheduledAt ? new Date(tpl.lastScheduledAt).getTime() : 0;
      const elapsedMinutes = (now - lastMs) / 60_000;
      if (elapsedMinutes >= tpl.scheduleInterval) {
        try {
          const run = this.startRun({
            templateId: tpl.id,
            taskId: `sched-${Date.now()}`,
            title: `[Scheduled] ${tpl.name} — ${new Date().toISOString().slice(0, 16)}`,
          });
          tpl.lastScheduledAt = new Date().toISOString();
          logger.info(`[WorkflowEngine] Scheduled run started: ${run.id} (template: ${tpl.id})`);
        } catch (e) {
          logger.error(`[WorkflowEngine] Scheduled run failed for template ${tpl.id}:`, { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
        }
      }
    }
  }

  /** Update the schedule interval for a template (minutes; 0 = disabled). */
  updateTemplateSchedule(templateId: string, scheduleInterval: number): WorkflowTemplate {
    const tpl = this.templates.get(templateId);
    if (!tpl) throw new Error(`Template not found: ${templateId}`);
    tpl.scheduleInterval = scheduleInterval;
    if (scheduleInterval > 0 && !tpl.lastScheduledAt) {
      tpl.lastScheduledAt = new Date().toISOString();
    }
    return tpl;
  }

  // ─── Template Persistence ──────────────────────────────────────────────────

  private _loadCustomTemplates(): void {
    try {
      if (fs.existsSync(this.templatesPath)) {
        const data = JSON.parse(fs.readFileSync(this.templatesPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const tpl of data) {
            this.templates.set(tpl.id, tpl);
          }
        }
      }
    } catch (e) {
      logger.error('[WorkflowEngine] Failed to load custom templates:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  private _saveCustomTemplates(): void {
    try {
      fs.mkdirSync(path.dirname(this.templatesPath), { recursive: true });
      const custom = Array.from(this.templates.values()).filter((t) => !DEFAULT_TEMPLATE_IDS.has(t.id));
      fs.writeFileSync(this.templatesPath, JSON.stringify(custom, null, 2), 'utf-8');
    } catch (e) {
      logger.error('[WorkflowEngine] Failed to save custom templates:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  // ─── Template CRUD ─────────────────────────────────────────────────────────

  addTemplate(tpl: { id: string; name: string; trigger: string; stages: string[] }): WorkflowTemplate {
    if (!tpl.id || !/^[a-zA-Z0-9-]{1,64}$/.test(tpl.id)) {
      throw new Error('Template id must be 1-64 alphanumeric/hyphen characters');
    }
    if (this.templates.has(tpl.id)) {
      throw new Error(`Template with id "${tpl.id}" already exists`);
    }
    if (!tpl.name || tpl.name.length > 128) {
      throw new Error('Template name must be 1-128 characters');
    }
    if (!tpl.stages || tpl.stages.length < 1 || tpl.stages.length > 20) {
      throw new Error('Template must have 1-20 stages');
    }
    try { new RegExp(tpl.trigger); } catch { throw new Error('Template trigger is not a valid regex'); }

    const newTpl: WorkflowTemplate = {
      id: tpl.id,
      name: tpl.name,
      trigger: tpl.trigger,
      stages: [...tpl.stages],
    };
    this.templates.set(newTpl.id, newTpl);
    this._saveCustomTemplates();
    return newTpl;
  }

  updateTemplate(id: string, patch: { name?: string; trigger?: string; stages?: string[] }): WorkflowTemplate {
    if (DEFAULT_TEMPLATE_IDS.has(id)) {
      throw new Error(`Cannot modify built-in template "${id}"`);
    }
    const tpl = this.templates.get(id);
    if (!tpl) throw new Error(`Template "${id}" not found`);

    if (patch.name !== undefined) {
      if (!patch.name || patch.name.length > 128) throw new Error('Template name must be 1-128 characters');
      tpl.name = patch.name;
    }
    if (patch.trigger !== undefined) {
      try { new RegExp(patch.trigger); } catch { throw new Error('Template trigger is not a valid regex'); }
      tpl.trigger = patch.trigger;
    }
    if (patch.stages !== undefined) {
      if (!patch.stages || patch.stages.length < 1 || patch.stages.length > 20) {
        throw new Error('Template must have 1-20 stages');
      }
      tpl.stages = [...patch.stages];
    }
    this.templates.set(id, tpl);
    this._saveCustomTemplates();
    return tpl;
  }

  deleteTemplate(id: string): void {
    if (DEFAULT_TEMPLATE_IDS.has(id)) {
      throw new Error(`Cannot delete built-in template "${id}"`);
    }
    if (!this.templates.has(id)) {
      throw new Error(`Template "${id}" not found`);
    }
    const activeRuns = [...this.runs.values()].filter((r) => r.templateId === id && r.status === 'active');
    if (activeRuns.length > 0) {
      throw new Error(`Cannot delete template "${id}": ${activeRuns.length} active run(s) exist`);
    }
    this.templates.delete(id);
    this._saveCustomTemplates();
  }

  listCustomTemplates(): WorkflowTemplate[] {
    return Array.from(this.templates.values()).filter((t) => !DEFAULT_TEMPLATE_IDS.has(t.id));
  }
}

function appendNote(existing: string | undefined, note: string): string {
  return existing ? `${existing} | ${note}` : note;
}

import { Router, Request, Response } from "express";
import { WorkflowEngine, type WorkflowStageStatus, type WorkflowSweepResult } from "../workflows/WorkflowEngine.js";
import { TaskAssignment } from "../tasks/TaskAssignment.js";
import { logger } from '../utils/logger.js';

type OrgTreeAgent = {
  id: string;
  name: string;
  role: string;
  skills?: string[];
};

interface RawOrgAgent {
  id?: unknown;
  name?: unknown;
  skills?: unknown;
}

interface OrgTree {
  director?: RawOrgAgent;
  sysadmins?: RawOrgAgent[];
  specialists?: RawOrgAgent[];
}

interface GlobalWithOrganization {
  organization?: {
    getAgentTree?: () => OrgTree | undefined;
  };
}

const VALID_STAGE_STATUS = new Set<WorkflowStageStatus>([
  "pending",
  "in_progress",
  "done",
  "failed",
  "skipped"
]);

function getOrgAgents(): OrgTreeAgent[] {
  const tree = (globalThis as GlobalWithOrganization).organization?.getAgentTree?.();

  return [
    ...(tree?.director
      ? [
          {
            id: String(tree.director.id),
            name: String(tree.director.name),
            role: "director",
            skills: Array.isArray(tree.director.skills) ? tree.director.skills as string[] : []
          }
        ]
      : []),
    ...((tree?.sysadmins || []).map((agent: RawOrgAgent) => ({
      id: String(agent.id),
      name: String(agent.name),
      role: "sysadmin",
      skills: Array.isArray(agent.skills) ? agent.skills as string[] : []
    }))),
    ...((tree?.specialists || []).map((agent: RawOrgAgent) => ({
      id: String(agent.id),
      name: String(agent.name),
      role: "specialist",
      skills: Array.isArray(agent.skills) ? agent.skills as string[] : []
    })))
  ].filter((agent) => Boolean(agent.id && agent.name));
}

function readStatus(value: unknown): WorkflowStageStatus | null {
  if (typeof value !== "string") return null;
  if (VALID_STAGE_STATUS.has(value as WorkflowStageStatus)) {
    return value as WorkflowStageStatus;
  }
  return null;
}

export function createWorkflowsRouter(): Router {
  const router = Router();
  const engine = WorkflowEngine.getInstance();
  const assignment = TaskAssignment.getInstance();

  router.get("/templates", (_req: Request, res: Response) => {
    res.json({ templates: engine.listTemplates() });
  });

  router.get("/runs", (_req: Request, res: Response) => {
    res.json({ runs: engine.listRuns() });
  });

  router.get("/runs/:id", (req: Request, res: Response) => {
    const run = engine.getRun(String(req.params.id));
    if (!run) {
      return res.status(404).json({ error: "run not found" });
    }
    return res.json({ run });
  });

  router.post("/runs", (req: Request, res: Response) => {
    try {
      const { templateId, taskId, title } = req.body || {};
      if (!templateId || !taskId || !title) {
        return res.status(400).json({ error: "templateId, taskId, title are required" });
      }

      const run = engine.startRun({
        templateId: String(templateId),
        taskId: String(taskId),
        title: String(title)
      });

      return res.status(201).json({ run });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to start run";
      return res.status(400).json({ error: msg });
    }
  });

  router.get("/runs/:id/recommend-assignee", (req: Request, res: Response) => {
    try {
      const run = engine.getRun(String(req.params.id));
      if (!run) return res.status(404).json({ error: "run not found" });

      const agents = getOrgAgents();
      if (agents.length === 0) {
        return res.status(503).json({ error: "No agents available for recommendation" });
      }

      const recommendation = assignment.getRecommendation(agents, run.taskId, run.title, run.templateId, "high");
      return res.json({ recommendation });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to recommend assignee";
      return res.status(400).json({ error: msg });
    }
  });

  router.patch("/runs/:id/stages/:stage", (req: Request, res: Response) => {
    try {
      const { id, stage } = req.params;
      const requestedStatus = readStatus(req.body?.status);
      const owner = typeof req.body?.owner === "string" ? req.body.owner : undefined;
      const notes = typeof req.body?.notes === "string" ? req.body.notes : undefined;

      if (!requestedStatus) {
        return res.status(400).json({
          error: "status is required and must be one of: pending, in_progress, done, failed, skipped"
        });
      }

      let resolvedOwner = owner;
      let resolvedNotes = notes;

      if (String(stage) === "assign" && !resolvedOwner) {
        const run = engine.getRun(String(id));
        if (!run) {
          return res.status(404).json({ error: "run not found" });
        }

        const agents = getOrgAgents();
        if (agents.length > 0) {
          const recommendation = assignment.getRecommendation(agents, run.taskId, run.title, run.templateId, "high");
          const recommended = recommendation.recommendedAgent;
          if (recommended) {
            resolvedOwner = recommended.agentId;
            const score = Number.isFinite(recommended.score) ? recommended.score.toFixed(1) : String(recommended.score || "n/a");
            const reason = recommended.reasons?.[0] || "top score";
            const prefix = resolvedNotes ? `${resolvedNotes} | ` : "";
            resolvedNotes = `${prefix}Auto-assigned to ${recommended.agentName} (score ${score}) - ${reason}`;
          }
        }
      }

      const run = engine.updateStage(String(id), String(stage), {
        status: requestedStatus,
        owner: resolvedOwner,
        notes: resolvedNotes
      });

      return res.json({ run });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to update stage";
      return res.status(400).json({ error: msg });
    }
  });

  router.post("/runs/:id/reconcile", (req: Request, res: Response) => {
    try {
      const run = engine.reconcileRun(String(req.params.id));
      return res.json({ run });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to reconcile run";
      return res.status(400).json({ error: msg });
    }
  });

  router.get("/health", (_req: Request, res: Response) => {
    try {
      const result: WorkflowSweepResult = WorkflowEngine.getInstance().sweep();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: "Failed to sweep workflow runs" });
    }
  });

  // ─── Webhook Trigger ──────────────────────────────────────────────────────
  // POST /api/workflows/trigger  { event: string, payload?: object, taskId?: string }
  // Matches `event` against each template's trigger field (regex) and starts matching runs.
  router.post("/trigger", (req: Request, res: Response) => {
    const { event, payload = {}, taskId } = req.body as {
      event?: unknown; payload?: Record<string, unknown>; taskId?: unknown;
    };
    if (!event || typeof event !== "string") {
      res.status(400).json({ error: "`event` string is required" });
      return;
    }
    const templates = engine.listTemplates();
    const matching = templates.filter(t => {
      try { return new RegExp(t.trigger, "i").test(event); }
      catch { return t.trigger.toLowerCase().includes(event.toLowerCase()); }
    });
    if (matching.length === 0) {
      res.json({ runs: [], message: `No templates matched event: "${event}"` });
      return;
    }
    const runs = [];
    for (const tpl of matching) {
      try {
        const titleBase = typeof (payload as any).title === "string"
          ? (payload as any).title
          : `${tpl.name} — ${event}`;
        const run = engine.startRun({
          templateId: tpl.id,
          taskId: typeof taskId === "string" ? taskId : `trigger-${Date.now()}`,
          title: `[Triggered] ${titleBase}`,
        });
        runs.push(run);
      } catch (e) {
        logger.error(`[WorkflowTrigger] Failed to start run for template ${tpl.id}:`, { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      }
    }
    res.status(201).json({ runs, matched: matching.length, started: runs.length });
  });

  // ─── Template Schedule ────────────────────────────────────────────────────
  // PATCH /api/workflows/templates/:id/schedule  { scheduleInterval: number (minutes) }
  router.patch("/templates/:id/schedule", (req: Request, res: Response) => {
    const { scheduleInterval } = req.body as { scheduleInterval?: unknown };
    if (typeof scheduleInterval !== "number" || scheduleInterval < 0) {
      res.status(400).json({ error: "scheduleInterval must be a non-negative number (minutes)" });
      return;
    }
    try {
      const tpl = engine.updateTemplateSchedule(String(req.params.id), scheduleInterval);
      res.json({ template: tpl });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // POST /api/workflows/templates - Create a new custom template
  router.post('/templates', (req: Request, res: Response) => {
    const { id, name, trigger, stages } = req.body;
    if (!id || !name || trigger === undefined || !Array.isArray(stages)) {
      res.status(400).json({ error: 'Required fields: id, name, trigger, stages (array)' });
      return;
    }
    try {
      const tpl = engine.addTemplate({ id, name, trigger, stages });
      res.status(201).json({ template: tpl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(400).json({ error: msg });
    }
  });

  // PATCH /api/workflows/templates/:id - Update a custom template
  router.patch('/templates/:id', (req: Request, res: Response) => {
    const { name, trigger, stages } = req.body;
    try {
      const tpl = engine.updateTemplate(String(req.params.id), { name, trigger, stages });
      res.json({ template: tpl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('not found') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  // DELETE /api/workflows/templates/:id - Delete a custom template
  router.delete('/templates/:id', (req: Request, res: Response) => {
    try {
      engine.deleteTemplate(String(req.params.id));
      res.json({ success: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.includes('not found') ? 404 : 400;
      res.status(status).json({ error: msg });
    }
  });

  return router;
}

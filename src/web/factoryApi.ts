import { Router, Request, Response } from "express";
import { FactoryTaskService, type FactoryTaskState } from "../factory/FactoryTaskService.js";

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

export function createFactoryRouter(): Router {
  const router = Router();
  const service = FactoryTaskService.getInstance();

  // POST /tasks — create task
  router.post("/tasks", (req: Request, res: Response) => {
    try {
      const { title, description, actor } = req.body || {};
      if (!title || !actor) {
        return res.status(400).json({ error: "title and actor are required" });
      }
      const task = service.create(String(title), String(description || ""), String(actor));
      return res.status(201).json(task);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to create task";
      return res.status(500).json({ error: msg });
    }
  });

  // GET /tasks — list tasks (query: ?state=)
  router.get("/tasks", (req: Request, res: Response) => {
    try {
      const stateParam = req.query.state;
      let state: FactoryTaskState | undefined;
      if (typeof stateParam === "string" && stateParam !== "") {
        if (!VALID_STATES.has(stateParam as FactoryTaskState)) {
          return res.status(400).json({ error: `invalid state: ${stateParam}` });
        }
        state = stateParam as FactoryTaskState;
      }
      return res.json(service.list(state));
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to list tasks";
      return res.status(500).json({ error: msg });
    }
  });

  // GET /tasks/:id — get task
  router.get("/tasks/:id", (req: Request, res: Response) => {
    const task = service.get(String(req.params.id));
    if (!task) {
      return res.status(404).json({ error: "task not found" });
    }
    return res.json(task);
  });

  // POST /tasks/:id/transition — transition state
  router.post("/tasks/:id/transition", (req: Request, res: Response) => {
    try {
      const { toState, actor } = req.body || {};
      if (!toState || !actor) {
        return res.status(400).json({ error: "toState and actor are required" });
      }
      if (!VALID_STATES.has(toState as FactoryTaskState)) {
        return res.status(400).json({ error: `invalid toState: ${toState}` });
      }
      const task = service.transition(
        String(req.params.id),
        toState as FactoryTaskState,
        String(actor)
      );
      return res.json(task);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to transition task";
      if (msg.startsWith("Task not found")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(400).json({ error: msg });
    }
  });

  // POST /tasks/:id/gate-result — record gate result
  router.post("/tasks/:id/gate-result", (req: Request, res: Response) => {
    try {
      const { gate, result, notes, actor } = req.body || {};
      if (!gate || !result || !actor) {
        return res.status(400).json({ error: "gate, result, and actor are required" });
      }
      if (result !== "pass" && result !== "fail") {
        return res.status(400).json({ error: "result must be 'pass' or 'fail'" });
      }
      const task = service.recordGateResult(
        String(req.params.id),
        String(gate),
        result as "pass" | "fail",
        String(notes || ""),
        String(actor)
      );
      return res.json(task);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "failed to record gate result";
      if (msg.startsWith("Task not found")) {
        return res.status(404).json({ error: msg });
      }
      return res.status(500).json({ error: msg });
    }
  });

  return router;
}

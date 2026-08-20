import { Router, Request, Response } from "express";
import { TaskAssignment } from "../tasks/TaskAssignment.js";
import { logger } from '../utils/logger.js';

type AgentLike = {
  id: string;
  name: string;
  role: string;
  skills?: string[];
};

const ACTIVE_TASK_STATUSES = new Set(["assigned", "in_progress", "pending"]);

function getAgentList(): AgentLike[] {
  const tree = (globalThis as any).organization?.getAgentTree?.();
  if (!tree) return [];

  return [
    ...(tree.director
      ? [{ id: tree.director.id, name: tree.director.name, role: "director", skills: tree.director.skills || [] }]
      : []),
    ...((tree.sysadmins || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      role: "sysadmin",
      skills: a.skills || []
    }))),
    ...((tree.specialists || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      role: "specialist",
      skills: a.skills || []
    })))
  ];
}

function getTaskManager(): any {
  return (globalThis as any).taskManager;
}

function getLiveWorkload(agentId: string): number {
  const taskManager = getTaskManager();
  if (!taskManager?.getTasksByAgent) return 0;

  const tasks = taskManager.getTasksByAgent(agentId) || [];
  return tasks.filter((task: any) => ACTIVE_TASK_STATUSES.has(task.status)).length;
}

export function createTaskAssignmentRouter(): Router {
  const router = Router();
  const assignment = TaskAssignment.getInstance();

  router.get("/recommendation/:taskId", (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const { title, category, priority } = req.query;

      if (!title || !category || !priority) {
        return res.status(400).json({ error: "Missing parameters: title, category, priority required" });
      }

      const agents = getAgentList();
      if (agents.length === 0) {
        return res.status(503).json({ error: "No agents are currently available" });
      }

      for (const agent of agents) {
        const liveWorkload = getLiveWorkload(agent.id);
        assignment.setAgentWorkload(agent.id, liveWorkload);
      }

      const recommendation = assignment.getRecommendation(
        agents,
        String(taskId),
        String(title),
        String(category),
        String(priority)
      );

      res.json(recommendation);
    } catch (error) {
      logger.error("Error getting task recommendation:", { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      res.status(500).json({ error: "Failed to get recommendation" });
    }
  });

  router.post("/assign", (req: Request, res: Response) => {
    try {
      const { taskId, title, description, category, priority = "medium", ownerId = "director", autoCreate = false } = req.body || {};

      if (!category || (!taskId && !title)) {
        return res.status(400).json({
          error: "Missing required fields: category and either taskId or title"
        });
      }

      const agents = getAgentList();
      if (agents.length === 0) {
        return res.status(503).json({ error: "No agents are currently available" });
      }

      for (const agent of agents) {
        assignment.setAgentWorkload(agent.id, getLiveWorkload(agent.id));
      }

      const effectiveTaskId = taskId || `TASK-${Date.now()}`;
      const effectiveTitle = title || `Task ${effectiveTaskId}`;

      const recommendation = assignment.getRecommendation(
        agents,
        String(effectiveTaskId),
        String(effectiveTitle),
        String(category),
        String(priority)
      );

      const taskManager = getTaskManager();
      let assignedTask: any = null;

      if (taskManager) {
        let task = taskId ? taskManager.getTask(String(taskId)) : undefined;

        if (!task && autoCreate) {
          task = taskManager.createTask({
            title: String(effectiveTitle),
            description: String(description || "Auto-created by smart assignment"),
            ownerId: String(ownerId),
            category: String(category),
            priority: String(priority)
          });
        }

        if (task) {
          taskManager.assignAgentToTask(recommendation.recommendedAgent.agentId, task.id);
          assignment.setAgentWorkload(
            recommendation.recommendedAgent.agentId,
            getLiveWorkload(recommendation.recommendedAgent.agentId)
          );
          assignedTask = taskManager.getTask(task.id);
        }
      }

      res.json({
        success: true,
        recommendation,
        assignment: {
          agentId: recommendation.recommendedAgent.agentId,
          agentName: recommendation.recommendedAgent.agentName,
          score: recommendation.recommendedAgent.score,
          taskId: assignedTask?.id || effectiveTaskId,
          assigned: Boolean(assignedTask),
          autoCreated: Boolean(assignedTask && autoCreate)
        },
        task: assignedTask
      });
    } catch (error) {
      logger.error("Error assigning task:", { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      res.status(500).json({ error: "Failed to assign task" });
    }
  });

  router.post("/workload/:agentId", (req: Request, res: Response) => {
    try {
      const { agentId } = req.params;
      const { workload } = req.body;

      if (typeof workload !== "number" || workload < 0) {
        return res.status(400).json({ error: "workload must be a non-negative number" });
      }

      assignment.setAgentWorkload(String(agentId), workload);
      res.json({ success: true, agentId, workload });
    } catch (error) {
      logger.error("Error updating agent workload:", { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      res.status(500).json({ error: "Failed to update workload" });
    }
  });

  router.get("/workloads", (_req: Request, res: Response) => {
    try {
      const agents = getAgentList();
      const workloads = agents.map((agent) => {
        const live = getLiveWorkload(agent.id);
        const cached = assignment.getAgentWorkload(agent.id);
        const workload = Math.max(live, cached);
        assignment.setAgentWorkload(agent.id, workload);

        return {
          agentId: agent.id,
          agentName: agent.name,
          workload
        };
      });

      res.json(workloads);
    } catch (error) {
      logger.error("Error getting workloads:", { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      res.status(500).json({ error: "Failed to get workloads" });
    }
  });

  router.post("/score", (req: Request, res: Response) => {
    try {
      const { agentId, agentName, agentRole, taskCategory, taskPriority, skills } = req.body;

      if (!agentId || !agentName || !agentRole || !taskCategory || !taskPriority) {
        return res.status(400).json({
          error: "Missing required fields: agentId, agentName, agentRole, taskCategory, taskPriority"
        });
      }

      const live = getLiveWorkload(String(agentId));
      if (live > 0) {
        assignment.setAgentWorkload(String(agentId), live);
      }

      const score = assignment.scoreAgent(
        String(agentId),
        String(agentName),
        String(agentRole),
        String(taskCategory),
        String(taskPriority),
        skills || []
      );

      res.json(score);
    } catch (error) {
      logger.error("Error scoring agent:", { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      res.status(500).json({ error: "Failed to score agent" });
    }
  });

  return router;
}

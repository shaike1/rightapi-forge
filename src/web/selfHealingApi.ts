import { Router, Request, Response } from "express";
import { AgentBus } from "./agentBus";

const router = Router();

interface HealingRule {
  id: string;
  name: string;
  trigger: "agent_offline" | "error_rate_high" | "task_stuck" | "memory_high";
  condition: { threshold?: number; durationMinutes?: number };
  action: "restart_agent" | "reassign_tasks" | "scale_up" | "alert_only";
  targetAgentId?: string;
  enabled: boolean;
  lastTriggered?: string;
  triggerCount: number;
}

interface HealingEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  agentId: string;
  action: string;
  status: "triggered" | "resolved" | "failed";
  timestamp: string;
  details: string;
}

const healingRules: Map<string, HealingRule> = new Map([
  ["rule-1", {
    id: "rule-1",
    name: "Auto-restart offline agents",
    trigger: "agent_offline",
    condition: { durationMinutes: 5 },
    action: "restart_agent",
    enabled: true,
    triggerCount: 0
  }],
  ["rule-2", {
    id: "rule-2",
    name: "Reassign stuck tasks",
    trigger: "task_stuck",
    condition: { durationMinutes: 30 },
    action: "reassign_tasks",
    enabled: true,
    triggerCount: 0
  }],
  ["rule-3", {
    id: "rule-3",
    name: "Alert on high error rate",
    trigger: "error_rate_high",
    condition: { threshold: 20 },
    action: "alert_only",
    enabled: true,
    triggerCount: 0
  }]
]);

const healingEvents: HealingEvent[] = [];

function generateId(): string {
  return Math.random().toString(36).substr(2, 9);
}

// GET all rules
router.get("/rules", (_req: Request, res: Response) => {
  res.json(Array.from(healingRules.values()));
});

// POST create rule
router.post("/rules", (req: Request, res: Response) => {
  const rule: HealingRule = {
    id: generateId(),
    triggerCount: 0,
    ...req.body
  };
  healingRules.set(rule.id, rule);
  res.status(201).json(rule);
});

// PUT update rule
router.put("/rules/:id", (req: Request, res: Response) => {
  const rule = healingRules.get(req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  const updated = { ...rule, ...req.body, id: rule.id };
  healingRules.set(rule.id, updated);
  res.json(updated);
});

// DELETE rule
router.delete("/rules/:id", (req: Request, res: Response) => {
  if (!healingRules.delete(req.params.id)) {
    return res.status(404).json({ error: "Rule not found" });
  }
  res.json({ success: true });
});

// GET healing events log
router.get("/events", (_req: Request, res: Response) => {
  res.json(healingEvents.slice(-100).reverse());
});

// POST simulate trigger (for testing)
router.post("/trigger", (req: Request, res: Response) => {
  const { ruleId, agentId } = req.body;
  const rule = healingRules.get(ruleId);
  if (!rule) return res.status(404).json({ error: "Rule not found" });

  rule.triggerCount++;
  rule.lastTriggered = new Date().toISOString();

  const event: HealingEvent = {
    id: generateId(),
    ruleId: rule.id,
    ruleName: rule.name,
    agentId: agentId || "unknown",
    action: rule.action,
    status: "triggered",
    timestamp: new Date().toISOString(),
    details: `Auto-healing triggered: ${rule.action} for agent ${agentId}`
  };
  healingEvents.push(event);

  res.json({ event, rule });
});

// GET stats
router.get("/stats", (_req: Request, res: Response) => {
  const rules = Array.from(healingRules.values());
  res.json({
    totalRules: rules.length,
    enabledRules: rules.filter(r => r.enabled).length,
    totalEvents: healingEvents.length,
    recentEvents: healingEvents.slice(-5),
    topTriggers: rules.sort((a, b) => b.triggerCount - a.triggerCount).slice(0, 3)
  });
});

export default router;

// /api/automation-rules/* — workflow-rule CRUD + manual test trigger.
// Extracted from server.ts.
//
// Routes (mount at /api/automation-rules):
//   GET    /                  (no auth)
//   GET    /:id               (no auth)
//   POST   /                  (no auth)
//   PATCH  /:id               (no auth)
//   DELETE /:id               (no auth)
//   POST   /:id/test          (no auth — fires the actions if the
//                              trigger.condition evaluates true)
//
// State (`workflows` array) and helpers (saveWorkflows, evaluate,
// execute) stay in server.ts because the workflow engine's tick loop
// uses them directly. Router receives them by reference.
//
// Behavior preserved 1:1 with the inline blocks; the inline routes
// were already untyped (`req: any, res: any`), so we keep that
// pragmatism here.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';

interface WorkflowRuleLike {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: any;
  actions: any[];
  cooldown: number;
  lastTriggered?: string;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRulesApiDeps {
  /** Owned by server.ts. Mutated by reference (push/splice/find). */
  workflows: WorkflowRuleLike[];
  saveWorkflows: () => void;
  evaluateCondition: (condition: string, context: Record<string, any>) => boolean;
  executeWorkflowAction: (action: any, context: Record<string, any>) => Promise<string>;
}

export function createAutomationRulesRouter(deps: AutomationRulesApiDeps): Router {
  const router = Router();
  const { workflows, saveWorkflows, evaluateCondition, executeWorkflowAction } = deps;

  router.get('/', (_req: Request, res: Response) => {
    res.json({ workflows, total: workflows.length });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const wf = workflows.find(w => w.id === req.params.id);
    if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json(wf);
  });

  router.post('/', (req: Request, res: Response) => {
    const { name, description, trigger, actions, cooldown, enabled } = req.body || {};
    if (!name || !trigger || !actions) {
      res.status(400).json({ error: 'name, trigger, and actions required' });
      return;
    }
    const wf: WorkflowRuleLike = {
      id: crypto.randomUUID(),
      name,
      description: description || '',
      enabled: enabled !== false,
      trigger,
      actions: Array.isArray(actions) ? actions : [actions],
      cooldown: cooldown || 300,
      lastTriggered: undefined,
      triggerCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    workflows.push(wf);
    saveWorkflows();
    res.status(201).json(wf);
  });

  router.patch('/:id', (req: Request, res: Response) => {
    const wf = workflows.find(w => w.id === req.params.id);
    if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
    const { name, description, trigger, actions, cooldown, enabled } = req.body || {};
    if (name !== undefined) wf.name = name;
    if (description !== undefined) wf.description = description;
    if (trigger !== undefined) wf.trigger = trigger;
    if (actions !== undefined) wf.actions = Array.isArray(actions) ? actions : [actions];
    if (cooldown !== undefined) wf.cooldown = cooldown;
    if (enabled !== undefined) wf.enabled = enabled;
    wf.updatedAt = new Date().toISOString();
    saveWorkflows();
    res.json(wf);
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const idx = workflows.findIndex(w => w.id === req.params.id);
    if (idx === -1) { res.status(404).json({ error: 'Workflow not found' }); return; }
    workflows.splice(idx, 1);
    saveWorkflows();
    res.json({ success: true });
  });

  router.post('/:id/test', async (req: Request, res: Response) => {
    const wf = workflows.find(w => w.id === req.params.id);
    if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
    const context = req.body?.context || {};
    const conditionMet = evaluateCondition(wf.trigger.condition, context);
    const results: string[] = [];
    if (conditionMet) {
      for (const action of wf.actions) {
        const result = await executeWorkflowAction(action, context);
        results.push(result);
      }
    }
    res.json({ conditionMet, results, trigger: wf.trigger });
  });

  return router;
}

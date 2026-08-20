import express from 'express';
import { WorkflowEngine } from '../workflows/WorkflowEngine.js';

export function createWorkflowRouter(engine: WorkflowEngine): express.Router {
  const router = express.Router();

  // Stats
  router.get('/stats', (_req, res) => { res.json(engine.getStats()); });

  // ── Workflows ──────────────────────────────────────────────────────────────

  router.get('/workflows', (_req, res) => {
    const workflows = engine.getAllWorkflows();
    res.json({ workflows, count: workflows.length });
  });

  router.get('/workflows/:id', (req, res) => {
    const wf = engine.getWorkflow(String(req.params.id));
    if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json(wf);
  });

  router.post('/workflows', (req, res) => {
    const { name, description, version, steps, variables, triggers } = req.body;
    if (!name || !version || !steps) {
      res.status(400).json({ error: 'name, version, and steps required' });
      return;
    }
    const wf = engine.createWorkflow({ name, description, version, steps, variables, triggers });
    res.json({ success: true, workflow: wf });
  });

  router.patch('/workflows/:id', (req, res) => {
    const wf = engine.updateWorkflow(String(req.params.id), req.body);
    if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json({ success: true, workflow: wf });
  });

  router.delete('/workflows/:id', (req, res) => {
    const ok = engine.deleteWorkflow(String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Workflow not found' }); return; }
    res.json({ success: true });
  });

  // ── Execute ────────────────────────────────────────────────────────────────

  router.post('/workflows/:id/execute', async (req, res) => {
    const wfId = String(req.params.id);
    const { triggeredBy, variables } = req.body;

    try {
      const exec = await engine.executeWorkflow(wfId, triggeredBy || 'api', variables || {});
      res.json({ success: true, execution: exec });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Executions ─────────────────────────────────────────────────────────────

  router.get('/executions', (req, res) => {
    const { workflowId, status, limit } = req.query as Record<string, string>;
    const execs = engine.getExecutions({
      workflowId,
      status: status as any,
      limit: limit ? parseInt(limit) : 50
    });
    // Serialize stepResults Map to object
    const serialized = execs.map(e => ({
      ...e,
      stepResults: Object.fromEntries(e.stepResults)
    }));
    res.json({ executions: serialized, count: serialized.length });
  });

  router.get('/executions/:id', (req, res) => {
    const exec = engine.getExecution(String(req.params.id));
    if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
    res.json({ ...exec, stepResults: Object.fromEntries(exec.stepResults) });
  });

  router.get('/executions/:id/logs', (req, res) => {
    const exec = engine.getExecution(String(req.params.id));
    if (!exec) { res.status(404).json({ error: 'Execution not found' }); return; }
    res.json({ logs: exec.logs, count: exec.logs.length });
  });

  // ── Approval ───────────────────────────────────────────────────────────────

  router.post('/executions/:id/approve', async (req, res) => {
    const { stepId, approvedBy } = req.body;
    if (!stepId) { res.status(400).json({ error: 'stepId required' }); return; }

    try {
      await engine.approveStep(String(req.params.id), stepId, approvedBy || 'unknown');
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/executions/:id/reject', async (req, res) => {
    const { stepId, rejectedBy, reason } = req.body;
    if (!stepId) { res.status(400).json({ error: 'stepId required' }); return; }

    try {
      await engine.rejectStep(String(req.params.id), stepId, rejectedBy || 'unknown', reason);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

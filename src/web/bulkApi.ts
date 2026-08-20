import express from 'express';
import { realtimeBus } from '../realtime/RealtimeBus.js';

export function createBulkRouter(): express.Router {
  const router = express.Router();

  // ── Bulk Task Operations ───────────────────────────────────────────────────

  router.post('/tasks', (req, res) => {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || !tasks.length) {
      res.status(400).json({ error: 'tasks array required' });
      return;
    }
    if (tasks.length > 100) {
      res.status(400).json({ error: 'Max 100 tasks per batch' });
      return;
    }

    const results = tasks.map((task: any, i: number) => {
      const id = `bulk-task-${Date.now()}-${i}`;
      realtimeBus.publish('task:created', { id, ...task, source: 'bulk' });
      return { id, status: 'queued', title: task.title || `Task ${i + 1}` };
    });

    res.json({
      success: true,
      created: results.length,
      results,
      batchId: `batch-${Date.now()}`
    });
  });

  // ── Bulk Task Cancel ───────────────────────────────────────────────────────

  router.post('/tasks/cancel', (req, res) => {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds) || !taskIds.length) {
      res.status(400).json({ error: 'taskIds array required' });
      return;
    }

    taskIds.forEach(id => {
      realtimeBus.publish('task:updated', { id, status: 'cancelled', cancelledAt: new Date() });
    });

    res.json({ success: true, cancelled: taskIds.length, taskIds });
  });

  // ── Bulk Agent Commands ────────────────────────────────────────────────────

  router.post('/agents/command', (req, res) => {
    const { agentIds, command, params } = req.body;
    if (!Array.isArray(agentIds) || !command) {
      res.status(400).json({ error: 'agentIds and command required' });
      return;
    }

    const allowedCommands = ['pause', 'resume', 'restart', 'clear-queue', 'ping'];
    if (!allowedCommands.includes(command)) {
      res.status(400).json({ error: 'Unknown command', allowed: allowedCommands });
      return;
    }

    const results = agentIds.map(agentId => {
      realtimeBus.publish('agent:status', { agentId, command, params, ts: new Date() });
      return { agentId, command, status: 'sent' };
    });

    res.json({ success: true, command, results, count: results.length });
  });

  // ── Bulk Alert Acknowledge ─────────────────────────────────────────────────

  router.post('/alerts/acknowledge', (req, res) => {
    const { alertIds, acknowledgedBy } = req.body;
    if (!Array.isArray(alertIds) || !alertIds.length) {
      res.status(400).json({ error: 'alertIds required' });
      return;
    }

    alertIds.forEach(id => {
      realtimeBus.publish('alert:acknowledged', { id, acknowledgedBy, ts: new Date() });
    });

    res.json({ success: true, acknowledged: alertIds.length, alertIds });
  });

  // ── Bulk Alert Resolve ─────────────────────────────────────────────────────

  router.post('/alerts/resolve', (req, res) => {
    const { alertIds, resolvedBy, resolution } = req.body;
    if (!Array.isArray(alertIds) || !alertIds.length) {
      res.status(400).json({ error: 'alertIds required' });
      return;
    }

    alertIds.forEach(id => {
      realtimeBus.publish('alert:resolved', { id, resolvedBy, resolution, ts: new Date() });
    });

    res.json({ success: true, resolved: alertIds.length, alertIds });
  });

  // ── Bulk Pipeline Trigger ──────────────────────────────────────────────────

  router.post('/pipelines/trigger', (req, res) => {
    const { pipelineIds, params } = req.body;
    if (!Array.isArray(pipelineIds) || !pipelineIds.length) {
      res.status(400).json({ error: 'pipelineIds required' });
      return;
    }

    const results = pipelineIds.map(id => {
      const buildId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      realtimeBus.publish('pipeline:triggered', { pipelineId: id, buildId, params, ts: new Date() });
      return { pipelineId: id, buildId, status: 'triggered' };
    });

    res.json({ success: true, triggered: results.length, results });
  });

  // ── Bulk Workflow Execute ──────────────────────────────────────────────────

  router.post('/workflows/execute', (req, res) => {
    const { workflowIds, params } = req.body;
    if (!Array.isArray(workflowIds) || !workflowIds.length) {
      res.status(400).json({ error: 'workflowIds required' });
      return;
    }

    const results = workflowIds.map(id => {
      const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      realtimeBus.publish('workflow:started', { workflowId: id, executionId: execId, params, ts: new Date() });
      return { workflowId: id, executionId: execId, status: 'started' };
    });

    res.json({ success: true, executed: results.length, results });
  });

  return router;
}

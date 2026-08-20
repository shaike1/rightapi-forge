import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { appendAuditEntry } from './auditLogApi.js';

const router = Router();
const DATA_DIR = process.env.DATA_DIR || '/data/itops-agents';
const PIPELINES_FILE = path.join(DATA_DIR, 'pipelines.json');
const DEPLOYMENTS_FILE = path.join(DATA_DIR, 'deployments.json');

export interface Pipeline {
  id: string;
  name: string;
  repo: string;
  branch: string;
  status: 'idle' | 'running' | 'success' | 'failure';
  lastRun?: string;
  duration?: number;
  triggeredBy?: string;
  steps: PipelineStep[];
  webhookUrl?: string;
}

export interface PipelineStep {
  name: string;
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped';
  duration?: number;
  log?: string;
}

export interface Deployment {
  id: string;
  pipelineId: string;
  pipelineName: string;
  environment: 'dev' | 'staging' | 'production';
  version: string;
  status: 'deploying' | 'deployed' | 'rolled-back' | 'failed';
  startedAt: string;
  finishedAt?: string;
  deployedBy: string;
  commitSha?: string;
  notes?: string;
}

function readPipelines(): Pipeline[] {
  if (!fs.existsSync(PIPELINES_FILE)) return defaultPipelines();
  try { return JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf8')); } catch { return defaultPipelines(); }
}

function savePipelines(pipelines: Pipeline[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PIPELINES_FILE, JSON.stringify(pipelines, null, 2));
}

function readDeployments(): Deployment[] {
  if (!fs.existsSync(DEPLOYMENTS_FILE)) return defaultDeployments();
  try { return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf8')); } catch { return defaultDeployments(); }
}

function saveDeployments(d: Deployment[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(d, null, 2));
}

function defaultPipelines(): Pipeline[] {
  const pipelines: Pipeline[] = [];
  savePipelines(pipelines);
  return pipelines;
}

function defaultDeployments(): Deployment[] {
  const deployments: Deployment[] = [];
  saveDeployments(deployments);
  return deployments;
}

// GET /api/cicd/pipelines
router.get('/pipelines', (_req: Request, res: Response) => {
  res.json(readPipelines());
});

// GET /api/cicd/pipelines/:id
router.get('/pipelines/:id', (req: Request, res: Response) => {
  const p = readPipelines().find(p => p.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// POST /api/cicd/pipelines/:id/trigger
router.post('/pipelines/:id/trigger', (req: Request, res: Response) => {
  const pipelines = readPipelines();
  const idx = pipelines.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const p = pipelines[idx];
  const triggeredBy = req.body.triggeredBy || 'manual';
  // Simulate run
  p.status = 'running';
  p.lastRun = new Date().toISOString();
  p.triggeredBy = triggeredBy;
  p.steps = p.steps.map(s => ({ ...s, status: 'pending' as const }));
  savePipelines(pipelines);
  appendAuditEntry({ actor: triggeredBy, actorType: 'agent', action: 'pipeline.trigger', resource: 'Pipeline', resourceId: p.id, outcome: 'success', severity: 'info', details: { pipeline: p.name } });
  // Async simulate completion
  setTimeout(() => {
    const pls = readPipelines();
    const i = pls.findIndex(pp => pp.id === req.params.id);
    if (i === -1) return;
    const success = Math.random() > 0.2;
    pls[i].status = success ? 'success' : 'failure';
    pls[i].duration = Math.floor(Math.random() * 120 + 30);
    pls[i].steps = pls[i].steps.map((s, si) => {
      const stepFailed = !success && si === pls[i].steps.length - 1;
      return { ...s, status: (stepFailed ? 'failure' : 'success') as PipelineStep['status'], duration: Math.floor(Math.random() * 30 + 5) };
    });
    savePipelines(pls);
    appendAuditEntry({ actor: 'system', actorType: 'system', action: 'pipeline.complete', resource: 'Pipeline', resourceId: pls[i].id, outcome: success ? 'success' : 'failure', severity: success ? 'info' : 'critical' });
  }, 5000);
  res.json({ message: `Pipeline ${p.name} triggered`, pipeline: p });
});

// GET /api/cicd/deployments
router.get('/deployments', (_req: Request, res: Response) => {
  res.json(readDeployments());
});

// POST /api/cicd/deployments
router.post('/deployments', (req: Request, res: Response) => {
  const deployments = readDeployments();
  const dep: Deployment = {
    id: `dep-${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: 'deploying',
    ...req.body,
  };
  deployments.unshift(dep);
  saveDeployments(deployments);
  appendAuditEntry({ actor: dep.deployedBy || 'system', actorType: 'agent', action: 'deployment.start', resource: 'Deployment', resourceId: dep.id, outcome: 'success', severity: 'info', details: { env: dep.environment, version: dep.version } });
  res.status(201).json(dep);
});

// PUT /api/cicd/deployments/:id/status
router.put('/deployments/:id/status', (req: Request, res: Response) => {
  const deployments = readDeployments();
  const idx = deployments.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  deployments[idx].status = req.body.status;
  if (req.body.status !== 'deploying') deployments[idx].finishedAt = new Date().toISOString();
  saveDeployments(deployments);
  appendAuditEntry({ actor: 'system', actorType: 'system', action: 'deployment.update', resource: 'Deployment', resourceId: req.params.id, outcome: req.body.status === 'failed' ? 'failure' : 'success', severity: req.body.status === 'failed' ? 'critical' : 'info' });
  res.json(deployments[idx]);
});

// GET /api/cicd/stats
router.get('/stats', (_req: Request, res: Response) => {
  const pipelines = readPipelines();
  const deployments = readDeployments();
  res.json({
    pipelines: { total: pipelines.length, success: pipelines.filter(p => p.status === 'success').length, failure: pipelines.filter(p => p.status === 'failure').length, running: pipelines.filter(p => p.status === 'running').length },
    deployments: { total: deployments.length, deployed: deployments.filter(d => d.status === 'deployed').length, failed: deployments.filter(d => d.status === 'failed').length, deploying: deployments.filter(d => d.status === 'deploying').length },
  });
});

export default router;

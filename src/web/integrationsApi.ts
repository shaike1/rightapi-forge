import { Router } from 'express';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { PagerDutyService } from '../integrations/PagerDutyService.js';
import { GitHubIssuesService } from '../integrations/GitHubIssuesService.js';

const router = Router();

const INTEGRATIONS_CONFIG_PATH = process.env.INTEGRATIONS_CONFIG_PATH || '/data/itops-agents/integrations.json';

function loadConfig(): Record<string, any> {
  try {
    if (fs.existsSync(INTEGRATIONS_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(INTEGRATIONS_CONFIG_PATH, 'utf8'));
    }
  } catch (e) { logger.error('[integrationsApi] config load error', e); }
  return {};
}

function saveConfig(cfg: Record<string, any>) {
  fs.mkdirSync(INTEGRATIONS_CONFIG_PATH.split("/").slice(0,-1).join("/"), { recursive: true });
  fs.writeFileSync(INTEGRATIONS_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// GET /api/integrations — list configured integrations (no secrets)
router.get('/', (req, res) => {
  const cfg = loadConfig();
  const summary = {
    pagerduty: { enabled: cfg.pagerduty?.enabled ?? false, configured: !!cfg.pagerduty?.integrationKey },
    github: { enabled: cfg.github?.enabled ?? false, configured: !!cfg.github?.token, repo: cfg.github ? `${cfg.github.owner}/${cfg.github.repo}` : null },
  };
  res.json(summary);
});

// PUT /api/integrations/pagerduty — configure PagerDuty
router.put('/pagerduty', (req, res) => {
  const { integrationKey, enabled } = req.body;
  const cfg = loadConfig();
  cfg.pagerduty = { integrationKey, enabled: enabled ?? true };
  saveConfig(cfg);
  res.json({ ok: true, enabled: cfg.pagerduty.enabled });
});

// POST /api/integrations/pagerduty/trigger — trigger an incident
router.post('/pagerduty/trigger', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.pagerduty?.integrationKey) {
    return res.status(400).json({ error: 'PagerDuty not configured' });
  }
  const pd = new PagerDutyService(cfg.pagerduty);
  const result = await pd.triggerIncident({
    title: req.body.title ?? 'IT Ops Alert',
    severity: req.body.severity ?? 'error',
    source: req.body.source ?? 'itops-agents',
    summary: req.body.summary,
    dedupeKey: req.body.dedupeKey,
    customDetails: req.body.customDetails,
  });
  if (!result) return res.status(500).json({ error: 'PagerDuty trigger failed' });
  res.json({ ok: true, ...result });
});

// POST /api/integrations/pagerduty/resolve
router.post('/pagerduty/resolve', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.pagerduty?.integrationKey) return res.status(400).json({ error: 'PagerDuty not configured' });
  const pd = new PagerDutyService(cfg.pagerduty);
  const ok = await pd.resolveIncident(req.body.dedupeKey);
  res.json({ ok });
});

// PUT /api/integrations/github — configure GitHub
router.put('/github', (req, res) => {
  const { token, owner, repo, enabled } = req.body;
  const cfg = loadConfig();
  cfg.github = { token, owner, repo, enabled: enabled ?? true };
  saveConfig(cfg);
  res.json({ ok: true, repo: `${owner}/${repo}` });
});

// POST /api/integrations/github/issues — create an issue
router.post('/github/issues', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.github?.token) return res.status(400).json({ error: 'GitHub not configured' });
  const gh = new GitHubIssuesService(cfg.github);
  const result = await gh.createIssue({
    title: req.body.title,
    body: req.body.body,
    labels: req.body.labels,
    assignees: req.body.assignees,
  });
  if (!result) return res.status(500).json({ error: 'GitHub issue creation failed' });
  res.json({ ok: true, ...result });
});

// GET /api/integrations/github/issues — list open issues
router.get('/github/issues', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.github?.token) return res.status(400).json({ error: 'GitHub not configured' });
  const gh = new GitHubIssuesService(cfg.github);
  const issues = await gh.listOpenIssues();
  res.json({ issues });
});

// DELETE /api/integrations/github/issues/:number — close issue
router.delete('/github/issues/:number', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.github?.token) return res.status(400).json({ error: 'GitHub not configured' });
  const gh = new GitHubIssuesService(cfg.github);
  const ok = await gh.closeIssue(Number(req.params.number));
  res.json({ ok });
});

export default router;

// /api/settings/* — config endpoints for AD/LDAP, MS Teams, SMTP, scheduled
// reports, Slack, Discord. All require config.write. Extracted from server.ts.
//
// Routes (mount at /api/settings):
//   GET    /ad
//   PUT    /ad
//   POST   /ad/test
//   GET    /teams
//   PUT    /teams
//   POST   /teams/test
//   GET    /smtp
//   POST   /smtp
//   POST   /smtp/test
//   GET    /reports
//   POST   /reports
//   POST   /reports/send-now
//   GET    /slack
//   POST   /slack
//   POST   /slack/test
//   GET    /discord
//   POST   /discord
//   POST   /discord/test
//
// /api/auth/providers (the public "is LDAP/Azure AD enabled" probe used by
// the login page) deliberately stays inline in server.ts — it's an auth
// surface, not a settings one.

import { Router, type Request, type Response } from 'express';
import type { ADAuthManager } from '../auth/ADAuthManager.js';
import type { ADConfigStore } from '../auth/ADConfigStore.js';
import type { TeamsConfigStore } from '../integrations/TeamsConfigStore.js';
import type { TeamsProvider } from '../integrations/TeamsProvider.js';
import type { SmtpService, SmtpConfig } from '../notifications/SmtpService.js';
import type { ReportsScheduler } from '../notifications/ReportsScheduler.js';
import type { SlackService, SlackConfig } from '../notifications/SlackService.js';
import type { DiscordService, DiscordConfig } from '../notifications/DiscordService.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { OrganizationManager } from '../agents/Organization.js';
import type { TaskManager } from '../tasks/TaskManager.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface SettingsApiDeps {
  adConfigStore: ADConfigStore;
  adManager: ADAuthManager;
  teamsConfigStore: TeamsConfigStore;
  teamsProvider: TeamsProvider;
  smtpService: SmtpService;
  reportsScheduler: ReportsScheduler;
  slackService: SlackService;
  discordService: DiscordService;
  /** reports/send-now needs a snapshot of incidents/agents/tasks. */
  incidentManager: IncidentManager;
  organization: OrganizationManager;
  taskManager: TaskManager;
  validateAuth: AuthCheck;
}

export function createSettingsRouter(deps: SettingsApiDeps): Router {
  const router = Router();
  const {
    adConfigStore,
    adManager,
    teamsConfigStore,
    teamsProvider,
    smtpService,
    reportsScheduler,
    slackService,
    discordService,
    incidentManager,
    organization,
    taskManager,
    validateAuth,
  } = deps;

  function gate(req: Request, res: Response): boolean {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return false;
    }
    return true;
  }

  // ── AD / LDAP ──────────────────────────────────────────────────────
  router.get('/ad', (req, res) => {
    if (!gate(req, res)) return;
    res.json(adConfigStore.masked());
  });

  router.put('/ad', (req, res) => {
    if (!gate(req, res)) return;
    try {
      const newCfg = req.body;
      adConfigStore.save(newCfg);
      adManager.reload(newCfg);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  router.post('/ad/test', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      if (req.body && (req.body.ldap || req.body.azure)) {
        const { ADAuthManager: ADMgr } = await import('../auth/ADAuthManager.js');
        const testManager = new ADMgr(req.body);
        const results = await testManager.testConnections();
        res.json(results);
      } else {
        const results = await adManager.testConnections();
        res.json(results);
      }
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── MS Teams ───────────────────────────────────────────────────────
  router.get('/teams', (req, res) => {
    if (!gate(req, res)) return;
    res.json(teamsConfigStore.masked());
  });

  router.put('/teams', (req, res) => {
    if (!gate(req, res)) return;
    try {
      teamsConfigStore.save(req.body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  router.post('/teams/test', async (req, res) => {
    if (!gate(req, res)) return;
    const url = req.body?.webhookUrl || teamsConfigStore.config.defaultWebhookUrl;
    if (!url) { res.status(400).json({ error: 'No webhook URL configured' }); return; }
    const result = await teamsProvider.testConnection(url);
    res.json(result);
  });

  // ── SMTP / Email ───────────────────────────────────────────────────
  router.get('/smtp', (req, res) => {
    if (!gate(req, res)) return;
    const cfg = smtpService.maskedConfig();
    res.json(cfg ?? { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: [], enabled: false });
  });

  router.post('/smtp', (req, res) => {
    if (!gate(req, res)) return;
    try {
      const body = req.body as SmtpConfig;
      // Preserve existing password when client sends back masked placeholder
      body.pass = smtpService.resolvePassword(body.pass);
      smtpService.saveConfig(body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  router.post('/smtp/test', async (req, res) => {
    if (!gate(req, res)) return;
    const result = await smtpService.testConnection();
    res.json(result);
  });

  // ── Scheduled reports ──────────────────────────────────────────────
  router.get('/reports', (req, res) => {
    if (!gate(req, res)) return;
    res.json(reportsScheduler.loadSchedule());
  });

  router.post('/reports', (req, res) => {
    if (!gate(req, res)) return;
    try {
      reportsScheduler.saveSchedule(req.body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  router.post('/reports/send-now', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const schedule = reportsScheduler.loadSchedule();
      const incidents = incidentManager.list({});
      const agents = organization.getAllAgents();
      const rawStats = taskManager.getStatistics();
      const taskStats = {
        pending: rawStats.pending || 0,
        inProgress: rawStats.in_progress || 0,
        completed: rawStats.completed || 0,
      };
      await reportsScheduler.sendReport(schedule, incidents, agents, taskStats);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to send report' });
    }
  });

  // ── Slack ──────────────────────────────────────────────────────────
  // For inbound Slack events/interactions, set SLACK_SIGNING_SECRET and use
  // validateSlackWebhook() from utils/webhookValidator.ts to verify
  // request signatures.
  router.get('/slack', (req, res) => {
    if (!gate(req, res)) return;
    res.json(slackService.maskedConfig());
  });

  router.post('/slack', (req, res) => {
    if (!gate(req, res)) return;
    try {
      const body = req.body as SlackConfig;
      body.webhookUrl = slackService.resolveWebhookUrl(body.webhookUrl);
      slackService.saveConfig(body);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  router.post('/slack/test', async (req, res) => {
    if (!gate(req, res)) return;
    const result = await slackService.testConnection();
    res.json(result);
  });

  // ── Discord ────────────────────────────────────────────────────────
  router.get('/discord', (req, res) => {
    if (!gate(req, res)) return;
    res.json(discordService.getConfig());
  });

  router.post('/discord', (req, res) => {
    if (!gate(req, res)) return;
    try {
      const body = req.body as DiscordConfig;
      body.webhookUrl = discordService.resolveWebhookUrl(body.webhookUrl);
      discordService.saveConfig(body);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  router.post('/discord/test', async (req, res) => {
    if (!gate(req, res)) return;
    const result = await discordService.testConnection();
    res.json(result);
  });

  return router;
}

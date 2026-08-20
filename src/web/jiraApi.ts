// /api/jira/* — Jira sync, ticket lookup, import-into-incident, and
// create-from-incident. Extracted from server.ts.
//
// Routes (mount at /api/jira):
//   GET  /sync/status                     (security.read)
//   POST /sync/trigger                    (security.write)
//   GET  /tickets                         (security.read)
//   GET  /tickets/:key                    (security.read)
//   POST /import/:key                     (security.write)
//   POST /create-from-incident/:incidentId (security.write)
//
// jiraService is lazily resolved via getJiraService() because in
// server.ts it starts null and is initialised after AI provider settings
// load. The reverse direction — `/api/incidents/:id/jira-link` — lives
// in incidentsApi.ts because it's "set jiraKey on this incident".

import { Router, type Request, type Response } from 'express';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { JiraIntegrationService, JiraTicket } from '../integrations/JiraIntegrationService.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface JiraApiDeps {
  incidentManager: IncidentManager;
  getJiraService: () => JiraIntegrationService | null;
  broadcast: (data: unknown) => void;
  validateAuth: AuthCheck;
}

export function createJiraRouter(deps: JiraApiDeps): Router {
  const router = Router();
  const { incidentManager, getJiraService, broadcast, validateAuth } = deps;

  router.get('/sync/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const jiraService = getJiraService();
    res.json(
      jiraService
        ? jiraService.getSyncStatus()
        : { enabled: false, lastPolledAt: null, lastTicketCount: 0, nextPollAt: null, pollIntervalMinutes: 15 },
    );
  });

  router.post('/sync/trigger', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const jiraService = getJiraService();
    if (!jiraService?.isEnabled()) {
      res.json({ triggered: false, reason: 'Jira disabled' });
      return;
    }
    jiraService.pollForUpdates(incidentManager)
      .then(count => { broadcast({ type: 'jira_sync_complete', data: { count } }); })
      .catch(() => {});
    res.json({ triggered: true, message: 'Sync triggered' });
  });

  router.get('/tickets', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const jiraService = getJiraService();
    if (!jiraService?.isEnabled()) {
      res.json({ disabled: true, tickets: [] });
      return;
    }
    try {
      const project = req.query.project as string | undefined;
      const maxResults = parseInt((req.query.maxResults as string) || '50', 10) || 50;
      let tickets: JiraTicket[];
      if (req.query.jql) {
        tickets = await jiraService.getTickets(req.query.jql as string, maxResults);
      } else if (req.query.q) {
        tickets = await jiraService.searchTickets(req.query.q as string, project);
      } else {
        const jql = project
          ? `project=${project} ORDER BY updated DESC`
          : 'ORDER BY updated DESC';
        tickets = await jiraService.getTickets(jql, maxResults);
      }
      res.json({ tickets });
    } catch {
      res.status(500).json({ error: 'Failed to fetch tickets' });
    }
  });

  router.get('/tickets/:key', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const jiraService = getJiraService();
    if (!jiraService?.isEnabled()) {
      res.status(503).json({ error: 'Jira disabled' });
      return;
    }
    try {
      const ticket = await jiraService.getTicket(req.params.key);
      if (!ticket) { res.status(404).json({ error: 'Ticket not found' }); return; }
      res.json(ticket);
    } catch {
      res.status(500).json({ error: 'Failed to fetch ticket' });
    }
  });

  router.post('/import/:key', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const jiraService = getJiraService();
    if (!jiraService?.isEnabled()) {
      res.status(503).json({ error: 'Jira disabled' });
      return;
    }
    try {
      const result = await jiraService.importTicket(req.params.key, incidentManager);
      if (!result) { res.status(404).json({ error: 'Ticket not found' }); return; }
      if (!result.alreadyExisted) {
        broadcast({ type: 'incident_updated', data: result.incident });
      }
      res.json({ incident: result.incident, alreadyExisted: result.alreadyExisted });
    } catch {
      res.status(500).json({ error: 'Import failed' });
    }
  });

  router.post('/create-from-incident/:incidentId', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const jiraService = getJiraService();
    if (!jiraService?.isEnabled()) {
      res.status(503).json({ error: 'Jira is not configured or disabled' });
      return;
    }
    const inc = incidentManager.get(req.params.incidentId);
    if (!inc) { res.status(404).json({ error: 'Incident not found' }); return; }
    try {
      const jiraKey = await jiraService.createTicketForIncident(inc);
      if (!jiraKey) {
        res.status(500).json({ error: 'Failed to create Jira issue — check Jira skill configuration' });
        return;
      }
      broadcast({ type: 'incident_updated', data: incidentManager.get(req.params.incidentId) });
      res.json({ ok: true, jiraKey });
    } catch {
      res.status(500).json({ error: 'Failed to create Jira issue' });
    }
  });

  return router;
}

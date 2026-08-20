// Incidents CRUD + lifecycle — extracted from server.ts.
//
// Routes (mount at /api/incidents):
//   GET    /stats                       (security.read)
//   GET    /                            (security.read)
//   POST   /                            (security.write) — also fires off
//                                       AI auto-analysis + multi-channel
//                                       notifications (Slack/Discord/Teams)
//   GET    /export.csv                  (security.read; supports ?token=)
//   GET    /:id                         (security.read)
//   PATCH  /:id                         (security.write)
//   POST   /:id/escalate                (security.write)
//   POST   /:id/resolve                 (security.write)
//   POST   /:id/close                   (security.write)
//   POST   /:id/note                    (security.write)
//   POST   /:id/analyze                 (security.write)
//   POST   /:incidentId/jira-link       (security.write)
//
// Side effects deliberately match the inline blocks 1:1 — same broadcast
// payloads, same Slack/Discord/Teams gate logic, same fire-and-forget
// Jira sync. This is a pure refactor; if you change behavior, update the
// matching test.
//
// Deps are passed in (not imported) so the module doesn't reach back into
// server.ts internals — same shape as the other createXxxRouter modules.

import { Router, type Request, type Response } from 'express';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { IncidentAnalyzer } from '../ai/IncidentAnalyzer.js';
import type { JiraIntegrationService } from '../integrations/JiraIntegrationService.js';
import type { TeamsProvider } from '../integrations/TeamsProvider.js';
import type { TeamsConfigStore } from '../integrations/TeamsConfigStore.js';
import type { SlackService } from '../notifications/SlackService.js';
import type { DiscordService } from '../notifications/DiscordService.js';

type AuthResult = { ok: boolean; reason?: string; username?: string; role?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;
type TokenAuthCheck = (token: string | undefined, permission?: string) => AuthResult;

/** Roles that may only see their own incidents. Admin/operator pass
 *  through unscoped; viewer reads everything (legacy security.read) but
 *  cannot mutate; `requester` is the new self-service role — strictly
 *  scoped to created_by===username, and only `incidents.read.own` /
 *  `incidents.create.own` permissions. */
const SCOPED_TO_OWN: ReadonlySet<string> = new Set(['requester']);
function isScopedRole(role: string | undefined): boolean {
  return !!role && SCOPED_TO_OWN.has(role);
}

export interface IncidentsApiDeps {
  incidentManager: IncidentManager;
  incidentAnalyzer: IncidentAnalyzer;
  /** Lazily resolved — jiraService starts null and is initialised after
   *  the AI provider settings load. Pass a getter so the router always
   *  sees the current value. */
  getJiraService: () => JiraIntegrationService | null;
  teamsProvider: TeamsProvider;
  teamsConfigStore: TeamsConfigStore;
  slackService: SlackService;
  discordService: DiscordService;
  broadcast: (data: unknown) => void;
  createNotification: (type: string, title: string, message: string, severity?: string) => void;
  validateAuth: AuthCheck;
  validateAuthToken: TokenAuthCheck;
  logError: (msg: string, ctx: Record<string, unknown>) => void;
  /** Re-route an incident to a (newly picked) agent and create an
   *  investigation task. Optional — when omitted, escalate falls back
   *  to the legacy "just bump severity" behavior. Wired in server.ts
   *  to the dispatchIncidentToAgent helper that owns the workload
   *  tracker + task manager. */
  dispatchIncidentToAgent?: (
    incident: { id: string; title: string; description?: string; severity: 'low' | 'medium' | 'high' | 'critical'; assignedAgent?: string | null },
    reason: string,
  ) => { agentId: string; agentName: string; taskId: string } | null;
}

export function createIncidentsRouter(deps: IncidentsApiDeps): Router {
  const router = Router();
  const {
    incidentManager,
    incidentAnalyzer,
    getJiraService,
    teamsProvider,
    teamsConfigStore,
    slackService,
    discordService,
    broadcast,
    createNotification,
    validateAuth,
    validateAuthToken,
    logError,
    dispatchIncidentToAgent,
  } = deps;

  // ── Stats ──────────────────────────────────────────────────────────
  router.get('/stats', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    res.json(incidentManager.getStats());
  });

  // ── List ───────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const { status, severity, assignedTo, q } = req.query as Record<string, string>;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    let incidents = incidentManager.list({ status, severity, assignedTo });
    if (q) {
      const matchIds = new Set(incidentManager.search(q).map(i => i.id));
      incidents = incidents.filter(i => matchIds.has(i.id));
    }
    const total = incidents.length;
    const page = incidents.slice(offset, offset + limit);
    res.json({ incidents: page, total, limit, offset });
  });

  // ── Mine ───────────────────────────────────────────────────────────
  // Self-service portal feed. Returns only incidents created by the
  // authenticated user. Works for every authenticated role (admin,
  // operator, viewer, requester) — admins/operators see "my tickets"
  // alongside fleet-wide; requester only ever sees this set.
  // Permission: incidents.read.own (held by admin/operator/requester).
  router.get('/mine', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'incidents.read.own');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    if (!auth.username) { res.status(403).json({ error: 'Missing principal' }); return; }
    const { status, severity, q } = req.query as Record<string, string>;
    const limit = Math.min(parseInt((req.query.limit as string) || '50', 10), 200);
    const offset = parseInt((req.query.offset as string) || '0', 10);
    let incidents = incidentManager.incidentStore.listByCreator(auth.username);
    if (status)   incidents = incidents.filter(i => i.status === status);
    if (severity) incidents = incidents.filter(i => i.severity === severity);
    if (q) {
      const needle = q.toLowerCase();
      incidents = incidents.filter(i =>
        i.title.toLowerCase().includes(needle) ||
        (i.description || '').toLowerCase().includes(needle) ||
        i.id.toLowerCase().includes(needle),
      );
    }
    const total = incidents.length;
    const page = incidents.slice(offset, offset + limit);
    res.json({ incidents: page, total, limit, offset });
  });

  // ── Create ─────────────────────────────────────────────────────────
  // Side-effects (kept identical to the inline block):
  //   1. broadcast incident_updated
  //   2. createNotification (DB-persisted notification)
  //   3. Slack / Discord / Teams notifications (each gated on its own
  //      "incidentCreated" event flag / webhook URL)
  //
  // NOTE: AI auto-analysis is NOT triggered here. IncidentManager's
  // onCreated callback (wired in server.ts) already runs the analyzer
  // for every new incident regardless of source — alert-rule, manual,
  // jira-import, or this route. Adding a second setImmediate here
  // would double-fire analyzer for API-created incidents only,
  // wasting tokens and creating two analysis writes for the same
  // incident. If onCreated stops firing in some future refactor, the
  // analyzer should re-land at the IncidentManager layer, not here.
  router.post('/', (req, res) => {
    // Two paths: admin/operator with full security.write (existing
    // behavior) OR a self-service requester with incidents.create.own.
    // Try the legacy gate first so audit logs / tests don't change; fall
    // back to the self-service perm. Either way the principal's username
    // is stamped on the row via createdBy.
    let auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) {
      const own = validateAuth(req.header('authorization') || undefined, 'incidents.create.own');
      if (!own.ok) { res.status(403).json({ error: auth.reason }); return; }
      auth = own;
    }
    try {
      const inc = incidentManager.create({
        ...req.body,
        source: req.body.source || 'manual',
        createdBy: auth.username ?? null,
      });
      broadcast({ type: 'incident_updated', data: inc });
      createNotification(
        'incident',
        `New Incident: ${inc.title}`,
        `Severity: ${inc.severity} | Status: ${inc.status}`,
        inc.severity === 'critical' ? 'critical' : inc.severity === 'high' ? 'warning' : 'info',
      );
      if (slackService.loadConfig().events?.incidentCreated) {
        slackService.notifyIncident({ id: inc.id, title: inc.title, severity: inc.severity, status: inc.status }).catch(() => {});
      }
      if (discordService.loadConfig().events?.incidentCreated) {
        discordService.notifyIncident({ id: inc.id, title: inc.title, severity: inc.severity, status: inc.status }).catch(() => {});
      }
      const teamsUrl = teamsConfigStore.getWebhookUrl('incident');
      if (teamsUrl) {
        teamsProvider.sendIncidentCard(teamsUrl, {
          id: inc.id, title: inc.title, severity: inc.severity, status: inc.status,
          assignedTo: inc.assignedTo, updatedAt: inc.createdAt,
          url: `${process.env.PUBLIC_URL || ''}/incidents.html`,
        }, 'created').catch(() => {});
      }
      res.json(inc);
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  // ── Export CSV ─────────────────────────────────────────────────────
  // Supports ?token=... so a logged-in browser can trigger a direct
  // download via <a href> without setting an Authorization header.
  router.get('/export.csv', (req, res) => {
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const auth = queryToken
      ? validateAuthToken(queryToken, 'security.read')
      : validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const incidents = incidentManager.list({});
    const header = 'id,title,severity,status,assignedTo,source,createdAt,resolvedAt,slaMinutes,slaBreached\n';
    const rows = incidents.map(i => [
      i.id,
      `"${(i.title || '').replace(/"/g, '""')}"`,
      i.severity,
      i.status,
      i.assignedTo || '',
      i.source,
      i.createdAt,
      i.resolvedAt || '',
      i.slaMinutes,
      (i as any).slaBreached ? 'true' : 'false',
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="incidents.csv"');
    res.send(header + rows);
  });

  // ── Get one ────────────────────────────────────────────────────────
  // Two paths: anyone with security.read sees any row (legacy); a
  // requester sees only their own. We try security.read first so
  // admin/operator/viewer keep identical behavior; only the failure
  // path drops to the scoped check, and that path additionally enforces
  // createdBy === username so a requester can't probe foreign INC ids.
  router.get('/:id', (req, res) => {
    let auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    let scoped = false;
    if (!auth.ok) {
      const own = validateAuth(req.header('authorization') || undefined, 'incidents.read.own');
      if (!own.ok) { res.status(403).json({ error: auth.reason }); return; }
      auth = own;
      scoped = isScopedRole(own.role);
    }
    const inc = incidentManager.get(req.params.id);
    if (!inc) { res.status(404).json({ error: 'Not found' }); return; }
    if (scoped && (inc as any).createdBy !== auth.username) {
      // Don't 404 → 403 transition: leak nothing about whether the id exists.
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(inc);
  });

  // ── Update ─────────────────────────────────────────────────────────
  router.patch('/:id', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const inc = incidentManager.update(req.params.id, req.body);
    if (!inc) { res.status(404).json({ error: 'Not found' }); return; }
    broadcast({ type: 'incident_updated', data: inc });
    const jiraService = getJiraService();
    if (jiraService?.isEnabled() && (inc as any).jiraKey && req.body.status) {
      const statusComment = `Status updated to: ${req.body.status}`;
      jiraService.addCommentToTicket((inc as any).jiraKey, statusComment).catch(() => {});
      jiraService.transitionTicket((inc as any).jiraKey, req.body.status).catch(() => {});
    }
    res.json(inc);
  });

  // ── Escalate ───────────────────────────────────────────────────────
  // Bumps severity + flips status to 'investigating' (legacy behavior),
  // then dispatches the incident to an agent so something *actually
  // happens*. The dispatcher picks an agent (re-uses the existing
  // assignment if one is present), marks them busy in the workload
  // tracker, and creates an investigation task. Without dispatchIncident
  // ToAgent wired, falls back to legacy bump-only behavior so
  // incidentsApi remains testable in isolation.
  router.post('/:id/escalate', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const inc = incidentManager.escalate(req.params.id, req.body.reason || 'Manual escalation', req.body.newAssignee);
    if (!inc) { res.status(404).json({ error: 'Not found' }); return; }
    let dispatch: { agentId: string; agentName: string; taskId: string } | null = null;
    if (dispatchIncidentToAgent) {
      try {
        dispatch = dispatchIncidentToAgent(
          { id: inc.id, title: inc.title, description: inc.description, severity: inc.severity, assignedAgent: inc.assignedAgent },
          `escalation: ${req.body.reason || 'manual'}`,
        );
      } catch (e) {
        logError('escalate dispatch failed', { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) });
      }
    }
    const after = incidentManager.get(inc.id) ?? inc;
    broadcast({ type: 'incident_updated', data: after });
    const teamsUrl = teamsConfigStore.getWebhookUrl('escalation');
    if (teamsUrl) {
      teamsProvider.sendIncidentCard(teamsUrl, {
        id: after.id, title: after.title, severity: after.severity, status: after.status,
        assignedTo: after.assignedTo, updatedAt: (after as any).updatedAt,
        url: `${process.env.PUBLIC_URL || ''}/incidents.html`,
      }, 'escalated').catch(() => {});
    }
    res.json({ ...after, dispatch });
  });

  // ── Resolve ────────────────────────────────────────────────────────
  // Resolves the incident immediately for snappy UI feedback, then
  // kicks off background verification. If the verifier reports the
  // underlying problem is still present, IncidentManager.verifyResolution
  // re-opens the incident and emits a follow-up `incident_updated`
  // broadcast. Pass `?skipVerify=true` to skip — useful for incidents
  // that have no automated verification path.
  router.post('/:id/resolve', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const inc = incidentManager.resolve(req.params.id, req.body.resolution || 'Resolved');
    if (!inc) { res.status(404).json({ error: 'Not found' }); return; }
    broadcast({ type: 'incident_updated', data: inc });
    const teamsUrl = teamsConfigStore.getWebhookUrl('incident');
    if (teamsUrl) {
      teamsProvider.sendIncidentCard(teamsUrl, {
        id: inc.id, title: inc.title, severity: inc.severity, status: inc.status,
        assignedTo: inc.assignedTo, updatedAt: (inc as any).resolvedAt,
        url: `${process.env.PUBLIC_URL || ''}/incidents.html`,
      }, 'resolved').catch(() => {});
    }

    const skipVerify = req.query.skipVerify === 'true' || req.body.skipVerify === true;
    if (!skipVerify) {
      // Fire-and-forget — the verifier may take seconds, and we want
      // the resolve POST to return immediately. If it fails, the
      // method itself re-opens the incident; we just emit a final
      // websocket update so the UI catches the flip-back.
      (async () => {
        try {
          const result = await incidentManager.verifyResolution(inc.id);
          const after = incidentManager.get(inc.id);
          if (after) broadcast({ type: 'incident_updated', data: after });
          if (!result.ok) {
            createNotification(
              'incident',
              `Resolution failed verification: ${inc.title}`,
              `Re-opened — ${result.details || 'verifier reported not-ok'}`,
              'warning',
            );
          }
        } catch (e) {
          logError('resolve verify failed', { incidentId: inc.id, err: e instanceof Error ? e.message : String(e) });
        }
      })();
    }
    res.json(inc);
  });

  // ── Close ──────────────────────────────────────────────────────────
  router.post('/:id/close', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const inc = incidentManager.close(req.params.id);
    if (!inc) { res.status(404).json({ error: 'Not found' }); return; }
    broadcast({ type: 'incident_updated', data: inc });
    res.json(inc);
  });

  // ── Add note ───────────────────────────────────────────────────────
  router.post('/:id/note', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const entry = incidentManager.addNote(req.params.id, auth.username || 'operator', req.body.message || '');
    if (!entry) { res.status(404).json({ error: 'Not found' }); return; }
    broadcast({ type: 'incident_updated', data: { id: req.params.id, note: entry } });
    const inc = incidentManager.get(req.params.id);
    const jiraService = getJiraService();
    if (jiraService?.isEnabled() && inc && (inc as any).jiraKey) {
      const actor = auth.username || 'operator';
      jiraService.addCommentToTicket((inc as any).jiraKey, `Note added by ${actor}: ${req.body.message || ''}`).catch(() => {});
    }
    res.json(entry);
  });

  // ── Analyze (manual trigger) ───────────────────────────────────────
  router.post('/:id/analyze', async (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const inc = incidentManager.get(req.params.id);
    if (!inc) { res.status(404).json({ error: 'Not found' }); return; }
    try {
      const similar = incidentManager.list({ severity: inc.severity }).filter(i => i.id !== inc.id).slice(0, 3);
      const analysis = await incidentAnalyzer.analyze(inc, similar);
      incidentManager.incidentStore.saveAnalysis(inc.id, JSON.stringify(analysis));
      res.json({ analysis });
    } catch (e: any) {
      res.status(500).json({ error: e.message || 'AI analysis failed' });
    }
  });

  // ── Jira link ──────────────────────────────────────────────────────
  // Lives under /api/incidents because it's "set jiraKey on this
  // incident". The reverse direction (create-jira-from-incident) lives
  // in /api/jira/.
  router.post('/:incidentId/jira-link', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason }); return; }
    const { jiraKey } = req.body as { jiraKey?: string };
    const { incidentId } = req.params;
    if (!jiraKey) { res.status(400).json({ error: 'jiraKey is required' }); return; }
    const inc = incidentManager.get(incidentId);
    if (!inc) { res.status(404).json({ error: 'Incident not found' }); return; }

    const jiraService = getJiraService();
    let url = '';
    if (jiraService?.isEnabled()) {
      try {
        const ticket = await jiraService.getTicket(jiraKey);
        url = ticket?.url || '';
      } catch { /* ignore */ }
    }
    if (!url) {
      const base = process.env.JIRA_BASE_URL || '';
      url = base ? `${base}/browse/${jiraKey}` : '';
    }

    incidentManager.incidentStore.updateJiraKey(incidentId, jiraKey, url);
    broadcast({ type: 'incident_updated', data: incidentManager.get(incidentId) });
    res.json({ ok: true, jiraKey, jiraUrl: url });
  });

  return router;
}

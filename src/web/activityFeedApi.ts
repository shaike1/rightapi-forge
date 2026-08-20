// /api/activity — agent-centric activity feed for the Dashboard.
//
// Derives a single chronological stream from three sources:
//   1. Incident timeline notes — every "agent did X" written by
//      AgentIncidentHandler / IncidentAutoRemediator / EscalationPipeline
//      lands here, plus operator notes.
//   2. Incident lifecycle events — opened / escalated / resolved / closed.
//   3. Task completion + agent assignment broadcasts (last N kept by
//      server.ts in memory; passed in via the deps so we don't reach
//      across modules).
//
// The output is intentionally lightweight (id, ts, kind, message,
// optional incidentId/agentName) so the Dashboard widget can render N
// rows without a heavy round-trip per row. The actor strings the rest
// of the platform writes (agent ids vs display names) are normalised
// through a lookup map the caller passes in.

import { Router, type Request, type Response } from 'express';
import type { IncidentManager } from '../incidents/IncidentManager.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export type ActivityKind =
  | 'incident_opened'
  | 'incident_escalated'
  | 'incident_resolved'
  | 'incident_closed'
  | 'agent_note'
  | 'agent_action'        // generic catch-all when actor looks like an agent
  | 'escalation_level'    // "[L<n>] …" timeline notes from EscalationPipeline
  | 'remediation_step';   // notes from IncidentAutoRemediator

export interface ActivityItem {
  id: string;
  timestamp: string;
  kind: ActivityKind;
  message: string;
  /** Original timeline actor (agent id, "system", "auto-remediator", …). */
  actor: string;
  /** Resolved display name if the actor maps to a known agent. */
  actorName?: string;
  incidentId?: string;
  incidentTitle?: string;
  serverId?: string | null;
  /** For escalation_level entries, the parsed L<n>. */
  level?: number;
}

export interface ActivityFeedApiDeps {
  incidentManager: IncidentManager;
  /** Resolves an actor id to a display name. Optional — when missing or
   *  returning null, the raw actor string is shown. */
  resolveAgentName?: (idOrName: string) => string | null;
  validateAuth: AuthCheck;
}

/** Map the raw timeline `type` + actor into one of our ActivityKind
 *  buckets. Agent actions are distinguished by the actor *not* being
 *  one of the well-known system actors. */
function classify(timelineType: string, actor: string, message: string): ActivityKind {
  if (timelineType === 'opened')    return 'incident_opened';
  if (timelineType === 'escalated') return 'incident_escalated';
  if (timelineType === 'resolved')  return 'incident_resolved';
  if (timelineType === 'closed')    return 'incident_closed';
  if (timelineType !== 'note' && timelineType !== 'updated') return 'agent_action';
  // Note-typed entries: pick a sub-kind by content/actor.
  if (actor === 'escalation-pipeline' || /^\[L\d\]/.test(message)) return 'escalation_level';
  if (actor === 'auto-remediator' || /^Auto-remediator/i.test(message)) return 'remediation_step';
  if (actor === 'system' || actor === 'health-monitor' || actor === 'agent-incident-handler') return 'agent_action';
  // Looks like a real agent name/id wrote this.
  return 'agent_note';
}

/** Pull the L<n> out of an "[L3] …" timeline message, if present. */
function parseEscalationLevel(message: string): number | undefined {
  const m = /^\[L(\d)\]/.exec(message);
  return m ? Number(m[1]) : undefined;
}

export function createActivityFeedRouter(deps: ActivityFeedApiDeps): Router {
  const router = Router();

  router.get('/recent', (req, res) => {
    const auth = deps.validateAuth(req.headers.authorization, 'security.read');
    if (!auth.ok) {
      return res.status(401).json({ error: auth.reason || 'unauthorized' });
    }

    const limit = Math.min(Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50), 500);
    const kindFilter = typeof req.query.kind === 'string'
      ? new Set(String(req.query.kind).split(',').map(s => s.trim()).filter(Boolean) as ActivityKind[])
      : null;
    const sinceMs = req.query.sinceMs ? Number(req.query.sinceMs) : Date.now() - 24 * 3600 * 1000;
    const incidentIdFilter = typeof req.query.incidentId === 'string' && req.query.incidentId ? String(req.query.incidentId) : null;

    try {
      // Walk the active+recent incidents. We don't have a global
      // timeline table, so iterate per-incident — fine at the scale of
      // a typical Beacon deployment (low thousands of incidents).
      const incidents = deps.incidentManager.list();
      const items: ActivityItem[] = [];
      for (const inc of incidents) {
        if (incidentIdFilter && inc.id !== incidentIdFilter) continue;
        const tl = deps.incidentManager.getTimeline(inc.id);
        for (const t of tl) {
          const ts = Date.parse(t.timestamp);
          if (!Number.isFinite(ts) || ts < sinceMs) continue;
          const kind = classify(t.type, t.actor, t.message);
          if (kindFilter && !kindFilter.has(kind)) continue;
          items.push({
            id: t.id,
            timestamp: t.timestamp,
            kind,
            message: t.message,
            actor: t.actor,
            actorName: deps.resolveAgentName?.(t.actor) ?? undefined,
            incidentId: inc.id,
            incidentTitle: inc.title,
            serverId: inc.serverId ?? null,
            level: kind === 'escalation_level' ? parseEscalationLevel(t.message) : undefined,
          });
        }
      }
      // Newest first; truncate.
      items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
      res.json({ items: items.slice(0, limit), total: items.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

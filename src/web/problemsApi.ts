// /api/problems — recurring-incident problem records + AI analysis.
//
// Routes:
//   GET    /                  list (operator+ read)
//   GET    /:id               with linked incidents + occurrences
//   PUT    /:id               status / resolution / severity (operator+)
//   POST   /:id/analyze       re-run the AI root-cause analysis
//   POST   /:id/create-runbook  auto-generate a runbook from AI suggestion (admin)
//
// All mutations audited via the shared AuditLog so /api/audit shows
// which operator marked which problem investigating/resolved.

import { Router, type Request, type Response } from 'express';
import type {
  Problem, ProblemStatus, ProblemSeverity, ProblemStore,
} from '../incidents/ProblemStore.js';
import type { RecurringDetector } from '../incidents/RecurringDetector.js';
import type { RunbookEngine } from '../runbooks/RunbookEngine.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

export interface ProblemsApiDeps {
  problems: ProblemStore;
  detector: RecurringDetector;
  runbooks?: RunbookEngine;
  auditLog?: AuditLog;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string; role?: UserRole };
}

const VALID_STATUSES: ReadonlySet<ProblemStatus> = new Set<ProblemStatus>(['open', 'investigating', 'resolved']);
const VALID_SEVERITIES: ReadonlySet<ProblemSeverity> = new Set<ProblemSeverity>(['low', 'medium', 'high', 'critical']);

export function createProblemsRouter(deps: ProblemsApiDeps): Router {
  const router = Router();
  const { problems, detector, runbooks, auditLog, validateAuth } = deps;

  function gate(req: Request, res: Response, permission: string): { ok: boolean; username?: string; role?: UserRole } {
    const auth = validateAuth(req.header('authorization') || undefined, permission);
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return { ok: false };
    }
    return { ok: true, username: auth.username, role: auth.role };
  }

  function audit(req: Request, actor: { username?: string; role?: UserRole } | null, action: string, success: boolean, detail?: string): void {
    if (!auditLog) return;
    auditLog.log({
      action,
      username: actor?.username || 'anonymous',
      role: (actor?.role as string) || 'unknown',
      resource: req.path,
      method: req.method,
      ip: req.ip || '',
      success,
      ...(detail ? { detail } : {}),
    });
  }

  router.get('/', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    const rawSev    = typeof req.query.severity === 'string' ? req.query.severity : undefined;
    const rawServer = typeof req.query.server === 'string' ? req.query.server : undefined;
    res.json({
      problems: problems.list({
        status: rawStatus && VALID_STATUSES.has(rawStatus as ProblemStatus) ? (rawStatus as ProblemStatus) : undefined,
        severity: rawSev && VALID_SEVERITIES.has(rawSev as ProblemSeverity) ? (rawSev as ProblemSeverity) : undefined,
        serverId: rawServer,
      }),
      stats: problems.stats(),
    });
  });

  router.get('/top-recurring', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 3, 20) : 3;
    res.json({ top: problems.topRecurring(limit) });
  });

  // Reverse lookup — used by IncidentDetailPage to show a "Part of
  // problem" banner. Returns null when the incident isn't linked.
  router.get('/by-incident/:incidentId', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const p = problems.findProblemForIncident(String(req.params.incidentId));
    if (!p) {
      res.json({ problem: null });
      return;
    }
    const occurrences = problems.getLinkedIncidents(p.id).length;
    res.json({ problem: { ...p, occurrences } });
  });

  router.get('/:id', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const p = problems.getWithIncidents(String(req.params.id));
    if (!p) {
      res.status(404).json({ error: 'problem not found' });
      return;
    }
    res.json({ problem: p });
  });

  router.put('/:id', (req, res) => {
    const actor = gate(req, res, 'approvals.read');  // operator+ can adjust state
    if (!actor.ok) return;
    const patch: Record<string, unknown> = {};
    const b = req.body || {};
    if (b.title       !== undefined) patch.title = String(b.title);
    if (b.description !== undefined) patch.description = String(b.description);
    if (b.status      !== undefined) {
      if (!VALID_STATUSES.has(b.status)) {
        res.status(400).json({ error: 'status must be open | investigating | resolved' });
        return;
      }
      patch.status = b.status;
    }
    if (b.severity    !== undefined) {
      if (!VALID_SEVERITIES.has(b.severity)) {
        res.status(400).json({ error: 'severity must be low | medium | high | critical' });
        return;
      }
      patch.severity = b.severity;
    }
    if (b.resolution  !== undefined) patch.resolution = String(b.resolution);
    if (b.rootCause   !== undefined) patch.rootCause = String(b.rootCause);
    if (b.suggestedFix!== undefined) patch.suggestedFix = String(b.suggestedFix);
    if (patch.status === 'resolved') patch.resolvedBy = actor.username ?? null;
    const updated = problems.update(String(req.params.id), patch as any);
    if (!updated) {
      res.status(404).json({ error: 'problem not found' });
      return;
    }
    audit(req, actor, 'problems.update', true, `id=${updated.id} changed=${Object.keys(patch).join(',')}`);
    res.json({ problem: updated });
  });

  router.post('/:id/analyze', async (req, res) => {
    const actor = gate(req, res, 'approvals.read');
    if (!actor.ok) return;
    const updated = await detector.analyze(String(req.params.id));
    if (!updated) {
      res.status(404).json({ error: 'problem not found' });
      return;
    }
    audit(req, actor, 'problems.analyze', true, `id=${updated.id}`);
    res.json({ problem: updated });
  });

  router.post('/:id/create-runbook', async (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    if (!runbooks) {
      res.status(503).json({ error: 'runbook engine not available' });
      return;
    }
    const p = problems.get(String(req.params.id));
    if (!p) {
      res.status(404).json({ error: 'problem not found' });
      return;
    }
    if (!p.aiRaw) {
      res.status(400).json({ error: 'no AI analysis yet — run /analyze first' });
      return;
    }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(p.aiRaw); }
    catch {
      res.status(400).json({ error: 'AI analysis is malformed — re-run /analyze' });
      return;
    }
    const steps = Array.isArray(parsed.preventionRunbook) ? parsed.preventionRunbook : [];
    if (steps.length === 0) {
      res.status(400).json({ error: 'AI did not produce a prevention runbook — re-run /analyze or adjust manually' });
      return;
    }
    // Normalise the AI's loose step shape into RunbookStep — give every
    // step an id, default description, and trust the AI's `type` field
    // when it matches one of the engine's supported kinds.
    const normalised = steps.map((raw, i) => {
      const r = raw as Record<string, unknown>;
      const stepId = (typeof r.id === 'string' && r.id) ? r.id : `s${i + 1}`;
      const description = (typeof r.description === 'string' && r.description) ? r.description : `Auto-step ${i + 1}`;
      return { ...r, id: stepId, description };
    });
    const templateId = `prb-${p.id.toLowerCase()}-prevention`;
    try {
      const template = runbooks.addTemplate({
        id: templateId,
        name: `Prevention: ${p.title}`,
        description: `Auto-generated from AI analysis of ${p.id}. Edit before running in production.`,
        category: 'prevention',
        tags: ['auto-generated', 'problem-prevention', p.id],
        steps: normalised as any,
        triggerType: 'manual',
        triggerConfig: {},
        enabled: false, // operator must explicitly enable
        createdBy: actor.username,
      });
      audit(req, actor, 'problems.create-runbook', true, `problemId=${p.id} templateId=${template.id} steps=${normalised.length}`);
      res.status(201).json({ template });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'problems.create-runbook.error', false, msg);
      res.status(400).json({ error: msg });
    }
  });

  return router;
}

void ((_: Problem | undefined) => _);

import { Router, type Request, type Response } from 'express';
import type { RunbookEngine } from '../runbooks/RunbookEngine.js';
import type { RunbookApprovalStore } from '../runbooks/RunbookApprovalStore.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

export interface RunbooksApiDeps {
  engine: RunbookEngine;
  /** Optional — when present, approve / reject routes use this for the
   *  full audit chain (request → decision). The engine itself also
   *  writes approval rows to this store. */
  approvals?: RunbookApprovalStore;
  auditLog?: AuditLog;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string; role?: UserRole };
}

// Permission → JWT role mapping uses the existing matrix:
//   operator+ (operator, admin) can read + execute + cancel
//   admin     only             can mint/update/delete templates and approve / reject
// We piggy-back on `approvals.manage` (admin-only) for decisions and
// `approvals.read` (everyone) for listing pending approvals. Existing
// permission strings — see security/AuthService.ts.

export function createRunbooksRouter(deps: RunbooksApiDeps): Router {
  const router = Router();
  const { engine, approvals, auditLog, validateAuth } = deps;

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

  // ─── Templates ────────────────────────────────────────────────────────

  router.get('/templates', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    res.json({ templates: engine.listTemplates() });
  });

  router.get('/templates/:id', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const template = engine.getTemplate(String(req.params.id));
    if (!template) {
      res.status(404).json({ error: 'template not found' });
      return;
    }
    res.json({ template });
  });

  router.post('/templates', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const { id, name, description, category, steps, tags, triggerType, triggerConfig, enabled } = req.body || {};
      if (!id || !name || !description || !category || !Array.isArray(steps)) {
        res.status(400).json({ error: 'id, name, description, category, steps are required' });
        return;
      }
      const template = engine.addTemplate({
        id, name, description, category, steps, tags: tags ?? [],
        triggerType: triggerType ?? 'manual',
        triggerConfig: triggerConfig ?? {},
        enabled: enabled !== false,
        createdBy: actor.username,
      });
      audit(req, actor, 'runbooks.template.create', true, `id=${template.id} trigger=${template.triggerType}`);
      res.status(201).json({ template });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to add template';
      audit(req, actor, 'runbooks.template.create.error', false, msg);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.patch('/templates/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const template = engine.updateTemplate(String(req.params.id), req.body || {});
      audit(req, actor, 'runbooks.template.update', true, `id=${template.id}`);
      res.json({ template });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to update template';
      audit(req, actor, 'runbooks.template.update.error', false, msg);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.delete('/templates/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      engine.deleteTemplate(String(req.params.id));
      audit(req, actor, 'runbooks.template.delete', true, `id=${req.params.id}`);
      res.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to delete template';
      audit(req, actor, 'runbooks.template.delete.error', false, msg);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ─── Runs ─────────────────────────────────────────────────────────────

  router.get('/runs', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const status = typeof req.query.status === 'string' ? req.query.status as import('../runbooks/RunbookTypes.js').RunbookStatus : undefined;
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 200, 1000) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) || 0 : undefined;
    res.json({ runs: engine.listRuns(status, { limit, offset }) });
  });

  router.get('/runs/export.csv', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const runs = engine.listRuns();
    const header = 'id,templateId,templateName,status,startedAt,completedAt,triggeredBy\n';
    const rows = runs.map(r => [
      r.id, r.templateId,
      `"${(r.templateName || '').replace(/"/g, '""')}"`,
      r.status, r.startedAt, r.completedAt || '',
      `"${(r.triggeredBy || '').replace(/"/g, '""')}"`,
    ].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="runbook-history.csv"');
    res.send(header + rows);
  });

  router.get('/runs/:id', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const run = engine.getRun(String(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    const approvalsForRun = approvals ? approvals.listForRun(run.id) : [];
    res.json({ run, approvals: approvalsForRun });
  });

  router.post('/runs', async (req, res) => {
    const actor = gate(req, res, 'tools.execute.safe');
    if (!actor.ok) return;
    try {
      const { templateId, triggeredBy, context } = req.body || {};
      if (!templateId) {
        res.status(400).json({ error: 'templateId is required' });
        return;
      }
      const run = await engine.executeRun(
        String(templateId),
        String(triggeredBy || actor.username || 'api'),
        { context: context && typeof context === 'object' ? context : undefined },
      );
      audit(req, actor, 'runbooks.run.execute', true, `templateId=${templateId} runId=${run.id}`);
      res.status(201).json({ run });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to execute run';
      audit(req, actor, 'runbooks.run.execute.error', false, msg);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/runs/:id/approve', (req, res) => {
    const actor = gate(req, res, 'approvals.manage');
    if (!actor.ok) return;
    try {
      const { reason } = req.body || {};
      engine.approveStep(String(req.params.id), actor.username || 'unknown', typeof reason === 'string' ? reason : undefined);
      audit(req, actor, 'runbooks.run.approve', true, `runId=${req.params.id}${reason ? ` reason="${String(reason).slice(0, 120)}"` : ''}`);
      res.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to approve step';
      audit(req, actor, 'runbooks.run.approve.error', false, msg);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/runs/:id/reject', (req, res) => {
    const actor = gate(req, res, 'approvals.manage');
    if (!actor.ok) return;
    try {
      const { reason } = req.body || {};
      if (typeof reason !== 'string' || !reason.trim()) {
        res.status(400).json({ error: 'reason is required when rejecting' });
        return;
      }
      engine.rejectStep(String(req.params.id), actor.username || 'unknown', reason.trim());
      audit(req, actor, 'runbooks.run.reject', true, `runId=${req.params.id} reason="${reason.slice(0, 200)}"`);
      res.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to reject step';
      audit(req, actor, 'runbooks.run.reject.error', false, msg);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/runs/:id/cancel', (req, res) => {
    const actor = gate(req, res, 'tools.execute.safe');
    if (!actor.ok) return;
    try {
      const { reason } = req.body || {};
      engine.cancelRun(String(req.params.id), reason);
      audit(req, actor, 'runbooks.run.cancel', true, `runId=${req.params.id}`);
      res.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'failed to cancel run';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ─── Approvals ────────────────────────────────────────────────────────
  // Spec calls these out as a separate API surface but they're naturally
  // a sub-resource of /api/runbooks since every approval ties to a run.
  // We expose them inline here so the frontend doesn't need to juggle two
  // base URLs. /api/approvals (generic token API) stays untouched.

  router.get('/approvals/pending', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    if (!approvals) {
      res.json({ approvals: [] });
      return;
    }
    res.json({ approvals: approvals.listPending() });
  });

  router.get('/approvals/run/:runId', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    if (!approvals) {
      res.json({ approvals: [] });
      return;
    }
    res.json({ approvals: approvals.listForRun(String(req.params.runId)) });
  });

  return router;
}

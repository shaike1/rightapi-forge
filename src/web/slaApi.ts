// /api/sla — policy CRUD + tracking + metrics surface.
//
// Permission model mirrors the rest of the platform: operator+ for reads,
// admin for mutations. Every mutation emits an audit row so the audit
// page shows who tweaked which policy.

import { Router, type Request, type Response } from 'express';
import type { SLAEngine, MetricsPeriod } from '../sla/SLAEngine.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

export interface SLAApiDeps {
  engine: SLAEngine;
  auditLog?: AuditLog;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string; role?: UserRole };
}

const VALID_PERIODS: ReadonlySet<MetricsPeriod> = new Set<MetricsPeriod>(['24h', '7d', '30d', '90d']);

export function createSlaRouter(deps: SLAApiDeps): Router {
  const router = Router();
  const { engine, auditLog, validateAuth } = deps;

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

  function periodOf(req: Request): MetricsPeriod {
    const raw = String(req.query.period || '7d');
    return VALID_PERIODS.has(raw as MetricsPeriod) ? (raw as MetricsPeriod) : '7d';
  }

  // ── Policies ──────────────────────────────────────────────────────────

  router.get('/policies', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    res.json({ policies: engine.listPolicies() });
  });

  router.post('/policies', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const { name, severity, responseTimeMinutes, resolutionTimeMinutes, businessHoursOnly, enabled } = req.body || {};
      const policy = engine.createPolicy({
        name: String(name ?? ''),
        severity,
        responseTimeMinutes: Number(responseTimeMinutes),
        resolutionTimeMinutes: Number(resolutionTimeMinutes),
        businessHoursOnly: !!businessHoursOnly,
        enabled: enabled !== false,
      });
      audit(req, actor, 'sla.policy.create', true, `id=${policy.id} severity=${policy.severity}`);
      res.status(201).json({ policy });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'sla.policy.create.error', false, msg);
      res.status(400).json({ error: msg });
    }
  });

  router.put('/policies/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const patch: Record<string, unknown> = {};
      const b = req.body || {};
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.severity !== undefined) patch.severity = b.severity;
      if (b.responseTimeMinutes   !== undefined) patch.responseTimeMinutes   = Number(b.responseTimeMinutes);
      if (b.resolutionTimeMinutes !== undefined) patch.resolutionTimeMinutes = Number(b.resolutionTimeMinutes);
      if (b.businessHoursOnly !== undefined) patch.businessHoursOnly = !!b.businessHoursOnly;
      if (b.enabled !== undefined) patch.enabled = !!b.enabled;
      const updated = engine.updatePolicy(String(req.params.id), patch as any);
      if (!updated) {
        res.status(404).json({ error: 'policy not found' });
        return;
      }
      audit(req, actor, 'sla.policy.update', true, `id=${updated.id} changed=${Object.keys(patch).join(',')}`);
      res.json({ policy: updated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'sla.policy.update.error', false, msg);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/policies/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    const ok = engine.deletePolicy(String(req.params.id));
    audit(req, actor, ok ? 'sla.policy.delete' : 'sla.policy.delete.notfound', ok, `id=${req.params.id}`);
    if (!ok) {
      res.status(404).json({ error: 'policy not found' });
      return;
    }
    res.json({ success: true });
  });

  // ── Tracking ──────────────────────────────────────────────────────────

  router.get('/tracking', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const state = req.query.state === 'breached' || req.query.state === 'met' || req.query.state === 'pending'
      ? (req.query.state as 'breached' | 'met' | 'pending')
      : undefined;
    const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 200, 2000) : undefined;
    res.json({ tracking: engine.listTracking({ state, limit }) });
  });

  router.get('/tracking/:incidentId', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const t = engine.getTracking(String(req.params.incidentId));
    if (!t) {
      res.status(404).json({ error: 'tracking not found' });
      return;
    }
    res.json({ tracking: t });
  });

  // ── Metrics ───────────────────────────────────────────────────────────

  router.get('/metrics', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const period = periodOf(req);
    res.json({
      period,
      overall: engine.getMetrics(period),
      bySeverity: engine.getMetricsBySeverity(period),
      trend: engine.getComplianceTrend(period),
    });
  });

  return router;
}

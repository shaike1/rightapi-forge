// /api/reports — schedule CRUD + on-demand generation + history.
//
// Permission model:
//   - approvals.read → list/get schedules, history, generate-on-demand
//                      (operator+ can request a report)
//   - admin.write    → create/update/delete schedules
//
// Mutations + on-demand generation are audited via the scheduler's own
// audit hook (passed in at construction); routes only handle the HTTP
// shape and gating.

import { Router, type Request, type Response } from 'express';
import type { ReportScheduler } from '../reports/ReportScheduler.js';
import { formatReport } from '../reports/ReportScheduler.js';
import type { ReportFormat, ReportType } from '../reports/ReportTypes.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

const VALID_TYPES: ReadonlySet<ReportType> = new Set<ReportType>(['daily_summary', 'weekly_report', 'monthly_report']);
const VALID_FORMATS: ReadonlySet<ReportFormat> = new Set<ReportFormat>(['html', 'markdown', 'json']);

export interface ReportsApiDeps {
  scheduler: ReportScheduler;
  auditLog?: AuditLog;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string; role?: UserRole };
}

export function createReportsRouter(deps: ReportsApiDeps): Router {
  const router = Router();
  const { scheduler, auditLog, validateAuth } = deps;

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

  // ─── Schedules ────────────────────────────────────────────────────────

  router.get('/schedules', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    res.json({ schedules: scheduler.listSchedules() });
  });

  router.post('/schedules', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const { name, reportType, cronExpression, channels, enabled } = req.body || {};
      if (!VALID_TYPES.has(reportType)) {
        res.status(400).json({ error: 'reportType must be daily_summary | weekly_report | monthly_report' });
        return;
      }
      const created = scheduler.createSchedule({
        name: String(name ?? ''),
        reportType,
        cronExpression: String(cronExpression ?? ''),
        channels: Array.isArray(channels) ? channels : [],
        enabled: enabled !== false,
        createdBy: actor.username ?? null,
      });
      audit(req, actor, 'reports.schedule.create', true, `id=${created.id} type=${created.reportType} cron="${created.cronExpression}"`);
      res.status(201).json({ schedule: created });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'reports.schedule.create.error', false, msg);
      res.status(400).json({ error: msg });
    }
  });

  router.put('/schedules/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const b = req.body || {};
      const patch: Record<string, unknown> = {};
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.reportType !== undefined) {
        if (!VALID_TYPES.has(b.reportType)) {
          res.status(400).json({ error: 'reportType must be daily_summary | weekly_report | monthly_report' });
          return;
        }
        patch.reportType = b.reportType;
      }
      if (b.cronExpression !== undefined) patch.cronExpression = String(b.cronExpression);
      if (b.channels !== undefined) patch.channels = Array.isArray(b.channels) ? b.channels : [];
      if (b.enabled !== undefined) patch.enabled = !!b.enabled;
      const updated = scheduler.updateSchedule(String(req.params.id), patch as any);
      if (!updated) {
        res.status(404).json({ error: 'schedule not found' });
        return;
      }
      audit(req, actor, 'reports.schedule.update', true, `id=${updated.id} changed=${Object.keys(patch).join(',')}`);
      res.json({ schedule: updated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'reports.schedule.update.error', false, msg);
      res.status(400).json({ error: msg });
    }
  });

  router.delete('/schedules/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    const ok = scheduler.deleteSchedule(String(req.params.id));
    audit(req, actor, ok ? 'reports.schedule.delete' : 'reports.schedule.delete.notfound', ok, `id=${req.params.id}`);
    if (!ok) {
      res.status(404).json({ error: 'schedule not found' });
      return;
    }
    res.json({ success: true });
  });

  // ─── On-demand + history ──────────────────────────────────────────────

  router.post('/generate', async (req, res) => {
    const actor = gate(req, res, 'approvals.read');
    if (!actor.ok) return;
    const { type, format } = req.body || {};
    if (!VALID_TYPES.has(type)) {
      res.status(400).json({ error: 'type must be daily_summary | weekly_report | monthly_report' });
      return;
    }
    const fmt = VALID_FORMATS.has(format) ? format : 'markdown';
    try {
      const r = await scheduler.runOnce({ type, format: fmt, triggeredBy: `api:${actor.username ?? 'unknown'}` });
      res.json({ data: r.data, rendered: r.rendered, format: fmt, historyId: r.historyId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'reports.generate.error', false, msg);
      res.status(500).json({ error: msg });
    }
  });

  router.get('/history', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) || 50 : 50;
    res.json({ history: scheduler.listHistory(limit) });
  });

  router.get('/history/:id', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const item = scheduler.getHistory(String(req.params.id));
    if (!item) {
      res.status(404).json({ error: 'history entry not found' });
      return;
    }
    // Allow client to request a rendered format inline.
    const format = req.query.format as ReportFormat | undefined;
    if (format && VALID_FORMATS.has(format)) {
      res.json({ ...item, rendered: formatReport(item.data, format), format });
      return;
    }
    res.json(item);
  });

  return router;
}

// /api/integrations/plugins — admin-facing CRUD for event-driven plugins.
//
// Mounted under the existing /api/integrations namespace so the new
// Integrations sidebar entry has one base URL. The existing
// integrationsApi.ts routes (/pagerduty, /github/*) keep working
// unchanged — Express matches the specific paths there before /plugins/*
// in this router.
//
// Permission model:
//   - admin.write   → list / get / config / enable / disable / test
//   - approvals.read → status + external incidents read (operator+)
//
// Every mutating route emits an audit row so the audit log shows who
// turned which integration on/off and when.

import { Router, type Request, type Response } from 'express';
import type { PluginManager } from '../plugins/PluginManager.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

export interface IntegrationPluginsApiDeps {
  manager: PluginManager;
  auditLog?: AuditLog;
  validateAuth: (
    authHeader: string | undefined,
    permission?: string,
  ) => { ok: boolean; reason?: string; username?: string; role?: UserRole };
}

export function createIntegrationPluginsRouter(deps: IntegrationPluginsApiDeps): Router {
  const router = Router();
  const { manager, auditLog, validateAuth } = deps;

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
    res.json({ integrations: manager.list() });
  });

  router.get('/:id', (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const v = manager.get(String(req.params.id));
    if (!v) {
      res.status(404).json({ error: 'integration not found' });
      return;
    }
    res.json({ integration: v });
  });

  router.put('/:id/config', async (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const config = (req.body && typeof req.body === 'object' && req.body.config && typeof req.body.config === 'object')
        ? req.body.config
        : req.body;
      if (!config || typeof config !== 'object') {
        res.status(400).json({ error: 'config object is required' });
        return;
      }
      const updated = await manager.setConfig(String(req.params.id), config as Record<string, unknown>);
      const keys = Object.keys(config as Record<string, unknown>).join(',');
      audit(req, actor, 'integrations.config.update', true, `id=${updated.id} fields=${keys}`);
      res.json({ integration: updated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'integrations.config.update.error', false, msg);
      res.status(msg.includes('Unknown plugin') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/:id/enable', async (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const updated = await manager.enable(String(req.params.id));
      audit(req, actor, 'integrations.enable', true, `id=${updated.id}`);
      res.json({ integration: updated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit(req, actor, 'integrations.enable.error', false, msg);
      // onLoad failure leaves enabled=1 with last_error set so the UI
      // surfaces the error banner. 502 distinguishes "your call was
      // fine, the upstream broke" from a 400 schema rejection.
      const status = msg.includes('Unknown plugin') ? 404 : msg.includes('onLoad failed') ? 502 : 400;
      res.status(status).json({ error: msg, integration: manager.get(String(req.params.id)) });
    }
  });

  router.post('/:id/disable', async (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    try {
      const updated = await manager.disable(String(req.params.id));
      audit(req, actor, 'integrations.disable', true, `id=${updated.id}`);
      res.json({ integration: updated });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(msg.includes('Unknown plugin') ? 404 : 400).json({ error: msg });
    }
  });

  router.post('/:id/test', async (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    const config = (req.body && typeof req.body === 'object' && req.body.config && typeof req.body.config === 'object')
      ? req.body.config
      : (req.body ?? {});
    const result = await manager.testConnection(String(req.params.id), config as Record<string, unknown>);
    audit(req, actor, result.ok ? 'integrations.test.ok' : 'integrations.test.fail', result.ok, result.error);
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.get('/:id/status', async (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const status = await manager.externalStatus(String(req.params.id));
    res.json({ status });
  });

  router.get('/:id/incidents', async (req, res) => {
    if (!gate(req, res, 'approvals.read').ok) return;
    const incidents = await manager.externalIncidents(String(req.params.id));
    res.json({ incidents });
  });

  return router;
}

// /api/changes — Change Management REST surface.
//
// Routes:
//   GET    /                       list (filters)
//   GET    /stats                  totals by status + type
//   GET    /:id                    single change
//   POST   /                       create (operator+)
//   PUT    /:id                    update (operator+)
//   DELETE /:id                    delete (admin)
//   GET    /by-incident/:id        correlated changes for an incident
//                                  ("possible cause" surface)
//
// Mutations audited. onChangeCreated / onChangeCompleted fan-out via
// the optional callbacks so server.ts wires the PluginManager hooks
// without this router knowing about plugins.

import { Router } from 'express';
import type { ChangeStore, Change, ChangeStatus, ChangeType, ChangeRisk } from '../changes/ChangeStore.js';
import type { ChangeCorrelation } from '../changes/ChangeCorrelation.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

type AuthResult = { ok: boolean; reason?: string; username?: string; role?: UserRole };

const VALID_TYPES: ReadonlySet<ChangeType> = new Set(['deployment', 'config', 'maintenance', 'emergency', 'auto-remediation']);
const VALID_STATUSES: ReadonlySet<ChangeStatus> = new Set(['planned', 'in_progress', 'completed', 'failed', 'rolled_back']);
const VALID_RISK: ReadonlySet<ChangeRisk> = new Set(['low', 'medium', 'high']);

export interface ChangesApiDeps {
  changeStore: ChangeStore;
  changeCorrelation: ChangeCorrelation;
  incidentManager: IncidentManager;
  auditLog?: AuditLog;
  validateAuth: (authHeader: string | undefined, permission?: string) => AuthResult;
  onChangeCreated?: (change: Change) => void;
  onChangeCompleted?: (change: Change) => void;
}

export function createChangesRouter(deps: ChangesApiDeps): Router {
  const router = Router();
  const { changeStore, changeCorrelation, incidentManager, auditLog, validateAuth, onChangeCreated, onChangeCompleted } = deps;

  function gate(req: any, res: any, permission: string): AuthResult {
    const a = validateAuth(req.header('authorization') || undefined, permission);
    if (!a.ok) { res.status(403).json({ error: a.reason || 'Forbidden' }); return { ok: false }; }
    return a;
  }
  function audit(req: any, actor: AuthResult | null, action: string, success: boolean, detail?: string): void {
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

  router.get('/stats', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    res.json(changeStore.stats());
  });

  router.get('/', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const status = typeof req.query.status === 'string' && VALID_STATUSES.has(req.query.status as ChangeStatus) ? req.query.status as ChangeStatus : undefined;
    const type   = typeof req.query.type   === 'string' && VALID_TYPES.has(req.query.type as ChangeType)       ? req.query.type as ChangeType       : undefined;
    const filter = {
      status,
      type,
      assetId:  typeof req.query.assetId  === 'string' ? req.query.assetId  : undefined,
      serverId: typeof req.query.serverId === 'string' ? req.query.serverId : undefined,
      since:    typeof req.query.since    === 'string' ? req.query.since    : undefined,
      until:    typeof req.query.until    === 'string' ? req.query.until    : undefined,
    };
    res.json({ changes: changeStore.list(filter), stats: changeStore.stats() });
  });

  router.get('/by-incident/:incidentId', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const inc = incidentManager.get(String(req.params.incidentId));
    if (!inc) { res.status(404).json({ error: 'incident not found' }); return; }
    const correlated = changeCorrelation.correlate({
      id: inc.id,
      createdAt: inc.createdAt,
      serverId: inc.serverId,
      // incidents don't yet carry an assetId column — correlation picks up
      // the auto-discovered asset from the server lookup.
      assetId: null,
    });
    res.json({ correlated });
  });

  router.get('/:id', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const c = changeStore.get(String(req.params.id));
    if (!c) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ change: c });
  });

  router.post('/', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const b = req.body || {};
    if (!VALID_TYPES.has(b.type)) { res.status(400).json({ error: `type must be one of ${[...VALID_TYPES].join(', ')}` }); return; }
    if (b.riskLevel && !VALID_RISK.has(b.riskLevel)) { res.status(400).json({ error: 'riskLevel must be low|medium|high' }); return; }
    if (b.status && !VALID_STATUSES.has(b.status)) { res.status(400).json({ error: 'invalid status' }); return; }
    try {
      const change = changeStore.create({
        type: b.type,
        title: String(b.title || '').trim(),
        description: typeof b.description === 'string' ? b.description : null,
        riskLevel: b.riskLevel || 'medium',
        assetId: typeof b.assetId === 'string' ? b.assetId : null,
        serverId: typeof b.serverId === 'string' ? b.serverId : null,
        createdBy: actor.username ?? null,
        scheduledAt: typeof b.scheduledAt === 'string' ? b.scheduledAt : null,
        status: b.status || 'planned',
        source: 'manual',
        metadata: typeof b.metadata === 'object' && b.metadata ? b.metadata : undefined,
      });
      audit(req, actor, 'changes.create', true, `id=${change.id} type=${change.type} status=${change.status}`);
      try { onChangeCreated?.(change); } catch { /* fire-and-forget */ }
      if (change.status === 'completed' || change.status === 'failed' || change.status === 'rolled_back') {
        try { onChangeCompleted?.(change); } catch { /* swallow */ }
      }
      res.status(201).json({ change });
    } catch (e: any) {
      audit(req, actor, 'changes.create.error', false, e?.message);
      res.status(400).json({ error: e?.message || 'create failed' });
    }
  });

  router.put('/:id', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const b = req.body || {};
    if (b.status && !VALID_STATUSES.has(b.status)) { res.status(400).json({ error: 'invalid status' }); return; }
    if (b.riskLevel && !VALID_RISK.has(b.riskLevel)) { res.status(400).json({ error: 'invalid riskLevel' }); return; }
    const existing = changeStore.get(String(req.params.id));
    if (!existing) { res.status(404).json({ error: 'not found' }); return; }
    const updated = changeStore.update(String(req.params.id), {
      status: b.status,
      title: typeof b.title === 'string' ? b.title : undefined,
      description: b.description === undefined ? undefined : (b.description === null ? null : String(b.description)),
      riskLevel: b.riskLevel,
      scheduledAt: b.scheduledAt === undefined ? undefined : (b.scheduledAt === null ? null : String(b.scheduledAt)),
      metadata: typeof b.metadata === 'object' && b.metadata ? b.metadata : undefined,
      relatedIncidentId: b.relatedIncidentId === undefined ? undefined : (b.relatedIncidentId === null ? null : String(b.relatedIncidentId)),
    });
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'changes.update', true, `id=${updated.id} status=${updated.status}`);
    // Completion transition (planned/in_progress → terminal) fires the
    // hook exactly once.
    const wasTerminal = existing.status === 'completed' || existing.status === 'failed' || existing.status === 'rolled_back';
    const nowTerminal = updated.status === 'completed' || updated.status === 'failed' || updated.status === 'rolled_back';
    if (!wasTerminal && nowTerminal) {
      try { onChangeCompleted?.(updated); } catch { /* swallow */ }
    }
    res.json({ change: updated });
  });

  router.delete('/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    const removed = changeStore.delete(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'changes.delete', true, `id=${req.params.id}`);
    res.json({ ok: true });
  });

  return router;
}

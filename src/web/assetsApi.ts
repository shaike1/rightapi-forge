// /api/assets — CMDB CRUD + relationships + impact analysis.
//
// Routes:
//   GET    /                      list assets (filter by type/tag/q/serverId)
//   GET    /stats                 totals by type + relationship count
//   GET    /:id                   asset with up/down relationships
//   POST   /                      create asset (operator+)
//   PUT    /:id                   update asset (operator+)
//   DELETE /:id                   delete asset + cascading relationships (admin)
//   POST   /relationships         create edge (operator+)
//   DELETE /relationships/:id     remove edge (operator+)
//   GET    /:id/impact            BFS impact tree (direction + maxDepth)
//   GET    /by-incident/:id       lookup the asset linked to an incident
//                                  (via the incident's server_id)
//
// All mutating routes are audited (mirrors problemsApi pattern).

import { Router } from 'express';
import type {
  AssetStore, Asset, AssetType, RelationshipType,
} from '../cmdb/AssetStore.js';
import type { ImpactAnalyzer } from '../cmdb/ImpactAnalyzer.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

const VALID_TYPES: ReadonlySet<AssetType> = new Set(['server', 'service', 'application', 'network', 'database', 'other']);
const VALID_REL_TYPES: ReadonlySet<RelationshipType> = new Set(['hosts', 'runs', 'depends_on', 'connects_to']);

type AuthResult = { ok: boolean; reason?: string; username?: string; role?: UserRole };

export interface AssetsApiDeps {
  assetStore: AssetStore;
  impactAnalyzer: ImpactAnalyzer;
  incidentManager: IncidentManager;
  auditLog?: AuditLog;
  validateAuth: (authHeader: string | undefined, permission?: string) => AuthResult;
  /** Fired after a new asset is created (not on update). Wired to
   *  PluginManager.notifyAssetCreated in server.ts. */
  onAssetCreated?: (asset: Asset) => void;
}

export function createAssetsRouter(deps: AssetsApiDeps): Router {
  const router = Router();
  const { assetStore, impactAnalyzer, incidentManager, auditLog, validateAuth, onAssetCreated } = deps;

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

  // ── Stats ───────────────────────────────────────────────────────
  router.get('/stats', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    res.json(assetStore.stats());
  });

  // ── List ────────────────────────────────────────────────────────
  router.get('/', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const filter = {
      type: typeof req.query.type === 'string' && VALID_TYPES.has(req.query.type as AssetType) ? req.query.type as AssetType : undefined,
      tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      serverId: typeof req.query.serverId === 'string' ? req.query.serverId : undefined,
    };
    res.json({ assets: assetStore.list(filter), stats: assetStore.stats() });
  });

  // ── By incident (reverse lookup via server_id) ─────────────────
  // Used by IncidentDetailPage to surface a "Linked asset" banner.
  router.get('/by-incident/:incidentId', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const inc = incidentManager.get(String(req.params.incidentId));
    if (!inc || !inc.serverId) { res.json({ asset: null }); return; }
    const asset = assetStore.getByServerId(inc.serverId);
    res.json({ asset });
  });

  // ── Get one ─────────────────────────────────────────────────────
  router.get('/:id', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const asset = assetStore.getWithRelationships(String(req.params.id));
    if (!asset) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ asset });
  });

  // ── Impact ──────────────────────────────────────────────────────
  router.get('/:id/impact', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const direction = req.query.direction === 'upstream' ? 'upstream' : 'downstream';
    const maxDepth = Math.min(10, Math.max(0, parseInt(String(req.query.maxDepth ?? '5'), 10) || 5));
    const report = impactAnalyzer.analyze(String(req.params.id), { direction, maxDepth });
    if (!report) { res.status(404).json({ error: 'asset not found' }); return; }
    res.json(report);
  });

  // ── Create ──────────────────────────────────────────────────────
  router.post('/', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    try {
      const body = req.body || {};
      if (!body.type || !VALID_TYPES.has(body.type)) {
        res.status(400).json({ error: `type must be one of ${[...VALID_TYPES].join(', ')}` });
        return;
      }
      const asset = assetStore.create({
        type: body.type,
        name: String(body.name || '').trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : undefined,
        serverId: typeof body.serverId === 'string' ? body.serverId : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      });
      audit(req, actor, 'assets.create', true, `id=${asset.id} type=${asset.type}`);
      try { onAssetCreated?.(asset); } catch { /* fire-and-forget */ }
      res.status(201).json({ asset });
    } catch (e: any) {
      audit(req, actor, 'assets.create.error', false, e?.message);
      res.status(400).json({ error: e?.message || 'create failed' });
    }
  });

  // ── Update ──────────────────────────────────────────────────────
  router.put('/:id', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const body = req.body || {};
    if (body.type !== undefined && !VALID_TYPES.has(body.type)) {
      res.status(400).json({ error: 'invalid type' });
      return;
    }
    const updated = assetStore.update(String(req.params.id), {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: body.description === undefined ? undefined : (body.description === null ? null : String(body.description)),
      type: body.type,
      metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : undefined,
      tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
    });
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'assets.update', true, `id=${updated.id}`);
    res.json({ asset: updated });
  });

  // ── Delete ──────────────────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    const removed = assetStore.delete(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'assets.delete', true, `id=${req.params.id}`);
    res.json({ ok: true });
  });

  // ── Relationships ───────────────────────────────────────────────
  router.post('/relationships', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const { parentId, childId, type } = req.body || {};
    if (!parentId || !childId) { res.status(400).json({ error: 'parentId and childId required' }); return; }
    if (!VALID_REL_TYPES.has(type)) {
      res.status(400).json({ error: `type must be one of ${[...VALID_REL_TYPES].join(', ')}` });
      return;
    }
    try {
      const rel = assetStore.addRelationship(String(parentId), String(childId), type);
      audit(req, actor, 'assets.relate', true, `${parentId}-[${type}]->${childId}`);
      res.status(201).json({ relationship: rel });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'failed' });
    }
  });

  router.delete('/relationships/:id', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const removed = assetStore.removeRelationship(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'assets.unrelate', true, `id=${req.params.id}`);
    res.json({ ok: true });
  });

  return router;
}

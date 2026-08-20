// /api/knowledge — KB CRUD + search + upvote + auto-draft from incident.
//
// Routes:
//   GET    /                       list (filter by status/tag/q, with FTS rank)
//   GET    /stats                  totals
//   GET    /search?q=…             search-only response (no full list join)
//   GET    /:id                    one article
//   POST   /                       create (operator+) — defaults to draft
//   PUT    /:id                    edit (operator+)
//   DELETE /:id                    delete (admin)
//   POST   /:id/useful             upvote (any auth) — audited so a
//                                   single user can't spam-vote silently
//   POST   /:id/publish            shortcut to flip draft→published (operator+)
//   POST   /from-incident/:id      auto-draft from an incident's data
//                                   (operator+)
//
// Mutations audited. onArticleCreated fan-out via the optional cb so
// server.ts wires PluginManager without this router knowing about plugins.

import { Router } from 'express';
import type { KnowledgeStore, KnowledgeArticle, ArticleStatus } from '../knowledge/KnowledgeStore.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { AuditLog } from '../security/AuditLog.js';
import type { UserRole } from '../security/AuthService.js';

const VALID_STATUSES: ReadonlySet<ArticleStatus> = new Set(['draft', 'published', 'archived']);

type AuthResult = { ok: boolean; reason?: string; username?: string; role?: UserRole };

export interface KnowledgeApiDeps {
  knowledgeStore: KnowledgeStore;
  incidentManager: IncidentManager;
  auditLog?: AuditLog;
  validateAuth: (authHeader: string | undefined, permission?: string) => AuthResult;
  onArticleCreated?: (article: KnowledgeArticle) => void;
}

export function createKnowledgeRouter(deps: KnowledgeApiDeps): Router {
  const router = Router();
  const { knowledgeStore, incidentManager, auditLog, validateAuth, onArticleCreated } = deps;

  function gate(req: any, res: any, permission: string): AuthResult {
    const a = validateAuth(req.header('authorization') || undefined, permission);
    if (!a.ok) { res.status(403).json({ error: a.reason || 'Forbidden' }); return { ok: false }; }
    return a;
  }
  function audit(req: any, actor: AuthResult | null, action: string, success: boolean, detail?: string): void {
    if (!auditLog) return;
    auditLog.log({
      action, username: actor?.username || 'anonymous',
      role: (actor?.role as string) || 'unknown',
      resource: req.path, method: req.method, ip: req.ip || '',
      success, ...(detail ? { detail } : {}),
    });
  }

  router.get('/stats', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    res.json(knowledgeStore.stats());
  });

  router.get('/search', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const status = typeof req.query.status === 'string' && VALID_STATUSES.has(req.query.status as ArticleStatus) ? req.query.status as ArticleStatus : 'published';
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
    res.json({ results: knowledgeStore.search(q, { tag, status, limit }) });
  });

  router.get('/', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const status = typeof req.query.status === 'string' && VALID_STATUSES.has(req.query.status as ArticleStatus) ? req.query.status as ArticleStatus : undefined;
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    // q triggers FTS5; otherwise plain list scan.
    const articles = q
      ? knowledgeStore.search(q, { tag, status, limit })
      : knowledgeStore.list({ status, tag, limit });
    res.json({ articles, stats: knowledgeStore.stats() });
  });

  router.get('/:id', (req, res) => {
    if (!gate(req, res, 'security.read').ok) return;
    const a = knowledgeStore.get(String(req.params.id));
    if (!a) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ article: a });
  });

  router.post('/', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const b = req.body || {};
    if (b.status && !VALID_STATUSES.has(b.status)) { res.status(400).json({ error: 'invalid status' }); return; }
    try {
      const article = knowledgeStore.create({
        title: String(b.title || '').trim(),
        content: String(b.content || ''),
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
        linkedIncidents: Array.isArray(b.linkedIncidents) ? b.linkedIncidents.map(String) : undefined,
        createdBy: actor.username ?? null,
        status: b.status ?? 'draft',
      });
      audit(req, actor, 'knowledge.create', true, `id=${article.id} status=${article.status}`);
      try { onArticleCreated?.(article); } catch { /* swallow */ }
      res.status(201).json({ article });
    } catch (e: any) {
      audit(req, actor, 'knowledge.create.error', false, e?.message);
      res.status(400).json({ error: e?.message || 'create failed' });
    }
  });

  router.put('/:id', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const b = req.body || {};
    if (b.status && !VALID_STATUSES.has(b.status)) { res.status(400).json({ error: 'invalid status' }); return; }
    const updated = knowledgeStore.update(String(req.params.id), {
      title: typeof b.title === 'string' ? b.title : undefined,
      content: typeof b.content === 'string' ? b.content : undefined,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
      linkedIncidents: Array.isArray(b.linkedIncidents) ? b.linkedIncidents.map(String) : undefined,
      status: b.status,
    });
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'knowledge.update', true, `id=${updated.id} status=${updated.status}`);
    res.json({ article: updated });
  });

  router.delete('/:id', (req, res) => {
    const actor = gate(req, res, 'admin.write');
    if (!actor.ok) return;
    const removed = knowledgeStore.delete(String(req.params.id));
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'knowledge.delete', true, `id=${req.params.id}`);
    res.json({ ok: true });
  });

  router.post('/:id/useful', (req, res) => {
    const actor = gate(req, res, 'security.read');
    if (!actor.ok) return;
    const updated = knowledgeStore.incrementUseful(String(req.params.id));
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'knowledge.useful', true, `id=${updated.id} new_count=${updated.usefulCount}`);
    res.json({ article: updated });
  });

  router.post('/:id/publish', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const updated = knowledgeStore.update(String(req.params.id), { status: 'published' });
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req, actor, 'knowledge.publish', true, `id=${updated.id}`);
    res.json({ article: updated });
  });

  // ── Auto-draft from an incident ───────────────────────────────────
  // Operator hits "create KB article" on a resolved incident; we
  // seed a draft pre-populated with the incident's title, severity,
  // resolution timeline, and a link back. Operator edits + publishes.
  router.post('/from-incident/:incidentId', (req, res) => {
    const actor = gate(req, res, 'security.write');
    if (!actor.ok) return;
    const inc = incidentManager.get(String(req.params.incidentId));
    if (!inc) { res.status(404).json({ error: 'incident not found' }); return; }
    const timeline = (incidentManager as any).incidentStore?.getTimeline
      ? incidentManager.incidentStore.getTimeline(inc.id)
      : [];
    const body: string[] = [
      `> Auto-drafted from incident **${inc.id}** — *${inc.title}*`,
      '',
      `**Severity:** ${inc.severity}  ·  **Source:** ${inc.source}`,
      inc.serverId ? `**Server:** \`${inc.serverId}\`` : '',
      '',
      '## Summary',
      inc.description || '_(no description)_',
      '',
      '## Resolution timeline',
      ...(timeline as Array<{ timestamp: string; actor: string; type: string; message: string }>).map(t =>
        `- **${t.timestamp}** _${t.actor}_ (${t.type}): ${t.message}`,
      ),
      '',
      '## Resolution',
      '_Add the steps that actually resolved this. This article is in draft — edit + publish before it shows up in operator search._',
    ].filter(Boolean).join('\n');
    try {
      const article = knowledgeStore.create({
        title: `Resolution: ${inc.title}`,
        content: body,
        tags: ['auto-draft', inc.severity, ...(inc.serverId ? [`server:${inc.serverId}`] : [])],
        linkedIncidents: [inc.id],
        createdBy: actor.username ?? null,
        status: 'draft',
      });
      audit(req, actor, 'knowledge.from-incident', true, `incidentId=${inc.id} articleId=${article.id}`);
      try { onArticleCreated?.(article); } catch { /* swallow */ }
      res.status(201).json({ article });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || 'failed' });
    }
  });

  return router;
}

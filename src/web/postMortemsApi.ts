// Post-mortems API — read-only knowledge-base browser for resolved
// incidents.
//
// Mount at /api/post-mortems. All routes require `security.read` since
// post-mortems can contain operational detail (server names, command
// output) we don't want to expose anonymously.
//
// Routes:
//   GET  /stats                 — count + avg-duration breakdown
//   GET  /search?q=…&limit=…    — FTS5 search
//   GET  /incident/:incidentId  — every post-mortem written for one incident
//   GET  /:id                   — single post-mortem
//   GET  /                      — paginated list (limit/offset/severity/serverId/type)
//
// Note: /stats, /search, and /incident/:id all share the /api/post-mortems
// prefix with /:id. Order matters — the more-specific routes are
// registered first so they're matched before /:id eats the path.

import { Router, type Request, type Response } from 'express';
import type { PostMortemStore } from '../persistence/PostMortemStore.js';

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface PostMortemsApiDeps {
  store: PostMortemStore;
  validateAuth: AuthCheck;
}

export function createPostMortemsRouter(deps: PostMortemsApiDeps): Router {
  const router = Router();
  const { store, validateAuth } = deps;

  const requireRead = (req: Request, res: Response): boolean => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason });
      return false;
    }
    return true;
  };

  // ── Stats ────────────────────────────────────────────────────────────
  router.get('/stats', (req, res) => {
    if (!requireRead(req, res)) return;
    res.json(store.stats());
  });

  // ── Full-text search ─────────────────────────────────────────────────
  router.get('/search', (req, res) => {
    if (!requireRead(req, res)) return;
    const q = String(req.query.q ?? '').trim();
    if (!q) { res.json({ items: [], total: 0, query: '' }); return; }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '20'), 10) || 20, 1), 100);
    const items = store.search(q, { limit });
    res.json({ items, total: items.length, query: q });
  });

  // ── By incident ──────────────────────────────────────────────────────
  router.get('/incident/:incidentId', (req, res) => {
    if (!requireRead(req, res)) return;
    const items = store.byIncident(req.params.incidentId);
    res.json({ items, total: items.length, incidentId: req.params.incidentId });
  });

  // ── Single by id ─────────────────────────────────────────────────────
  router.get('/:id', (req, res) => {
    if (!requireRead(req, res)) return;
    const id = req.params.id;
    // Cheap shape check so an id-with-typo doesn't blow up the SQL prep
    // — the PostMortemStore returns null on missing rows either way, but
    // a 400 here gives clearer feedback than a generic 404.
    if (!/^PM-[A-Z0-9]+$/i.test(id)) {
      res.status(400).json({ error: 'invalid post-mortem id (expected "PM-XXXXXXXX")' });
      return;
    }
    const pm = store.get(id);
    if (!pm) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(pm);
  });

  // ── Paginated list ───────────────────────────────────────────────────
  router.get('/', (req, res) => {
    if (!requireRead(req, res)) return;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 500);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : undefined;
    const incidentType = typeof req.query.incidentType === 'string' ? req.query.incidentType : undefined;
    const severity = typeof req.query.severity === 'string' ? req.query.severity : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const result = store.list({ limit, offset, serverId, incidentType, severity, since });
    res.json({ ...result, limit, offset });
  });

  return router;
}

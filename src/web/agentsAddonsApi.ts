// /api/agents/:id/{ltm,conversations,logs,activity} — additional
// agent-scoped endpoints. Extracted from server.ts.
//
// Layered AFTER ./agentsApi.ts on the same /api/agents prefix —
// Express falls through the first router for paths it doesn't match.
//
// Routes:
//   GET    /:id/ltm                long-term memory list (no auth)
//   POST   /:id/ltm                store fact (no auth)
//   DELETE /:id/ltm/:key           forget (no auth)
//   POST   /:id/ltm/recall         semantic recall (no auth)
//   GET    /:id/conversations      per-user chat history
//   DELETE /:id/conversations      clear per-user chat history
//   GET    /:id/logs               mock log stub (preserved 1:1)
//   GET    /:id/activity           mock activity stub (preserved 1:1)
//
// /:id/message and /:id/message/stream stay inline in server.ts —
// they're heavyweight chat surfaces with their own dep landscape
// (AI provider routing, delegation tool, multi-turn context, etc.)
// and deserve a dedicated extraction.

import { Router, type Request, type Response } from 'express';

interface AgentMemoryLike {
  entries: any[];
}

interface ChatHistoryStoreLike {
  getHistory: (sessionKey: string) => any[];
  clear: (sessionKey: string) => void;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface AgentsAddonsApiDeps {
  loadAgentMemory: (agentId: string) => AgentMemoryLike;
  memoryStore: (agentId: string, key: string, value: string, category?: string) => unknown;
  memoryForget: (agentId: string, key: string) => boolean;
  memoryRecall: (agentId: string, query: string, limit?: number) => unknown[];
  chatHistoryStore: ChatHistoryStoreLike;
  validateAuth: AuthCheck;
}

export function createAgentsAddonsRouter(deps: AgentsAddonsApiDeps): Router {
  const router = Router();
  const { loadAgentMemory, memoryStore, memoryForget, memoryRecall, chatHistoryStore, validateAuth } = deps;

  // ── Long-term memory ───────────────────────────────────────────────
  router.get('/:id/ltm', (req: Request, res: Response) => {
    const mem = loadAgentMemory(req.params.id);
    res.json({ agentId: req.params.id, entries: mem.entries, count: mem.entries.length });
  });

  router.post('/:id/ltm', (req: Request, res: Response) => {
    const { key, value, category } = req.body;
    if (!key || !value) { res.status(400).json({ error: 'key and value required' }); return; }
    const entry = memoryStore(req.params.id, key, value, category || 'general');
    res.json({ success: true, entry });
  });

  router.delete('/:id/ltm/:key', (req: Request, res: Response) => {
    const removed = memoryForget(req.params.id, decodeURIComponent(req.params.key));
    if (!removed) { res.status(404).json({ error: 'Key not found' }); return; }
    res.json({ success: true });
  });

  router.post('/:id/ltm/recall', (req: Request, res: Response) => {
    const { query, limit } = req.body;
    if (!query) { res.status(400).json({ error: 'query required' }); return; }
    const results = memoryRecall(req.params.id, query, limit || 10);
    res.json({ results });
  });

  // ── Conversations (per-user chat history) ──────────────────────────
  router.get('/:id/conversations', (req: Request, res: Response) => {
    const agentId = req.params.id;
    const auth = validateAuth(req.header('authorization') || undefined);
    const sessionUser = auth.username || 'anonymous';
    const sessionKey = `${sessionUser}:${agentId}`;
    try {
      const history = chatHistoryStore.getHistory(sessionKey);
      const messages = history.map((m: any) => ({
        from: m.role === 'user' ? 'user' : agentId,
        role: m.role,
        text: m.text,
        content: m.text,
        message: m.text,
        timestamp: m.timestamp || new Date().toISOString(),
      }));
      res.json(messages);
    } catch {
      res.json([]);
    }
  });

  router.delete('/:id/conversations', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined);
    const sessionUser = auth.username || 'anonymous';
    const sessionKey = `${sessionUser}:${req.params.id}`;
    chatHistoryStore.clear(sessionKey);
    res.json({ ok: true, cleared: sessionKey });
  });

  // ── Logs / activity (mock stubs, preserved 1:1) ────────────────────
  router.get('/:id/logs', (req: Request, res: Response) => {
    const agentId = req.params.id;
    const logs = [
      { timestamp: new Date(Date.now() - 3600000).toISOString(), level: 'info', message: 'Agent started successfully' },
      { timestamp: new Date(Date.now() - 1800000).toISOString(), level: 'info', message: 'Connected to AgentBus' },
      { timestamp: new Date(Date.now() - 900000).toISOString(), level: 'debug', message: 'Processing task #123' },
      { timestamp: new Date(Date.now() - 600000).toISOString(), level: 'info', message: 'Task completed successfully' },
      { timestamp: new Date().toISOString(), level: 'info', message: 'Agent active and ready' },
    ];
    res.json({ agentId, logs, count: logs.length });
  });

  router.get('/:id/activity', (req: Request, res: Response) => {
    const agentId = req.params.id;
    res.json({
      agentId,
      activity: {
        tasksCompleted: Math.floor(Math.random() * 50) + 10,
        messagesSent: Math.floor(Math.random() * 100) + 20,
        uptime: process.uptime(),
        lastActive: new Date().toISOString(),
      },
    });
  });

  return router;
}

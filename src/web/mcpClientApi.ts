// REST API for the MCP-client subsystem (ITOps as an MCP client). Lets the
// UI list configured servers, add/edit/remove them, trigger connect /
// disconnect, list a server's tools, and invoke a tool ad-hoc for testing.
//
// All routes are protected by the auth middleware mounted higher up the
// stack (see /api/* gating in server.ts) — this router only declares
// shape and delegation to the manager.

import { Router } from 'express';
import { logger } from '../utils/logger.js';
import type { McpClientManager } from '../integrations/mcp/McpClientManager.js';
import type { McpServerDef, McpTransportKind } from '../integrations/mcp/types.js';

const VALID_TRANSPORTS: McpTransportKind[] = ['http', 'sse', 'stdio'];

export function createMcpClientRouter(manager: McpClientManager): Router {
  const router = Router();

  router.get('/servers', (_req, res) => {
    res.json({ servers: manager.listSummaries() });
  });

  router.post('/servers', async (req, res) => {
    const def = parseDef(req.body);
    if (typeof def === 'string') {
      res.status(400).json({ error: def });
      return;
    }
    try {
      const client = await manager.upsert(def);
      res.json({ ok: true, status: client.getStatus() });
    } catch (e) {
      logger.error('[mcpClientApi] upsert failed', {
        err: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.put('/servers/:id', async (req, res) => {
    const def = parseDef({ ...req.body, id: req.params.id });
    if (typeof def === 'string') {
      res.status(400).json({ error: def });
      return;
    }
    try {
      const client = await manager.upsert(def);
      res.json({ ok: true, status: client.getStatus() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.delete('/servers/:id', async (req, res) => {
    try {
      const removed = await manager.remove(req.params.id);
      res.json({ ok: removed });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post('/servers/:id/connect', async (req, res) => {
    try {
      await manager.connect(req.params.id);
      res.json({ ok: true, status: manager.get(req.params.id)?.getStatus() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post('/servers/:id/disconnect', async (req, res) => {
    try {
      await manager.disconnect(req.params.id);
      res.json({ ok: true, status: manager.get(req.params.id)?.getStatus() });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.get('/servers/:id/tools', async (req, res) => {
    try {
      const tools = await manager.listTools(req.params.id);
      res.json({ tools });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Convenience: connect (if needed) + listTools + return success/error so
  // the "Test connection" button has a single call to make.
  router.post('/servers/:id/test', async (req, res) => {
    const id = req.params.id;
    const client = manager.get(id);
    if (!client) {
      res.status(404).json({ ok: false, error: 'unknown server' });
      return;
    }
    try {
      if (!client.isConnected()) await client.connect();
      const tools = await client.refreshTools();
      res.json({
        ok: true,
        status: client.getStatus(),
        toolCount: tools.length,
      });
    } catch (e) {
      res.status(200).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        status: client.getStatus(),
      });
    }
  });

  router.post('/servers/:id/call', async (req, res) => {
    const tool = String(req.body?.tool ?? '').trim();
    const args = (req.body?.args && typeof req.body.args === 'object')
      ? req.body.args as Record<string, unknown>
      : {};
    if (!tool) {
      res.status(400).json({ error: 'tool name is required' });
      return;
    }
    try {
      const result = await manager.callTool(req.params.id, tool, args);
      res.json({ ok: !result.isError, content: result.content });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}

function parseDef(body: unknown): McpServerDef | string {
  if (!body || typeof body !== 'object') return 'request body must be an object';
  const b = body as Record<string, unknown>;
  const id = String(b.id ?? '').trim();
  if (!id || !/^[a-zA-Z0-9_.-]+$/.test(id)) {
    return 'id must be a slug matching [a-zA-Z0-9_.-]+';
  }
  const transport = String(b.transport ?? '') as McpTransportKind;
  if (!VALID_TRANSPORTS.includes(transport)) {
    return `transport must be one of ${VALID_TRANSPORTS.join(', ')}`;
  }
  const def: McpServerDef = {
    id,
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : id,
    description: typeof b.description === 'string' ? b.description : undefined,
    transport,
    enabled: b.enabled === undefined ? true : !!b.enabled,
    exposeToAgents: b.exposeToAgents === undefined ? true : !!b.exposeToAgents,
  };
  if (transport === 'http' || transport === 'sse') {
    if (typeof b.url !== 'string' || !b.url) return 'url is required for http/sse transports';
    def.url = b.url;
    if (typeof b.authToken === 'string' && b.authToken) def.authToken = b.authToken;
    if (b.headers && typeof b.headers === 'object') {
      def.headers = filterStringMap(b.headers as Record<string, unknown>);
    }
  } else {
    if (typeof b.command !== 'string' || !b.command) return 'command is required for stdio transport';
    def.command = b.command;
    if (Array.isArray(b.args)) def.args = b.args.map(String);
    if (b.env && typeof b.env === 'object') {
      def.env = filterStringMap(b.env as Record<string, unknown>);
    }
  }
  return def;
}

function filterStringMap(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

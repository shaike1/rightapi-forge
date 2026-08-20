// /api/agent-bus/* — inter-agent messaging surface. Extracted from
// server.ts.
//
// Routes (mount at /api/agent-bus):
//   GET  /threads               agent_bus.read
//   GET  /messages              agent_bus.read
//   POST /send                  agent_bus.write
//   POST /swarm                 agent_bus.write
//
// Both POST routes go through the credential-execution resolver
// (so an agent can't send messages on behalf of an identity it lacks
// credentials for) before dispatching the actual message via the
// helper functions in server.ts. Helpers and resolver passed in as
// deps to avoid threading server.ts internals.

import { Router, type Request, type Response } from 'express';
import type { AgentMessageBus } from '../agents/AgentMessageBus.js';

interface CredentialResolutionLike {
  allowed: boolean;
  reason?: string;
  matchedEntryIds?: string[];
}

interface CredentialExecutionResolverLike {
  resolve: (opts: {
    agentId: string;
    environment: string;
    system: string;
    requiredScopes: string[];
    providedCredentialScopes: string[];
  }) => CredentialResolutionLike;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface AgentBusApiDeps {
  agentBus: AgentMessageBus;
  credentialExecutionResolver: CredentialExecutionResolverLike;
  dispatchMessage: (opts: {
    fromAgentId: string;
    toAgentId: string;
    content: string;
    threadId?: string;
    taskId?: string;
    expectReply: boolean;
    actorId?: string;
  }) => Promise<{ sent: unknown; reply?: unknown }>;
  dispatchSwarm: (opts: {
    task: string;
    coordinatorAgentId?: string;
    workerAgentIds?: string[];
    maxWorkers?: number;
    includeSynthesis?: boolean;
    threadId?: string;
    taskId?: string;
    actorId?: string;
  }) => Promise<unknown>;
  validateAuth: AuthCheck;
}

export function createAgentBusRouter(deps: AgentBusApiDeps): Router {
  const router = Router();
  const { agentBus, credentialExecutionResolver, dispatchMessage, dispatchSwarm, validateAuth } = deps;

  router.get('/threads', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'agent_bus.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
    res.json({ threads: agentBus.listThreads({ agentId, limit }) });
  });

  router.get('/messages', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'agent_bus.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const threadId = req.query.threadId ? String(req.query.threadId) : undefined;
    const taskId = req.query.taskId ? String(req.query.taskId) : undefined;
    const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
    res.json({ messages: agentBus.listMessages({ threadId, taskId, agentId, limit }) });
  });

  router.post('/send', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'agent_bus.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const { fromAgentId, toAgentId, content, threadId, taskId, expectReply, environment, system } = req.body || {};
    if (!fromAgentId || !toAgentId || !content) {
      res.status(400).json({ error: 'fromAgentId, toAgentId, content are required' });
      return;
    }
    if (!String(fromAgentId).trim()) {
      res.status(403).json({ error: 'Blocked by credential policy', reason: 'Agent identity required' });
      return;
    }
    let credResolution: CredentialResolutionLike;
    try {
      credResolution = credentialExecutionResolver.resolve({
        agentId: String(fromAgentId),
        environment: (environment as string | undefined) || 'default',
        system: (system as string | undefined) || 'default',
        requiredScopes: [],
        providedCredentialScopes: [],
      });
    } catch {
      res.status(500).json({ error: 'Blocked by credential policy', reason: 'Credential policy check unavailable' });
      return;
    }
    if (!credResolution.allowed) {
      res.status(403).json({ error: 'Blocked by credential policy', reason: credResolution.reason });
      return;
    }
    try {
      const result = await dispatchMessage({
        fromAgentId: String(fromAgentId),
        toAgentId: String(toAgentId),
        content: String(content),
        threadId: threadId ? String(threadId) : undefined,
        taskId: taskId ? String(taskId) : undefined,
        expectReply: expectReply !== false,
        actorId: auth.username,
      });
      res.json({ success: true, message: result.sent, reply: result.reply || undefined });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/swarm', async (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'agent_bus.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }

    const body = req.body || {};
    const task = String(body.task || body.content || '').trim();
    if (!task) {
      res.status(400).json({ error: 'task is required' });
      return;
    }

    const workerAgentIds = Array.isArray(body.workerAgentIds)
      ? body.workerAgentIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
      : undefined;

    const swarmAgentId = body.coordinatorAgentId ? String(body.coordinatorAgentId) : 'system';
    if (!swarmAgentId.trim()) {
      res.status(403).json({ error: 'Blocked by credential policy', reason: 'Agent identity required' });
      return;
    }
    let swarmCredResolution: CredentialResolutionLike;
    try {
      swarmCredResolution = credentialExecutionResolver.resolve({
        agentId: swarmAgentId,
        environment: (body.environment as string | undefined) || 'default',
        system: (body.system as string | undefined) || 'default',
        requiredScopes: [],
        providedCredentialScopes: [],
      });
    } catch {
      res.status(500).json({ error: 'Blocked by credential policy', reason: 'Credential policy check unavailable' });
      return;
    }
    if (!swarmCredResolution.allowed) {
      res.status(403).json({ error: 'Blocked by credential policy', reason: swarmCredResolution.reason });
      return;
    }

    try {
      const result = await dispatchSwarm({
        task,
        coordinatorAgentId: body.coordinatorAgentId ? String(body.coordinatorAgentId) : undefined,
        workerAgentIds,
        maxWorkers: body.maxWorkers,
        includeSynthesis: body.includeSynthesis,
        threadId: body.threadId ? String(body.threadId) : undefined,
        taskId: body.taskId ? String(body.taskId) : undefined,
        actorId: auth.username,
      });
      res.json({ success: true, result });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}

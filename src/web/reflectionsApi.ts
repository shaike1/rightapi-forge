// Reflection API router — surfaces stored ReflectionResults and aggregated
// performance stats for the dashboard. Mounted from web/server.ts; kept here
// in its own module so the routes can be unit-tested without standing up the
// full server.

import express from 'express';
import type { SqliteAgentMemoryStore } from '../persistence/SqliteStore.js';
import type { Agent } from '../agents/Agent.js';

export interface ReflectionsApiDeps {
  agentMemoryStore: SqliteAgentMemoryStore;
  getAgent(id: string): Agent | undefined;
}

export function createReflectionsRouter(deps: ReflectionsApiDeps): express.Router {
  const router = express.Router();
  const { agentMemoryStore, getAgent } = deps;

  // GET /api/agents/:id/reflections?limit=N&minRating=1&maxRating=5
  router.get('/agents/:id/reflections', (req, res) => {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const limit = clampInt(req.query.limit, 1, 500, 50);
    const minRatingRaw = req.query.minRating;
    const maxRatingRaw = req.query.maxRating;
    const min = parseRating(minRatingRaw);
    const max = parseRating(maxRatingRaw);

    const reflections = (min !== null || max !== null)
      ? agentMemoryStore.getReflectionsByRating(agentId, min ?? 1, max ?? 5, limit)
      : agentMemoryStore.getReflections(agentId, limit);

    res.json({
      agentId,
      agentName: agent.name,
      count: reflections.length,
      reflections,
    });
  });

  // GET /api/agents/:id/performance
  router.get('/agents/:id/performance', (req, res) => {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const stats = agentMemoryStore.getPerformanceStats(agentId);
    res.json({
      agentId,
      agentName: agent.name,
      role: agent.role,
      ...stats,
    });
  });

  return router;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseRating(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, n));
}

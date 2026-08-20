// Per-agent usage API.
//
//   GET /api/agents/:id/usage           — today + week summary + budget gate
//   GET /api/agents/:id/usage/history   — last 7 daily records
//   POST /api/agents/:id/usage/budget   — set/replace the daily budget
//   POST /api/agents/:id/usage/reset    — operator override (resets today)
//
// The router takes a UsageTracker via deps so it can be unit-tested in
// isolation; web/server.ts mounts it with the process-wide singleton.

import express from 'express';
import type { UsageTracker } from '../agents/UsageTracker.js';
import type { Agent } from '../agents/Agent.js';

export interface UsageApiDeps {
  usageTracker: UsageTracker;
  getAgent(id: string): Agent | undefined;
}

export function createUsageRouter(deps: UsageApiDeps): express.Router {
  const router = express.Router();
  const { usageTracker, getAgent } = deps;

  router.get('/agents/:id/usage', (req, res) => {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const gate = usageTracker.checkGate(agentId);
    const today = usageTracker.getToday(agentId);
    const week = usageTracker.getWeekSummary(agentId);
    const budget = usageTracker.getBudget(agentId) ?? null;

    res.json({
      agentId,
      agentName: agent.name,
      role: agent.role,
      today,
      week,
      budget,
      gate: {
        allowed: gate.allowed,
        reason: gate.reason ?? null,
        remainingTokens: Number.isFinite(gate.remainingTokens) ? gate.remainingTokens : null,
        remainingCostUsd: Number.isFinite(gate.remainingCostUsd) ? gate.remainingCostUsd : null,
      },
    });
  });

  router.get('/agents/:id/usage/history', (req, res) => {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    res.json({ agentId, agentName: agent.name, days: usageTracker.getWeek(agentId) });
  });

  router.post('/agents/:id/usage/budget', express.json(), (req, res) => {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const body = req.body ?? {};
    const dailyTokens = parsePositiveNumber(body.dailyTokens);
    if (!dailyTokens) { res.status(400).json({ error: 'dailyTokens (positive number) is required' }); return; }
    const dailyCostUsd = body.dailyCostUsd === undefined ? undefined : parsePositiveNumber(body.dailyCostUsd);
    const warnAtFraction = body.warnAtFraction === undefined ? undefined : parseFraction(body.warnAtFraction);
    const autoResetDaily = body.autoResetDaily === undefined ? undefined : !!body.autoResetDaily;

    usageTracker.setBudget(agentId, { dailyTokens, dailyCostUsd, warnAtFraction, autoResetDaily });
    res.json({ agentId, budget: usageTracker.getBudget(agentId) });
  });

  router.post('/agents/:id/usage/reset', express.json(), (req, res) => {
    const agentId = req.params.id;
    const agent = getAgent(agentId);
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
    const scope = req.body?.scope === 'all' ? 'all' : 'today';
    if (scope === 'all') usageTracker.resetAll(agentId);
    else usageTracker.resetToday(agentId);
    res.json({ agentId, scope, today: usageTracker.getToday(agentId) });
  });

  return router;
}

function parsePositiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseFraction(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

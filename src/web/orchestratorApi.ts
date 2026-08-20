// /api/orchestrator/* — orchestrator status, reliability SLO + policy
// CRUD, manual tick, last-sweep snapshot. Extracted from server.ts.
//
// Routes (mount at /api/orchestrator):
//   GET  /status                   security.read
//   GET  /reliability-slo          security.read
//   POST /reliability-slo/apply    config.write
//   GET  /reliability-policy       security.read
//   POST /reliability-policy       config.write
//   POST /tick                     config.write
//   GET  /sweep/last               security.read
//
// Both write routes (apply + reliability-policy) expect an
// expectedRevision for optimistic concurrency, and emit a
// policy-change audit record after a successful write. Helpers
// (cryptoRandomId, computeChangedKeys) bundled into a `helpers` dep.

import { Router, type Request, type Response } from 'express';
import type { OrchestratorService } from '../orchestrator/OrchestratorService.js';
import type { PolicyChangeAuditStore } from '../security/PolicyChangeAuditStore.js';

interface ReliabilityPolicyStoreLike {
  getRecord: () => { policy: any; revision: number; updatedAt: string };
  updateWithOptions: (patch: any, opts: { expectedRevision: number }) => { policy: any; revision: number; updatedAt: string };
}

interface ReliabilitySlo {
  tuningSuggestions?: Array<{ id: string; patch?: any }>;
  [key: string]: unknown;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface OrchestratorApiHelpers {
  cryptoRandomId: () => string;
  computeChangedKeys: (before: unknown, after: unknown) => string[];
}

export interface OrchestratorApiDeps {
  orchestratorService: OrchestratorService;
  reliabilityPolicyStore: ReliabilityPolicyStoreLike;
  policyChangeAuditStore: PolicyChangeAuditStore;
  buildReliabilitySlo: () => ReliabilitySlo;
  helpers: OrchestratorApiHelpers;
  validateAuth: AuthCheck;
}

export function createOrchestratorRouter(deps: OrchestratorApiDeps): Router {
  const router = Router();
  const {
    orchestratorService,
    reliabilityPolicyStore,
    policyChangeAuditStore,
    buildReliabilitySlo,
    helpers,
    validateAuth,
  } = deps;

  router.get('/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      res.json(orchestratorService.getStatus());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/reliability-slo', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      res.json(buildReliabilitySlo());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/reliability-slo/apply', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const suggestionId = String(req.body?.suggestionId || '').trim();
      if (!suggestionId) {
        res.status(400).json({ error: 'suggestionId is required' });
        return;
      }
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        res.status(400).json({ error: 'expectedRevision is required' });
        return;
      }
      const slo = buildReliabilitySlo();
      const suggestion = (slo.tuningSuggestions || []).find(item => item.id === suggestionId);
      if (!suggestion) {
        res.status(404).json({ error: `Suggestion '${suggestionId}' not found for current SLO window` });
        return;
      }
      const before = reliabilityPolicyStore.getRecord();
      const after = reliabilityPolicyStore.updateWithOptions(suggestion.patch || {}, { expectedRevision });
      orchestratorService.setReliabilityPolicy(after.policy);
      policyChangeAuditStore.append({
        id: helpers.cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'orchestrator_reliability',
        actorId: auth.username || 'unknown',
        action: 'update',
        expectedRevision,
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: helpers.computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy,
      });
      res.json({
        success: true,
        appliedSuggestion: suggestion,
        policy: after.policy,
        revision: after.revision,
        updatedAt: after.updatedAt,
        snapshot: orchestratorService.getStatus(),
        slo: buildReliabilitySlo(),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/reliability-policy', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const record = reliabilityPolicyStore.getRecord();
    res.json({ policy: record.policy, revision: record.revision, updatedAt: record.updatedAt });
  });

  router.post('/reliability-policy', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        res.status(400).json({ error: 'expectedRevision is required' });
        return;
      }
      const patch = {
        autoRecoverEnabled: req.body?.autoRecoverEnabled,
        stuckThresholdMinutes: req.body?.stuckThresholdMinutes,
        retryLimit: req.body?.retryLimit,
        retryCooldownMinutes: req.body?.retryCooldownMinutes,
      };
      const before = reliabilityPolicyStore.getRecord();
      const after = reliabilityPolicyStore.updateWithOptions(patch, { expectedRevision });
      orchestratorService.setReliabilityPolicy(after.policy);
      policyChangeAuditStore.append({
        id: helpers.cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'orchestrator_reliability',
        actorId: auth.username || 'unknown',
        action: 'update',
        expectedRevision,
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: helpers.computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy,
      });
      res.json({
        success: true,
        policy: after.policy,
        revision: after.revision,
        updatedAt: after.updatedAt,
        snapshot: orchestratorService.getStatus(),
      });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.post('/tick', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const reason = req.body?.reason ? String(req.body.reason) : undefined;
      const snapshot = orchestratorService.tick(reason);
      res.json({ success: true, snapshot });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get('/sweep/last', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      res.json(orchestratorService.getLastSweep());
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}

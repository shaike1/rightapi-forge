// /api/delegations/* — propose/inspect/transition delegations between
// agents, plus the delegation-policy CRUD. Extracted from server.ts.
//
// Routes (mount at /api/delegations):
//   GET  /                        (delegations.read)
//   GET  /:delegationId           (delegations.read)
//   GET  /policy                  (delegations.read)
//   POST /policy                  (config.write)
//   POST /                        (delegations.write)
//   POST /:delegationId/transition (delegations.write)
//
// The transition handler is the heaviest path — it can require an
// approval token (validated + consumed via the ledger) and writes
// execution-audit records on each blocked/allowed step. We accept a
// bundled `helpers` deps object rather than threading 6 separate
// functions through, since they always travel together.
//
// Risk-level computation (getDelegationRiskLevel) and approval-gate
// detection (delegationTransitionRequiresApproval) are also bundled in
// helpers — they're tiny pure functions in server.ts today; eventually
// they should move to the security module so this file can import them
// directly.

import { Router, type Request, type Response } from 'express';
import type { DelegationManager } from '../tasks/DelegationManager.js';
import type { DelegationPolicyStore } from '../tasks/DelegationPolicyStore.js';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { ExecutionAuditStore } from '../security/ExecutionAuditStore.js';
import type { ApprovalTokenLedger } from '../security/ApprovalTokenLedger.js';
import type { PolicyChangeAuditStore } from '../security/PolicyChangeAuditStore.js';
import type { Delegation } from '../types/index.js';

type AuthResult = {
  ok: boolean;
  reason?: string;
  username?: string;
  role?: string;
};
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

interface ApprovalValidation {
  ok: boolean;
  reason?: string;
  tokenId?: string;
}

export interface DelegationsApiHelpers {
  cryptoRandomId: () => string;
  /** Compute risk tier from a delegation shape — used at create-time
   *  to stamp the record. */
  getDelegationRiskLevel: (d: Delegation) => 'low' | 'medium' | 'high';
  /** Returns true iff a state transition needs an approval token. */
  transitionRequiresApproval: (d: Delegation, nextState: string) => boolean;
  validateApprovalToken: (params: { token: string | undefined; command: string; agentId: string }) => ApprovalValidation;
  /** Re-rolls the parent task's status if a delegation moved. */
  rollupParentTaskStatus: (parentTaskId: string) => void;
  /** Diff helper for the policy audit log — returns the keys that
   *  changed between two policy snapshots. */
  computeChangedKeys: (before: unknown, after: unknown) => string[];
}

export interface DelegationsApiDeps {
  delegationManager: DelegationManager;
  delegationPolicyStore: DelegationPolicyStore;
  policyChangeAuditStore: PolicyChangeAuditStore;
  taskManager: TaskManager;
  executionAuditStore: ExecutionAuditStore;
  approvalTokenLedger: ApprovalTokenLedger;
  helpers: DelegationsApiHelpers;
  validateAuth: AuthCheck;
}

export function createDelegationsRouter(deps: DelegationsApiDeps): Router {
  const router = Router();
  const {
    delegationManager,
    delegationPolicyStore,
    policyChangeAuditStore,
    taskManager,
    executionAuditStore,
    approvalTokenLedger,
    helpers,
    validateAuth,
  } = deps;

  // ── List ───────────────────────────────────────────────────────────
  router.get('/', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const delegations = delegationManager.list({
      taskId: req.query.taskId ? String(req.query.taskId) : undefined,
      assigneeAgentId: req.query.assigneeAgentId ? String(req.query.assigneeAgentId) : undefined,
      requesterAgentId: req.query.requesterAgentId ? String(req.query.requesterAgentId) : undefined,
      state: req.query.state ? String(req.query.state) as any : undefined,
      limit,
    });
    res.json({ delegations });
  });

  // ── Policy ─────────────────────────────────────────────────────────
  // Comes BEFORE /:delegationId so that GET /policy doesn't get
  // captured as a delegation lookup. Express matches in declaration
  // order within a router.
  router.get('/policy', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const record = delegationPolicyStore.getRecord();
    res.json({ policy: record.policy, revision: record.revision, updatedAt: record.updatedAt });
  });

  router.post('/policy', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'config.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const expectedRevision = Number(req.body?.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        res.status(400).json({ error: 'expectedRevision is required' });
        return;
      }
      const before = delegationPolicyStore.getRecord();
      const after = delegationPolicyStore.updateWithOptions(req.body || {}, { expectedRevision });
      policyChangeAuditStore.append({
        id: helpers.cryptoRandomId(),
        timestamp: new Date().toISOString(),
        policyType: 'delegation',
        actorId: auth.username || 'unknown',
        action: 'update',
        expectedRevision,
        previousRevision: before.revision,
        nextRevision: after.revision,
        changedKeys: helpers.computeChangedKeys(before.policy, after.policy),
        before: before.policy,
        after: after.policy,
      });
      res.json({ success: true, policy: after.policy, revision: after.revision, updatedAt: after.updatedAt });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // ── Get one ────────────────────────────────────────────────────────
  router.get('/:delegationId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const delegation = delegationManager.get(req.params.delegationId);
      if (!delegation) {
        res.status(404).json({ error: 'Delegation not found' });
        return;
      }
      const parentTask = taskManager.getTask(delegation.parentTaskId) || null;
      const childTask = delegation.childTaskId ? (taskManager.getTask(delegation.childTaskId) || null) : null;
      const taskTimeline = parentTask
        ? taskManager.getTaskTimeline(delegation.parentTaskId)
        : { operations: [], checkpoints: [] };
      const delegationOperations = (taskTimeline.operations || [])
        .filter(op => {
          const text = `${op.summary || ''}\n${op.details || ''}`;
          return text.includes(delegation.id);
        })
        .slice(-50);
      const linkedCheckpoints = (taskTimeline.checkpoints || []).slice(-50);
      const executionAudits = executionAuditStore.listByTask(delegation.parentTaskId, 200)
        .filter(a => a.command === 'delegation.dispatch' || a.taskId === delegation.parentTaskId)
        .slice(0, 50);
      res.json({
        delegation,
        parentTask,
        childTask,
        history: delegation.history || [],
        linkedOperations: delegationOperations,
        linkedCheckpoints,
        linkedExecutionAudits: executionAudits,
      });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── Create ─────────────────────────────────────────────────────────
  router.post('/', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const body = req.body || {};
      if (!body.parentTaskId || !body.requesterAgentId || !body.assigneeAgentId || !body.objective) {
        res.status(400).json({ error: 'parentTaskId, requesterAgentId, assigneeAgentId, objective are required' });
        return;
      }
      if (!taskManager.getTask(String(body.parentTaskId))) {
        res.status(404).json({ error: 'Parent task not found' });
        return;
      }
      const delegation = delegationManager.create({
        parentTaskId: String(body.parentTaskId),
        childTaskId: body.childTaskId ? String(body.childTaskId) : undefined,
        requesterAgentId: String(body.requesterAgentId),
        assigneeAgentId: String(body.assigneeAgentId),
        objective: String(body.objective),
        deadline: body.deadline ? String(body.deadline) : undefined,
        riskLevel: helpers.getDelegationRiskLevel({
          id: '',
          requestId: '',
          parentTaskId: String(body.parentTaskId),
          childTaskId: body.childTaskId ? String(body.childTaskId) : undefined,
          requesterAgentId: String(body.requesterAgentId),
          assigneeAgentId: String(body.assigneeAgentId),
          objective: String(body.objective),
          deadline: body.deadline ? String(body.deadline) : undefined,
          state: 'proposed',
          createdAt: '',
          updatedAt: '',
          history: [],
        } as Delegation),
        metadata: {},
        actorId: auth.username,
      });
      taskManager.appendOperation(String(body.parentTaskId), {
        actorId: auth.username,
        actorType: 'user',
        type: 'note',
        summary: `Delegation proposed: ${delegation.id}`,
        details: `${delegation.requesterAgentId} -> ${delegation.assigneeAgentId}\nObjective: ${delegation.objective}`,
        status: 'recorded',
      });
      helpers.rollupParentTaskStatus(String(body.parentTaskId));
      res.json({ success: true, delegation });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── Transition (with approval gate) ────────────────────────────────
  router.post('/:delegationId/transition', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const body = req.body || {};
      if (!body.nextState) {
        res.status(400).json({ error: 'nextState is required' });
        return;
      }
      const current = delegationManager.get(req.params.delegationId);
      if (!current) {
        res.status(404).json({ error: 'Delegation not found' });
        return;
      }
      const nextState = String(body.nextState) as any;
      const requiresApproval = helpers.transitionRequiresApproval(current, nextState);
      if (requiresApproval) {
        const command = 'delegation.dispatch';
        const approval = helpers.validateApprovalToken({
          token: body.approvalToken ? String(body.approvalToken) : undefined,
          command,
          agentId: String(auth.username || ''),
        });
        if (!approval.ok) {
          executionAuditStore.append({
            id: helpers.cryptoRandomId(),
            timestamp: new Date().toISOString(),
            taskId: current.parentTaskId,
            command,
            skillId: 'delegation',
            agentId: auth.username || 'unknown',
            agentRole: auth.role || 'operator',
            status: 'blocked',
            reason: approval.reason,
            approvalRequired: true,
            approvalTokenId: approval.tokenId,
            credentialIds: [],
            credentialScopes: [],
          });
          res.status(403).json({ error: approval.reason || 'Invalid approval token' });
          return;
        }
        const consume = approvalTokenLedger.consume({
          tokenId: approval.tokenId as string,
          command,
          agentId: String(auth.username || ''),
        });
        if (!consume.ok) {
          executionAuditStore.append({
            id: helpers.cryptoRandomId(),
            timestamp: new Date().toISOString(),
            taskId: current.parentTaskId,
            command,
            skillId: 'delegation',
            agentId: auth.username || 'unknown',
            agentRole: auth.role || 'operator',
            status: 'blocked',
            reason: consume.reason || 'Approval token invalid state',
            approvalRequired: true,
            approvalTokenId: approval.tokenId,
            credentialIds: [],
            credentialScopes: [],
          });
          res.status(403).json({ error: consume.reason || 'Approval token invalid state' });
          return;
        }
        executionAuditStore.append({
          id: helpers.cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: current.parentTaskId,
          command,
          skillId: 'delegation',
          agentId: auth.username || 'unknown',
          agentRole: auth.role || 'operator',
          status: 'allowed',
          approvalRequired: true,
          approvalTokenId: approval.tokenId,
          credentialIds: [],
          credentialScopes: [],
        });
      }
      const delegation = delegationManager.transition({
        delegationId: req.params.delegationId,
        nextState,
        actorId: auth.username,
        reason: body.reason ? String(body.reason) : undefined,
      });
      if (delegation.parentTaskId) {
        try {
          taskManager.appendOperation(delegation.parentTaskId, {
            actorId: auth.username,
            actorType: 'user',
            type: 'note',
            summary: `Delegation state updated: ${delegation.id}`,
            details: `State -> ${delegation.state}${body.reason ? `\nReason: ${String(body.reason)}` : ''}`,
            status: 'recorded',
          });
        } catch {
          // Ignore missing parent task.
        }
        helpers.rollupParentTaskStatus(delegation.parentTaskId);
      }
      res.json({ success: true, delegation });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  return router;
}

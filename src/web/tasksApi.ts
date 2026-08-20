// /api/tasks/* — task lifecycle: list, status, subtasks, timeline,
// snapshots, activity feed, cancel/drop, rollback (preview/request/apply),
// dependency graph. Extracted from server.ts.
//
// Routes (mount at /api/tasks):
//   GET  /                                 (no auth — preserved 1:1)
//   PUT  /:taskId/status                   (tools.execute.privileged)
//   GET  /:taskId/subtasks                 (delegations.read)
//   POST /:taskId/subtasks                 (delegations.write)
//   GET  /:taskId/timeline                 (audit.read)
//   GET  /:taskId/snapshots                (audit.read)
//   GET  /:taskId/snapshots/:snapshotId    (audit.read)
//   POST /:taskId/snapshots/:snapshotId/restore  (tools.execute.privileged)
//   GET  /:taskId/activity                 (audit.read)
//   POST /:taskId/cancel                   (tools.execute.privileged)
//   POST /:taskId/drop                     (tools.execute.privileged)
//   POST /:taskId/rollback/request         (tools.execute.privileged)
//   GET  /:taskId/rollback/preview         (audit.read)
//   POST /:taskId/rollback/apply           (tools.execute.privileged)
//   GET  /:taskId/graph                    (security.read)
//
// `rollback/apply` is the heaviest path — same approval-token machinery
// as delegations.transition, with the addition of a snapshot-policy
// gate. We bundle helpers into a single object since they always travel
// together.
//
// Note: GET /api/tasks (the root) is unauthenticated in the inline
// block. Preserved 1:1 — hardening is a follow-up.

import { Router, type Request, type Response } from 'express';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { TaskSnapshotStore } from '../tasks/TaskSnapshotStore.js';
import type { AgentMessageBus } from '../agents/AgentMessageBus.js';
import type { ExecutionAuditStore } from '../security/ExecutionAuditStore.js';
import type { ApprovalTokenLedger } from '../security/ApprovalTokenLedger.js';
import type { OrchestratorService } from '../orchestrator/OrchestratorService.js';

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

export interface TasksApiHelpers {
  cryptoRandomId: () => string;
  validateApprovalToken: (params: { token: string | undefined; command: string; agentId: string }) => ApprovalValidation;
  rollupParentTaskStatus: (parentTaskId: string) => void;
}

export interface TasksApiDeps {
  taskManager: TaskManager;
  taskSnapshotStore: TaskSnapshotStore;
  agentBus: AgentMessageBus;
  executionAuditStore: ExecutionAuditStore;
  approvalTokenLedger: ApprovalTokenLedger;
  orchestratorService: OrchestratorService;
  helpers: TasksApiHelpers;
  validateAuth: AuthCheck;
}

export function createTasksRouter(deps: TasksApiDeps): Router {
  const router = Router();
  const {
    taskManager,
    taskSnapshotStore,
    agentBus,
    executionAuditStore,
    approvalTokenLedger,
    orchestratorService,
    helpers,
    validateAuth,
  } = deps;

  // ── Root list (unauthenticated — matches inline) ───────────────────
  router.get('/', (_req: Request, res: Response) => {
    res.json(taskManager.getAllTasks());
  });

  // ── Status update ──────────────────────────────────────────────────
  router.put('/:taskId/status', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const status = String(req.body?.status || '').trim() as
        | 'pending' | 'assigned' | 'in_progress' | 'completed'
        | 'failed' | 'blocked' | 'cancelled' | 'dropped'
        | 'rolling_back' | 'rolled_back';
      const allowedStatuses = [
        'pending', 'assigned', 'in_progress', 'completed', 'failed',
        'blocked', 'cancelled', 'dropped', 'rolling_back', 'rolled_back',
      ] as const;
      if (!(allowedStatuses as readonly string[]).includes(status)) {
        res.status(400).json({ error: `Invalid status. Allowed values: ${allowedStatuses.join(', ')}` });
        return;
      }
      const task = taskManager.updateTaskStatus(req.params.taskId, status);
      res.json({ success: true, task });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('not found')) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // ── Subtasks ───────────────────────────────────────────────────────
  router.get('/:taskId/subtasks', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const parent = taskManager.getTask(req.params.taskId);
      if (!parent) { res.status(404).json({ error: 'Task not found' }); return; }
      const subtasks = taskManager.getChildTasks(req.params.taskId);
      res.json({ parentTask: parent, subtasks });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.post('/:taskId/subtasks', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'delegations.write');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const parent = taskManager.getTask(req.params.taskId);
      if (!parent) { res.status(404).json({ error: 'Parent task not found' }); return; }
      const body = req.body || {};
      if (!body.title || !body.description) {
        res.status(400).json({ error: 'title and description are required' });
        return;
      }
      const subtask = taskManager.createTask({
        title: String(body.title),
        description: String(body.description),
        ownerId: body.ownerId ? String(body.ownerId) : parent.ownerId,
        category: body.category ? String(body.category) : parent.category,
        priority: body.priority ? String(body.priority) : parent.priority,
        assignedTo: body.assignedTo ? String(body.assignedTo) : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map((t: unknown) => String(t)) : [],
        dependencies: Array.isArray(body.dependencies) ? body.dependencies.map((d: unknown) => String(d)) : undefined,
        parentTaskId: req.params.taskId,
      } as any);
      taskManager.appendOperation(req.params.taskId, {
        actorId: auth.username,
        actorType: 'user',
        type: 'note',
        summary: `Subtask created: ${subtask.id}`,
        details: `${subtask.title}`,
        status: 'recorded',
      });
      helpers.rollupParentTaskStatus(req.params.taskId);
      res.json({ success: true, subtask });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── Timeline ───────────────────────────────────────────────────────
  router.get('/:taskId/timeline', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const timeline = taskManager.getTaskTimeline(req.params.taskId);
      res.json(timeline);
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // ── Snapshots ──────────────────────────────────────────────────────
  router.get('/:taskId/snapshots', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    res.json({
      taskId: req.params.taskId,
      snapshots: taskSnapshotStore.listByTask(req.params.taskId, limit),
    });
  });

  router.get('/:taskId/snapshots/:snapshotId', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const snapshot = taskSnapshotStore.get(req.params.snapshotId);
    if (!snapshot || snapshot.taskId !== req.params.taskId) {
      res.status(404).json({ error: 'Snapshot not found for task' });
      return;
    }
    res.json({ snapshot });
  });

  router.post('/:taskId/snapshots/:snapshotId/restore', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const snapshot = taskSnapshotStore.get(req.params.snapshotId);
      if (!snapshot || snapshot.taskId !== req.params.taskId) {
        res.status(404).json({ error: 'Snapshot not found for task' });
        return;
      }
      const restored = taskSnapshotStore.markRestored({
        snapshotId: req.params.snapshotId,
        actorId: auth.username || 'operator',
      });
      taskManager.appendOperation(req.params.taskId, {
        actorId: auth.username,
        actorType: 'user',
        type: 'rollback',
        summary: `Snapshot restore acknowledged: ${restored.id}`,
        details: `Manifest target: ${restored.manifest.target}\nPlan: ${restored.manifest.rollbackPlan}`,
        status: 'recorded',
      });
      res.json({ success: true, snapshot: restored });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ── Activity feed (paginated, multi-source) ────────────────────────
  // Combines task operations + agent bus messages + execution audit
  // into a single chronologically-sorted feed with cursor pagination
  // (timestamp + id as tiebreaker for stable ordering).
  router.get('/:taskId/activity', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const limitRaw = req.query.limit ? Number(req.query.limit) : 100;
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
      const sourceFilter = req.query.source ? String(req.query.source) : 'all';
      const windowHoursRaw = req.query.windowHours ? Number(req.query.windowHours) : undefined;
      const windowHours = Number.isFinite(windowHoursRaw as number)
        ? Math.min(Math.max(windowHoursRaw as number, 1), 24 * 30)
        : undefined;
      const search = req.query.search ? String(req.query.search).trim().toLowerCase().slice(0, 200) : '';
      const cursorRaw = req.query.cursor ? String(req.query.cursor) : '';
      let cursorTimestamp: number | undefined;
      let cursorId: string | undefined;
      if (cursorRaw) {
        try {
          const decoded = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8')) as { timestamp: string; id: string };
          const ts = Date.parse(decoded.timestamp);
          if (Number.isFinite(ts) && decoded.id) {
            cursorTimestamp = ts;
            cursorId = decoded.id;
          }
        } catch {
          // Ignore malformed cursor and serve first page.
        }
      }
      const timeline = taskManager.getTaskTimeline(req.params.taskId);
      const busMessages = agentBus.listMessages({ taskId: req.params.taskId, limit: 1000 });
      const executionAudit = executionAuditStore.listByTask(req.params.taskId, 1000);
      const now = Date.now();
      const cutoff = windowHours ? (now - (windowHours * 60 * 60 * 1000)) : 0;

      const feed = [
        ...timeline.operations.map(op => ({
          source: 'task_operation',
          timestamp: op.timestamp instanceof Date ? op.timestamp.toISOString() : new Date(op.timestamp).toISOString(),
          id: op.id,
          payload: op,
        })),
        ...busMessages.map(msg => ({
          source: 'agent_bus',
          timestamp: msg.timestamp,
          id: msg.id,
          payload: msg,
        })),
        ...executionAudit.map(record => ({
          source: 'execution_audit',
          timestamp: record.timestamp,
          id: record.id,
          payload: record,
        })),
      ]
        .filter(item => {
          if (sourceFilter !== 'all' && item.source !== sourceFilter) return false;
          const ts = Date.parse(item.timestamp);
          if (windowHours && Number.isFinite(ts) && ts < cutoff) return false;
          if (!search) return true;
          const haystack = JSON.stringify(item.payload || {}).toLowerCase();
          return haystack.includes(search) || item.source.includes(search);
        })
        .sort((a, b) => {
          const bt = Date.parse(b.timestamp);
          const at = Date.parse(a.timestamp);
          if (bt !== at) return bt - at;
          return String(b.id).localeCompare(String(a.id));
        });

      const cursorFiltered = feed.filter(item => {
        if (cursorTimestamp === undefined || !cursorId) return true;
        const ts = Date.parse(item.timestamp);
        if (!Number.isFinite(ts)) return false;
        if (ts < cursorTimestamp) return true;
        if (ts > cursorTimestamp) return false;
        return String(item.id) < cursorId;
      });
      const page = cursorFiltered.slice(0, limit);
      const hasMore = cursorFiltered.length > limit;
      const nextCursor = hasMore && page.length > 0
        ? Buffer.from(JSON.stringify({
          timestamp: page[page.length - 1].timestamp,
          id: page[page.length - 1].id,
        }), 'utf8').toString('base64url')
        : null;

      res.json({
        taskId: req.params.taskId,
        task: timeline.task,
        checkpoints: timeline.checkpoints,
        feed: page,
        pageInfo: {
          limit,
          hasMore,
          nextCursor,
          source: sourceFilter,
          windowHours: windowHours || null,
          search: search || null,
        },
      });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // ── Cancel / drop ──────────────────────────────────────────────────
  router.post('/:taskId/cancel', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const reason = req.body?.reason ? String(req.body.reason) : 'Cancelled by user';
      const task = taskManager.cancelTask(req.params.taskId, reason, auth.username);
      res.json({ success: true, task });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  router.post('/:taskId/drop', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const reason = req.body?.reason ? String(req.body.reason) : 'Dropped by user';
      const task = taskManager.dropTask(req.params.taskId, reason, auth.username);
      res.json({ success: true, task });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // ── Rollback ───────────────────────────────────────────────────────
  router.post('/:taskId/rollback/request', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const reason = req.body?.reason ? String(req.body.reason) : 'Rollback requested';
      const task = taskManager.requestRollback(req.params.taskId, reason, auth.username);
      res.json({ success: true, task });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  router.get('/:taskId/rollback/preview', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'audit.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const checkpointId = req.query.checkpointId ? String(req.query.checkpointId) : undefined;
      const preview = taskManager.getRollbackPreview(req.params.taskId, checkpointId);
      const snapshotId = preview.checkpoint?.metadata?.snapshotId
        ? String(preview.checkpoint.metadata.snapshotId)
        : undefined;
      const snapshot = snapshotId ? taskSnapshotStore.get(snapshotId) : undefined;
      const snapshotPolicy = {
        required: !!preview.checkpoint?.metadata?.requireSnapshot,
        present: !!snapshot,
        restored: !!snapshot?.restoredAt,
        snapshotId: snapshotId || null,
      };
      res.json({ success: true, preview: { ...preview, snapshotPolicy } });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  router.post('/:taskId/rollback/apply', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'tools.execute.privileged');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    try {
      const command = 'task.rollback.apply';
      const timeline = taskManager.getTaskTimeline(req.params.taskId);
      const checkpoints = timeline.checkpoints || [];
      const selectedCheckpoint = req.body?.checkpointId
        ? checkpoints.find(c => c.id === String(req.body.checkpointId))
        : checkpoints[checkpoints.length - 1];
      const selectedSnapshotId = selectedCheckpoint?.metadata?.snapshotId
        ? String(selectedCheckpoint.metadata.snapshotId)
        : undefined;
      const requireSnapshot = !!selectedCheckpoint?.metadata?.requireSnapshot;
      if (requireSnapshot && !selectedSnapshotId) {
        res.status(409).json({ error: 'Rollback blocked: selected checkpoint requires a snapshot reference.' });
        return;
      }
      if (selectedSnapshotId) {
        const snapshot = taskSnapshotStore.get(selectedSnapshotId);
        if (!snapshot || snapshot.taskId !== req.params.taskId) {
          res.status(409).json({ error: 'Rollback blocked: checkpoint snapshot is missing or does not match task.' });
          return;
        }
        taskSnapshotStore.markRestored({
          snapshotId: selectedSnapshotId,
          actorId: auth.username || 'operator',
        });
        taskManager.appendOperation(req.params.taskId, {
          actorId: auth.username,
          actorType: 'user',
          type: 'rollback',
          summary: `Snapshot manifest applied: ${selectedSnapshotId}`,
          details: `Target: ${snapshot.manifest.target}\nPlan: ${snapshot.manifest.rollbackPlan}\nSteps:\n- ${snapshot.manifest.rollbackSteps.join('\n- ')}`,
          status: 'recorded',
        });
      }
      const approval = helpers.validateApprovalToken({
        token: req.body?.approvalToken ? String(req.body.approvalToken) : undefined,
        command,
        agentId: String(auth.username || ''),
      });
      if (!approval.ok) {
        executionAuditStore.append({
          id: helpers.cryptoRandomId(),
          timestamp: new Date().toISOString(),
          taskId: req.params.taskId,
          command,
          skillId: 'task_lifecycle',
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
          taskId: req.params.taskId,
          command,
          skillId: 'task_lifecycle',
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
      const task = taskManager.applyRollback(req.params.taskId, {
        checkpointId: req.body?.checkpointId ? String(req.body.checkpointId) : undefined,
        note: req.body?.note ? String(req.body.note) : undefined,
        actorId: auth.username,
      });
      executionAuditStore.append({
        id: helpers.cryptoRandomId(),
        timestamp: new Date().toISOString(),
        taskId: req.params.taskId,
        command,
        skillId: 'task_lifecycle',
        agentId: auth.username || 'unknown',
        agentRole: auth.role || 'operator',
        status: 'allowed',
        approvalRequired: true,
        approvalTokenId: approval.tokenId,
        credentialIds: [],
        credentialScopes: [],
      });
      res.json({
        success: true,
        task,
        approvalTokenId: approval.tokenId,
        checkpointId: selectedCheckpoint?.id,
        snapshotId: selectedSnapshotId || null,
      });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  // ── Dependency graph (orchestrator-backed) ─────────────────────────
  router.get('/:taskId/graph', (req: Request, res: Response) => {
    const auth = validateAuth(req.header('authorization') || undefined, 'security.read');
    if (!auth.ok) { res.status(403).json({ error: auth.reason || 'Forbidden' }); return; }
    const taskId = String(req.params.taskId || '');
    if (!taskId) {
      res.status(400).json({ error: 'taskId is required' });
      return;
    }
    try {
      const graph = orchestratorService.getTaskGraph(taskId);
      res.json(graph);
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });

  return router;
}

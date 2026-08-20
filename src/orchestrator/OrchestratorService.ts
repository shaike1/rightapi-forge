import { TaskManager } from '../tasks/TaskManager.js';
import { DelegationManager } from '../tasks/DelegationManager.js';
import { WorkflowEngine, WorkflowSweepResult } from '../workflows/WorkflowEngine.js';
import { logger } from '../utils/logger.js';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  SkillCategory,
  Delegation,
  DelegationState
} from '../types/index.js';
import type { Agent } from '../agents/Agent.js';
import type { SkillManager } from '../skills/SkillManager.js';

// Maps task category → ordered list of agent skill keywords (higher index = lower relevance)
const CATEGORY_SKILL_WEIGHTS: Record<string, Record<string, number>> = {
  infrastructure:      { 'server-management': 3, docker: 3, linux: 2, infrastructure: 3, bash: 1, ssh: 2 },
  monitoring:          { monitoring: 3, 'server-management': 2, linux: 1, bash: 1 },
  deployment:          { deployment: 3, devops: 3, docker: 2, linux: 1, bash: 1 },
  security:            { security: 3, linux: 1, ssh: 1 },
  'service-management':{ servicedesk: 3, jira: 2 },
  microsoft365:        { microsoft365: 3 },
  general:             { 'server-management': 2, monitoring: 1, bash: 1, linux: 2, infrastructure: 1 },
};

const PHASES = [
  'todo',
  'triage',
  'in_progress',
  'review',
  'done',
  'blocked',
  'failed',
  'cancelled',
  'rolled_back'
] as const;

export type OrchestratorPhase = (typeof PHASES)[number];

const TERMINAL_STATUSES: TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'dropped',
  'rolled_back'
];

const PHASE_INDEX = PHASES.reduce<Record<OrchestratorPhase, number>>((acc, phase, index) => {
  acc[phase] = index;
  return acc;
}, {} as Record<OrchestratorPhase, number>);

const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 1200,
  high: 900,
  medium: 600,
  low: 300
};

const DEFAULT_PROJECT = process.env.ORCHESTRATOR_DEFAULT_PROJECT || 'default';
const DEFAULT_RELIABILITY_POLICY: OrchestratorReliabilityPolicy = {
  autoRecoverEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.ORCHESTRATOR_AUTO_RECOVER || 'true').toLowerCase()),
  stuckThresholdMinutes: Number.isFinite(Number(process.env.ORCHESTRATOR_STUCK_THRESHOLD_MINUTES || '90'))
    ? Math.max(1, Math.floor(Number(process.env.ORCHESTRATOR_STUCK_THRESHOLD_MINUTES || '90')))
    : 90,
  retryLimit: Number.isFinite(Number(process.env.ORCHESTRATOR_STUCK_RETRY_LIMIT || '2'))
    ? Math.max(0, Math.floor(Number(process.env.ORCHESTRATOR_STUCK_RETRY_LIMIT || '2')))
    : 2,
  retryCooldownMinutes: Number.isFinite(Number(process.env.ORCHESTRATOR_STUCK_RETRY_COOLDOWN_MINUTES || '15'))
    ? Math.max(1, Math.floor(Number(process.env.ORCHESTRATOR_STUCK_RETRY_COOLDOWN_MINUTES || '15')))
    : 15
};
const RECOVERY_HISTORY_LIMIT = 500;

export interface OrchestratorReliabilityPolicy {
  autoRecoverEnabled: boolean;
  stuckThresholdMinutes: number;
  retryLimit: number;
  retryCooldownMinutes: number;
}

export interface OrchestratorRecoveryEvent {
  timestamp: string;
  taskId: string;
  action: 'retry' | 'quarantine' | 'recovery_failed';
  fromStatus: TaskStatus;
  toStatus?: TaskStatus;
  attempt: number;
  reason: string;
}

function sanitizeReliabilityPolicy(
  patch?: Partial<OrchestratorReliabilityPolicy>,
  current: OrchestratorReliabilityPolicy = DEFAULT_RELIABILITY_POLICY
): OrchestratorReliabilityPolicy {
  const stuckThreshold = Number(patch?.stuckThresholdMinutes);
  const retryLimit = Number(patch?.retryLimit);
  const retryCooldown = Number(patch?.retryCooldownMinutes);
  return {
    autoRecoverEnabled: patch?.autoRecoverEnabled === undefined
      ? current.autoRecoverEnabled
      : !!patch.autoRecoverEnabled,
    stuckThresholdMinutes: patch?.stuckThresholdMinutes === undefined
      ? current.stuckThresholdMinutes
      : (Number.isFinite(stuckThreshold)
        ? Math.min(Math.max(Math.floor(stuckThreshold), 1), 24 * 60)
        : current.stuckThresholdMinutes),
    retryLimit: patch?.retryLimit === undefined
      ? current.retryLimit
      : (Number.isFinite(retryLimit)
        ? Math.min(Math.max(Math.floor(retryLimit), 0), 10)
        : current.retryLimit),
    retryCooldownMinutes: patch?.retryCooldownMinutes === undefined
      ? current.retryCooldownMinutes
      : (Number.isFinite(retryCooldown)
        ? Math.min(Math.max(Math.floor(retryCooldown), 1), 24 * 60)
        : current.retryCooldownMinutes)
  };
}

export interface OrchestratorQueueEntry {
  taskId: string;
  title: string;
  projectId: string;
  ownerId: string;
  assignedTo?: string;
  priority: TaskPriority;
  category: SkillCategory;
  status: TaskStatus;
  orchestratorPhase: OrchestratorPhase;
  tags: string[];
  dependencies: string[];
  delegations: Delegation[];
  score: number;
  queuePosition: number;
  createdAt: string;
  lastUpdated: string;
}

export interface OrchestratorStatus {
  lastTickAt: string | null;
  lastTickReason?: string;
  lastUpdatedAt: string;
  activeAgents: number;
  queueCounts: Record<OrchestratorPhase, number>;
  queueCountsByProject: Record<string, number>;
  queue: OrchestratorQueueEntry[];
  workflowHealth?: WorkflowSweepResult | null;
  stuckEntries: Array<{
    taskId: string;
    phase: OrchestratorPhase;
    status: TaskStatus;
    idleMinutes: number;
    retryAttempts: number;
    remainingRetries: number;
    lastRecoveryAt?: string;
    cooldownRemainingMinutes: number;
    nextRecoveryEligibleAt?: string;
    recoveryState: 'eligible' | 'cooldown' | 'quarantined';
  }>;
  reliability: {
    autoRecoverEnabled: boolean;
    stuckThresholdMinutes: number;
    retryLimit: number;
    retryCooldownMinutes: number;
    totalActions: number;
    totalRetries: number;
    totalQuarantined: number;
    recentActions: Array<{
      timestamp: string;
      taskId: string;
      action: 'retry' | 'quarantine' | 'recovery_failed';
      fromStatus: TaskStatus;
      toStatus?: TaskStatus;
      attempt: number;
      reason: string;
    }>;
  };
}

export interface OrchestratorGraphNode {
  id: string;
  label: string;
  type: 'task' | 'delegation';
  status?: TaskStatus;
  state?: DelegationState;
  assignedTo?: string;
  ownerId?: string;
  projectId?: string;
  tags?: string[];
  lastUpdated: string;
}

export interface OrchestratorGraphEdge {
  from: string;
  to: string;
  type: 'parent' | 'child' | 'dependency' | 'delegation_parent' | 'delegation_child';
}

export interface OrchestratorGraph {
  nodes: OrchestratorGraphNode[];
  edges: OrchestratorGraphEdge[];
}

export class OrchestratorService {
  private lastSnapshot: OrchestratorStatus;
  private lastTickAt: string | null = null;
  private lastTickReason?: string;
  private lastWorkflowSweep: WorkflowSweepResult | null = null;
  private reliabilityPolicy: OrchestratorReliabilityPolicy;
  private retryAttemptsByTask = new Map<string, number>();
  private lastRecoveryAtByTask = new Map<string, number>();
  private recoveryHistory: OrchestratorRecoveryEvent[] = [];

  constructor(
    private readonly taskManager: TaskManager,
    private readonly delegationManager: DelegationManager,
    initialReliabilityPolicy?: Partial<OrchestratorReliabilityPolicy>
  ) {
    this.reliabilityPolicy = sanitizeReliabilityPolicy(initialReliabilityPolicy, DEFAULT_RELIABILITY_POLICY);
    this.lastSnapshot = this.buildSnapshot();
  }

  tick(reason?: string): OrchestratorStatus {
    this.lastTickAt = new Date().toISOString();
    this.lastTickReason = reason;
    this.lastSnapshot = this.buildSnapshot(reason);
    try {
      this.lastWorkflowSweep = WorkflowEngine.getInstance().sweep();
    } catch (err) {
      this.lastWorkflowSweep = null;
    }
    this.lastSnapshot = { ...this.lastSnapshot, workflowHealth: this.lastWorkflowSweep };
    return this.lastSnapshot;
  }

  getStatus(): OrchestratorStatus {
    if (!this.lastSnapshot) {
      this.lastSnapshot = this.buildSnapshot();
    }
    return this.lastSnapshot;
  }

  getLastSweep(): { lastSweepAt: string | null; lastTickAt: string | null; workflowHealth: WorkflowSweepResult | null } {
    return {
      lastSweepAt: this.lastTickAt,
      lastTickAt: this.lastTickAt,
      workflowHealth: this.lastWorkflowSweep,
    };
  }

  getReliabilityPolicy(): OrchestratorReliabilityPolicy {
    return { ...this.reliabilityPolicy };
  }

  setReliabilityPolicy(patch: Partial<OrchestratorReliabilityPolicy>): OrchestratorReliabilityPolicy {
    this.reliabilityPolicy = sanitizeReliabilityPolicy(patch, this.reliabilityPolicy);
    this.lastSnapshot = this.buildSnapshot('reliability_policy_updated');
    return this.getReliabilityPolicy();
  }

  listRecoveryHistory(limit: number = 100): OrchestratorRecoveryEvent[] {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 1000) : 100;
    return this.recoveryHistory.slice(-safeLimit).reverse();
  }

  getTaskGraph(taskId: string): OrchestratorGraph {
    const seed = this.taskManager.getTask(taskId);
    if (!seed) {
      throw new Error(`Task ${taskId} not found`);
    }
    const nodes = new Map<string, OrchestratorGraphNode>();
    const edges: OrchestratorGraphEdge[] = [];

    const visitTask = (task: Task): void => {
      if (nodes.has(task.id)) return;
      nodes.set(task.id, {
        id: task.id,
        label: task.title,
        type: 'task',
        status: task.status,
        assignedTo: task.assignedTo,
        ownerId: task.ownerId,
        projectId: task.projectId || DEFAULT_PROJECT,
        tags: task.tags,
        lastUpdated: task.updatedAt.toISOString()
      });
    };

    const addParentChain = (child: Task): void => {
      if (!child.parentTaskId) return;
      const parent = this.taskManager.getTask(child.parentTaskId);
      if (!parent) return;
      visitTask(parent);
      edges.push({ from: parent.id, to: child.id, type: 'parent' });
      addParentChain(parent);
    };

    const addChildren = (parent: Task): void => {
      const children = parent.childTaskIds || [];
      children.forEach(childId => {
        const child = this.taskManager.getTask(childId);
        if (!child) return;
        visitTask(child);
        edges.push({ from: parent.id, to: child.id, type: 'child' });
        addChildren(child);
      });
    };

    const addDependencies = (task: Task): void => {
      (task.dependencies || []).forEach(depId => {
        const dependency = this.taskManager.getTask(depId);
        if (!dependency) return;
        visitTask(dependency);
        edges.push({ from: dependency.id, to: task.id, type: 'dependency' });
      });
    };

    const addDelegations = (task: Task): void => {
      const delegations = this.delegationManager.list({ taskId: task.id, limit: 50 });
      delegations.forEach(delegation => {
        const nodeId = `delegation:${delegation.id}`;
        if (!nodes.has(nodeId)) {
          nodes.set(nodeId, {
            id: nodeId,
            label: delegation.objective,
            type: 'delegation',
            state: delegation.state,
            lastUpdated: delegation.updatedAt
          });
        }
        edges.push({ from: task.id, to: nodeId, type: 'delegation_parent' });
        if (delegation.childTaskId) {
          const childTask = this.taskManager.getTask(delegation.childTaskId);
          if (childTask) {
            visitTask(childTask);
            edges.push({ from: nodeId, to: childTask.id, type: 'delegation_child' });
          }
        }
      });
    };

    visitTask(seed);
    addParentChain(seed);
    addChildren(seed);
    addDependencies(seed);
    addDelegations(seed);

    return {
      nodes: Array.from(nodes.values()),
      edges
    };
  }

  private buildSnapshot(reason?: string): OrchestratorStatus {
    let queue = this.buildQueue();
    if (this.reliabilityPolicy.autoRecoverEnabled) {
      const actions = this.recoverStuckEntries(queue);
      if (actions.length > 0) {
        queue = this.buildQueue();
      }
    }
    const queueCounts = this.countPhases(queue);
    const queueCountsByProject = this.countProjects(queue);
    const stuckEntries = queue
      .filter(entry => this.isStuck(entry))
      .map(entry => ({
        taskId: entry.taskId,
        phase: entry.orchestratorPhase,
        status: entry.status,
        idleMinutes: Math.round((Date.now() - Date.parse(entry.lastUpdated || entry.createdAt)) / 60000),
        retryAttempts: this.retryAttemptsByTask.get(entry.taskId) || 0,
        remainingRetries: Math.max(0, this.reliabilityPolicy.retryLimit - (this.retryAttemptsByTask.get(entry.taskId) || 0)),
        lastRecoveryAt: this.lastRecoveryAtByTask.get(entry.taskId)
          ? new Date(this.lastRecoveryAtByTask.get(entry.taskId) as number).toISOString()
          : undefined,
        cooldownRemainingMinutes: this.getCooldownRemainingMinutes(entry.taskId),
        nextRecoveryEligibleAt: this.getNextRecoveryEligibleAt(entry.taskId),
        recoveryState: this.getRecoveryState(entry)
      }));
    const activeAgents = new Set(queue.map(entry => entry.assignedTo).filter(Boolean)).size;

    return {
      lastTickAt: this.lastTickAt,
      lastTickReason: this.lastTickReason || reason,
      lastUpdatedAt: new Date().toISOString(),
      activeAgents,
      queueCounts,
      queueCountsByProject,
      queue,
      workflowHealth: this.lastWorkflowSweep,
      stuckEntries,
      reliability: {
        autoRecoverEnabled: this.reliabilityPolicy.autoRecoverEnabled,
        stuckThresholdMinutes: this.reliabilityPolicy.stuckThresholdMinutes,
        retryLimit: this.reliabilityPolicy.retryLimit,
        retryCooldownMinutes: this.reliabilityPolicy.retryCooldownMinutes,
        totalActions: this.recoveryHistory.length,
        totalRetries: this.recoveryHistory.filter(item => item.action === 'retry').length,
        totalQuarantined: this.recoveryHistory.filter(item => item.action === 'quarantine').length,
        recentActions: this.recoveryHistory.slice(-20).reverse()
      }
    };
  }

  private buildQueue(): OrchestratorQueueEntry[] {
    const tasks = this.taskManager.getAllTasks();
    const queue: OrchestratorQueueEntry[] = [];
    tasks.forEach(task => {
      if (this.isTerminalStatus(task.status)) return;
      const orchestratorPhase = this.determinePhase(task);
      const delegations = this.delegationManager.list({ taskId: task.id, limit: 10 });
      const score = this.computeScore(task);
      queue.push({
        taskId: task.id,
        title: task.title,
        projectId: task.projectId || DEFAULT_PROJECT,
        ownerId: task.ownerId,
        assignedTo: task.assignedTo,
        priority: task.priority,
        category: task.category,
        status: task.status,
        orchestratorPhase,
        tags: task.tags,
        dependencies: task.dependencies || [],
        delegations,
        score,
        queuePosition: queue.length + 1,
        createdAt: task.createdAt.toISOString(),
        lastUpdated: task.updatedAt.toISOString()
      });
    });
    queue.sort((a, b) => {
      const phaseOrder = PHASE_INDEX[a.orchestratorPhase] - PHASE_INDEX[b.orchestratorPhase];
      if (phaseOrder !== 0) return phaseOrder;
      return b.score - a.score;
    });
    queue.forEach((entry, index) => {
      entry.queuePosition = index + 1;
    });
    return queue;
  }

  private countPhases(queue: OrchestratorQueueEntry[]): Record<OrchestratorPhase, number> {
    const counts = PHASES.reduce<Record<OrchestratorPhase, number>>((acc, phase) => {
      acc[phase] = 0;
      return acc;
    }, {} as Record<OrchestratorPhase, number>);
    queue.forEach(entry => {
      counts[entry.orchestratorPhase] = (counts[entry.orchestratorPhase] || 0) + 1;
    });
    return counts;
  }

  private countProjects(queue: OrchestratorQueueEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    queue.forEach(entry => {
      const key = entry.projectId || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  private determinePhase(task: Task): OrchestratorPhase {
    if (task.status === 'completed') return 'done';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'blocked') return 'blocked';
    if (task.status === 'rolling_back') return 'rolled_back';
    if (task.status === 'cancelled' || task.status === 'dropped') return 'cancelled';
    if (task.status === 'rolled_back') return 'rolled_back';

    const needsReview = (task.tags || []).some(tag =>
      ['review', 'qa', 'validation', 'gate'].includes(String(tag).toLowerCase())
    );
    const hasOpenDependencies = (task.dependencies || []).some(depId => {
      const dep = this.taskManager.getTask(depId);
      if (!dep) return false;
      return !this.isTerminalStatus(dep.status);
    });

    if (task.status === 'assigned' || task.status === 'pending') {
      if (hasOpenDependencies) return 'triage';
      if (needsReview) return 'review';
      return 'todo';
    }

    if (task.status === 'in_progress') {
      return needsReview ? 'review' : 'in_progress';
    }

    return 'todo';
  }

  private computeScore(task: Task): number {
    const base = PRIORITY_WEIGHTS[task.priority] || PRIORITY_WEIGHTS.medium;
    const ageHours = (Date.now() - task.updatedAt.getTime()) / (1000 * 60 * 60);
    return base + Math.max(0, ageHours) * 10;
  }

  private isStuck(entry: OrchestratorQueueEntry): boolean {
    if (!entry.lastUpdated) return false;
    const last = Date.parse(entry.lastUpdated);
    if (Number.isNaN(last)) return false;
    const stuckThresholdMs = this.reliabilityPolicy.stuckThresholdMinutes * 60 * 1000;
    return (Date.now() - last) > stuckThresholdMs && entry.orchestratorPhase !== 'done';
  }

  private isTerminalStatus(status: TaskStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
  }

  private recoverStuckEntries(queue: OrchestratorQueueEntry[]): Array<{
    taskId: string;
    action: 'retry' | 'quarantine' | 'recovery_failed';
  }> {
    const now = Date.now();
    const actions: Array<{ taskId: string; action: 'retry' | 'quarantine' | 'recovery_failed' }> = [];
    const stuck = queue.filter(entry => this.isStuck(entry));
    for (const entry of stuck) {
      if (!['pending', 'assigned', 'in_progress', 'blocked'].includes(entry.status)) continue;
      const lastRecoveryAt = this.lastRecoveryAtByTask.get(entry.taskId) || 0;
      const cooldownMs = this.reliabilityPolicy.retryCooldownMinutes * 60 * 1000;
      if ((now - lastRecoveryAt) < cooldownMs) continue;
      const attempt = (this.retryAttemptsByTask.get(entry.taskId) || 0) + 1;
      const fromStatus = entry.status;
      try {
        if (attempt <= this.reliabilityPolicy.retryLimit) {
          const toStatus: TaskStatus = fromStatus === 'in_progress' ? 'assigned' : 'pending';
          this.taskManager.updateTaskStatus(entry.taskId, toStatus);
          this.retryAttemptsByTask.set(entry.taskId, attempt);
          this.lastRecoveryAtByTask.set(entry.taskId, now);
          this.pushRecoveryEvent({
            timestamp: new Date().toISOString(),
            taskId: entry.taskId,
            action: 'retry',
            fromStatus,
            toStatus,
            attempt,
            reason: `Task stuck for more than ${this.reliabilityPolicy.stuckThresholdMinutes} minutes`
          });
          actions.push({ taskId: entry.taskId, action: 'retry' });
        } else {
          this.taskManager.updateTaskStatus(entry.taskId, 'blocked');
          this.retryAttemptsByTask.set(entry.taskId, attempt);
          this.lastRecoveryAtByTask.set(entry.taskId, now);
          this.pushRecoveryEvent({
            timestamp: new Date().toISOString(),
            taskId: entry.taskId,
            action: 'quarantine',
            fromStatus,
            toStatus: 'blocked',
            attempt,
            reason: `Retry limit exceeded (${this.reliabilityPolicy.retryLimit}) for stuck task`
          });
          actions.push({ taskId: entry.taskId, action: 'quarantine' });
        }
      } catch (error) {
        this.lastRecoveryAtByTask.set(entry.taskId, now);
        this.pushRecoveryEvent({
          timestamp: new Date().toISOString(),
          taskId: entry.taskId,
          action: 'recovery_failed',
          fromStatus,
          attempt,
          reason: (error as Error).message
        });
        actions.push({ taskId: entry.taskId, action: 'recovery_failed' });
      }
    }
    return actions;
  }

  private pushRecoveryEvent(event: {
    timestamp: string;
    taskId: string;
    action: 'retry' | 'quarantine' | 'recovery_failed';
    fromStatus: TaskStatus;
    toStatus?: TaskStatus;
    attempt: number;
    reason: string;
  }): void {
    this.recoveryHistory.push(event);
    if (this.recoveryHistory.length > RECOVERY_HISTORY_LIMIT) {
      this.recoveryHistory.splice(0, this.recoveryHistory.length - RECOVERY_HISTORY_LIMIT);
    }
  }

  private getCooldownRemainingMinutes(taskId: string): number {
    const lastRecoveryAt = this.lastRecoveryAtByTask.get(taskId);
    if (!lastRecoveryAt) return 0;
    const cooldownEndsAt = lastRecoveryAt + (this.reliabilityPolicy.retryCooldownMinutes * 60 * 1000);
    const remainingMs = cooldownEndsAt - Date.now();
    if (remainingMs <= 0) return 0;
    return Math.ceil(remainingMs / 60000);
  }

  private getNextRecoveryEligibleAt(taskId: string): string | undefined {
    const lastRecoveryAt = this.lastRecoveryAtByTask.get(taskId);
    if (!lastRecoveryAt) return undefined;
    return new Date(lastRecoveryAt + (this.reliabilityPolicy.retryCooldownMinutes * 60 * 1000)).toISOString();
  }

  private getRecoveryState(entry: OrchestratorQueueEntry): 'eligible' | 'cooldown' | 'quarantined' {
    const attempts = this.retryAttemptsByTask.get(entry.taskId) || 0;
    if (attempts > this.reliabilityPolicy.retryLimit) {
      return 'quarantined';
    }
    const cooldownRemainingMinutes = this.getCooldownRemainingMinutes(entry.taskId);
    if (cooldownRemainingMinutes > 0) {
      return 'cooldown';
    }
    return 'eligible';
  }

  /**
   * Select the best available agent for a task based on skill-category weights.
   * Directors are excluded from direct task execution.
   * Agents with more in-progress tasks are penalised.
   */
  selectAgentForTask(task: Task, agents: Agent[]): Agent | null {
    const weights = CATEGORY_SKILL_WEIGHTS[task.category] ?? CATEGORY_SKILL_WEIGHTS['general'];

    // Count active tasks per agent
    const activeCounts = new Map<string, number>();
    this.taskManager.getAllTasks()
      .filter(t => t.status === 'in_progress' && t.assignedTo)
      .forEach(t => {
        activeCounts.set(t.assignedTo!, (activeCounts.get(t.assignedTo!) || 0) + 1);
      });

    let bestAgent: Agent | null = null;
    let bestScore = -Infinity;

    for (const agent of agents) {
      if (agent.role === 'director') continue;
      if (agent.config.status !== 'active') continue;

      let score = 0;
      for (const skill of agent.config.skills) {
        score += weights[skill] ?? 0;
      }
      // Penalise busy agents (each active task costs 5 points)
      score -= (activeCounts.get(agent.id) || 0) * 5;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    return bestAgent;
  }

  /**
   * Dispatch tasks that are queued but not yet running to the best available
   * agents and execute them.
   *
   * Includes both 'pending' (no agent yet) and 'assigned' (agent baked in at
   * create time, e.g. by the scheduler or by callers passing assignedTo to
   * TaskManager.createTask). Without 'assigned' here, scheduler-created tasks
   * — which always go through TaskManager.createTask with assignedTo set,
   * which immediately flips status to 'assigned' — would never run until the
   * stuck-task sweep timed them out (~90 min) and reset them to 'pending'.
   * That bug produced the live "tasks complete exactly 90 min after creation
   * with no agent activity" symptom.
   *
   * Called periodically by the server tick loop.
   */
  async dispatchPendingTasks(
    agents: Agent[],
    skillManager: SkillManager,
    onTaskComplete?: (taskId: string, result: string) => void,
    onTaskFailed?: (taskId: string, error: string) => void
  ): Promise<number> {
    const pending = this.taskManager.getAllTasks().filter(
      t => (t.status === 'pending' || t.status === 'assigned')
        && this.taskManager.canStartTask(t.id)
    );

    let dispatched = 0;

    for (const task of pending) {
      // Use pre-assigned agent if set, otherwise select best match
      const agent = task.assignedTo
        ? agents.find(a => a.id === task.assignedTo) || this.selectAgentForTask(task, agents)
        : this.selectAgentForTask(task, agents);
      if (!agent) continue;

      try {
        if (!task.assignedTo) this.taskManager.assignAgentToTask(agent.id, task.id);
        this.taskManager.updateTaskStatus(task.id, 'in_progress');
        dispatched++;

        // Execute asynchronously — do not await to allow parallel execution
        agent.executeTask(task, skillManager).then(result => {
          this.taskManager.updateTaskStatus(task.id, 'completed');
          onTaskComplete?.(task.id, result);
        }).catch((err: Error) => {
          this.taskManager.setTaskError(task.id, err.message);
          onTaskFailed?.(task.id, err.message);
        });
      } catch (err) {
        logger.error(`[Orchestrator] Failed to dispatch task ${task.id}:`, { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? (err as Error).stack : undefined });
      }
    }

    if (dispatched > 0) {
      this.lastSnapshot = this.buildSnapshot('dispatch');
    }

    return dispatched;
  }
}

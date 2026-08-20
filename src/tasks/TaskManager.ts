// Task management system for IT operations

import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'eventemitter3';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  SkillCategory,
  TaskOperation,
  TaskRollbackCheckpoint,
  RollbackImpactClass
} from '../types/index.js';
import { Agent } from '../agents/Agent.js';
import { SqliteTaskStore } from '../persistence/SqliteStore.js';
import { logger } from '../utils/logger.js';

export interface TaskEvent {
  task: Task;
  previousStatus?: TaskStatus;
}

export class TaskManager extends EventEmitter {
  private tasks: Map<string, Task> = new Map();
  private agentTasks: Map<string, string[]> = new Map(); // agentId -> taskIds
  private store: SqliteTaskStore | null = null;

  constructor(dbPath?: string) {
    super();
    if (dbPath) {
      this.store = new SqliteTaskStore(dbPath);
      // Load persisted tasks into memory
      for (const task of this.store.getAll()) {
        this.tasks.set(task.id, task);
        if (task.assignedTo) {
          const list = this.agentTasks.get(task.assignedTo) ?? [];
          list.push(task.id);
          this.agentTasks.set(task.assignedTo, list);
        }
      }
      logger.info(`[TaskManager] Loaded ${this.tasks.size} task(s) from SQLite`);
    }
  }

  private static TERMINAL_STATUSES: TaskStatus[] = [
    'completed',
    'failed',
    'cancelled',
    'dropped',
    'rolled_back'
  ];

  createTask(params: {
    title: string;
    description: string;
    ownerId: string;
    category: SkillCategory;
    priority?: TaskPriority;
    assignedTo?: string;
    projectId?: string;
    tags?: string[];
    dependencies?: string[];
    parentTaskId?: string;
  }): Task {
    if (params.parentTaskId && !this.tasks.has(params.parentTaskId)) {
      throw new Error(`Parent task ${params.parentTaskId} not found`);
    }
    const task: Task = {
      id: uuidv4(),
      title: params.title,
      description: params.description,
      status: 'pending',
      priority: params.priority || 'medium',
      ownerId: params.ownerId,
      assignedTo: params.assignedTo,
      projectId: params.projectId || 'default',
      category: params.category,
      tags: params.tags || [],
      dependencies: params.dependencies,
      parentTaskId: params.parentTaskId,
      childTaskIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      operations: [],
      rollbackCheckpoints: []
    };

    this.tasks.set(task.id, task);
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent) {
        if (!parent.childTaskIds) parent.childTaskIds = [];
        parent.childTaskIds.push(task.id);
        parent.updatedAt = new Date();
        this.persist(parent);
      }
    }
    this.appendOperation(task.id, {
      actorType: 'system',
      type: 'note',
      summary: 'Task created',
      details: `${task.title} (${task.category}, priority ${task.priority})${task.parentTaskId ? ` [subtask of ${task.parentTaskId}]` : ''}`,
      status: 'recorded'
    });

    if (task.assignedTo) {
      this.assignAgentToTask(task.assignedTo, task.id);
    }

    this.persist(task);
    this.emit('task:created', { task });
    return task;
  }

  private persist(task: Task): void {
    this.store?.upsert(task);
  }

  assignAgentToTask(agentId: string, taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.assignedTo = agentId;
    task.status = 'assigned';
    task.updatedAt = new Date();

    if (!this.agentTasks.has(agentId)) {
      this.agentTasks.set(agentId, []);
    }
    this.agentTasks.get(agentId)?.push(taskId);

    this.persist(task);
    this.emit('task:assigned', { task });
  }

  updateTaskStatus(taskId: string, status: TaskStatus): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const previousStatus = task.status;
    task.status = status;
    task.updatedAt = new Date();

    if (TaskManager.TERMINAL_STATUSES.includes(status)) {
      task.completedAt = new Date();
    }

    this.appendOperation(task.id, {
      actorType: 'system',
      type: 'status_change',
      summary: `Status changed: ${previousStatus} -> ${status}`,
      status: 'recorded'
    });

    this.emit('task:status_changed', { task, previousStatus });
    this.persist(task);
    return task;
  }

  setTaskResult(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.result = result;
    task.updatedAt = new Date();
    this.appendOperation(task.id, {
      actorType: 'system',
      type: 'execution',
      summary: 'Task execution result recorded',
      details: result.slice(0, 400),
      status: 'success'
    });
    this.persist(task);
  }

  setTaskError(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const previousStatus = task.status;
    task.error = error;
    task.status = 'failed';
    task.updatedAt = new Date();
    this.appendOperation(task.id, {
      actorType: 'system',
      type: 'execution',
      summary: 'Task execution failed',
      details: error,
      status: 'failed'
    });

    this.emit('task:status_changed', { task, previousStatus });
    this.emit('task:failed', { task });
    this.persist(task);
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getTasksByOwner(ownerId: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.ownerId === ownerId);
  }

  getTasksByAgent(agentId: string): Task[] {
    const taskIds = this.agentTasks.get(agentId) || [];
    return taskIds.map(id => this.tasks.get(id)).filter(Boolean) as Task[];
  }

  getTasksByStatus(status: TaskStatus): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.status === status);
  }

  getChildTasks(parentTaskId: string): Task[] {
    return Array.from(this.tasks.values())
      .filter(t => t.parentTaskId === parentTaskId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  getTasksByCategory(category: SkillCategory): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.category === category);
  }

  getTasksByPriority(priority: TaskPriority): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.priority === priority);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getPendingTasks(): Task[] {
    return this.getTasksByStatus('pending');
  }

  getInProgressTasks(): Task[] {
    return this.getTasksByStatus('in_progress');
  }

  getCompletedTasks(): Task[] {
    return this.getTasksByStatus('completed');
  }

  getFailedTasks(): Task[] {
    return this.getTasksByStatus('failed');
  }

  getHighPriorityTasks(): Task[] {
    return this.getTasksByPriority('high').concat(this.getTasksByPriority('critical'));
  }

  canStartTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    // Check if dependencies are met
    if (task.dependencies && task.dependencies.length > 0) {
      for (const depId of task.dependencies) {
        const dep = this.tasks.get(depId);
        if (!dep || dep.status !== 'completed') {
          return false;
        }
      }
    }

    return true;
  }

  getAvailableTasksForAgent(agent: Agent): Task[] {
    const agentTasks = this.getTasksByAgent(agent.id);
    return agentTasks.filter(t =>
      (t.status === 'assigned' || t.status === 'pending') && this.canStartTask(t.id)
    );
  }

  deleteTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent?.childTaskIds) {
        parent.childTaskIds = parent.childTaskIds.filter(id => id !== taskId);
        parent.updatedAt = new Date();
      }
    }

    if (task.assignedTo) {
      const agentTaskList = this.agentTasks.get(task.assignedTo);
      if (agentTaskList) {
        const index = agentTaskList.indexOf(taskId);
        if (index > -1) {
          agentTaskList.splice(index, 1);
        }
      }
    }

    this.tasks.delete(taskId);
    this.emit('task:deleted', { task });
  }

  clear(): void {
    this.tasks.clear();
    this.agentTasks.clear();
  }

  getStatistics(): Record<string, number> {
    const all = this.getAllTasks();
    return {
      total: all.length,
      pending: this.getPendingTasks().length,
      assigned: this.getTasksByStatus('assigned').length,
      in_progress: this.getInProgressTasks().length,
      completed: this.getCompletedTasks().length,
      failed: this.getFailedTasks().length,
      cancelled: this.getTasksByStatus('cancelled').length,
      dropped: this.getTasksByStatus('dropped').length,
      rolling_back: this.getTasksByStatus('rolling_back').length,
      rolled_back: this.getTasksByStatus('rolled_back').length,
      critical: this.getTasksByPriority('critical').length,
      high: this.getTasksByPriority('high').length
    };
  }

  appendOperation(taskId: string, params: {
    actorId?: string;
    actorType: TaskOperation['actorType'];
    type: TaskOperation['type'];
    summary: string;
    details?: string;
    status?: TaskOperation['status'];
  }): TaskOperation {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const operation: TaskOperation = {
      id: uuidv4(),
      timestamp: new Date(),
      actorId: params.actorId,
      actorType: params.actorType,
      type: params.type,
      summary: params.summary,
      details: params.details,
      status: params.status || 'recorded'
    };
    if (!task.operations) task.operations = [];
    task.operations.push(operation);
    task.updatedAt = new Date();
    this.emit('task:operation', { task });
    return operation;
  }

  addRollbackCheckpoint(taskId: string, params: {
    label: string;
    rollbackPlan: string;
    operationId?: string;
    impactClasses?: RollbackImpactClass[];
    required?: boolean;
    metadata?: Record<string, unknown>;
  }): TaskRollbackCheckpoint {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const checkpoint: TaskRollbackCheckpoint = {
      id: uuidv4(),
      timestamp: new Date(),
      label: params.label,
      rollbackPlan: params.rollbackPlan,
      operationId: params.operationId,
      impactClasses: params.impactClasses || [],
      required: params.required ?? true,
      metadata: params.metadata
    };
    if (!task.rollbackCheckpoints) task.rollbackCheckpoints = [];
    task.rollbackCheckpoints.push(checkpoint);
    task.updatedAt = new Date();
    this.appendOperation(task.id, {
      actorType: 'system',
      type: 'rollback',
      summary: `Rollback checkpoint added: ${checkpoint.label}`,
      details: checkpoint.rollbackPlan,
      status: 'recorded'
    });
    return checkpoint;
  }

  cancelTask(taskId: string, reason: string, actorId?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const previousStatus = task.status;
    task.cancellationReason = reason;
    task.status = 'cancelled';
    task.updatedAt = new Date();
    task.completedAt = new Date();
    this.appendOperation(task.id, {
      actorId,
      actorType: actorId ? 'user' : 'system',
      type: 'cancel',
      summary: 'Task cancelled',
      details: reason,
      status: 'recorded'
    });
    this.emit('task:status_changed', { task, previousStatus });
    return task;
  }

  dropTask(taskId: string, reason: string, actorId?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const previousStatus = task.status;
    task.dropReason = reason;
    task.status = 'dropped';
    task.updatedAt = new Date();
    task.completedAt = new Date();
    this.appendOperation(task.id, {
      actorId,
      actorType: actorId ? 'user' : 'system',
      type: 'drop',
      summary: 'Task dropped',
      details: reason,
      status: 'recorded'
    });
    this.emit('task:status_changed', { task, previousStatus });
    return task;
  }

  requestRollback(taskId: string, reason: string, actorId?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const previousStatus = task.status;
    task.status = 'rolling_back';
    task.updatedAt = new Date();
    this.appendOperation(task.id, {
      actorId,
      actorType: actorId ? 'user' : 'system',
      type: 'rollback',
      summary: 'Rollback requested',
      details: reason,
      status: 'recorded'
    });
    this.emit('task:status_changed', { task, previousStatus });
    return task;
  }

  applyRollback(taskId: string, params?: { checkpointId?: string; note?: string; actorId?: string }): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const previousStatus = task.status;
    const checkpointCount = (task.rollbackCheckpoints || []).length;
    const riskyExecutions = (task.operations || []).filter(op =>
      op.type === 'execution'
      && op.status === 'success'
      && this.operationNeedsCheckpoint(op)
    );
    if (riskyExecutions.length > 0 && checkpointCount === 0) {
      throw new Error(
        `Rollback blocked: ${riskyExecutions.length} risky execution operation(s) found but no rollback checkpoints are available.`
      );
    }
    const checkpoints = task.rollbackCheckpoints || [];
    const checkpoint = params?.checkpointId
      ? checkpoints.find(c => c.id === params.checkpointId)
      : checkpoints[checkpoints.length - 1];
    if (riskyExecutions.length > 0 && !checkpoint) {
      throw new Error('Rollback blocked: a rollback checkpoint is required for risky execution history.');
    }
    if (checkpoint && !checkpoint.rollbackPlan?.trim()) {
      throw new Error('Rollback blocked: selected checkpoint is missing a rollback plan.');
    }
    task.status = 'rolled_back';
    task.updatedAt = new Date();
    task.completedAt = new Date();
    this.appendOperation(task.id, {
      actorId: params?.actorId,
      actorType: params?.actorId ? 'user' : 'system',
      type: 'rollback',
      summary: 'Rollback applied',
      details: checkpoint
        ? `Checkpoint: ${checkpoint.label}. Plan: ${checkpoint.rollbackPlan}${params?.note ? `\nNote: ${params.note}` : ''}`
        : `No checkpoint selected.${params?.note ? `\nNote: ${params.note}` : ''}`,
      status: 'success'
    });
    this.emit('task:status_changed', { task, previousStatus });
    return task;
  }

  getTaskTimeline(taskId: string): { task: Task; operations: TaskOperation[]; checkpoints: TaskRollbackCheckpoint[] } {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    return {
      task,
      operations: task.operations || [],
      checkpoints: task.rollbackCheckpoints || []
    };
  }

  getRollbackPreview(taskId: string, checkpointId?: string): {
    taskId: string;
    checkpoint?: TaskRollbackCheckpoint;
    selectedCheckpointId?: string;
    selectedCheckpointLabel?: string;
    selectedCheckpointOperationId?: string;
    impactedOperations: TaskOperation[];
    impactedCounts: Record<string, number>;
    impactClassCounts: Record<string, number>;
    impactClasses: RollbackImpactClass[];
    checkpointPolicy: { required: boolean; satisfied: boolean; reason: string };
    summary: string;
    rollbackPlan?: string;
  } {
    const timeline = this.getTaskTimeline(taskId);
    const checkpoints = timeline.checkpoints || [];
    const operations = timeline.operations || [];

    const checkpoint = checkpointId
      ? checkpoints.find(c => c.id === checkpointId)
      : checkpoints[checkpoints.length - 1];

    let baseIndex = -1;
    if (checkpoint) {
      if (checkpoint.operationId) {
        baseIndex = operations.findIndex(op => op.id === checkpoint.operationId);
      }
      if (baseIndex < 0) {
        const checkpointTime = checkpoint.timestamp.getTime();
        for (let i = operations.length - 1; i >= 0; i -= 1) {
          if (operations[i].timestamp.getTime() <= checkpointTime) {
            baseIndex = i;
            break;
          }
        }
      }
    }

    const impactedOperations = baseIndex >= 0
      ? operations.slice(baseIndex + 1)
      : operations.slice();
    const impactedCounts = impactedOperations.reduce<Record<string, number>>((acc, op) => {
      acc[op.type] = (acc[op.type] || 0) + 1;
      return acc;
    }, {});
    const classCounts = impactedOperations.reduce<Record<string, number>>((acc, op) => {
      const classes = this.inferImpactClasses(op, checkpoint);
      classes.forEach(cls => {
        acc[cls] = (acc[cls] || 0) + 1;
      });
      return acc;
    }, {});
    const impactClasses = Object.keys(classCounts) as RollbackImpactClass[];
    const requiresCheckpoint = impactedOperations.some(op => this.operationNeedsCheckpoint(op));
    const hasPlan = !!checkpoint?.rollbackPlan?.trim();
    const checkpointPolicy = {
      required: requiresCheckpoint,
      satisfied: !requiresCheckpoint || (!!checkpoint && hasPlan),
      reason: requiresCheckpoint
        ? (!!checkpoint
          ? (hasPlan ? 'Risky operations covered by selected checkpoint plan.' : 'Selected checkpoint has no rollback plan.')
          : 'Risky operations detected; a rollback checkpoint is required.')
        : 'No risky operations requiring mandatory checkpoint were detected.'
    };

    const summary = checkpoint
      ? `Dry-run preview from checkpoint "${checkpoint.label}" indicates ${impactedOperations.length} operation(s) would be reverted.`
      : `Dry-run preview without a checkpoint indicates ${impactedOperations.length} operation(s) could be reverted from task history.`;

    return {
      taskId,
      checkpoint,
      selectedCheckpointId: checkpoint?.id,
      selectedCheckpointLabel: checkpoint?.label,
      selectedCheckpointOperationId: checkpoint?.operationId,
      impactedOperations,
      impactedCounts,
      impactClassCounts: classCounts,
      impactClasses,
      checkpointPolicy,
      summary,
      rollbackPlan: checkpoint?.rollbackPlan
    };
  }

  private operationNeedsCheckpoint(operation: TaskOperation): boolean {
    const text = `${operation.summary}\n${operation.details || ''}`.toLowerCase();
    return (
      text.includes('[risk:privileged]')
      || text.includes('[risk:destructive]')
      || text.includes('deploy')
      || text.includes('docker.exec')
      || text.includes('security.sudo')
    );
  }

  private inferImpactClasses(operation: TaskOperation, checkpoint?: TaskRollbackCheckpoint): RollbackImpactClass[] {
    const classes = new Set<RollbackImpactClass>();
    const text = `${operation.summary}\n${operation.details || ''}\n${checkpoint?.rollbackPlan || ''}`.toLowerCase();

    if (operation.type === 'status_change' || operation.type === 'cancel' || operation.type === 'drop' || operation.type === 'rollback') {
      classes.add('task_state');
    }
    if (operation.type === 'note' && text.includes('thread')) {
      classes.add('communication');
    }
    if (text.includes('docker') || text.includes('k8s') || text.includes('server.') || text.includes('host')) {
      classes.add('infrastructure');
    }
    if (text.includes('deploy') || text.includes('release') || text.includes('rollout')) {
      classes.add('deployment');
    }
    if (text.includes('credential') || text.includes('token') || text.includes('auth') || text.includes('sudo') || text.includes('security')) {
      classes.add('security');
    }
    if (text.includes('backup') || text.includes('database') || text.includes('schema') || text.includes('file')) {
      classes.add('data');
    }
    if (classes.size === 0) classes.add('unknown');

    return Array.from(classes.values());
  }
}

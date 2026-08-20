import fs from 'fs';
import path from 'path';
import type { OrganizationManager } from '../agents/Organization.js';
import type { DiscordAlertNotifier } from './DiscordAlertNotifier.js';
import type { TaskManager, TaskEvent } from '../tasks/TaskManager.js';
import type { Task, TaskPriority, TaskStatus } from '../types/index.js';

export type OpsAlertSeverity = 'info' | 'warning' | 'high' | 'critical';
export type OpsAlertStatus = 'open' | 'acked' | 'resolved';

export interface OpsAlert {
  id: string;
  type: 'task_failed' | 'task_blocked' | 'task_stuck' | 'system_health' | 'capacity' | 'agent_status';
  severity: OpsAlertSeverity;
  source: string;
  title: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  status: OpsAlertStatus;
  agentId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface OpsHealthSnapshot {
  generatedAt: string;
  summary: {
    status: 'healthy' | 'degraded' | 'critical';
    score: number;
    reasons: string[];
  };
  agents: {
    total: number;
    active: number;
    inactive: number;
    byRole: Record<string, number>;
    unhealthy: Array<{
      id: string;
      name: string;
      role: string;
      status: string;
    }>;
  };
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    open: number;
    failed: number;
    blocked: number;
    stuck: number;
    highPriorityOpen: number;
    staleThresholdMinutes: number;
    stuckTasks: Array<{
      id: string;
      title: string;
      status: TaskStatus;
      priority: TaskPriority;
      assignedTo?: string;
      updatedAt: string;
      ageMinutes: number;
    }>;
  };
  alerts: {
    open: number;
    acked: number;
    resolved: number;
    critical: number;
    warningOrHigher: number;
    recent: OpsAlert[];
  };
  system: {
    uptimeSeconds: number;
    nodeVersion: string;
    memory: {
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
      externalMb: number;
    };
  };
}

export class OperationalInsightsService {
  private readonly alerts = new Map<string, OpsAlert>();
  private readonly stuckThresholdMinutes: number;
  private readonly memoryWarningMb: number;
  private readonly memoryCriticalMb: number;
  private readonly stateFilePath: string;
  private readonly discordNotifier?: DiscordAlertNotifier;
  private readonly escalationAfterMinutes: number;

  constructor(
    private readonly taskManager: TaskManager,
    private readonly organization: OrganizationManager,
    options?: {
      stuckThresholdMinutes?: number;
      memoryWarningMb?: number;
      memoryCriticalMb?: number;
      stateFilePath?: string;
      discordNotifier?: DiscordAlertNotifier;
      escalationAfterMinutes?: number;
    }
  ) {
    this.stuckThresholdMinutes = options?.stuckThresholdMinutes ?? 30;
    this.memoryWarningMb = options?.memoryWarningMb ?? 512;
    this.memoryCriticalMb = options?.memoryCriticalMb ?? 1024;
    this.stateFilePath = options?.stateFilePath || '/data/itops-agents/ops-alerts.json';
    this.discordNotifier = options?.discordNotifier;
    this.escalationAfterMinutes = options?.escalationAfterMinutes ?? 30;
    this.loadState();
    this.attachTaskListeners();
  }

  acknowledgeAlert(alertId: string): OpsAlert | null {
    this.refreshDerivedAlerts();
    const alert = this.alerts.get(alertId);
    if (!alert) return null;
    if (alert.status === 'resolved') return alert;
    alert.status = 'acked';
    alert.updatedAt = new Date().toISOString();
    this.alerts.set(alert.id, alert);
    this.saveState();
    return alert;
  }

  resolveAlert(alertId: string): OpsAlert | null {
    this.refreshDerivedAlerts();
    const alert = this.alerts.get(alertId);
    if (!alert) return null;
    alert.status = 'resolved';
    alert.updatedAt = new Date().toISOString();
    this.alerts.set(alert.id, alert);
    this.saveState();
    return alert;
  }

  getAlerts(): OpsAlert[] {
    this.refreshDerivedAlerts();
    return Array.from(this.alerts.values()).sort((a, b) => {
      const severityDiff = this.severityRank(b.severity) - this.severityRank(a.severity);
      if (severityDiff !== 0) return severityDiff;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }

  getAlertStats(): {
    total: number;
    open: number;
    acked: number;
    resolved: number;
    bySeverity: Record<OpsAlertSeverity, number>;
    byType: Record<string, number>;
  } {
    const alerts = this.getAlerts();
    return {
      total: alerts.length,
      open: alerts.filter(alert => alert.status === 'open').length,
      acked: alerts.filter(alert => alert.status === 'acked').length,
      resolved: alerts.filter(alert => alert.status === 'resolved').length,
      bySeverity: {
        info: alerts.filter(alert => alert.severity === 'info').length,
        warning: alerts.filter(alert => alert.severity === 'warning').length,
        high: alerts.filter(alert => alert.severity === 'high').length,
        critical: alerts.filter(alert => alert.severity === 'critical').length
      },
      byType: alerts.reduce<Record<string, number>>((acc, alert) => {
        acc[alert.type] = (acc[alert.type] || 0) + 1;
        return acc;
      }, {})
    };
  }

  createTestAlert(input?: {
    title?: string;
    message?: string;
    severity?: OpsAlertSeverity;
    source?: string;
  }): OpsAlert {
    const alertId = `test:${Date.now()}`;
    this.upsertAlert({
      id: alertId,
      type: 'system_health',
      severity: input?.severity || 'high',
      source: input?.source || 'manual-test',
      title: input?.title || 'Test alert',
      message: input?.message || 'This is a manually triggered test alert.'
    });
    return this.alerts.get(alertId)!;
  }

  runEscalationSweep(): number {
    let escalated = 0;
    const now = Date.now();
    for (const alert of this.alerts.values()) {
      if (alert.status !== 'open') {
        continue;
      }
      const ageMinutes = Math.floor((now - new Date(alert.createdAt).getTime()) / 60000);
      const alreadyEscalated = Boolean(alert.metadata?.escalatedAt);
      if (ageMinutes < this.escalationAfterMinutes || alreadyEscalated) {
        continue;
      }
      const nextAlert: OpsAlert = {
        ...alert,
        metadata: {
          ...(alert.metadata || {}),
          escalatedAt: new Date().toISOString(),
          escalationAgeMinutes: ageMinutes
        },
        updatedAt: new Date().toISOString()
      };
      this.alerts.set(nextAlert.id, nextAlert);
      this.saveState();
      void this.notifyExternalChannels(nextAlert);
      escalated += 1;
    }
    return escalated;
  }

  getHealthSnapshot(): OpsHealthSnapshot {
    const alerts = this.getAlerts();
    const agents = this.organization.getAllAgents();
    const tasks = this.taskManager.getAllTasks();
    const stuckTasks = this.getStuckTasks(tasks);
    const memory = process.memoryUsage();
    const byStatus = this.buildTaskStatusCounters(tasks);
    const activeAgents = agents.filter(agent => agent.config.status === 'active');
    const inactiveAgents = agents.filter(agent => agent.config.status !== 'active');
    const byRole = agents.reduce<Record<string, number>>((acc, agent) => {
      acc[agent.role] = (acc[agent.role] || 0) + 1;
      return acc;
    }, {});

    const reasons: string[] = [];
    let score = 100;

    const openAlerts = alerts.filter(alert => alert.status === 'open');
    const criticalAlerts = openAlerts.filter(alert => alert.severity === 'critical').length;
    const warningOrHigher = openAlerts.filter(alert => ['warning', 'high', 'critical'].includes(alert.severity)).length;

    if (criticalAlerts > 0) {
      score -= Math.min(40, criticalAlerts * 20);
      reasons.push(`${criticalAlerts} critical alert${criticalAlerts === 1 ? '' : 's'} open`);
    }
    if (warningOrHigher > 0) {
      score -= Math.min(25, warningOrHigher * 5);
      reasons.push(`${warningOrHigher} warning/high alerts need attention`);
    }
    if (stuckTasks.length > 0) {
      score -= Math.min(20, stuckTasks.length * 5);
      reasons.push(`${stuckTasks.length} stuck task${stuckTasks.length === 1 ? '' : 's'} detected`);
    }
    if (inactiveAgents.length > 0) {
      score -= Math.min(20, inactiveAgents.length * 10);
      reasons.push(`${inactiveAgents.length} inactive agent${inactiveAgents.length === 1 ? '' : 's'}`);
    }
    if (agents.length === 0) {
      score -= 40;
      reasons.push('No agents loaded');
    }

    score = Math.max(0, score);
    const summaryStatus: OpsHealthSnapshot['summary']['status'] =
      score >= 85 ? 'healthy' : score >= 60 ? 'degraded' : 'critical';

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        status: summaryStatus,
        score,
        reasons
      },
      agents: {
        total: agents.length,
        active: activeAgents.length,
        inactive: inactiveAgents.length,
        byRole,
        unhealthy: inactiveAgents.map(agent => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          status: agent.config.status
        }))
      },
      tasks: {
        total: tasks.length,
        byStatus,
        open: tasks.filter(task => !this.isTerminalStatus(task.status)).length,
        failed: byStatus.failed,
        blocked: byStatus.blocked,
        stuck: stuckTasks.length,
        highPriorityOpen: tasks.filter(task => !this.isTerminalStatus(task.status) && ['high', 'critical'].includes(task.priority)).length,
        staleThresholdMinutes: this.stuckThresholdMinutes,
        stuckTasks: stuckTasks.map(task => ({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          assignedTo: task.assignedTo,
          updatedAt: task.updatedAt.toISOString(),
          ageMinutes: this.taskAgeMinutes(task)
        }))
      },
      alerts: {
        open: alerts.filter(alert => alert.status === 'open').length,
        acked: alerts.filter(alert => alert.status === 'acked').length,
        resolved: alerts.filter(alert => alert.status === 'resolved').length,
        critical: alerts.filter(alert => alert.status === 'open' && alert.severity === 'critical').length,
        warningOrHigher: alerts.filter(alert => alert.status === 'open' && ['warning', 'high', 'critical'].includes(alert.severity)).length,
        recent: alerts.slice(0, 10)
      },
      system: {
        uptimeSeconds: process.uptime(),
        nodeVersion: process.version,
        memory: {
          rssMb: this.toMb(memory.rss),
          heapUsedMb: this.toMb(memory.heapUsed),
          heapTotalMb: this.toMb(memory.heapTotal),
          externalMb: this.toMb(memory.external)
        }
      }
    };
  }

  private attachTaskListeners(): void {
    this.taskManager.on('task:failed', ({ task }: TaskEvent) => {
      this.upsertAlert({
        id: `task-failed:${task.id}`,
        type: 'task_failed',
        severity: task.priority === 'critical' ? 'critical' : 'high',
        source: 'task-manager',
        title: `Task failed: ${task.title}`,
        message: task.error || 'Task entered failed state',
        taskId: task.id,
        agentId: task.assignedTo,
        metadata: {
          priority: task.priority,
          category: task.category
        }
      });
    });

    this.taskManager.on('task:status_changed', ({ task, previousStatus }: TaskEvent) => {
      if (task.status === 'blocked') {
        this.upsertAlert({
          id: `task-blocked:${task.id}`,
          type: 'task_blocked',
          severity: task.priority === 'critical' ? 'high' : 'warning',
          source: 'task-manager',
          title: `Task blocked: ${task.title}`,
          message: `Task moved from ${previousStatus || 'unknown'} to blocked`,
          taskId: task.id,
          agentId: task.assignedTo,
          metadata: {
            priority: task.priority,
            category: task.category
          }
        });
      }
    });
  }

  private refreshDerivedAlerts(): void {
    this.refreshSystemAlerts();
    this.refreshStuckTaskAlerts();
  }

  private refreshSystemAlerts(): void {
    const agents = this.organization.getAllAgents();
    if (agents.length === 0) {
      this.upsertAlert({
        id: 'system:no-agents',
        type: 'agent_status',
        severity: 'critical',
        source: 'organization',
        title: 'No agents loaded',
        message: 'The organization has no active agents loaded into memory.'
      });
    } else {
      this.resolveDerivedAlert('system:no-agents');
    }

    const inactiveAgents = agents.filter(agent => agent.config.status !== 'active');
    if (inactiveAgents.length > 0) {
      this.upsertAlert({
        id: 'system:inactive-agents',
        type: 'agent_status',
        severity: inactiveAgents.length >= 2 ? 'high' : 'warning',
        source: 'organization',
        title: 'Inactive agents detected',
        message: `${inactiveAgents.length} agent${inactiveAgents.length === 1 ? '' : 's'} are not active`,
        metadata: {
          agentIds: inactiveAgents.map(agent => agent.id)
        }
      });
    } else {
      this.resolveDerivedAlert('system:inactive-agents');
    }

    const rssMb = this.toMb(process.memoryUsage().rss);
    if (rssMb >= this.memoryCriticalMb) {
      this.upsertAlert({
        id: 'system:memory',
        type: 'system_health',
        severity: 'critical',
        source: 'node-process',
        title: 'Critical memory usage',
        message: `RSS memory is ${rssMb} MB (threshold ${this.memoryCriticalMb} MB)`
      });
    } else if (rssMb >= this.memoryWarningMb) {
      this.upsertAlert({
        id: 'system:memory',
        type: 'system_health',
        severity: 'warning',
        source: 'node-process',
        title: 'High memory usage',
        message: `RSS memory is ${rssMb} MB (threshold ${this.memoryWarningMb} MB)`
      });
    } else {
      this.resolveDerivedAlert('system:memory');
    }
  }

  private refreshStuckTaskAlerts(): void {
    const stuckTasks = this.getStuckTasks(this.taskManager.getAllTasks());
    const activeIds = new Set(stuckTasks.map(task => `task-stuck:${task.id}`));

    for (const task of stuckTasks) {
      this.upsertAlert({
        id: `task-stuck:${task.id}`,
        type: 'task_stuck',
        severity: task.priority === 'critical' ? 'critical' : task.priority === 'high' ? 'high' : 'warning',
        source: 'task-manager',
        title: `Task appears stuck: ${task.title}`,
        message: `No meaningful update for ${this.taskAgeMinutes(task)} minutes while in ${task.status}`,
        taskId: task.id,
        agentId: task.assignedTo,
        metadata: {
          priority: task.priority,
          status: task.status,
          updatedAt: task.updatedAt.toISOString()
        }
      });
    }

    for (const [alertId, alert] of this.alerts.entries()) {
      if (alert.type === 'task_stuck' && !activeIds.has(alertId)) {
        this.resolveDerivedAlert(alertId);
      }
    }
  }

  private resolveDerivedAlert(alertId: string): void {
    const existing = this.alerts.get(alertId);
    if (!existing || existing.status === 'resolved') return;
    existing.status = 'resolved';
    existing.updatedAt = new Date().toISOString();
    this.alerts.set(existing.id, existing);
    this.saveState();
  }

  private upsertAlert(alert: Omit<OpsAlert, 'createdAt' | 'updatedAt' | 'status'> & { createdAt?: string; updatedAt?: string; status?: OpsAlertStatus }): void {
    const existing = this.alerts.get(alert.id);
    const now = new Date().toISOString();

    if (existing) {
      const shouldReopen = existing.status === 'resolved';
      const nextAlert = {
        ...existing,
        ...alert,
        createdAt: existing.createdAt,
        updatedAt: now,
        status: shouldReopen ? 'open' : existing.status
      } satisfies OpsAlert;
      this.alerts.set(alert.id, nextAlert);
      this.saveState();
      const severityEscalated = this.severityRank(nextAlert.severity) > this.severityRank(existing.severity);
      if (shouldReopen || severityEscalated) {
        void this.notifyExternalChannels(nextAlert);
      }
      return;
    }

    const newAlert = {
      createdAt: alert.createdAt || now,
      updatedAt: alert.updatedAt || now,
      status: alert.status || 'open',
      ...alert
    } satisfies OpsAlert;
    this.alerts.set(alert.id, newAlert);
    this.saveState();
    void this.notifyExternalChannels(newAlert);
  }

  private getStuckTasks(tasks: Task[]): Task[] {
    return tasks
      .filter(task => ['assigned', 'in_progress', 'blocked'].includes(task.status))
      .filter(task => this.taskAgeMinutes(task) >= this.stuckThresholdMinutes)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  private buildTaskStatusCounters(tasks: Task[]): Record<TaskStatus, number> {
    const base: Record<TaskStatus, number> = {
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      cancelled: 0,
      dropped: 0,
      rolling_back: 0,
      rolled_back: 0
    };

    for (const task of tasks) {
      base[task.status] += 1;
    }

    return base;
  }

  private taskAgeMinutes(task: Task): number {
    return Math.max(0, Math.floor((Date.now() - task.updatedAt.getTime()) / 60000));
  }

  private isTerminalStatus(status: TaskStatus): boolean {
    return ['completed', 'failed', 'cancelled', 'dropped', 'rolled_back'].includes(status);
  }

  private severityRank(severity: OpsAlertSeverity): number {
    return {
      info: 0,
      warning: 1,
      high: 2,
      critical: 3
    }[severity];
  }

  private toMb(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
  }

  private async notifyExternalChannels(alert: OpsAlert): Promise<void> {
    if (!this.discordNotifier) {
      return;
    }
    try {
      await this.discordNotifier.notify(alert);
    } catch (error) {
      console.error('Failed to send Discord alert:', (error as Error).message);
    }
  }

  getEscalationAfterMinutes(): number {
    return this.escalationAfterMinutes;
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFilePath)) {
        return;
      }
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { alerts?: OpsAlert[] };
      for (const alert of parsed.alerts || []) {
        if (alert?.id) {
          this.alerts.set(alert.id, alert);
        }
      }
    } catch (error) {
      console.error('Failed to load ops alert state:', (error as Error).message);
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify({ alerts: Array.from(this.alerts.values()) }, null, 2),
        'utf8'
      );
    } catch (error) {
      console.error('Failed to save ops alert state:', (error as Error).message);
    }
  }
}

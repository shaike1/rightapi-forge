// Task Scheduler Service
// Handles recurring tasks with cron-like scheduling

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface ScheduleRule {
  id: string;
  name: string;
  description?: string;
  cronExpression: string;
  taskTemplate: {
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    assignTo?: string; // agentId
    tags?: string[];
  };
  enabled: boolean;
  timezone?: string;
  missedRunPolicy: 'skip' | 'run-once' | 'run-all';
  conflictPolicy: 'skip' | 'queue' | 'terminate-previous';
  maxConcurrent?: number;
  createdAt: Date;
  updatedAt: Date;
  lastRun?: Date;
  nextRun?: Date;
}

export interface ScheduledTaskRun {
  id: string;
  scheduleId: string;
  scheduledFor: Date;
  startedAt?: Date;
  completedAt?: Date;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  taskId?: string; // created task ID
  error?: string;
}

export class TaskScheduler extends EventEmitter {
  private schedules: Map<string, ScheduleRule> = new Map();
  private runs: Map<string, ScheduledTaskRun> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private dataPath: string;
  private tickInterval: NodeJS.Timeout | null = null;

  constructor(dataPath: string = '/data/itops-agents/schedules.json') {
    super();
    this.dataPath = dataPath;
    this.load();
  }

  start(): void {
    if (this.tickInterval) return;
    
    // Check every minute for due schedules
    this.tickInterval = setInterval(() => {
      this.tick();
    }, 60000); // 1 minute
    
    console.log('[TaskScheduler] Started (60s tick)');
    this.tick(); // immediate first tick
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    
    console.log('[TaskScheduler] Stopped');
  }

  private tick(): void {
    const now = new Date();
    
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) continue;
      
      const nextRun = this.calculateNextRun(schedule.cronExpression, schedule.timezone);
      schedule.nextRun = nextRun || undefined;
      
      // Check if it's time to run (within last minute)
      if (nextRun && nextRun <= now && (!schedule.lastRun || nextRun > schedule.lastRun)) {
        this.executeSchedule(schedule, nextRun);
      }
    }
  }

  private async executeSchedule(schedule: ScheduleRule, scheduledFor: Date): Promise<void> {
    const runId = uuidv4();
    const run: ScheduledTaskRun = {
      id: runId,
      scheduleId: schedule.id,
      scheduledFor,
      status: 'pending'
    };
    
    this.runs.set(runId, run);
    
    try {
      // Check for conflicts (other runs of same schedule still running)
      const activeRuns = Array.from(this.runs.values()).filter(
        r => r.scheduleId === schedule.id && r.status === 'running'
      );
      
      if (activeRuns.length > 0) {
        switch (schedule.conflictPolicy) {
          case 'skip':
            run.status = 'skipped';
            console.log(`[TaskScheduler] Skipped ${schedule.name} due to active run`);
            return;
          case 'queue':
            // Wait for active runs to complete
            // (simplified: just skip for now)
            run.status = 'skipped';
            return;
          case 'terminate-previous':
            // In real implementation, terminate previous runs
            // For now, just proceed
            break;
        }
      }
      
      run.status = 'running';
      run.startedAt = new Date();
      
      // Emit event for task creation
      this.emit('schedule-execute', {
        scheduleId: schedule.id,
        runId: run.id,
        taskTemplate: schedule.taskTemplate
      });
      
      // In real implementation, wait for task completion
      // For now, mark as completed immediately
      run.status = 'completed';
      run.completedAt = new Date();
      
      schedule.lastRun = scheduledFor;
      schedule.updatedAt = new Date();
      
      this.save();
      
    } catch (error) {
      run.status = 'failed';
      run.error = (error as Error).message;
      console.error(`[TaskScheduler] Failed to execute ${schedule.name}:`, error);
    }
  }

  private calculateNextRun(cronExpression: string, timezone?: string): Date | null {
    // Simplified cron parser (real implementation would use a library like 'cron-parser')
    // For now, just return next minute
    const now = new Date();
    const next = new Date(now.getTime() + 60000);
    return next;
  }

  addSchedule(schedule: Omit<ScheduleRule, 'id' | 'createdAt' | 'updatedAt'>): ScheduleRule {
    const id = uuidv4();
    const now = new Date();
    
    const newSchedule: ScheduleRule = {
      ...schedule,
      id,
      createdAt: now,
      updatedAt: now,
      nextRun: this.calculateNextRun(schedule.cronExpression, schedule.timezone) || undefined
    };
    
    this.schedules.set(id, newSchedule);
    this.save();
    
    return newSchedule;
  }

  updateSchedule(id: string, updates: Partial<ScheduleRule>): ScheduleRule | null {
    const schedule = this.schedules.get(id);
    if (!schedule) return null;
    
    Object.assign(schedule, updates);
    schedule.updatedAt = new Date();
    
    if (updates.cronExpression || updates.timezone) {
      schedule.nextRun = this.calculateNextRun(
        schedule.cronExpression,
        schedule.timezone
      ) || undefined;
    }
    
    this.save();
    return schedule;
  }

  deleteSchedule(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) {
      this.save();
    }
    return deleted;
  }

  getSchedule(id: string): ScheduleRule | undefined {
    return this.schedules.get(id);
  }

  getAllSchedules(): ScheduleRule[] {
    return Array.from(this.schedules.values());
  }

  getScheduleRuns(scheduleId: string, limit: number = 50): ScheduledTaskRun[] {
    return Array.from(this.runs.values())
      .filter(r => r.scheduleId === scheduleId)
      .sort((a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime())
      .slice(0, limit);
  }

  private save(): void {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data = {
        schedules: Array.from(this.schedules.entries()),
        runs: Array.from(this.runs.entries()).slice(0, 1000) // keep last 1000 runs
      };
      
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      console.error('[TaskScheduler] Failed to save:', error);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.dataPath)) return;
      
      const content = fs.readFileSync(this.dataPath, 'utf8');
      const data = JSON.parse(content);
      
      this.schedules = new Map(data.schedules || []);
      this.runs = new Map(data.runs || []);
      
      console.log(`[TaskScheduler] Loaded ${this.schedules.size} schedule(s)`);
    } catch (error) {
      console.error('[TaskScheduler] Failed to load:', error);
    }
  }
}

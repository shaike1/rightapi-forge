// Cron-based Task Scheduler for RightAPI Forge

import type { ScheduledTask as CronTask } from 'node-cron';
import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  nextRun?: string;
  createdAt: string;
}

type TaskQueueFn = (agentId: string, prompt: string) => Promise<string | null>;

export class TaskScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private jobs: Map<string, CronTask> = new Map();
  private persistPath: string;
  private queueTask: TaskQueueFn;

  constructor(persistPath: string, queueTask: TaskQueueFn) {
    this.persistPath = persistPath;
    this.queueTask = queueTask;
    this.load();
    this.seedDefaults();
    this.startAll();
  }

  private load() {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8'));
      for (const t of raw) {
        this.tasks.set(t.id, t);
      }
      logger.info(`[Scheduler] Loaded ${this.tasks.size} scheduled task(s)`);
    } catch (e) {
      logger.error('[Scheduler] Failed to load tasks:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  private save() {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify([...this.tasks.values()], null, 2));
    } catch (e) {
      logger.error('[Scheduler] Failed to save tasks:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    }
  }

  private seedDefaults() {
    const defaults: ScheduledTask[] = [
      {
        id: 'seed-hourly-health',
        name: 'Hourly Server Health Check',
        cronExpression: '0 * * * *',
        agentId: 'auto',
        prompt: 'Run a health check: check CPU, memory, and disk usage on all monitored servers. Summarize the results.',
        enabled: true,
        createdAt: new Date().toISOString()
      },
      {
        id: 'seed-daily-summary',
        name: 'Daily IT Ops Summary',
        cronExpression: '0 8 * * *',
        agentId: 'auto',
        prompt: 'Generate a morning IT operations report: check all servers health, list any failed services, summarize recent alerts and tasks. Post summary.',
        enabled: true,
        createdAt: new Date().toISOString()
      },
      {
        id: 'seed-nightly-docker',
        name: 'Nightly Docker Container Check',
        cronExpression: '0 23 * * *',
        agentId: 'auto',
        prompt: 'Check all Docker containers on all hosts. Report any unhealthy, exited, or restarting containers. List running compose projects.',
        enabled: true,
        createdAt: new Date().toISOString()
      }
    ];
    for (const d of defaults) {
      if (!this.tasks.has(d.id)) {
        this.tasks.set(d.id, d);
      }
    }
    this.save();
  }

  private startAll() {
    for (const task of this.tasks.values()) {
      if (task.enabled) this.startJob(task);
    }
  }

  private startJob(task: ScheduledTask) {
    if (this.jobs.has(task.id)) {
      this.jobs.get(task.id)!.stop();
      this.jobs.delete(task.id);
    }
    if (!cron.validate(task.cronExpression)) {
      logger.warn(`[Scheduler] Invalid cron expression for task "${task.name}": ${task.cronExpression}`);
      return;
    }
    const job = cron.schedule(task.cronExpression, async () => {
      logger.info(`[Scheduler] Running task "${task.name}" (id=${task.id})`);
      task.lastRun = new Date().toISOString();
      this.save();
      try {
        const result = await this.queueTask(task.agentId, task.prompt);
        task.lastResult = result ?? 'Task queued';
      } catch (e: any) {
        task.lastResult = `Error: ${e.message}`;
      }
      this.save();
    });
    this.jobs.set(task.id, job);
    logger.info(`[Scheduler] Scheduled "${task.name}" → ${task.cronExpression}`);
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  add(task: Omit<ScheduledTask, 'id' | 'createdAt'>): ScheduledTask {
    const newTask: ScheduledTask = {
      ...task,
      id: 'sched-' + Date.now(),
      createdAt: new Date().toISOString()
    };
    this.tasks.set(newTask.id, newTask);
    if (newTask.enabled) this.startJob(newTask);
    this.save();
    return newTask;
  }

  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, patch);
    if (task.enabled) {
      this.startJob(task);
    } else {
      this.jobs.get(id)?.stop();
      this.jobs.delete(id);
    }
    this.save();
    return task;
  }

  remove(id: string): boolean {
    if (!this.tasks.has(id)) return false;
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.tasks.delete(id);
    this.save();
    return true;
  }

  async runNow(id: string): Promise<string> {
    const task = this.tasks.get(id);
    if (!task) return `Task ${id} not found`;
    task.lastRun = new Date().toISOString();
    this.save();
    try {
      const result = await this.queueTask(task.agentId, task.prompt);
      task.lastResult = result ?? 'Task queued';
    } catch (e: any) {
      task.lastResult = `Error: ${e.message}`;
    }
    this.save();
    return task.lastResult || 'done';
  }
}

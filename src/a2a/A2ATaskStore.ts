/**
 * A2ATaskStore — persists A2A task state
 * Phase 2: Task Execution
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type {
  A2ATask,
  A2ATaskState,
  A2AMessage,
  A2AArtifact,
} from './A2ATypes.js';

export interface A2ATaskRecord extends A2ATask {
  agentId: string;
  createdAt: string;
  updatedAt: string;
}

export class A2ATaskStore {
  private tasks = new Map<string, A2ATaskRecord>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  create(params: {
    agentId: string;
    sessionId?: string;
    message: A2AMessage;
    metadata?: Record<string, unknown>;
  }): A2ATaskRecord {
    const now = new Date().toISOString();
    const task: A2ATaskRecord = {
      id: uuidv4(),
      agentId: params.agentId,
      sessionId: params.sessionId,
      status: {
        state: 'submitted',
        timestamp: now,
      },
      history: [params.message],
      artifacts: [],
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  get(id: string): A2ATaskRecord | undefined {
    return this.tasks.get(id);
  }

  listByAgent(agentId: string): A2ATaskRecord[] {
    return Array.from(this.tasks.values())
      .filter(t => t.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAll(): A2ATaskRecord[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  updateStatus(id: string, state: A2ATaskState, message?: A2AMessage): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = { state, timestamp: new Date().toISOString(), message };
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  addArtifact(id: string, artifact: A2AArtifact): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.artifacts = task.artifacts ?? [];
    task.artifacts.push(artifact);
    task.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.status.state === 'completed' || task.status.state === 'failed') return false;
    return this.updateStatus(id, 'canceled', {
      role: 'agent',
      parts: [{ type: 'text', text: 'Task canceled by request' }],
    });
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as A2ATaskRecord[];
      raw.forEach(t => this.tasks.set(t.id, t));
      logger.info(`[A2ATaskStore] Loaded ${this.tasks.size} tasks from ${this.filePath}`);
    } catch {
      logger.warn(`[A2ATaskStore] Could not load ${this.filePath} — starting fresh`);
    }
  }

  private save(): void {
    try {
      writeFileSync(
        this.filePath,
        JSON.stringify(Array.from(this.tasks.values()), null, 2),
      );
    } catch (e) {
      logger.warn(`[A2ATaskStore] Failed to persist tasks: ${(e as Error).message}`);
    }
  }
}

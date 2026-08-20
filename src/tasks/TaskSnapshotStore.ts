import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface TaskSnapshot {
  id: string;
  taskId: string;
  createdAt: string;
  command: string;
  skillId: string;
  agentId: string;
  risk?: string;
  sandbox?: string;
  paramsHash: string;
  timelineHash: string;
  operationCount: number;
  checkpointCount: number;
  manifest: {
    rollbackPlan: string;
    rollbackSteps: string[];
    target: string;
  };
  metadata?: Record<string, unknown>;
  restoredAt?: string;
  restoredBy?: string;
}

interface SnapshotFile {
  version: number;
  snapshots: TaskSnapshot[];
}

function hashObject(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function randomId(): string {
  return `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class TaskSnapshotStore {
  private filePath: string;
  private maxSnapshots: number;
  private snapshots: TaskSnapshot[] = [];

  constructor(filePath: string, maxSnapshots: number = 5000) {
    this.filePath = filePath;
    this.maxSnapshots = maxSnapshots;
    this.load();
  }

  create(params: {
    taskId: string;
    command: string;
    skillId: string;
    agentId: string;
    risk?: string;
    sandbox?: string;
    params: Record<string, unknown>;
    timeline: { operations: unknown[]; checkpoints: unknown[] };
    manifest: TaskSnapshot['manifest'];
    metadata?: Record<string, unknown>;
  }): TaskSnapshot {
    const snapshot: TaskSnapshot = {
      id: randomId(),
      taskId: params.taskId,
      createdAt: new Date().toISOString(),
      command: params.command,
      skillId: params.skillId,
      agentId: params.agentId,
      risk: params.risk,
      sandbox: params.sandbox,
      paramsHash: hashObject(params.params),
      timelineHash: hashObject({
        operations: params.timeline.operations,
        checkpoints: params.timeline.checkpoints
      }),
      operationCount: params.timeline.operations.length,
      checkpointCount: params.timeline.checkpoints.length,
      manifest: params.manifest,
      metadata: params.metadata
    };
    this.snapshots.push(snapshot);
    this.trim();
    this.save();
    return snapshot;
  }

  get(snapshotId: string): TaskSnapshot | undefined {
    return this.snapshots.find(s => s.id === snapshotId);
  }

  listByTask(taskId: string, limit: number = 100): TaskSnapshot[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 500);
    return this.snapshots
      .filter(s => s.taskId === taskId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, effectiveLimit);
  }

  markRestored(params: { snapshotId: string; actorId: string }): TaskSnapshot {
    const snapshot = this.get(params.snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot ${params.snapshotId} not found`);
    }
    snapshot.restoredAt = new Date().toISOString();
    snapshot.restoredBy = params.actorId;
    this.save();
    return snapshot;
  }

  private trim(): void {
    if (this.snapshots.length <= this.maxSnapshots) return;
    this.snapshots = this.snapshots.slice(this.snapshots.length - this.maxSnapshots);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SnapshotFile;
      this.snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
    } catch {
      this.snapshots = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: SnapshotFile = {
      version: 1,
      snapshots: this.snapshots
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

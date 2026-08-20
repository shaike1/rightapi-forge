import path from 'path';
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { Delegation, DelegationState, DelegationRiskLevel } from '../types/index.js';
import { logger } from '../utils/logger.js';

const ALLOWED_TRANSITIONS: Record<DelegationState, DelegationState[]> = {
  proposed: ['approved', 'rejected'],
  approved: ['dispatched', 'rejected'],
  dispatched: ['accepted', 'rejected'],
  accepted: ['completed', 'rejected'],
  rejected: [],
  completed: []
};

export class DelegationManager {
  private dbPath: string;
  private maxRecords: number;
  private delegations: Delegation[] = [];
  private db: Database.Database;

  constructor(filePath: string, maxRecords: number = 10000) {
    // Accept either the legacy JSON path or a .db path; always use SQLite
    this.dbPath = filePath.endsWith('.db') ? filePath : filePath.replace(/\.json$/, '.db');
    this.maxRecords = maxRecords;
    const dir = path.dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.load();
    logger.info(`[DelegationManager] SQLite store opened at ${this.dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        from_agent TEXT,
        to_agent TEXT,
        state TEXT,
        reason TEXT,
        created_at TEXT,
        updated_at TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_del_state      ON delegations(state);
      CREATE INDEX IF NOT EXISTS idx_del_from_agent ON delegations(from_agent);
      CREATE INDEX IF NOT EXISTS idx_del_to_agent   ON delegations(to_agent);
      CREATE INDEX IF NOT EXISTS idx_del_task_id    ON delegations(task_id);
    `);
  }

  create(params: {
    parentTaskId: string;
    childTaskId?: string;
    requesterAgentId: string;
    assigneeAgentId: string;
    objective: string;
    deadline?: string;
    riskLevel?: DelegationRiskLevel;
    metadata?: Record<string, unknown>;
    actorId?: string;
  }): Delegation {
    const now = new Date().toISOString();
    const delegation: Delegation = {
      id: uuidv4(),
      requestId: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parentTaskId: params.parentTaskId,
      childTaskId: params.childTaskId,
      requesterAgentId: params.requesterAgentId,
      assigneeAgentId: params.assigneeAgentId,
      objective: params.objective,
      deadline: params.deadline,
      riskLevel: params.riskLevel,
      state: 'proposed',
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata || {},
      history: [{
        state: 'proposed',
        actorId: params.actorId,
        timestamp: now,
        reason: 'Delegation proposed'
      }]
    };
    this.delegations.push(delegation);
    this.trim();
    this.upsert(delegation);
    return delegation;
  }

  linkChildTask(delegationId: string, childTaskId: string): Delegation {
    const delegation = this.get(delegationId);
    if (!delegation) throw new Error(`Delegation ${delegationId} not found`);
    delegation.childTaskId = childTaskId;
    delegation.updatedAt = new Date().toISOString();
    this.upsert(delegation);
    return delegation;
  }

  transition(params: {
    delegationId: string;
    nextState: DelegationState;
    actorId?: string;
    reason?: string;
  }): Delegation {
    const delegation = this.get(params.delegationId);
    if (!delegation) throw new Error(`Delegation ${params.delegationId} not found`);
    const allowed = ALLOWED_TRANSITIONS[delegation.state] || [];
    if (!allowed.includes(params.nextState)) {
      throw new Error(`Invalid delegation transition: ${delegation.state} -> ${params.nextState}`);
    }
    delegation.state = params.nextState;
    delegation.updatedAt = new Date().toISOString();
    delegation.history.push({
      state: params.nextState,
      actorId: params.actorId,
      timestamp: delegation.updatedAt,
      reason: params.reason
    });
    this.upsert(delegation);
    return delegation;
  }

  appendHistory(params: {
    delegationId: string;
    reason: string;
    actorId?: string;
  }): Delegation {
    const delegation = this.get(params.delegationId);
    if (!delegation) throw new Error(`Delegation ${params.delegationId} not found`);
    delegation.updatedAt = new Date().toISOString();
    delegation.history.push({
      state: delegation.state,
      actorId: params.actorId,
      timestamp: delegation.updatedAt,
      reason: params.reason
    });
    this.upsert(delegation);
    return delegation;
  }

  updateMetadata(params: {
    delegationId: string;
    metadata: Record<string, unknown>;
  }): Delegation {
    const delegation = this.get(params.delegationId);
    if (!delegation) throw new Error(`Delegation ${params.delegationId} not found`);
    delegation.metadata = {
      ...(delegation.metadata || {}),
      ...params.metadata
    };
    delegation.updatedAt = new Date().toISOString();
    this.upsert(delegation);
    return delegation;
  }

  get(delegationId: string): Delegation | undefined {
    return this.delegations.find(d => d.id === delegationId);
  }

  list(params?: { taskId?: string; state?: DelegationState; assigneeAgentId?: string; requesterAgentId?: string; limit?: number }): Delegation[] {
    const limit = Math.min(Math.max(params?.limit || 200, 1), 1000);
    return this.delegations
      .filter(d => {
        if (params?.taskId && d.parentTaskId !== params.taskId && d.childTaskId !== params.taskId) return false;
        if (params?.state && d.state !== params.state) return false;
        if (params?.assigneeAgentId && d.assigneeAgentId !== params.assigneeAgentId) return false;
        if (params?.requesterAgentId && d.requesterAgentId !== params.requesterAgentId) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit);
  }

  close(): void {
    this.db.close();
  }

  private trim(): void {
    if (this.delegations.length <= this.maxRecords) return;
    const toRemove = this.delegations.splice(0, this.delegations.length - this.maxRecords);
    const del = this.db.prepare('DELETE FROM delegations WHERE id = ?');
    const trimMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    trimMany(toRemove.map(d => d.id));
  }

  private load(): void {
    try {
      const rows = this.db.prepare('SELECT data FROM delegations ORDER BY created_at ASC').all() as { data: string }[];
      this.delegations = rows.map(r => JSON.parse(r.data) as Delegation);
    } catch {
      this.delegations = [];
    }
  }

  private upsert(delegation: Delegation): void {
    this.db.prepare(`
      INSERT INTO delegations (id, task_id, from_agent, to_agent, state, reason, created_at, updated_at, data)
      VALUES (@id, @task_id, @from_agent, @to_agent, @state, @reason, @created_at, @updated_at, @data)
      ON CONFLICT(id) DO UPDATE SET
        task_id    = excluded.task_id,
        from_agent = excluded.from_agent,
        to_agent   = excluded.to_agent,
        state      = excluded.state,
        reason     = excluded.reason,
        updated_at = excluded.updated_at,
        data       = excluded.data
    `).run({
      id:         delegation.id,
      task_id:    delegation.parentTaskId,
      from_agent: delegation.requesterAgentId,
      to_agent:   delegation.assigneeAgentId,
      state:      delegation.state,
      reason:     delegation.history[delegation.history.length - 1]?.reason ?? null,
      created_at: delegation.createdAt,
      updated_at: delegation.updatedAt,
      data:       JSON.stringify(delegation),
    });
  }
}


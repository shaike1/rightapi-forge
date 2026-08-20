// Activity Timeline Service for Mission Control - tracks all system events for audit trail

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type { ActivityEvent } from '../types/index.js';

export interface ActivityFilter {
  entityType?: ActivityEvent['entityType'];
  entityId?: string;
  actorType?: ActivityEvent['actorType'];
  actorId?: string;
  startDate?: Date;
  endDate?: Date;
  severity?: ActivityEvent['severity'];
  limit?: number;
  offset?: number;
}

export class ActivityTimelineService {
  private events: ActivityEvent[] = [];
  private dataPath: string;
  private maxEvents: number;
  private flushInterval: number;
  private flushTimer?: NodeJS.Timeout;

  constructor(dataPath: string = './data/activity-timeline.jsonl', options?: { maxEvents?: number; flushInterval?: number }) {
    this.dataPath = dataPath;
    this.maxEvents = options?.maxEvents || 10000;
    this.flushInterval = options?.flushInterval || 30000; // 30 seconds default

    this.ensureDataDir();
    this.load();
    this.startAutoFlush();
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private startAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }

  private stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // Record a new activity event
  record(event: Omit<ActivityEvent, 'id' | 'timestamp'>): ActivityEvent {
    const activityEvent: ActivityEvent = {
      id: uuidv4(),
      timestamp: new Date(),
      ...event
    };

    this.events.push(activityEvent);

    // Trim to max events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    // Immediately append to file for durability
    this.appendToFile(activityEvent);

    return activityEvent;
  }

  // Convenience methods for common event types

  recordTaskEvent(
    action: string,
    taskId: string,
    taskName: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>,
    severity?: ActivityEvent['severity']
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'task',
      entityId: taskId,
      entityName: taskName,
      action,
      description,
      metadata,
      severity
    });
  }

  recordAgentEvent(
    action: string,
    agentId: string,
    agentName: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'agent',
      entityId: agentId,
      entityName: agentName,
      action,
      description,
      metadata
    });
  }

  recordBoardEvent(
    action: string,
    boardId: string,
    boardName: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'board',
      entityId: boardId,
      entityName: boardName,
      action,
      description,
      metadata
    });
  }

  recordApprovalEvent(
    action: string,
    approvalId: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>,
    severity?: ActivityEvent['severity']
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'approval',
      entityId: approvalId,
      action,
      description,
      metadata,
      severity
    });
  }

  recordCredentialEvent(
    action: string,
    credentialId: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>,
    severity?: ActivityEvent['severity']
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'credential',
      entityId: credentialId,
      action,
      description,
      metadata,
      severity
    });
  }

  recordDelegationEvent(
    action: string,
    delegationId: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'delegation',
      entityId: delegationId,
      action,
      description,
      metadata
    });
  }

  recordPolicyEvent(
    action: string,
    policyId: string,
    policyName: string,
    actor: { type: 'agent' | 'user' | 'system'; id?: string; name?: string },
    description: string,
    metadata?: Record<string, unknown>,
    severity?: ActivityEvent['severity']
  ): ActivityEvent {
    return this.record({
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      entityType: 'policy',
      entityId: policyId,
      entityName: policyName,
      action,
      description,
      metadata,
      severity
    });
  }

  // Query events

  getAll(limit?: number, offset?: number): ActivityEvent[] {
    let result = [...this.events].reverse(); // Most recent first

    if (offset) {
      result = result.slice(offset);
    }
    if (limit) {
      result = result.slice(0, limit);
    }

    return result;
  }

  getByFilter(filter: ActivityFilter): ActivityEvent[] {
    let result = [...this.events].reverse();

    if (filter.entityType) {
      result = result.filter(e => e.entityType === filter.entityType);
    }
    if (filter.entityId) {
      result = result.filter(e => e.entityId === filter.entityId);
    }
    if (filter.actorType) {
      result = result.filter(e => e.actorType === filter.actorType);
    }
    if (filter.actorId) {
      result = result.filter(e => e.actorId === filter.actorId);
    }
    if (filter.startDate) {
      result = result.filter(e => e.timestamp >= filter.startDate!);
    }
    if (filter.endDate) {
      result = result.filter(e => e.timestamp <= filter.endDate!);
    }
    if (filter.severity) {
      result = result.filter(e => e.severity === filter.severity);
    }

    if (filter.offset) {
      result = result.slice(filter.offset);
    }
    if (filter.limit) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }

  getByEntity(entityType: ActivityEvent['entityType'], entityId: string, limit?: number): ActivityEvent[] {
    return this.getByFilter({ entityType, entityId, limit });
  }

  getByActor(actorType: ActivityEvent['actorType'], actorId?: string, limit?: number): ActivityEvent[] {
    return this.getByFilter({ actorType, actorId, limit });
  }

  getByDateRange(startDate: Date, endDate: Date, limit?: number): ActivityEvent[] {
    return this.getByFilter({ startDate, endDate, limit });
  }

  getBySeverity(severity: ActivityEvent['severity'], limit?: number): ActivityEvent[] {
    return this.getByFilter({ severity, limit });
  }

  // Get recent events by type
  getRecentByType(entityType: ActivityEvent['entityType'], limit: number = 50): ActivityEvent[] {
    return this.getByFilter({ entityType, limit });
  }

  // Get statistics
  getStats(days: number = 7): {
    totalEvents: number;
    byEntityType: Record<string, number>;
    byActorType: Record<string, number>;
    bySeverity: Record<string, number>;
    recentCount: number;
  } {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recentEvents = this.events.filter(e => e.timestamp >= cutoffDate);

    const byEntityType: Record<string, number> = {};
    const byActorType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const event of recentEvents) {
      byEntityType[event.entityType] = (byEntityType[event.entityType] || 0) + 1;
      byActorType[event.actorType] = (byActorType[event.actorType] || 0) + 1;
      if (event.severity) {
        bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
      }
    }

    return {
      totalEvents: this.events.length,
      byEntityType,
      byActorType,
      bySeverity,
      recentCount: recentEvents.length
    };
  }

  // Get timeline for a specific task (with related events)
  getTaskTimeline(taskId: string): {
    taskEvents: ActivityEvent[];
    relatedEvents: ActivityEvent[];
  } {
    const taskEvents = this.getByEntity('task', taskId);

    // Find related events (delegations, approvals related to this task)
    const relatedEventIds = new Set<string>();
    for (const event of taskEvents) {
      if (event.metadata?.delegationId) {
        relatedEventIds.add(event.metadata.delegationId as string);
      }
      if (event.metadata?.approvalId) {
        relatedEventIds.add(event.metadata.approvalId as string);
      }
    }

    const relatedEvents = this.events.filter(e =>
      relatedEventIds.has(e.entityId) ||
      (e.metadata?.taskId === taskId)
    );

    return {
      taskEvents,
      relatedEvents
    };
  }

  // Search events by text
  search(query: string, limit?: number): ActivityEvent[] {
    const lowerQuery = query.toLowerCase();
    let result = this.events.filter(e =>
      e.description.toLowerCase().includes(lowerQuery) ||
      e.action.toLowerCase().includes(lowerQuery) ||
      (e.entityName && e.entityName.toLowerCase().includes(lowerQuery)) ||
      (e.actorName && e.actorName.toLowerCase().includes(lowerQuery))
    );

    result = result.reverse();

    if (limit) {
      result = result.slice(0, limit);
    }

    return result;
  }

  // Persistence

  private appendToFile(event: ActivityEvent): void {
    try {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.dataPath, line, 'utf8');
    } catch (error) {
      logger.error('Failed to append activity event to file:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }

  private flush(): void {
    // Ensure all in-memory events are persisted
    // Since we append on every record, this is mainly a no-op
    // but can be used for compaction in the future
  }

  load(): boolean {
    if (!fs.existsSync(this.dataPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(this.dataPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);

      this.events = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          // Convert timestamp back to Date
          event.timestamp = new Date(event.timestamp);
          this.events.push(event);
        } catch (e) {
          logger.error('Failed to parse activity line:', { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
        }
      }

      // Trim to max events
      if (this.events.length > this.maxEvents) {
        this.events = this.events.slice(-this.maxEvents);
        this.compact();
      }

      return true;
    } catch (error) {
      logger.error('Failed to load activity timeline:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      return false;
    }
  }

  private compact(): void {
    // Rewrite the file with only current events
    try {
      const lines = this.events.map(e => JSON.stringify(e));
      fs.writeFileSync(this.dataPath, lines.join('\n') + '\n', 'utf8');
    } catch (error) {
      logger.error('Failed to compact activity timeline:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }

  // Clear old events
  clearOlderThan(days: number): number {
    const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const beforeCount = this.events.length;

    this.events = this.events.filter(e => e.timestamp >= cutoffDate);
    const removed = beforeCount - this.events.length;

    if (removed > 0) {
      this.compact();
    }

    return removed;
  }

  // Export/Import
  export(startDate?: Date, endDate?: Date): string {
    let events = this.events;

    if (startDate || endDate) {
      events = this.getByFilter({ startDate, endDate });
    }

    return JSON.stringify({
      version: 1,
      exportDate: new Date().toISOString(),
      eventCount: events.length,
      events
    }, null, 2);
  }

  // Cleanup
  destroy(): void {
    this.stopAutoFlush();
    this.flush();
  }
}

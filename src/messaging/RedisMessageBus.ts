// Redis-backed message bus.
//
// Same surface as AgentMessageBus, backed by ioredis primitives:
//   • Streams (XADD / XRANGE)         — message + delegation audit log
//   • Hashes  (HSET / HGETALL)         — per-delegation status records
//   • Pub/Sub (PUBLISH / SUBSCRIBE)    — real-time fan-out for live UI
//   • Lists   (LPUSH / LRANGE / LTRIM) — per-agent quick-recent-messages
//
// Why streams for the audit trail: streams are append-only, range-queryable,
// and have native MAXLEN trimming so the in-process JSON-file approach the
// in-memory bus uses doesn't have to manually bound itself.
//
// Connection-loss behaviour is delegated to ioredis' built-in retry strategy
// (default: exponential back-off with a 50-attempt cap). MessageBusFactory
// is the layer that decides whether to fall back to the in-memory bus.

import type Redis from 'ioredis';
import { logger } from '../utils/logger.js';
import type {
  MessageBus,
  AgentBusMessage,
  DelegationRecord,
  DelegationState,
} from './MessageBus.js';

const KEY = {
  // Hash of message metadata, indexed by message id.
  msgHash:    (id: string) => `bus:msg:${id}`,
  // Sorted set of message ids by timestamp — used for global queries.
  msgIndex:   () => `bus:msg:idx`,
  // Sorted-set indexes for fast filtering.
  threadIdx:  (threadId: string) => `bus:thread:${threadId}`,
  agentIdx:   (agentId: string) => `bus:agent:${agentId}`,
  taskIdx:    (taskId: string) => `bus:task:${taskId}`,
  roomIdx:    (roomId: string) => `bus:room:${roomId}`,
  // Set of all known thread / room ids.
  threadsAll: () => `bus:threads`,
  roomsAll:   () => `bus:rooms`,
  // Delegation hash (full record).
  delegHash:  (id: string) => `bus:deleg:${id}`,
  // Delegation index by created_at.
  delegIdx:   () => `bus:deleg:idx`,
  // Pub/Sub channel for live fan-out.
  liveChan:   () => `bus:live`,
};

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class RedisMessageBus implements MessageBus {
  /** Cap stored messages per index. Old entries are trimmed via ZREMRANGEBYRANK. */
  private maxMessagesPerIndex: number;

  constructor(private redis: Redis, opts: { maxMessagesPerIndex?: number } = {}) {
    this.maxMessagesPerIndex = opts.maxMessagesPerIndex ?? 10000;
  }

  createThreadId(): string {
    return `thread-${randomId()}`;
  }

  async send(params: {
    threadId?: string;
    roomId?: string;
    roomTopic?: string;
    taskId?: string;
    fromAgentId: string;
    toAgentId: string;
    content: string;
    kind?: AgentBusMessage['kind'];
  }): Promise<AgentBusMessage> {
    const message: AgentBusMessage = {
      id: randomId(),
      threadId: params.threadId || this.createThreadId(),
      roomId: params.roomId,
      roomTopic: params.roomTopic,
      taskId: params.taskId,
      fromAgentId: params.fromAgentId,
      toAgentId: params.toAgentId,
      content: params.content,
      timestamp: new Date().toISOString(),
      kind: params.kind || 'message',
      status: 'sent',
    };

    const ts = Date.parse(message.timestamp);
    const flat = serialiseMessage(message);

    // Pipelined write: all the index entries land in a single round-trip.
    const pipe = this.redis.pipeline();
    pipe.hmset(KEY.msgHash(message.id), flat);
    pipe.zadd(KEY.msgIndex(), ts, message.id);
    pipe.zadd(KEY.threadIdx(message.threadId), ts, message.id);
    pipe.zadd(KEY.agentIdx(message.fromAgentId), ts, message.id);
    pipe.zadd(KEY.agentIdx(message.toAgentId), ts, message.id);
    if (message.taskId) pipe.zadd(KEY.taskIdx(message.taskId), ts, message.id);
    if (message.roomId) {
      pipe.zadd(KEY.roomIdx(message.roomId), ts, message.id);
      pipe.sadd(KEY.roomsAll(), message.roomId);
    }
    pipe.sadd(KEY.threadsAll(), message.threadId);
    pipe.publish(KEY.liveChan(), JSON.stringify({ type: 'message', data: message }));
    await pipe.exec();

    // Trim the global index so memory doesn't grow unbounded.
    await this.redis.zremrangebyrank(KEY.msgIndex(), 0, -this.maxMessagesPerIndex - 1);

    return message;
  }

  async markStatus(
    id: string,
    status: AgentBusMessage['status'],
    error?: string,
  ): Promise<AgentBusMessage | null> {
    const exists = await this.redis.exists(KEY.msgHash(id));
    if (!exists) return null;
    const update: Record<string, string> = { status };
    if (error) update.error = error;
    await this.redis.hmset(KEY.msgHash(id), update);
    return this.getMessage(id);
  }

  async listMessages(params?: {
    threadId?: string;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<AgentBusMessage[]> {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 1000);
    let indexKey = KEY.msgIndex();
    if (params?.threadId) indexKey = KEY.threadIdx(params.threadId);
    else if (params?.taskId) indexKey = KEY.taskIdx(params.taskId);
    else if (params?.agentId) indexKey = KEY.agentIdx(params.agentId);

    // ZREVRANGE gets newest-first ids.
    const ids = await this.redis.zrevrange(indexKey, 0, limit - 1);
    if (ids.length === 0) return [];
    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hgetall(KEY.msgHash(id));
    const rows = await pipe.exec();
    const out: AgentBusMessage[] = [];
    for (const r of rows ?? []) {
      const flat = r?.[1] as Record<string, string> | null | undefined;
      if (flat && Object.keys(flat).length > 0) out.push(deserialiseMessage(flat));
    }
    return out;
  }

  async listThreads(params?: { agentId?: string; limit?: number }) {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 500);
    const threadIds = await this.redis.smembers(KEY.threadsAll());
    const map = new Map<string, {
      threadId: string;
      roomId?: string;
      roomTopic?: string;
      taskId?: string;
      lastMessageAt: string;
      participants: Set<string>;
      messageCount: number;
      lastStatus: AgentBusMessage['status'];
    }>();

    // Walk every thread index. For very large message counts this is slow;
    // the in-memory bus has the same characteristic so the tradeoff matches.
    for (const threadId of threadIds) {
      const ids = await this.redis.zrevrange(KEY.threadIdx(threadId), 0, -1);
      if (ids.length === 0) continue;
      const pipe = this.redis.pipeline();
      for (const id of ids) pipe.hgetall(KEY.msgHash(id));
      const rows = await pipe.exec();
      const messages = (rows ?? [])
        .map(r => deserialiseMessage((r?.[1] as Record<string, string>) || {}))
        .filter(m => m.id);
      if (params?.agentId) {
        const involved = messages.some(m => m.fromAgentId === params.agentId || m.toAgentId === params.agentId);
        if (!involved) continue;
      }
      const newest = messages[0];
      const entry = {
        threadId,
        roomId: newest.roomId,
        roomTopic: newest.roomTopic,
        taskId: newest.taskId,
        lastMessageAt: newest.timestamp,
        participants: new Set(messages.flatMap(m => [m.fromAgentId, m.toAgentId])),
        messageCount: messages.length,
        lastStatus: newest.status,
      };
      map.set(threadId, entry);
    }

    return Array.from(map.values())
      .map(t => ({
        threadId: t.threadId,
        roomId: t.roomId,
        roomTopic: t.roomTopic,
        taskId: t.taskId,
        lastMessageAt: t.lastMessageAt,
        participants: Array.from(t.participants.values()),
        messageCount: t.messageCount,
        lastStatus: t.lastStatus,
      }))
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
      .slice(0, limit);
  }

  async listRooms(params?: { limit?: number }) {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 500);
    const roomIds = await this.redis.smembers(KEY.roomsAll());
    const out = [];
    for (const roomId of roomIds) {
      const ids = await this.redis.zrevrange(KEY.roomIdx(roomId), 0, -1);
      if (ids.length === 0) continue;
      const pipe = this.redis.pipeline();
      for (const id of ids) pipe.hgetall(KEY.msgHash(id));
      const rows = await pipe.exec();
      const messages = (rows ?? [])
        .map(r => deserialiseMessage((r?.[1] as Record<string, string>) || {}))
        .filter(m => m.id);
      const newest = messages[0];
      out.push({
        roomId,
        roomTopic: newest.roomTopic,
        threadIds: Array.from(new Set(messages.map(m => m.threadId))),
        participantIds: Array.from(new Set(messages.flatMap(m => [m.fromAgentId, m.toAgentId]))),
        lastMessageAt: newest.timestamp,
        messageCount: messages.length,
      });
    }
    return out
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
      .slice(0, limit);
  }

  // ─── Delegation tracking ────────────────────────────────────────────────

  async delegateTask(input: {
    requesterAgentId: string;
    requesterAgentName?: string;
    assigneeAgentId: string;
    assigneeAgentName?: string;
    parentTaskId?: string;
    objective: string;
    context?: string;
  }): Promise<{ id: string; threadId: string }> {
    const id = `deleg-${randomId()}`;
    const threadId = this.createThreadId();

    // Drop the request message into the audit log — same shape as the
    // in-memory bus emits.
    await this.send({
      threadId,
      taskId: input.parentTaskId,
      fromAgentId: input.requesterAgentId,
      toAgentId: input.assigneeAgentId,
      content: this.formatRequestContent(input),
      kind: 'delegation_request',
    });

    const record: DelegationRecord = {
      id, threadId,
      parentTaskId: input.parentTaskId,
      requesterAgentId: input.requesterAgentId,
      requesterAgentName: input.requesterAgentName,
      assigneeAgentId: input.assigneeAgentId,
      assigneeAgentName: input.assigneeAgentName,
      objective: input.objective,
      context: input.context,
      state: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.redis.hmset(KEY.delegHash(id), serialiseDelegation(record));
    await this.redis.zadd(KEY.delegIdx(), Date.parse(record.createdAt), id);

    return { id, threadId };
  }

  async recordDelegationResult(id: string, result: {
    state: 'completed' | 'rejected';
    childTaskId?: string;
    summary?: string;
    error?: string;
    durationMs?: number;
  }): Promise<DelegationRecord | null> {
    const flat = await this.redis.hgetall(KEY.delegHash(id));
    if (!flat || Object.keys(flat).length === 0) return null;
    const record = deserialiseDelegation(flat);
    record.state = result.state;
    record.childTaskId = result.childTaskId;
    record.summary = result.summary;
    record.error = result.error;
    record.durationMs = result.durationMs;
    record.completedAt = new Date().toISOString();
    await this.redis.hmset(KEY.delegHash(id), serialiseDelegation(record));

    // Audit-log the response.
    await this.send({
      threadId: record.threadId,
      taskId: record.parentTaskId,
      fromAgentId: record.assigneeAgentId,
      toAgentId: record.requesterAgentId,
      content: this.formatResponseContent(record),
      kind: 'delegation_response',
    });

    return record;
  }

  async listDelegations(filter?: {
    id?: string;
    requesterAgentId?: string;
    assigneeAgentId?: string;
    state?: DelegationState;
    limit?: number;
  }): Promise<DelegationRecord[]> {
    const ids = filter?.id
      ? [filter.id]
      : await this.redis.zrevrange(KEY.delegIdx(), 0, -1);
    if (ids.length === 0) return [];

    const pipe = this.redis.pipeline();
    for (const id of ids) pipe.hgetall(KEY.delegHash(id));
    const rows = await pipe.exec();
    let records = (rows ?? [])
      .map(r => r?.[1] as Record<string, string> | null)
      .filter((r): r is Record<string, string> => !!r && Object.keys(r).length > 0)
      .map(deserialiseDelegation);

    if (filter?.requesterAgentId) records = records.filter(r => r.requesterAgentId === filter.requesterAgentId);
    if (filter?.assigneeAgentId)  records = records.filter(r => r.assigneeAgentId === filter.assigneeAgentId);
    if (filter?.state)            records = records.filter(r => r.state === filter.state);
    if (filter?.limit)            records = records.slice(0, filter.limit);
    return records;
  }

  async getDelegationStatsByAssignee(): Promise<Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }>> {
    const records = await this.listDelegations();
    const acc = new Map<string, { total: number; completed: number; rejected: number; durationSum: number; durationCount: number }>();
    for (const d of records) {
      const e = acc.get(d.assigneeAgentId) ?? { total: 0, completed: 0, rejected: 0, durationSum: 0, durationCount: 0 };
      e.total++;
      if (d.state === 'completed') e.completed++;
      if (d.state === 'rejected') e.rejected++;
      if (typeof d.durationMs === 'number') {
        e.durationSum += d.durationMs;
        e.durationCount++;
      }
      acc.set(d.assigneeAgentId, e);
    }
    const out = new Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }>();
    for (const [k, v] of acc) {
      out.set(k, {
        total: v.total, completed: v.completed, rejected: v.rejected,
        avgDurationMs: v.durationCount > 0 ? v.durationSum / v.durationCount : 0,
      });
    }
    return out;
  }

  async close(): Promise<void> {
    try { await this.redis.quit(); } catch { /* */ }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async getMessage(id: string): Promise<AgentBusMessage | null> {
    const flat = await this.redis.hgetall(KEY.msgHash(id));
    if (!flat || Object.keys(flat).length === 0) return null;
    return deserialiseMessage(flat);
  }

  private formatRequestContent(input: {
    requesterAgentName?: string;
    assigneeAgentName?: string;
    objective: string;
    context?: string;
  }): string {
    const lines = [`[delegation_request] ${input.requesterAgentName ?? 'agent'} → ${input.assigneeAgentName ?? 'agent'}: ${input.objective}`];
    if (input.context) lines.push(`context: ${input.context.slice(0, 500)}`);
    return lines.join('\n');
  }

  private formatResponseContent(record: DelegationRecord): string {
    const verb = record.state === 'completed' ? 'completed' : 'rejected';
    const dur = record.durationMs ? ` in ${Math.round(record.durationMs / 1000)}s` : '';
    if (record.state === 'completed') {
      return `[delegation_response] ${record.assigneeAgentName ?? 'agent'} ${verb}${dur}: ${(record.summary ?? '').slice(0, 500)}`;
    }
    return `[delegation_response] ${record.assigneeAgentName ?? 'agent'} ${verb}${dur}: ${(record.error ?? 'unknown error').slice(0, 500)}`;
  }
}

// ─── Serialisation helpers ──────────────────────────────────────────────────
//
// Redis hashes store flat string maps. We round-trip JS objects through
// JSON for the values that aren't already primitive strings.

function serialiseMessage(m: AgentBusMessage): Record<string, string> {
  const out: Record<string, string> = {
    id: m.id,
    threadId: m.threadId,
    fromAgentId: m.fromAgentId,
    toAgentId: m.toAgentId,
    content: m.content,
    timestamp: m.timestamp,
    kind: m.kind,
    status: m.status,
  };
  if (m.roomId)    out.roomId = m.roomId;
  if (m.roomTopic) out.roomTopic = m.roomTopic;
  if (m.taskId)    out.taskId = m.taskId;
  if (m.error)     out.error = m.error;
  return out;
}

function deserialiseMessage(flat: Record<string, string>): AgentBusMessage {
  return {
    id: flat.id,
    threadId: flat.threadId,
    roomId: flat.roomId,
    roomTopic: flat.roomTopic,
    taskId: flat.taskId,
    fromAgentId: flat.fromAgentId,
    toAgentId: flat.toAgentId,
    content: flat.content,
    timestamp: flat.timestamp,
    kind: (flat.kind as AgentBusMessage['kind']) ?? 'message',
    status: (flat.status as AgentBusMessage['status']) ?? 'sent',
    error: flat.error,
  };
}

function serialiseDelegation(d: DelegationRecord): Record<string, string> {
  const out: Record<string, string> = {
    id: d.id, threadId: d.threadId,
    requesterAgentId: d.requesterAgentId,
    assigneeAgentId: d.assigneeAgentId,
    objective: d.objective,
    state: d.state,
    createdAt: d.createdAt,
  };
  if (d.parentTaskId)        out.parentTaskId = d.parentTaskId;
  if (d.requesterAgentName)  out.requesterAgentName = d.requesterAgentName;
  if (d.assigneeAgentName)   out.assigneeAgentName = d.assigneeAgentName;
  if (d.context)             out.context = d.context;
  if (d.childTaskId)         out.childTaskId = d.childTaskId;
  if (d.completedAt)         out.completedAt = d.completedAt;
  if (typeof d.durationMs === 'number') out.durationMs = String(d.durationMs);
  if (d.summary)             out.summary = d.summary;
  if (d.error)               out.error = d.error;
  return out;
}

function deserialiseDelegation(flat: Record<string, string>): DelegationRecord {
  return {
    id: flat.id,
    threadId: flat.threadId,
    parentTaskId: flat.parentTaskId,
    requesterAgentId: flat.requesterAgentId,
    requesterAgentName: flat.requesterAgentName,
    assigneeAgentId: flat.assigneeAgentId,
    assigneeAgentName: flat.assigneeAgentName,
    objective: flat.objective,
    context: flat.context,
    state: flat.state as DelegationState,
    createdAt: flat.createdAt,
    completedAt: flat.completedAt,
    durationMs: flat.durationMs ? Number(flat.durationMs) : undefined,
    summary: flat.summary,
    error: flat.error,
    childTaskId: flat.childTaskId,
  };
}

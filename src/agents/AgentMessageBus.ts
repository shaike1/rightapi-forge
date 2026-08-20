import fs from 'fs';
import path from 'path';

export interface AgentBusMessage {
  id: string;
  threadId: string;
  roomId?: string;
  roomTopic?: string;
  taskId?: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  timestamp: string;
  kind: 'message' | 'reply' | 'system' | 'delegation_request' | 'delegation_response';
  status: 'sent' | 'delivered' | 'processed' | 'failed';
  error?: string;
}

export type DelegationState = 'pending' | 'completed' | 'rejected';

export interface DelegationRecord {
  id: string;
  threadId: string;
  parentTaskId?: string;
  childTaskId?: string;
  requesterAgentId: string;
  requesterAgentName?: string;
  assigneeAgentId: string;
  assigneeAgentName?: string;
  objective: string;
  context?: string;
  state: DelegationState;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
}

interface BusFile {
  version: number;
  messages: AgentBusMessage[];
  delegations?: DelegationRecord[];
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class AgentMessageBus {
  private filePath: string;
  private maxMessages: number;
  private messages: AgentBusMessage[] = [];
  private delegations: DelegationRecord[] = [];

  constructor(filePath: string, maxMessages: number = 10000) {
    this.filePath = filePath;
    this.maxMessages = maxMessages;
    this.load();
  }

  createThreadId(): string {
    return `thread-${randomId()}`;
  }

  send(params: {
    threadId?: string;
    roomId?: string;
    roomTopic?: string;
    taskId?: string;
    fromAgentId: string;
    toAgentId: string;
    content: string;
    kind?: AgentBusMessage['kind'];
  }): AgentBusMessage {
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
      status: 'sent'
    };
    this.messages.push(message);
    this.trim();
    this.save();
    return message;
  }

  markStatus(id: string, status: AgentBusMessage['status'], error?: string): AgentBusMessage | null {
    const message = this.messages.find(m => m.id === id);
    if (!message) return null;
    message.status = status;
    if (error) message.error = error;
    this.save();
    return message;
  }

  listMessages(params?: { threadId?: string; taskId?: string; agentId?: string; limit?: number }): AgentBusMessage[] {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 1000);
    let filtered = [...this.messages];
    if (params?.threadId) {
      filtered = filtered.filter(m => m.threadId === params.threadId);
    }
    if (params?.taskId) {
      filtered = filtered.filter(m => m.taskId === params.taskId);
    }
    if (params?.agentId) {
      filtered = filtered.filter(m => m.fromAgentId === params.agentId || m.toAgentId === params.agentId);
    }
    return filtered
      .map((message, index) => ({ message, index }))
      .sort((a, b) => Date.parse(b.message.timestamp) - Date.parse(a.message.timestamp) || b.index - a.index)
      .map(({ message }) => message)
      .slice(0, limit);
  }

  listThreads(params?: { agentId?: string; limit?: number }): Array<{
    threadId: string;
    roomId?: string;
    roomTopic?: string;
    taskId?: string;
    lastMessageAt: string;
    participants: string[];
    messageCount: number;
    lastStatus: AgentBusMessage['status'];
  }> {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 500);
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

    for (const msg of this.messages) {
      if (params?.agentId && msg.fromAgentId !== params.agentId && msg.toAgentId !== params.agentId) {
        continue;
      }
      const current = map.get(msg.threadId) || {
        threadId: msg.threadId,
        roomId: msg.roomId,
        roomTopic: msg.roomTopic,
        taskId: msg.taskId,
        lastMessageAt: msg.timestamp,
        participants: new Set<string>(),
        messageCount: 0,
        lastStatus: msg.status
      };
      current.messageCount += 1;
      current.participants.add(msg.fromAgentId);
      current.participants.add(msg.toAgentId);
      if (Date.parse(msg.timestamp) >= Date.parse(current.lastMessageAt)) {
        current.lastMessageAt = msg.timestamp;
        current.roomId = msg.roomId || current.roomId;
        current.roomTopic = msg.roomTopic || current.roomTopic;
        current.taskId = msg.taskId || current.taskId;
        current.lastStatus = msg.status;
      }
      map.set(msg.threadId, current);
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
        lastStatus: t.lastStatus
      }))
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
      .slice(0, limit);
  }

  listRooms(params?: { limit?: number }): Array<{
    roomId: string;
    roomTopic?: string;
    threadIds: string[];
    participantIds: string[];
    lastMessageAt: string;
    messageCount: number;
  }> {
    const limit = Math.min(Math.max(params?.limit || 100, 1), 500);
    const map = new Map<string, {
      roomId: string;
      roomTopic?: string;
      threadIds: Set<string>;
      participantIds: Set<string>;
      lastMessageAt: string;
      messageCount: number;
    }>();

    for (const msg of this.messages) {
      if (!msg.roomId) continue;
      const existing = map.get(msg.roomId) || {
        roomId: msg.roomId,
        roomTopic: msg.roomTopic,
        threadIds: new Set<string>(),
        participantIds: new Set<string>(),
        lastMessageAt: msg.timestamp,
        messageCount: 0
      };
      existing.threadIds.add(msg.threadId);
      existing.participantIds.add(msg.fromAgentId);
      existing.participantIds.add(msg.toAgentId);
      existing.messageCount += 1;
      if (Date.parse(msg.timestamp) >= Date.parse(existing.lastMessageAt)) {
        existing.lastMessageAt = msg.timestamp;
        existing.roomTopic = msg.roomTopic || existing.roomTopic;
      }
      map.set(msg.roomId, existing);
    }

    return Array.from(map.values())
      .map(room => ({
        roomId: room.roomId,
        roomTopic: room.roomTopic,
        threadIds: Array.from(room.threadIds.values()),
        participantIds: Array.from(room.participantIds.values()),
        lastMessageAt: room.lastMessageAt,
        messageCount: room.messageCount
      }))
      .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
      .slice(0, limit);
  }

  private trim(): void {
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(this.messages.length - this.maxMessages);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as BusFile;
      this.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      this.delegations = Array.isArray(parsed.delegations) ? parsed.delegations : [];
    } catch {
      this.messages = [];
      this.delegations = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: BusFile = {
      version: 1,
      messages: this.messages,
      delegations: this.delegations,
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  // ─── Delegation tracking ──────────────────────────────────────────────────

  /**
   * Record the start of a delegation: who's asking whom for what. Posts a
   * `delegation_request` message into the conversation thread so the same
   * audit trail viewer that shows messages also shows delegations, then
   * stores a structured DelegationRecord for `listDelegations`.
   *
   * Returns { id, threadId } so the caller can later call
   * recordDelegationResult(id, …) when the assignee finishes.
   */
  delegateTask(input: {
    requesterAgentId: string;
    requesterAgentName?: string;
    assigneeAgentId: string;
    assigneeAgentName?: string;
    parentTaskId?: string;
    objective: string;
    context?: string;
  }): { id: string; threadId: string } {
    const id = `deleg-${randomId()}`;
    const threadId = this.createThreadId();

    const requestMessage: AgentBusMessage = {
      id: randomId(),
      threadId,
      taskId: input.parentTaskId,
      fromAgentId: input.requesterAgentId,
      toAgentId: input.assigneeAgentId,
      content: this.formatRequestContent(input),
      timestamp: new Date().toISOString(),
      kind: 'delegation_request',
      status: 'sent',
    };
    this.messages.push(requestMessage);

    const record: DelegationRecord = {
      id,
      threadId,
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
    this.delegations.push(record);

    this.trim();
    this.save();
    return { id, threadId };
  }

  /**
   * Close out a previously-opened delegation. Posts a `delegation_response`
   * message into the same thread (so the conversation view shows request +
   * answer side-by-side) and updates the structured record.
   */
  recordDelegationResult(id: string, result: {
    state: 'completed' | 'rejected';
    childTaskId?: string;
    summary?: string;
    error?: string;
    durationMs?: number;
  }): DelegationRecord | null {
    const record = this.delegations.find(d => d.id === id);
    if (!record) return null;

    record.state = result.state;
    record.childTaskId = result.childTaskId;
    record.summary = result.summary;
    record.error = result.error;
    record.durationMs = result.durationMs;
    record.completedAt = new Date().toISOString();

    const responseMessage: AgentBusMessage = {
      id: randomId(),
      threadId: record.threadId,
      taskId: record.parentTaskId,
      fromAgentId: record.assigneeAgentId,
      toAgentId: record.requesterAgentId,
      content: this.formatResponseContent(record),
      timestamp: new Date().toISOString(),
      kind: 'delegation_response',
      status: result.state === 'completed' ? 'processed' : 'failed',
      error: result.error,
    };
    this.messages.push(responseMessage);

    this.trim();
    this.save();
    return record;
  }

  /** List delegation records, optionally filtered. Newest first. */
  listDelegations(filter?: {
    id?: string;
    requesterAgentId?: string;
    assigneeAgentId?: string;
    state?: DelegationState;
    limit?: number;
  }): DelegationRecord[] {
    let out = [...this.delegations];
    if (filter?.id) out = out.filter(d => d.id === filter.id);
    if (filter?.requesterAgentId) out = out.filter(d => d.requesterAgentId === filter.requesterAgentId);
    if (filter?.assigneeAgentId) out = out.filter(d => d.assigneeAgentId === filter.assigneeAgentId);
    if (filter?.state) out = out.filter(d => d.state === filter.state);
    out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (filter?.limit) out = out.slice(0, filter.limit);
    return out;
  }

  /** Stats by assignee — used by smart routing to score past success rate. */
  getDelegationStatsByAssignee(): Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }> {
    const map = new Map<string, { total: number; completed: number; rejected: number; durationSum: number; durationCount: number }>();
    for (const d of this.delegations) {
      const e = map.get(d.assigneeAgentId) ?? { total: 0, completed: 0, rejected: 0, durationSum: 0, durationCount: 0 };
      e.total++;
      if (d.state === 'completed') e.completed++;
      if (d.state === 'rejected') e.rejected++;
      if (typeof d.durationMs === 'number') {
        e.durationSum += d.durationMs;
        e.durationCount++;
      }
      map.set(d.assigneeAgentId, e);
    }
    const result = new Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }>();
    for (const [k, v] of map.entries()) {
      result.set(k, {
        total: v.total,
        completed: v.completed,
        rejected: v.rejected,
        avgDurationMs: v.durationCount > 0 ? v.durationSum / v.durationCount : 0,
      });
    }
    return result;
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

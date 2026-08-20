// Shared MessageBus contract.
//
// AgentMessageBus (in-memory + JSON file) and RedisMessageBus (production)
// both satisfy this interface. MessageBusFactory hands back whichever the
// operator picked via MESSAGE_BUS — existing call-sites import from here
// instead of binding to a concrete class.
//
// Methods are typed as "T | Promise<T>" so the synchronous in-memory path
// keeps working while the async Redis path slots in. Awaiting either
// works correctly.

import type { AgentBusMessage, DelegationRecord, DelegationState } from '../agents/index.js';

export type { AgentBusMessage, DelegationRecord, DelegationState };

export interface MessageBus {
  // Threads + low-level messages -----------------------------------------
  createThreadId(): string;
  send(params: {
    threadId?: string;
    roomId?: string;
    roomTopic?: string;
    taskId?: string;
    fromAgentId: string;
    toAgentId: string;
    content: string;
    kind?: AgentBusMessage['kind'];
  }): AgentBusMessage | Promise<AgentBusMessage>;
  markStatus(
    id: string,
    status: AgentBusMessage['status'],
    error?: string
  ): AgentBusMessage | null | Promise<AgentBusMessage | null>;
  listMessages(params?: {
    threadId?: string;
    taskId?: string;
    agentId?: string;
    limit?: number;
  }): AgentBusMessage[] | Promise<AgentBusMessage[]>;
  listThreads(params?: { agentId?: string; limit?: number }):
    | Array<{
        threadId: string;
        roomId?: string;
        roomTopic?: string;
        taskId?: string;
        lastMessageAt: string;
        participants: string[];
        messageCount: number;
        lastStatus: AgentBusMessage['status'];
      }>
    | Promise<Array<{
        threadId: string;
        roomId?: string;
        roomTopic?: string;
        taskId?: string;
        lastMessageAt: string;
        participants: string[];
        messageCount: number;
        lastStatus: AgentBusMessage['status'];
      }>>;
  listRooms(params?: { limit?: number }):
    | Array<{
        roomId: string;
        roomTopic?: string;
        threadIds: string[];
        participantIds: string[];
        lastMessageAt: string;
        messageCount: number;
      }>
    | Promise<Array<{
        roomId: string;
        roomTopic?: string;
        threadIds: string[];
        participantIds: string[];
        lastMessageAt: string;
        messageCount: number;
      }>>;

  // Delegation tracking --------------------------------------------------
  delegateTask(input: {
    requesterAgentId: string;
    requesterAgentName?: string;
    assigneeAgentId: string;
    assigneeAgentName?: string;
    parentTaskId?: string;
    objective: string;
    context?: string;
  }): { id: string; threadId: string } | Promise<{ id: string; threadId: string }>;
  recordDelegationResult(id: string, result: {
    state: 'completed' | 'rejected';
    childTaskId?: string;
    summary?: string;
    error?: string;
    durationMs?: number;
  }): DelegationRecord | null | Promise<DelegationRecord | null>;
  listDelegations(filter?: {
    id?: string;
    requesterAgentId?: string;
    assigneeAgentId?: string;
    state?: DelegationState;
    limit?: number;
  }): DelegationRecord[] | Promise<DelegationRecord[]>;
  getDelegationStatsByAssignee():
    | Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }>
    | Promise<Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }>>;

  // Lifecycle ------------------------------------------------------------
  close?(): void | Promise<void>;
}

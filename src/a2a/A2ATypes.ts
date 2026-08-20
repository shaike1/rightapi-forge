/**
 * A2A (Agent-to-Agent) Protocol Types
 * Based on Google A2A specification (https://google.github.io/A2A)
 * Phase 1: Agent Card discovery
 * Phase 2: Task execution (POST /a2a/agents/:id/tasks)
 */

// ─── Agent Card ───────────────────────────────────────────────────────────────

export interface A2AProvider {
  organization: string;
  url: string;
}

export interface A2ACapabilities {
  /** Whether the agent supports SSE streaming on task responses */
  streaming: boolean;
  /** Whether the agent supports push notifications via webhook */
  pushNotifications: boolean;
  /** Whether the agent preserves full task state transition history */
  stateTransitionHistory: boolean;
}

export interface A2AAuthentication {
  /** Supported auth schemes, e.g. ["Bearer"] */
  schemes: string[];
  /** Optional credential hint (e.g. URL to obtain token) */
  credentials?: string;
}

export interface A2ASkillCard {
  /** Unique skill identifier within this agent */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** What this skill does */
  description: string;
  /** Domain tags, e.g. ["monitoring", "infrastructure"] */
  tags: string[];
  /** Example invocations or command names */
  examples: string[];
  /** Accepted input MIME types */
  inputModes?: string[];
  /** Produced output MIME types */
  outputModes?: string[];
}

export interface A2AAgentCard {
  /** Display name of the agent */
  name: string;
  /** What this agent does and its role */
  description: string;
  /** Base URL for this agent's A2A task endpoint (Phase 2) */
  url: string;
  provider: A2AProvider;
  /** Semantic version of the agent */
  version: string;
  documentationUrl?: string;
  capabilities: A2ACapabilities;
  authentication: A2AAuthentication;
  /** Accepted input content types */
  defaultInputModes: string[];
  /** Produced output content types */
  defaultOutputModes: string[];
  /** Skills this agent can perform */
  skills: A2ASkillCard[];
  /** Platform-specific metadata */
  metadata?: Record<string, unknown>;
}

/** System-level agent card — represents the entire platform */
export interface A2ASystemCard extends A2AAgentCard {
  /** All individual agent cards in this platform */
  agents: A2AAgentCard[];
  /** Total skill count across all agents */
  totalSkills: number;
  /** Total agent count */
  totalAgents: number;
  /** Protocol version implemented */
  protocol: string;
}

// ─── Task Execution (Phase 2) ─────────────────────────────────────────────────

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface A2ATextPart {
  type: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface A2ADataPart {
  type: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart | A2ADataPart;

export interface A2AMessage {
  role: 'user' | 'agent';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2ATask {
  id: string;
  sessionId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

// ─── JSON-RPC 2.0 envelope (A2A uses JSON-RPC) ───────────────────────────────

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

export interface A2AJsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─── tasks/send params ────────────────────────────────────────────────────────

export interface A2ATaskSendParams {
  id: string;
  sessionId?: string;
  message: A2AMessage;
  historyLength?: number;
  pushNotification?: {
    url: string;
    headers?: Record<string, string>;
  };
  metadata?: Record<string, unknown>;
}

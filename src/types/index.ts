// Core type definitions for RightAPI Forge

export type AIPlatform = 'claude' | 'openai' | 'ollama' | 'moonshot' | 'glm' | 'minimax';

export type AgentRole = 'director' | 'sysadmin' | 'specialist' | 'manager' | 'individual';

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'dropped'
  | 'rolling_back'
  | 'rolled_back';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export type SkillCategory = 'infrastructure' | 'monitoring' | 'deployment' | 'security' | 'microsoft365' | 'service-management' | 'general';

export interface AICredentials {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ollamaBaseUrl?: string;
}

// Agent SOUL interface
export interface AgentSOUL {
  id: string;
  name: string;
  role: AgentRole;
  personality: {
    tone: 'formal' | 'casual' | 'technical' | 'friendly';
    verbose: boolean;
    emoji: boolean;
  };
  communication: {
    primaryLanguage: 'en' | 'he';
    fallbackLanguage?: 'en' | 'he';
    escalationPhrases: string[];
  };
  capabilities: {
    maxConcurrentTasks: number;
    timeoutMinutes: number;
    canEscalate: boolean;
    canDelegate: boolean;
    autoRetry: boolean;
  };
  skills: string[];
  boundaries: {
    deniedCommands: string[];
    maxFileSize: number;
    allowedNetworks: string[];
  };
  customSystemPrompt?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  role: AgentRole;
  reportsTo?: string; // Agent ID of the manager
  scope?: string[];
  aiPlatform: AIPlatform;
  model?: string;
  systemPrompt?: string;
  soul?: AgentSOUL; // Agent personality and configuration
  skills: string[];
  /** Optional per-agent guardrail overrides (token/duration/iteration/etc).
   *  Missing fields fall through to role defaults from Guardrails.ts. */
  guardrails?: {
    maxIterations?: number;
    maxTokensPerTask?: number;
    maxDurationMs?: number;
    maxToolCallsPerTask?: number;
    maxDelegationDepth?: number;
    maxConcurrentTasks?: number;
    costBudgetUsd?: number;
  };
  createdAt: Date;
  status: 'active' | 'inactive';
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  ownerId: string; // Agent who owns/created the task
  projectId?: string;
  assignedTo?: string; // Agent assigned to execute
  category: SkillCategory;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  dependencies?: string[]; // Task IDs
  parentTaskId?: string;
  childTaskIds?: string[];
  result?: string;
  error?: string;
  cancellationReason?: string;
  dropReason?: string;
  operations?: TaskOperation[];
  rollbackCheckpoints?: TaskRollbackCheckpoint[];
}

export type DelegationState =
  | 'proposed'
  | 'approved'
  | 'dispatched'
  | 'accepted'
  | 'rejected'
  | 'completed';

export type DelegationRiskLevel = 'low' | 'medium' | 'high';

export interface Delegation {
  id: string;
  requestId: string;
  parentTaskId: string;
  childTaskId?: string;
  requesterAgentId: string;
  assigneeAgentId: string;
  objective: string;
  deadline?: string;
  riskLevel?: DelegationRiskLevel;
  state: DelegationState;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  history: Array<{
    state: DelegationState;
    actorId?: string;
    timestamp: string;
    reason?: string;
  }>;
}

export type RollbackImpactClass =
  | 'infrastructure'
  | 'deployment'
  | 'security'
  | 'data'
  | 'communication'
  | 'task_state'
  | 'unknown';

export interface TaskOperation {
  id: string;
  timestamp: Date;
  actorId?: string;
  actorType: 'agent' | 'user' | 'system';
  type: 'note' | 'status_change' | 'execution' | 'rollback' | 'cancel' | 'drop';
  summary: string;
  details?: string;
  status: 'recorded' | 'success' | 'failed';
}

export interface TaskRollbackCheckpoint {
  id: string;
  timestamp: Date;
  label: string;
  rollbackPlan: string;
  operationId?: string;
  impactClasses?: RollbackImpactClass[];
  required?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentId?: string;
}

export interface Session {
  id: string;
  projectId: string;
  projectPath?: string;
  messages: Message[];
  activeAgents: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  commands: Command[];
  installPath?: string;
  enabled: boolean;
}

export interface Command {
  name: string;
  description: string;
  handler: string;
  parameters?: Record<string, unknown>;
}

export interface Organization {
  name: string;
  director: AgentConfig;
  sysadmins: AgentConfig[];
  specialists: AgentConfig[];
  createdAt: Date;
}

export interface AIResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface InfrastructureConfig {
  platform: 'docker' | 'kubernetes' | 'aws' | 'azure' | 'gcp' | 'local';
  credentials?: Record<string, unknown>;
  endpoints?: Record<string, string>;
}

export interface DeploymentConfig {
  name: string;
  environment: 'dev' | 'staging' | 'production';
  strategy: 'rolling' | 'blue_green' | 'canary';
  healthCheck?: string;
  rollbackOnFailure: boolean;
}

export interface MonitoringAlert {
  id: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  source: string;
  message: string;
  timestamp: Date;
  resolved: boolean;
  assignedTo?: string;
}

export interface ExecutionContext {
  sessionId: string;
  projectId: string;
  workspace: string;
  environment: Record<string, string>;
}

// Mission Control inspired types for enhanced work orchestration

export type BoardStatus = 'active' | 'archived' | 'locked';
export type BoardGroupStatus = 'active' | 'archived';

export interface Board {
  id: string;
  name: string;
  description?: string;
  groupId?: string; // BoardGroup this board belongs to
  status: BoardStatus;
  taskIds: string[];
  tags: string[];
  ownerId: string; // Agent who owns/created the board
  createdAt: Date;
  updatedAt: Date;
  settings?: {
    requireApprovalForCriticalTasks?: boolean;
    autoAssignToSpecialists?: boolean;
    maxConcurrentTasks?: number;
  };
}

export interface BoardGroup {
  id: string;
  name: string;
  description?: string;
  organizationName: string;
  status: BoardGroupStatus;
  boardIds: string[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ActivityEvent {
  id: string;
  timestamp: Date;
  actorType: 'agent' | 'user' | 'system';
  actorId?: string;
  actorName?: string;
  entityType: 'task' | 'agent' | 'board' | 'delegation' | 'approval' | 'credential' | 'policy';
  entityId: string;
  entityName?: string;
  action: string;
  description: string;
  metadata?: Record<string, unknown>;
  severity?: 'info' | 'warning' | 'error' | 'critical';
}

export interface ApprovalFlow {
  id: string;
  entityType: 'task' | 'delegation' | 'credential' | 'policy';
  entityId: string;
  title: string;
  description: string;
  requestedBy: string;
  requestedAt: Date;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approvers: Array<{
    userId: string;
    decision?: 'approved' | 'rejected';
    decisionAt?: Date;
    comment?: string;
  }>;
  requiredApprovals: number;
  metadata?: Record<string, unknown>;
}

export interface GatewayConfig {
  id: string;
  name: string;
  type: 'local' | 'remote' | 'distributed';
  endpoint?: string;
  status: 'connected' | 'disconnected' | 'degraded';
  capabilities: string[];
  agentIds: string[];
  lastHeartbeat?: Date;
  metadata?: Record<string, unknown>;
}

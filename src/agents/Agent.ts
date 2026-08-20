// Core Agent class

import { v4 as uuidv4 } from 'uuid';
import type { AgentConfig, Message, ExecutionContext, AIPlatform, Task } from '../types/index.js';
import { AIProviderFactory } from '../ai/factory.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { SqliteAgentMemoryStore } from '../persistence/SqliteStore.js';
import { SelfReflector } from './SelfReflection.js';
import type { ReflectionResult } from './SelfReflection.js';
import {
  GuardrailRunner,
  ConcurrencyLimiter,
  resolveGuardrails,
  type GuardrailConfig,
  type LimitType,
} from './Guardrails.js';
import { RollbackRegistry, type RollbackAction } from './RollbackRegistry.js';
import { UsageTracker } from './UsageTracker.js';
import { startSpan, endSpan, withSpan, SpanKind } from '../observability/Telemetry.js';
import { createLogger } from '../observability/Logger.js';
import { trace as otelTrace, context as otelContext } from '@opentelemetry/api';

const agentLog = createLogger({ component: 'agent' });

const MAX_TOOL_ITERATIONS = 10;

export interface ReactStep {
  iteration: number;
  thought?: string;
  tool?: string;
  params?: unknown;
  observation?: string;
  error?: string;
  durationMs: number;
}

export interface ExecuteTaskOptions {
  /** Max observe→reason→act iterations before forced termination. Default 10. */
  maxIterations?: number;
  /** Optional callback fired after every loop iteration. */
  onStep?: (step: ReactStep) => void;
  /** Optional callback fired with each raw model response (back-compat). */
  onProgress?: (msg: string) => void;
  /** Current delegation depth — set by DelegationSkill when invoking a target
   *  agent's executeTaskDetailed. Forwarded to every skill call so the
   *  delegation chain can refuse to recurse past a configured maximum. */
  delegationDepth?: number;
}

export interface ExecuteTaskResult {
  result: string;
  outcome: 'success' | 'partial' | 'failed';
  iterations: number;
  steps: ReactStep[];
  durationMs: number;
  /** True when the loop stopped because a guardrail tripped. The accompanying
   *  `limitReason` and `limitType` fields name what fired. */
  limitReached?: boolean;
  limitType?: LimitType;
  limitReason?: string;
  /** Snapshot of guardrail counters at task end — total tokens, tool calls,
   *  estimated cost. Always populated when guardrails ran. */
  usage?: {
    totalTokens: number;
    toolCalls: number;
    estimatedCostUsd: number;
  };
  /** Reversible-action recipes any state-changing skill registered during
   *  this task. Empty array if no skill called registerRollback. The caller
   *  can pass this to RollbackSkill or RollbackRegistry.executeAll() to
   *  unwind on failure. */
  rollbacks?: RollbackAction[];
}

/** Concurrency limiter shared across all Agent instances in the process.
 *  Per-agent counts are namespaced by agent id inside the limiter. */
const concurrencyLimiter = new ConcurrencyLimiter();

export class Agent {
  private static platformFailures: Map<AIPlatform, { at: number; error: string }> = new Map();

  static markPlatformFailure(platform: AIPlatform, error: string): void {
    Agent.platformFailures.set(platform, { at: Date.now(), error });
  }

  static clearPlatformFailure(platform: AIPlatform): void {
    Agent.platformFailures.delete(platform);
  }

  static getPlatformFailure(platform: AIPlatform): { at: number; error: string } | null {
    return Agent.platformFailures.get(platform) ?? null;
  }

  static isPlatformDegraded(platform: AIPlatform, windowMs = 5 * 60_000): boolean {
    const failure = Agent.platformFailures.get(platform);
    return !!failure && Date.now() - failure.at < windowMs;
  }

  /** Process-wide map of taskId → its RollbackRegistry, populated when a
   *  task finishes with non-zero rollback entries. RollbackSkill resolves
   *  registries through this when an agent (or operator) wants to undo. */
  static activeRollbackRegistries: Map<string, RollbackRegistry> = new Map();

  /** Process-wide usage tracker for daily token / tool-call / task counters
   *  and the daily-budget gate. Set via Agent.setUsageTracker; defaults to
   *  an in-memory tracker so existing code paths keep working. */
  private static usageTracker: UsageTracker = new UsageTracker();
  static setUsageTracker(t: UsageTracker): void { Agent.usageTracker = t; }
  static getUsageTracker(): UsageTracker { return Agent.usageTracker; }

  /** Process-wide hook fired after a successful task + reflection.
   *  Wired in by server.ts to drive the crystallization pipeline.
   *  Defaults to a no-op so unit tests + standalone invocations don't
   *  need to know about crystallization. Failures inside the hook are
   *  swallowed — like reflection, this is best-effort scaffolding. */
  private static crystallizationHook?: (input: {
    taskId: string;
    agentId: string;
    title: string;
    category?: string;
    steps: ReactStep[];
    reflection: ReflectionResult;
  }) => void | Promise<void>;
  static setCrystallizationHook(fn: typeof Agent.crystallizationHook): void {
    Agent.crystallizationHook = fn;
  }
  public config: AgentConfig;
  private aiFactory: AIProviderFactory;
  private messageHistory: Message[] = [];
  private currentContext?: ExecutionContext;
  private memoryStore?: SqliteAgentMemoryStore;
  private reflector?: SelfReflector;
  /** Token usage from the most recent provider.chat() call, written by
   *  processMessage and read back by the ReAct loop's GuardrailRunner. */
  private lastUsage?: { promptTokens: number; completionTokens: number };
  /** Last raw text sent to / received from the LLM — used as a token
   *  estimate fallback when the provider didn't report usage. */
  private lastTextSizes?: { inChars: number; outChars: number };
  private lastProviderError?: string;

  constructor(
    name: string,
    role: AgentConfig['role'],
    aiPlatform: AIPlatform,
    aiFactory: AIProviderFactory,
    options?: {
      reportsTo?: string;
      skills?: string[];
      scope?: string[];
      systemPrompt?: string;
    }
  ) {
    this.aiFactory = aiFactory;
    this.config = {
      id: uuidv4(),
      name,
      role,
      reportsTo: options?.reportsTo,
      scope: options?.scope || [],
      aiPlatform,
      skills: options?.skills || [],
      systemPrompt: options?.systemPrompt,
      createdAt: new Date(),
      status: 'active'
    };
  }

  setMemoryStore(store: SqliteAgentMemoryStore): void {
    this.memoryStore = store;
  }

  /** Optional override for the SelfReflector used after task completion.
   *  Useful in tests. By default a SelfReflector is constructed lazily from
   *  the agent's own AIProviderFactory the first time reflection runs. */
  setReflector(reflector: SelfReflector): void {
    this.reflector = reflector;
  }

  recallFacts(): string[] {
    return this.memoryStore?.listFacts(this.config.id) ?? [];
  }

  rememberFact(fact: string): void {
    this.memoryStore?.saveFact(this.config.id, fact);
  }

  get id(): string {
    return this.config.id;
  }

  get name(): string {
    return this.config.name;
  }

  get role(): string {
    return this.config.role;
  }

  async processMessage(
    message: string,
    context?: ExecutionContext
  ): Promise<string> {
    this.currentContext = context;

    // Add user message to history
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content: message,
      timestamp: new Date()
    };
    this.messageHistory.push(userMessage);
    this.memoryStore?.saveMessage(this.config.id, 'user', message);

    let responseContent: string;
    this.lastUsage = undefined;
    this.lastTextSizes = undefined;
    this.lastProviderError = undefined;

    // Check if AI is available
    try {
      const provider = await this.aiFactory.getProvider(this.config.aiPlatform);
      const systemPrompt = this.buildSystemPrompt();
      const messages = this.messageHistory.map(m => ({ role: m.role, content: m.content }));

      // LLM call span — child of whatever the caller has open (typically a
      // `react.iteration.N` span when this runs inside executeTaskDetailed).
      const response = await withSpan(
        `llm.${this.config.aiPlatform}`,
        async (span) => {
          const r = await provider.chat({ messages, system: systemPrompt, context });
          if (r.usage) {
            span.setAttribute('llm.tokens.prompt', r.usage.promptTokens);
            span.setAttribute('llm.tokens.completion', r.usage.completionTokens);
            span.setAttribute('llm.tokens.total', r.usage.totalTokens);
          }
          if (r.model) span.setAttribute('llm.model', r.model);
          return r;
        },
        {
          'agent.id': this.config.id,
          'agent.name': this.config.name,
          'llm.provider': this.config.aiPlatform,
        },
        SpanKind.CLIENT,
      );

      responseContent = response.content;
      Agent.clearPlatformFailure(this.config.aiPlatform);
      this.lastUsage = response.usage
        ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens }
        : undefined;
      this.lastTextSizes = {
        inChars: systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0),
        outChars: responseContent.length,
      };
    } catch (error) {
      // Demo mode: return a simple response when AI is not configured
      this.lastProviderError = error instanceof Error ? error.message : String(error);
      Agent.markPlatformFailure(this.config.aiPlatform, this.lastProviderError);
      responseContent = this.getDemoResponse(message);
      this.lastTextSizes = { inChars: message.length, outChars: responseContent.length };
    }

    // Add assistant response to history
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: responseContent,
      timestamp: new Date(),
      agentId: this.id
    };
    this.messageHistory.push(assistantMessage);
    this.memoryStore?.saveMessage(this.config.id, 'assistant', responseContent);

    return responseContent;
  }

  private getDemoResponse(message: string): string {
    const lowerMessage = message.toLowerCase();

    // Demo responses for common queries
    if (lowerMessage.includes('help') || lowerMessage.includes('what can you')) {
      return `Hello! I'm the ${this.name}, your ${this.role}.

I can help you with:
• Infrastructure management (Docker, Kubernetes, servers)
• Monitoring and alerts
• Deployment automation
• Security scanning
• System diagnostics

To enable full AI capabilities, please configure API keys:
- ANTHROPIC_API_KEY for Claude
- OPENAI_API_KEY for OpenAI
- Or use Ollama for local AI

Currently running in DEMO mode with predefined responses.`;
    }

    if (lowerMessage.includes('docker') || lowerMessage.includes('container')) {
      return `I can help you manage Docker containers. Here are some commands I can execute:

• docker.list - List all containers
• docker.stats - Get container statistics
• docker.logs - Fetch container logs
• docker.exec - Execute commands in containers

Would you like me to check the current Docker status?`;
    }

    if (lowerMessage.includes('status') || lowerMessage.includes('health')) {
      return `System Status Check:

📊 Overall System: HEALTHY
✓ Docker Service: Running
✓ Server Load: Normal
✓ Memory Usage: Normal

For detailed monitoring, I can check:
• CPU usage with 'monitor.cpu'
• Memory with 'monitor.memory'
• Disk space with 'server.disk'
• Full health check with 'health.check'`;
    }

    if (lowerMessage.includes('deploy') || lowerMessage.includes('deploy')) {
      return `I can help with deployments:

Deployment Options:
• Git-based deployment
• Docker container deployment
• Kubernetes deployment
• Rolling updates and rollbacks

Available deployment commands:
• deploy.start - Start a new deployment
• deploy.status - Check deployment status
• deploy.rollback - Rollback a deployment
• git.deploy - Deploy from git repository
• docker.deploy - Deploy Docker image`;
    }

    if (lowerMessage.includes('security') || lowerMessage.includes('scan')) {
      return `Security Management:

I can help with:
• Security scans and vulnerability assessments
• Firewall rule management
• User access reviews
• SSH configuration checks
• Failed login monitoring

Security commands:
• security.scan - Run security scan
• security.users - List system users
• security.ports - Show open ports
• security.firewall - Show firewall rules`;
    }

    if (lowerMessage.includes('monitor') || lowerMessage.includes('alert')) {
      return `Monitoring & Alerting:

I can help monitor:
• CPU and memory usage
• Disk space and I/O
• Network connections
• Application logs
• System metrics

Monitoring commands:
• monitor.cpu - Check CPU usage
• monitor.memory - Check memory usage
• health.check - Full health check
• logs.tail - View log files`;
    }

    // Default demo response
    return `I understand you're asking about: "${message}"

As the ${this.name}, I'm here to help coordinate IT operations.

**Currently running in DEMO MODE** - I have limited predefined responses.

To enable full AI capabilities, please set up:
1. ANTHROPIC_API_KEY (for Claude)
2. OPENAI_API_KEY (for OpenAI)
3. Or use Ollama for local AI

**What I can help with:**
• Docker & Kubernetes management
• System monitoring and health checks
• Deployment automation
• Security scanning
• Log analysis

Try asking me about:
• "Check Docker status"
• "Run health check"
• "Show me system resources"
• "List monitoring commands"`;
  }

  async streamMessage(
    message: string,
    onChunk: (chunk: string) => void,
    context?: ExecutionContext
  ): Promise<string> {
    this.currentContext = context;

    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content: message,
      timestamp: new Date()
    };
    this.messageHistory.push(userMessage);
    this.memoryStore?.saveMessage(this.config.id, 'user', message);

    const provider = await this.aiFactory.getProvider(this.config.aiPlatform);
    const systemPrompt = this.buildSystemPrompt();

    const response = await provider.streamChat(
      {
        messages: this.messageHistory.map(m => ({
          role: m.role,
          content: m.content
        })),
        system: systemPrompt,
        context
      },
      onChunk
    );

    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: response.content,
      timestamp: new Date(),
      agentId: this.id
    };
    this.messageHistory.push(assistantMessage);
    this.memoryStore?.saveMessage(this.config.id, 'assistant', response.content);

    return response.content;
  }

  private buildSystemPrompt(): string {
    const basePrompt = this.config.systemPrompt || this.getDefaultPrompt();
    const roleInfo = `\n\nYour Role: ${this.role}\nYour Name: ${this.name}\n`;
    const skillsInfo = this.config.skills.length > 0
      ? `\nYour Skills: ${this.config.skills.join(', ')}\n`
      : '';
    const scopeInfo = Array.isArray(this.config.scope) && this.config.scope.length > 0
      ? `\nYour Scope: ${this.config.scope.join(', ')}\n`
      : '';
    const executionRules = `
Operational Integrity Rules:
- You are a planning and advisory assistant unless the system explicitly confirms an action was executed.
- Do NOT claim you created agents, started sessions, assigned tasks, ran commands, or changed infrastructure unless you actually received a confirmed execution result.
- When the user asks for an action, respond with a clear plan and say it is a proposal/request, not already completed.
- If asked whether an action is complete, be explicit about uncertainty and ask to verify via dashboard/API state.
- Use least-privilege execution: prefer safe read-only tools first, then request privileged tools only if required.
- Never ask users to paste raw secrets into chat; request credential references (IDs/scopes) only.
- For privileged or destructive tools, explicitly state required approval and credential scopes before execution.
- Treat sandbox profile constraints as mandatory and mention runner + scope requirements in your plan.
`;

    return basePrompt + roleInfo + skillsInfo + scopeInfo + executionRules;
  }

  private getDefaultPrompt(): string {
    switch (this.config.role) {
      case 'director':
        return `You are the IT Operations Director. You oversee all IT operations, make strategic decisions,
and coordinate between system administrators and specialists. You focus on:
- High-level infrastructure planning
- Resource allocation and prioritization
- Incident response coordination
- Strategic technology decisions

Always consider the bigger picture and delegate tasks appropriately to your team.`;

      case 'sysadmin':
        return `You are a System Administrator. You manage infrastructure, servers, and systems.
Your responsibilities include:
- Server provisioning and maintenance
- System monitoring and alerts
- User access management
- Backup and disaster recovery
- Performance optimization

Execute tasks thoroughly and report issues to the director when needed.`;

      case 'specialist':
        return `You are an IT Specialist. You have deep expertise in specific areas like DevOps,
Security, Networking, or Applications. Your responsibilities include:
- Deep technical implementation work
- Specialized troubleshooting
- Tool-specific configurations
- Best practices implementation

Focus on quality and precision in your area of expertise.`;

      default:
        return `You are an IT Operations team member. Help with IT tasks efficiently.`;
    }
  }

  getHistory(): Message[] {
    return [...this.messageHistory];
  }

  clearHistory(): void {
    this.messageHistory = [];
  }

  setAIProviderFactory(aiFactory: AIProviderFactory): void {
    this.aiFactory = aiFactory;
  }

  assignSkill(skill: string): void {
    if (!this.config.skills.includes(skill)) {
      this.config.skills.push(skill);
    }
  }

  removeSkill(skill: string): void {
    this.config.skills = this.config.skills.filter(s => s !== skill);
  }

  toJSON(): AgentConfig {
    return { ...this.config };
  }
  static fromJSON(data: AgentConfig, aiFactory: AIProviderFactory): Agent {
    const agent = new Agent(
      data.name,
      data.role,
      data.aiPlatform,
      aiFactory,
      {
        skills: data.skills,
        scope: data.scope,
        systemPrompt: ''
      }
    );
    agent.config = { ...data };
    return agent;
  }

  /**
   * Execute a task using a ReAct (Reason + Act) loop:
   *   observe → reason → act → observe → … → final answer
   *
   * Each iteration the LLM must emit either an `Action:` block (tool call) or a
   * `Final Answer:` block. Tool output becomes the next `Observation:` and is
   * fed back into the loop until the agent answers or `maxIterations` is hit.
   *
   * Legacy `TOOL_CALL::` / `TASK_COMPLETE:` markers are still accepted so older
   * prompts and AI providers continue to work unchanged.
   *
   * Memory: similar past resolutions are injected into the prompt and the run
   * outcome is persisted back to the memory store for future recall.
   */
  async executeTask(
    task: Task,
    skillManager: SkillManager,
    onProgressOrOptions?: ((msg: string) => void) | ExecuteTaskOptions
  ): Promise<string> {
    const opts: ExecuteTaskOptions = typeof onProgressOrOptions === 'function'
      ? { onProgress: onProgressOrOptions }
      : (onProgressOrOptions ?? {});
    const detailed = await this.executeTaskDetailed(task, skillManager, opts);
    return detailed.result;
  }

  /**
   * Same loop as executeTask but returns the full ReAct trace (steps, outcome,
   * timing). Useful for callers that want to surface per-step progress to the UI.
   */
  async executeTaskDetailed(
    task: Task,
    skillManager: SkillManager,
    opts: ExecuteTaskOptions = {}
  ): Promise<ExecuteTaskResult> {
    // Resolve effective guardrails for this agent (role default ⊕ overrides
    // from the agent config). opts.maxIterations still wins so existing
    // callers that pass a tighter cap continue to work.
    const guardCfg: GuardrailConfig = resolveGuardrails(this.config.role as any, this.config.guardrails);
    const maxIterations = Math.max(1, opts.maxIterations ?? guardCfg.maxIterations ?? MAX_TOOL_ITERATIONS);
    const guard = new GuardrailRunner({ ...guardCfg, maxIterations }, this.config.aiPlatform);

    // Daily usage gate: refuse to start a new task when the agent has
    // already burned its daily token (or cost) budget. Skipped silently for
    // agents without a configured budget.
    const usageGate = Agent.usageTracker.checkGate(this.config.id);
    if (!usageGate.allowed) {
      return {
        result: `Refused: ${usageGate.reason}`,
        outcome: 'failed',
        iterations: 0,
        steps: [],
        durationMs: 0,
        limitReached: true,
        limitType: 'tokens',
        limitReason: usageGate.reason,
        usage: { totalTokens: 0, toolCalls: 0, estimatedCostUsd: 0 },
      };
    }

    // Concurrency check happens before any work so a refused start surfaces
    // immediately as a partial result rather than queueing.
    const acquire = concurrencyLimiter.acquire(this.config.id, guardCfg.maxConcurrentTasks);
    if (acquire.ok !== true) {
      return {
        result: `Refused: ${acquire.reason}`,
        outcome: 'failed',
        iterations: 0,
        steps: [],
        durationMs: 0,
        limitReached: true,
        limitType: acquire.limitType,
        limitReason: acquire.reason,
        usage: { totalTokens: 0, toolCalls: 0, estimatedCostUsd: 0 },
      };
    }
    const releaseSlot = acquire.release;

    const availableCommands = skillManager.getCommandsForSkills(this.config.skills);
    const commandList = availableCommands
      .map(cmd => `- ${cmd.name}: ${cmd.description}${cmd.parameters ? ' | params: ' + JSON.stringify(cmd.parameters) : ''}`)
      .join('\n');

    const taskSeverity = this.taskSeverityFromPriority(task.priority);
    const recallBlock = this.memoryStore?.buildIncidentRecallPrompt(
      this.config.id,
      task.title,
      taskSeverity,
      3
    ) ?? '';

    // Self-improvement loop: pull lessons from past reflections that look
    // relevant to this task, plus the agent's recent rating trend, so the
    // agent literally walks into the loop carrying its own past critiques.
    const lessonsBlock = this.buildLessonsBlock(task.title);

    const taskPrompt = `You are executing an IT operations task. Use the ReAct pattern: think, act, observe, repeat.

TASK: ${task.title}
DESCRIPTION: ${task.description || 'No description provided'}
CATEGORY: ${task.category}
PRIORITY: ${task.priority}
${recallBlock ? '\n' + recallBlock + '\n' : ''}${lessonsBlock ? '\n' + lessonsBlock + '\n' : ''}
AVAILABLE TOOLS:
${commandList}

CRITICAL: this is an EXECUTION task. You must INVOKE tools to gather real
data — never describe what you would do or speculate about an outcome
without actually running the relevant tool. If a tool can answer a
question (df, kubectl, monitor.cpu, etc.), call it. Do not guess values
you can measure.

On each turn output exactly ONE of these two blocks (no extra prose, no markdown fences, no \`\`\` fences):

  Thought: <one-line reasoning about the next step>
  Action: <command.name>
  Action Input: {"param": "value", ...}

— OR, only after you have actually executed enough tools to answer —

  Thought: <one-line reasoning summarising what the observations show>
  Final Answer: <one-paragraph summary of what was done and the outcome, citing concrete values from observations>

Rules:
- Only call tools listed above. Use the EXACT command name as shown.
- Action Input must be valid JSON on a single line; use {} if no params.
- You MUST invoke at least one tool unless the task is purely a knowledge
  question with zero operational data needed. Final Answer on iteration 0
  is reserved for the rare case the user asked you to explain a concept,
  NOT to triage / diagnose / measure / fix anything.
- "Filesystem triage", "check CPU", "investigate", "diagnose", "report",
  "verify", "test", "confirm" — these all require running tools first.
- You have at most ${maxIterations} action iterations before the loop terminates.

Begin.`;

    // Root span for this task — every iteration / skill call / LLM call /
    // delegation will hang off this. Started manually because the work
    // spans the entire executeTaskDetailed body and we want to attach the
    // final outcome attributes before ending. We rebind it as the active
    // OTel context for the loop body so child spans nest properly.
    const rootSpan = startSpan('agent.task', {
      'agent.id': this.config.id,
      'agent.name': this.config.name,
      'agent.role': this.config.role,
      'task.id': task.id,
      'task.title': task.title,
      'task.priority': task.priority,
      'task.category': task.category ?? '',
      'task.delegationDepth': opts.delegationDepth ?? 0,
    });
    const taskCtx = otelTrace.setSpan(otelContext.active(), rootSpan);

    // Per-task scoped logger — every record from inside the loop carries
    // agentId/taskId so log aggregators can group a single task's logs
    // without touching the active OTel span.
    const taskLog = agentLog.withContext({
      agentId: this.config.id,
      agentName: this.config.name,
      taskId: task.id,
      delegationDepth: opts.delegationDepth ?? 0,
    });
    taskLog.info('task started', {
      title: task.title,
      priority: task.priority,
      category: task.category,
      maxIterations,
    });

    // Save and reset conversation history so the task run is isolated.
    const savedHistory = [...this.messageHistory];
    this.messageHistory = [];

    const steps: ReactStep[] = [];
    const startedAt = Date.now();
    let currentMessage = taskPrompt;
    let finalResult = '';
    let iteration = 0;
    let terminationReason: 'final_answer' | 'no_action' | 'max_iterations' | 'limit_reached' | 'provider_error' = 'no_action';
    let limitVerdict: ReturnType<GuardrailRunner['check']> | null = null;
    let urgencyAlreadyInjected = false;

    // Per-task rollback registry. Skills push reversible-action recipes here
    // through skillContext.registerRollback; the Agent surfaces the resulting
    // stack in the ExecuteTaskResult so the caller (or RollbackSkill) can
    // execute it on failure.
    const rollbacks = new RollbackRegistry();

    // Context attached to every skill call from this loop. DelegationSkill
    // reads this to enforce the recursion-depth limit and to know who it's
    // being asked on behalf of; reversible skills push undo recipes via
    // registerRollback.
    const skillContext = {
      callerAgentId: this.config.id,
      callerAgentName: this.config.name,
      delegationDepth: opts.delegationDepth ?? 0,
      taskId: task.id,
      registerRollback: (input: Omit<RollbackAction, 'id' | 'timestamp' | 'executed'>): string =>
        rollbacks.register({
          ...input,
          taskId: task.id,
          agentId: this.config.id,
        }),
    };

    try {
      // Bind the task root span as the active OTel context so every span
      // started inside the loop (LLM calls, skill calls, delegations,
      // reflection) nests beneath it.
      await otelContext.with(taskCtx, async () => {
       while (iteration < maxIterations) {
        // Pre-iteration guardrail check. If anything has tripped, stop now —
        // we never overrun a limit, and we always know which one fired.
        const verdict = guard.check();
        if (!verdict.ok) {
          limitVerdict = verdict;
          terminationReason = 'limit_reached';
          break;
        }

        // <10 % time budget left → inject an urgency hint into the next
        // prompt (once) so the model knows to stop calling tools and answer.
        if (!urgencyAlreadyInjected && guard.isTimeAlmostUp()) {
          const hint = guard.urgencyHint();
          if (hint) {
            currentMessage = `${hint}\n\n${currentMessage}`;
            urgencyAlreadyInjected = true;
          }
        }

        // Per-iteration span: every action's LLM call and skill call hangs
        // off this so a Jaeger view shows the ReAct loop as a clean ladder.
        const iterationDecision: 'final' | 'action' | 'unknown' = await withSpan(
          `react.iteration.${iteration}`,
          async (iterSpan) => {
            const stepStart = Date.now();
            const response = await this.processMessage(currentMessage);
            opts.onProgress?.(response);
            if (this.lastProviderError) {
              const error = `AI provider unavailable: ${this.lastProviderError}`;
              taskLog.error('provider failed during task execution', { iteration, err: this.lastProviderError });
              steps.push({
                iteration,
                error,
                observation: response.slice(0, 500),
                durationMs: Date.now() - stepStart,
              });
              opts.onStep?.(steps[steps.length - 1]);
              finalResult = error;
              terminationReason = 'provider_error';
              return 'unknown';
            }

            // Record token usage from the LLM call. Provider.usage is preferred;
            // fall back to char-based estimate so untracked providers still
            // contribute to the budget.
            if (this.lastUsage) {
              guard.recordTokens(this.lastUsage.promptTokens, this.lastUsage.completionTokens);
              iterSpan.setAttribute('llm.tokens.prompt', this.lastUsage.promptTokens);
              iterSpan.setAttribute('llm.tokens.completion', this.lastUsage.completionTokens);
            } else if (this.lastTextSizes) {
              guard.recordTokensFromText(
                ' '.repeat(this.lastTextSizes.inChars),
                ' '.repeat(this.lastTextSizes.outChars),
              );
            }

            const parsed = this.parseReactResponse(response);
            iterSpan.setAttribute('react.kind', parsed.kind);

            // Per-iteration log so operators can see the ReAct decision
            // path without an OTel viewer. The "0 tool steps across 13
            // resolutions" mystery was hidden because nothing logged
            // here — once a final answer landed on iteration 0, the only
            // visible event was "task finished". Now we always log the
            // chosen action.
            taskLog.info('react decision', {
              iteration,
              kind: parsed.kind,
              tool: parsed.kind === 'action' ? parsed.tool : undefined,
              answerLen: parsed.kind === 'final' ? parsed.answer.length : undefined,
              responseLen: response.length,
            });

            if (parsed.kind === 'final') {
              steps.push({ iteration, thought: parsed.thought, durationMs: Date.now() - stepStart });
              finalResult = parsed.answer;
              terminationReason = 'final_answer';
              opts.onStep?.(steps[steps.length - 1]);
              return 'final';
            }

            if (parsed.kind === 'action') {
              iterSpan.setAttribute('react.tool', parsed.tool);
              let observation: string;
              let error: string | undefined;
              try {
                observation = await skillManager.execute(parsed.tool, parsed.params, skillContext);
              } catch (err) {
                error = (err as Error).message;
                observation = `Error: ${error}`;
              }
              guard.recordToolCall();
              if (error) iterSpan.setAttribute('react.error', error);

              const step: ReactStep = {
                iteration,
                thought: parsed.thought,
                tool: parsed.tool,
                params: parsed.params,
                observation: observation.slice(0, 2000),
                error,
                durationMs: Date.now() - stepStart,
              };
              steps.push(step);
              opts.onStep?.(step);

              currentMessage = `Observation: ${observation}\n\nContinue. Emit either another Thought/Action triple or a Final Answer.`;
              iteration++;
              guard.recordIteration();
              return 'action';
            }

            // No structured block recognised — accept the model's plain reply
            // as the answer, but log a sample so operators can see WHY the
            // parser couldn't extract an Action/Final-Answer. This used to
            // be silent, which produced the "13 resolutions, 0 tool steps"
            // mystery: every task ended here on iteration 0, marked success.
            taskLog.warn('react parser fell through — model response did not match any expected shape', {
              iteration,
              responsePreview: response.slice(0, 600),
              responseLength: response.length,
              hasAction: /Action:/i.test(response),
              hasActionInput: /Action Input:/i.test(response),
              hasFinalAnswer: /Final Answer:/i.test(response),
              hasCodeFence: response.includes('```'),
            });
            steps.push({
              iteration,
              observation: response.slice(0, 500),
              durationMs: Date.now() - stepStart,
            });
            opts.onStep?.(steps[steps.length - 1]);
            finalResult = response.trim();
            terminationReason = 'no_action';
            return 'unknown';
          },
          { 'iteration': iteration, 'task.id': task.id }
        );

        if (iterationDecision === 'final' || iterationDecision === 'unknown') break;
        // 'action' → continue the while loop
       }
      });

      if (!finalResult) {
        if (terminationReason === 'limit_reached' && limitVerdict) {
          finalResult = `Task stopped early (${limitVerdict.limitType}): ${limitVerdict.reason}. Last observation: ${steps[steps.length - 1]?.observation?.slice(0, 200) ?? 'n/a'}`;
        } else {
          // Loop exited via the `iteration < maxIterations` while-guard. Treat
          // that as the iterations limit firing so callers see a consistent
          // limitReached/limitType/limitReason payload regardless of which
          // gate caught it first.
          terminationReason = 'limit_reached';
          limitVerdict = {
            ok: false,
            limitType: 'iterations',
            reason: `iteration cap (${maxIterations}) reached`,
          };
          finalResult = `Task stopped early (iterations): iteration cap (${maxIterations}) reached. Last observation: ${steps[steps.length - 1]?.observation?.slice(0, 200) ?? 'n/a'}`;
        }
      }
    } finally {
      this.messageHistory = savedHistory;
      releaseSlot();
    }

    const durationMs = Date.now() - startedAt;
    const outcome: 'success' | 'partial' | 'failed' =
      terminationReason === 'limit_reached'
        ? 'partial'
        : terminationReason === 'max_iterations'
          ? 'partial'
          : terminationReason === 'provider_error' || terminationReason === 'no_action'
            ? 'failed'
          : steps.some(s => s.error) && terminationReason !== 'final_answer'
            ? 'failed'
            : finalResult.toLowerCase().startsWith('error')
              ? 'failed'
              : 'success';

    // Persist resolution for future recall.
    try {
      this.memoryStore?.recordResolution({
        agentId: this.config.id,
        incidentTitle: task.title,
        incidentSeverity: taskSeverity,
        problemDescription: task.description || '',
        stepsTried: steps.map(s => ({
          tool: s.tool,
          params: s.params,
          result: s.observation,
          thought: s.thought,
        })),
        whatWorked: finalResult,
        resolution: finalResult,
        resolutionTimeMs: durationMs,
        outcome,
      });
    } catch { /* memory persistence is best-effort */ }

    const snapshot = guard.snapshot();
    const result: ExecuteTaskResult = {
      result: finalResult,
      outcome,
      iterations: iteration,
      steps,
      durationMs,
      limitReached: terminationReason === 'limit_reached',
      limitType: limitVerdict?.limitType,
      limitReason: limitVerdict?.reason,
      usage: {
        totalTokens: snapshot.totalTokens,
        toolCalls: snapshot.toolCalls,
        estimatedCostUsd: snapshot.estimatedCostUsd,
      },
      rollbacks: rollbacks.list(),
    };

    // Annotate the root span with the final outcome before ending it. The
    // span is ended unconditionally — even if reflection / rollback bookkeeping
    // throws below, the trace stays clean.
    rootSpan.setAttribute('task.outcome', outcome);
    rootSpan.setAttribute('task.iterations', iteration);
    rootSpan.setAttribute('task.tokens', snapshot.totalTokens);
    rootSpan.setAttribute('task.toolCalls', snapshot.toolCalls);
    rootSpan.setAttribute('task.durationMs', durationMs);
    if (result.limitReached && limitVerdict?.limitType) {
      rootSpan.setAttribute('task.limitType', limitVerdict.limitType);
    }
    endSpan(rootSpan);

    // One structured record summarising the run, for log aggregators.
    const finishLevel = outcome === 'failed' ? 'error' : (result.limitReached ? 'warn' : 'info');
    taskLog[finishLevel]('task finished', {
      outcome,
      iterations: iteration,
      durationMs,
      tokens: snapshot.totalTokens,
      toolCalls: snapshot.toolCalls,
      estimatedCostUsd: snapshot.estimatedCostUsd,
      limitReached: !!result.limitReached,
      limitType: limitVerdict?.limitType,
      limitReason: limitVerdict?.reason,
    });

    // Stash this task's registry so RollbackSkill (running inside the same
    // process) can resolve it by taskId. Cleared after a successful run.
    if (rollbacks.size() > 0) {
      Agent.activeRollbackRegistries.set(task.id, rollbacks);
      // Auto-evict after 1 hour to avoid leaking. The dashboard / RollbackSkill
      // typically pick up the registry within seconds of task completion.
      setTimeout(() => Agent.activeRollbackRegistries.delete(task.id), 60 * 60 * 1000).unref?.();
    }

    // Record this task's usage into the daily counters so the next call's
    // gate has up-to-date data. Errors here are swallowed — usage tracking
    // is observability scaffolding, never blocks the result.
    try {
      Agent.usageTracker.recordTask(this.config.id, {
        totalTokens: snapshot.totalTokens,
        toolCalls: snapshot.toolCalls,
        estimatedCostUsd: snapshot.estimatedCostUsd,
      });
    } catch { /* best-effort */ }

    // Self-improvement loop. Two stages, deliberately separated so a
    // problem in stage 1 (LLM-driven reflection) doesn't kill stage 2
    // (mechanical crystallization). Both used to be nested inside one
    // try/catch with silent swallow, which produced the "0 reflections,
    // 0 drafts" symptom we observed in production for months.
    //
    // Stage 1 — Reflection: LLM critiques the trace, only worth running
    // for non-trivial / failed / errored tasks (SelfReflector.shouldReflect).
    let reflection: Awaited<ReturnType<SelfReflector['reflect']>> | undefined;
    if (this.memoryStore && SelfReflector.shouldReflect(result)) {
      try {
        const reflector = this.reflector ?? new SelfReflector(this.aiFactory);
        reflection = await withSpan(
          'reflection',
          () => reflector.reflect({
            task,
            agentId: this.config.id,
            agentName: this.config.name,
            agentRole: this.config.role,
            agentPlatform: this.config.aiPlatform,
            detailed: result,
          }),
          { 'agent.id': this.config.id, 'task.id': task.id },
        );
        this.memoryStore.storeReflection({
          taskId: reflection.taskId,
          agentId: reflection.agentId,
          selfRating: reflection.selfRating,
          whatWorked: reflection.whatWorked,
          whatDidntWork: reflection.whatDidntWork,
          lessonsLearned: reflection.lessonsLearned,
          suggestedImprovements: reflection.suggestedImprovements,
          toolEfficiency: reflection.toolEfficiency,
          wouldDoDifferently: reflection.wouldDoDifferently,
          taskTitle: task.title,
          timestamp: reflection.timestamp,
        });
      } catch (err) {
        // Reflection is best-effort, but we surface the failure now so
        // operators can see why reflections aren't landing.
        agentLog.warn('reflection failed', {
          taskId: task.id,
          agentId: this.config.id,
          err: err instanceof Error ? err.message : String(err),
        });
        reflection = undefined;
      }
    }

    // Stage 2 — Crystallization: fires on every successful task, with or
    // without a reflection. The analyzer downstream still gates on
    // complexity / score so trivial 1-step tasks won't pass; but a task
    // that ran 2-3 useful tool calls + succeeded gets a real shot at
    // becoming a draft skill, which previously required reflection (and
    // therefore shouldReflect=true) to even be evaluated.
    if (Agent.crystallizationHook && result.outcome === 'success') {
      try {
        await Agent.crystallizationHook({
          taskId: task.id,
          agentId: this.config.id,
          title: task.title,
          category: task.category,
          steps: result.steps,
          reflection, // may be undefined; analyzer scores reflectionFit lower without it
        });
      } catch (err) {
        agentLog.warn('crystallization hook failed', {
          taskId: task.id,
          agentId: this.config.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /** Build a short, prompt-injectable block of past lessons relevant to this
   *  task. Returns '' if no relevant history exists or no memory store. The
   *  whole block is intentionally capped at ~500 tokens-worth of text so it
   *  doesn't crowd out the actual ReAct prompt. */
  private buildLessonsBlock(taskTitle: string): string {
    if (!this.memoryStore || typeof this.memoryStore.getRelevantLessons !== 'function') {
      return '';
    }
    const recall = this.memoryStore.getRelevantLessons(this.config.id, taskTitle, { limit: 3 });

    const hasMatchedLessons = recall.lessons.length > 0;
    const hasMatchedWould = recall.wouldDoDifferently.length > 0;
    const hasMeaningfulTrend = recall.recentTrend !== 'insufficient' && recall.sampleSize >= 6;

    // No keyword-matched lessons AND no meaningful trend → don't bother the
    // model. We deliberately don't trigger on sampleSize alone, because that
    // counts unrelated past reflections too.
    if (!hasMatchedLessons && !hasMatchedWould && !hasMeaningfulTrend) {
      return '';
    }

    const lines: string[] = ['## Lessons from past similar tasks (your own reflections)'];
    if (hasMatchedLessons) {
      lines.push('Recent lessons (low-rated tasks first — those are where you learned the most):');
      for (const l of recall.lessons) lines.push(`  - ${l}`);
    }
    if (hasMatchedWould) {
      lines.push('What you said you would do differently next time:');
      for (const w of recall.wouldDoDifferently) lines.push(`  - ${w}`);
    }
    if (hasMeaningfulTrend) {
      const ratingTxt = recall.averageRating ? recall.averageRating.toFixed(1) : 'n/a';
      lines.push(`Self-rating average ${ratingTxt}/5 over ${recall.sampleSize} reflections — trend: ${recall.recentTrend}.`);
    }
    // Hard cap on the block size so it can't dominate the prompt.
    const block = lines.join('\n');
    return block.length > 2400 ? block.slice(0, 2397) + '...' : block;
  }

  /**
   * Parse a model response into either an Action (tool call) or a Final Answer.
   * Accepts the structured ReAct format and the legacy TOOL_CALL::/TASK_COMPLETE:
   * markers used by earlier versions of this agent.
   */
  private parseReactResponse(
    response: string
  ): { kind: 'action'; thought?: string; tool: string; params: Record<string, unknown> }
   | { kind: 'final'; thought?: string; answer: string }
   | { kind: 'unknown' } {
    // Normalisation pass — strip the formatting Claude tends to add even
    // when the prompt explicitly says "no markdown fences":
    //   • markdown bold around field labels: **Action:** → Action:
    //   • code fences around the whole block or around just the JSON:
    //     ```json\n{...}\n``` → {...}
    //   • smart quotes that break JSON.parse: "x" / "x" → "x"
    //   • Windows line endings inside the body
    const normalised = response
      .replace(/\*\*(Thought|Action|Action Input|Final Answer|Observation):\*\*/gi, '$1:')
      .replace(/```[a-zA-Z]*\s*\n?/g, '')
      .replace(/```/g, '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\r\n/g, '\n');

    const thoughtMatch = normalised.match(/Thought:\s*(.+)/i);
    const thought = thoughtMatch?.[1].split('\n')[0].trim();

    // Action: <tool> ... Action Input: {...JSON...}
    //
    // Action MUST be checked before Final Answer. Claude routinely emits
    // BOTH in the same response (a valid Action followed by a Final
    // Answer that narrates what the action would do). If we matched
    // Final Answer first, every such response would terminate the loop
    // on iteration 0 with no tool ever running — which is exactly the
    // "0 tool steps across 13 resolutions" symptom we hit. The presence
    // of an Action + parseable Action Input is the agent's commitment
    // to act; treat it as authoritative even when accompanied by prose.
    //
    // Tolerant of:
    //   • optional whitespace/newlines between Action and Action Input
    //   • the JSON spanning multiple lines (we balance braces below
    //     instead of relying on a regex's greedy/non-greedy quirks)
    const actionLineMatch = normalised.match(/Action:\s*([\w.\-:/]+)/i);
    const inputLineMatch  = normalised.match(/Action Input:\s*/i);
    if (actionLineMatch && inputLineMatch) {
      const inputStart = (inputLineMatch.index ?? 0) + inputLineMatch[0].length;
      const jsonStr = extractBalancedJson(normalised.slice(inputStart));
      if (jsonStr !== null) {
        let params: Record<string, unknown> = {};
        try { params = JSON.parse(jsonStr); } catch { params = {}; }
        return { kind: 'action', thought, tool: actionLineMatch[1].trim(), params };
      }
      // Action: line present but no parseable JSON block — accept empty params
      // rather than fall through to "unknown", since the model clearly tried.
      return { kind: 'action', thought, tool: actionLineMatch[1].trim(), params: {} };
    }

    // Final Answer: ... — terminator is the next ReAct keyword OR end of text
    const finalMatch = normalised.match(/Final Answer:\s*([\s\S]+?)(?:\n\s*(?:Thought:|Action:|Observation:)|$)/i);
    if (finalMatch) {
      return { kind: 'final', thought, answer: finalMatch[1].trim() };
    }

    // Legacy TOOL_CALL::{...}
    const legacyTool = normalised.match(/TOOL_CALL::\s*(\{[\s\S]+?\})/);
    if (legacyTool) {
      try {
        const tc = JSON.parse(legacyTool[1]) as { tool: string; params?: Record<string, unknown> };
        if (tc.tool) return { kind: 'action', thought, tool: tc.tool, params: tc.params ?? {} };
      } catch { /* fall through */ }
    }

    // Legacy TASK_COMPLETE: ...
    const legacyComplete = normalised.indexOf('TASK_COMPLETE:');
    if (legacyComplete !== -1) {
      return { kind: 'final', thought, answer: normalised.slice(legacyComplete + 'TASK_COMPLETE:'.length).trim() };
    }

    return { kind: 'unknown' };
  }

  private taskSeverityFromPriority(p: string): string {
    switch (p) {
      case 'critical': return 'critical';
      case 'high':     return 'high';
      case 'medium':   return 'medium';
      case 'low':      return 'low';
      default:         return 'medium';
    }
  }
}

/**
 * Walk a string from the first `{` and return the substring up to the
 * matching `}`, respecting nesting + JSON-string quoting. Returns null
 * if no balanced object is found.
 *
 * Why this exists: the previous regex (`\{[\s\S]*?\}`) was non-greedy
 * and stopped at the first `}` it saw, which broke whenever Action Input
 * contained a nested object (e.g. `{"params": {"key": "v"}}`) — the
 * parser would extract `{"params": {"key": "v"}` and JSON.parse would
 * silently throw, dropping all params and making the agent appear
 * untooled. A balance-counting walk handles arbitrarily nested JSON.
 */
function extractBalancedJson(input: string): string | null {
  const start = input.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

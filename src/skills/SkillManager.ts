// Skills management system for IT operations

// Microsoft365Skill is intentionally not imported — it declares 23 commands
// without implementing any handlers, so registering it would expose a phantom
// tool surface that wastes prompt tokens and 100 %-fails on dispatch. Re-add
// the import + registration once handlers exist.
// import { Microsoft365Skill } from './Microsoft365Skill.js';

import type { Skill, SkillCategory, Command } from '../types/index.js';
import { InfrastructureSkill } from './InfrastructureSkill.js';
import { MonitoringSkill } from './MonitoringSkill.js';
import { DeploymentSkill } from './DeploymentSkill.js';
import { SecuritySkill } from './SecuritySkill.js';
import { BashSkill } from './BashSkill.js';
import { FilesSkill } from './FilesSkill.js';
import { SSHSkill } from './SSHSkill.js';
import { WebSkill } from './WebSkill.js';
import { NetworkSkill } from './NetworkSkill.js';
import { UserManagementSkill } from './UserManagementSkill.js';
import { CertificateSkill } from './CertificateSkill.js';
import { AlertSkill } from './AlertSkill.js';
import { ProxmoxSkill } from './ProxmoxSkill.js';
import { NetworkScanSkill } from './NetworkScanSkill.js';
import { JiraSkill } from './JiraSkill.js';
import { ServiceDeskSkill } from './ServiceDeskSkill.js';
import { SystemUpdateSkill } from './SystemUpdateSkill.js';
import { LogAggregatorSkill } from './LogAggregatorSkill.js';
import { WorkflowSkill } from './WorkflowSkill.js';
import { RunbookSkill } from './RunbookSkill.js';
import { DelegationSkill } from './DelegationSkill.js';
import { RollbackSkill } from './RollbackSkill.js';
import { IncidentSkill } from './IncidentSkill.js';
import { RunbookEngine } from '../runbooks/RunbookEngine.js';
import { DatabaseSkill } from './extended/DatabaseSkill.js';
import { DockerSkill as DockerMgmtSkill } from './extended/DockerSkill.js';
import { KubernetesSkill } from './extended/KubernetesSkill.js';
import { CloudSkill } from './extended/CloudSkill.js';
import { CircuitBreakerRegistry, type CircuitBreakerConfig, type CircuitBreakerSnapshot } from './CircuitBreaker.js';
import { encode, fail } from './SkillResult.js';
import { withSpan } from '../observability/Telemetry.js';
import { createLogger } from '../observability/Logger.js';

const skillLog = createLogger({ component: 'skill-manager' });
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SkillInstance = Record<string, (...args: any[]) => Promise<string>>;

// Context that the dispatcher attaches to every handler invocation. Skills
// that don't care about it just ignore the second argument (which is what
// every existing handler does — they only typed `params`). DelegationSkill
// uses it to enforce a recursion-depth limit and identify the calling agent.
//
// Skills that perform reversible state changes (file writes, container
// starts, user creates, …) call ctx.registerRollback(...) to push an undo
// recipe onto the per-task RollbackRegistry. The Agent layer wires the
// registrar in; tests / standalone callers without a registry get a no-op.
export interface SkillExecutionContext {
  callerAgentId?: string;
  callerAgentName?: string;
  delegationDepth?: number;
  taskId?: string;
  registerRollback?: import('../agents/RollbackRegistry.js').RegisterRollbackFn;
}

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private executors: Map<string, SkillInstance> = new Map();
  /** Per-skill circuit breaker — opens after consecutive failures so the
   *  agent stops hammering a broken integration. Public for tests; the
   *  ReAct loop and dashboards read it through getCircuitBreaker(). */
  public readonly circuitBreakers: CircuitBreakerRegistry;

  constructor(opts?: { circuitBreaker?: Partial<CircuitBreakerConfig> }) {
    this.circuitBreakers = new CircuitBreakerRegistry(opts?.circuitBreaker);
    this.registerBuiltinSkills();
    this.snapshotBuiltins();
  }

  /** Read-only snapshot of every breaker that's seen at least one failure. */
  listCircuitBreakers(): CircuitBreakerSnapshot[] {
    return this.circuitBreakers.listActive();
  }

  /** Manual reset for operator override (closes the breaker and resets counter). */
  resetCircuitBreaker(skillId: string): void {
    this.circuitBreakers.reset(skillId);
  }

  private registerBuiltinSkills(): void {
    const infraSkill = new InfrastructureSkill();
    const monitorSkill = new MonitoringSkill();
    const deploySkill = new DeploymentSkill();
    const securitySkill = new SecuritySkill();
    // const m365Skill = new Microsoft365Skill(); // disabled — see import note above
    const bashSkill = new BashSkill();
    const filesSkill = new FilesSkill();
    const sshSkill = new SSHSkill();
    const webSkill = new WebSkill();
    const jiraSkill = new JiraSkill();
    const incidentManager = new IncidentManager(
      new SqliteIncidentStore(process.env.INCIDENT_DB_PATH || '/data/itops-agents/incidents.db')
    );
    const serviceDeskSkill = new ServiceDeskSkill(incidentManager);
    // IncidentSkill gets the same IncidentManager so timeline notes the agent
    // adds land in the canonical DB. The RunbookEngine is a singleton, so the
    // same one server.ts wires the SkillManager into. server.ts later calls
    // wireIncidentTools() to swap in the canonical instance with onCreated /
    // onCritical callbacks attached.
    const incidentSkill = new IncidentSkill({
      incidents: incidentManager,
      runbooks: RunbookEngine.getInstance(),
    });
    const networkSkill = new NetworkSkill();
    const usersSkill = new UserManagementSkill();
    const certSkill = new CertificateSkill();
    const alertSkill = new AlertSkill();
    const proxmoxSkill = new ProxmoxSkill();
    const networkScanSkill = new NetworkScanSkill();
    const systemUpdateSkill = new SystemUpdateSkill();
    const logAggregatorSkill = new LogAggregatorSkill();
    const workflowSkill = new WorkflowSkill();
    const runbookSkill = new RunbookSkill();
    const delegationSkill = new DelegationSkill();
    delegationSkill.setSkillManager(this); // wire the dispatcher into the executor
    const rollbackSkill = new RollbackSkill();
    rollbackSkill.setSkillManager(this);
    const databaseSkill = new DatabaseSkill();
    const dockerMgmtSkill = new DockerMgmtSkill();
    const kubernetesSkill = new KubernetesSkill();
    const cloudSkill = new CloudSkill();

    this.registerWithExecutor(infraSkill.getSkill(), infraSkill as unknown as SkillInstance);
    this.registerWithExecutor(monitorSkill.getSkill(), monitorSkill as unknown as SkillInstance);
    this.registerWithExecutor(deploySkill.getSkill(), deploySkill as unknown as SkillInstance);
    this.registerWithExecutor(securitySkill.getSkill(), securitySkill as unknown as SkillInstance);
    // this.registerWithExecutor(m365Skill.getSkill(), m365Skill as unknown as SkillInstance); // disabled — phantom skill, see top of file
    this.registerWithExecutor(bashSkill.getSkill(), bashSkill as unknown as SkillInstance);
    this.registerWithExecutor(filesSkill.getSkill(), filesSkill as unknown as SkillInstance);
    this.registerWithExecutor(sshSkill.getSkill(), sshSkill as unknown as SkillInstance);
    this.registerWithExecutor(webSkill.getSkill(), webSkill as unknown as SkillInstance);
    this.registerWithExecutor(jiraSkill.getSkill(), jiraSkill as unknown as SkillInstance);
    this.registerWithExecutor(serviceDeskSkill.getSkill(), serviceDeskSkill as unknown as SkillInstance);
    this.registerWithExecutor(networkSkill.getSkill(), networkSkill as unknown as SkillInstance);
    this.registerWithExecutor(usersSkill.getSkill(), usersSkill as unknown as SkillInstance);
    this.registerWithExecutor(certSkill.getSkill(), certSkill as unknown as SkillInstance);
    this.registerWithExecutor(alertSkill.getSkill(), alertSkill as unknown as SkillInstance);
    this.registerWithExecutor(proxmoxSkill.getSkill(), proxmoxSkill as unknown as SkillInstance);
    this.registerWithExecutor(networkScanSkill.getSkill(), networkScanSkill as unknown as SkillInstance);
    this.registerWithExecutor(systemUpdateSkill.getSkill(), systemUpdateSkill as unknown as SkillInstance);
    this.registerWithExecutor(logAggregatorSkill.getSkill(), logAggregatorSkill as unknown as SkillInstance);
    this.registerWithExecutor(workflowSkill.getSkill(), workflowSkill as unknown as SkillInstance);
    this.registerWithExecutor(runbookSkill.getSkill(), runbookSkill as unknown as SkillInstance);
    this.registerWithExecutor(delegationSkill.getSkill(), delegationSkill as unknown as SkillInstance);
    this.registerWithExecutor(rollbackSkill.getSkill(), rollbackSkill as unknown as SkillInstance);
    this.registerWithExecutor(databaseSkill.getSkill(), databaseSkill as unknown as SkillInstance);
    this.registerWithExecutor(dockerMgmtSkill.getSkill(), dockerMgmtSkill as unknown as SkillInstance);
    this.registerWithExecutor(kubernetesSkill.getSkill(), kubernetesSkill as unknown as SkillInstance);
    this.registerWithExecutor(cloudSkill.getSkill(), cloudSkill as unknown as SkillInstance);
    this.registerWithExecutor(incidentSkill.getSkill(), incidentSkill as unknown as SkillInstance);
  }

  /** Late-bind the canonical IncidentManager + RunbookEngine into the
   *  IncidentSkill so timeline writes / runbook triggers go through the same
   *  instances server.ts uses (and emit the same callbacks). The skill works
   *  without this — its constructor creates a fallback wired against the
   *  shared SQLite path — but onCreated/onCritical callbacks only fire on the
   *  server-owned instance, so callers wanting end-to-end observability should
   *  call this at boot. */
  wireIncidentTools(deps: {
    incidents?: IncidentManager;
    runbooks?: RunbookEngine;
    servers?: Pick<ServerRegistry, 'get'>;
    executor?: Pick<RemoteExecutor, 'execute'>;
  }): void {
    const exec = this.getExecutor('incident') as unknown as IncidentSkill | undefined;
    if (!exec) return;
    if (deps.incidents) exec.setIncidents(deps.incidents);
    if (deps.runbooks)  exec.setRunbooks(deps.runbooks);
    if (deps.servers) {
      exec.setServers(deps.servers);
      (this.getExecutor('kubernetes') as unknown as KubernetesSkill | undefined)?.setServers(deps.servers);
      (this.getExecutor('cloud') as unknown as CloudSkill | undefined)?.setServers(deps.servers);
      (this.getExecutor('database') as unknown as DatabaseSkill | undefined)?.setServers(deps.servers);
    }
    if (deps.executor) {
      exec.setExecutor(deps.executor);
      (this.getExecutor('kubernetes') as unknown as KubernetesSkill | undefined)?.setExecutor(deps.executor);
      (this.getExecutor('cloud') as unknown as CloudSkill | undefined)?.setExecutor(deps.executor);
      (this.getExecutor('database') as unknown as DatabaseSkill | undefined)?.setExecutor(deps.executor);
    }
  }

  registerWithExecutor(skill: Skill, executor: SkillInstance): void {
    this.skills.set(skill.id, skill);
    this.executors.set(skill.id, executor);
  }

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /**
   * Remove a registered skill + its executor. Returns true when something was
   * removed. Used by PluginLoader to swap reloaded plugins atomically without
   * leaving phantom command names in the dispatch table. The breaker for the
   * removed skill is also reset so the next registration starts clean.
   */
  unregister(skillId: string): boolean {
    const hadSkill    = this.skills.delete(skillId);
    const hadExecutor = this.executors.delete(skillId);
    if (hadSkill || hadExecutor) {
      try { this.circuitBreakers.reset(skillId); } catch { /* ignore */ }
      return true;
    }
    return false;
  }

  /** Built-in IDs registered in the constructor — PluginLoader refuses to
   *  unregister these so a malicious or buggy plugin can't crowd out a core
   *  skill. Computed from the current map at call time so any future built-in
   *  added to registerBuiltinSkills() is automatically protected. */
  isBuiltin(skillId: string): boolean {
    return this.builtinIds.has(skillId);
  }

  private readonly builtinIds: Set<string> = new Set();
  private snapshotBuiltins(): void {
    for (const id of this.skills.keys()) this.builtinIds.add(id);
  }

  /** Return the executor object backing a registered skill — used to inject
   *  late-bound dependencies (e.g. wiring DelegationSkill to an Organization
   *  after both have been constructed). */
  getExecutor(skillId: string): SkillInstance | undefined {
    return this.executors.get(skillId);
  }

  /** Convenience: wire DelegationSkill to an agent finder (typically the
   *  OrganizationManager) and optionally an auditor (e.g. AgentMessageBus) so
   *  delegate.* commands can resolve target agents and leave an audit trail.
   *  Until setFinder() is called, delegation handlers return a clear
   *  "unconfigured" fail() result rather than crashing. */
  wireDelegation(
    finder: import('./DelegationSkill.js').AgentFinder,
    options?: {
      auditor?: import('./DelegationSkill.js').DelegationAuditor;
      router?: import('./DelegationSkill.js').DelegationRouter;
    }
  ): void {
    const exec = this.getExecutor('delegation') as unknown as {
      setFinder(f: import('./DelegationSkill.js').AgentFinder): void;
      setAuditor(a: import('./DelegationSkill.js').DelegationAuditor): void;
      setRouter(r: import('./DelegationSkill.js').DelegationRouter): void;
    } | undefined;
    if (!exec) return;
    exec.setFinder(finder);
    if (options?.auditor) exec.setAuditor(options.auditor);
    if (options?.router) exec.setRouter(options.router);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  getByCategory(category: SkillCategory): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.category === category);
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  getEnabled(): Skill[] {
    return Array.from(this.skills.values()).filter(s => s.enabled);
  }

  enable(id: string): void {
    const skill = this.skills.get(id);
    if (skill) skill.enabled = true;
  }

  disable(id: string): void {
    const skill = this.skills.get(id);
    if (skill) skill.enabled = false;
  }

  getCommandsForSkill(skillId: string): Command[] {
    const skill = this.skills.get(skillId);
    return skill?.commands || [];
  }

  /** Return all commands for the given skill IDs (falls back to all enabled skills) */
  getCommandsForSkills(skillIds: string[]): Command[] {
    const ids = skillIds.length > 0 ? skillIds : Array.from(this.skills.keys());
    const commands: Command[] = [];
    for (const id of ids) {
      const skill = this.skills.get(id);
      if (skill?.enabled) commands.push(...skill.commands);
    }
    return commands;
  }

  findCommand(name: string): Command | undefined {
    for (const skill of this.skills.values()) {
      const command = skill.commands.find(c => c.name === name);
      if (command) return command;
    }
    return undefined;
  }

  /**
   * Execute a skill command by its dot-notation name (e.g. "bash.exec").
   *
   * Optional `context` is forwarded as the second argument so handlers that
   * need it (DelegationSkill in particular) can read the calling agent's
   * identity and the current delegation depth. Existing handlers ignore the
   * extra argument transparently.
   *
   * Wraps the call with the per-skill circuit breaker:
   *   - If the breaker is OPEN (or HALF_OPEN with no probe slots), short-
   *     circuit with a SkillResult-shaped fail() so the agent gets a clear
   *     observation rather than a thrown exception.
   *   - On execution, parse the SkillResult and report success/failure to
   *     the breaker so the state machine can advance.
   */
  async execute(
    commandName: string,
    params?: Record<string, unknown>,
    context?: SkillExecutionContext
  ): Promise<string> {
    for (const [skillId, skill] of this.skills.entries()) {
      const command = skill.commands.find(c => c.name === commandName);
      if (!command) continue;

      // Circuit-breaker gate. Blocked calls return immediately with a
      // SkillResult-encoded fail() so the ReAct loop sees a normal
      // observation it can act on.
      const verdict = this.circuitBreakers.canRun(skillId);
      if (!verdict.allowed) {
        skillLog.warn('circuit-breaker short-circuited call', {
          skillId,
          command: commandName,
          callerAgentId: context?.callerAgentId,
          taskId: context?.taskId,
          reopensAfterMs: verdict.reopensAfterMs,
        });
        return encode(fail(verdict.reason, 'circuit-open'));
      }

      const executor = this.executors.get(skillId);
      if (!executor) {
        this.circuitBreakers.recordFailure(skillId);
        throw new Error(`No executor registered for skill: ${skillId}`);
      }
      const handler = executor[command.handler];
      if (typeof handler !== 'function') {
        this.circuitBreakers.recordFailure(skillId);
        throw new Error(`Handler "${command.handler}" not found on skill "${skillId}"`);
      }

      // Per-skill-call span. Naming convention is "skill.<id>.<command>"
      // so a Jaeger view groups every call to a given skill cleanly.
      return withSpan(
        `skill.${skillId}.${command.handler}`,
        async (span) => {
          span.setAttribute('skill.id', skillId);
          span.setAttribute('skill.command', commandName);
          if (context?.callerAgentId) span.setAttribute('agent.id', context.callerAgentId);
          if (context?.callerAgentName) span.setAttribute('agent.name', context.callerAgentName);
          if (typeof context?.delegationDepth === 'number') {
            span.setAttribute('delegation.depth', context.delegationDepth);
          }

          let raw: string;
          try {
            raw = await handler.call(executor, params || {}, context);
          } catch (e) {
            // Hard exception → unconditional failure.
            this.circuitBreakers.recordFailure(skillId);
            const stateAfter = this.circuitBreakers.getState(skillId);
            skillLog.error('skill threw', {
              skillId,
              command: commandName,
              callerAgentId: context?.callerAgentId,
              taskId: context?.taskId,
              err: (e as Error)?.message,
              breakerState: stateAfter.state,
              consecutiveFailures: stateAfter.consecutiveFailures,
            });
            throw e;
          }

          // SkillResult is the standard handler return shape — parse it to
          // tell success from failure for the breaker. Non-JSON returns are
          // treated as success (the legacy prose path; counted optimistically).
          let resultOk = true;
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.ok === 'boolean') {
              resultOk = parsed.ok;
            }
          } catch { /* legacy prose */ }

          if (resultOk) this.circuitBreakers.recordSuccess(skillId);
          else this.circuitBreakers.recordFailure(skillId);
          span.setAttribute('skill.ok', resultOk);

          return raw;
        },
      );
    }
    throw new Error(`Unknown command: ${commandName}`);
  }
}

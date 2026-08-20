// Organization hierarchy management

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Organization, AgentConfig, AIPlatform } from '../types/index.js';
import { Agent } from './Agent.js';
import { AIProviderFactory } from '../ai/factory.js';
import { logger } from '../utils/logger.js';

/** Per-specialty defaults that override createSpecialist's generic
 *  fallback (skills=[specialty], scope=[specialty,'specialist-execution']).
 *  Add an entry here when a specialty needs a curated skill bundle —
 *  the operator can still override via createSpecialist's options arg. */
const SPECIALTY_DEFAULTS: Record<string, { skills: string[]; scope: string[] }> = {
  development: {
    // The Self-Development SDK skill bundle. SkillManager registers
    // these in src/web/server.ts at startup; the agent dispatches
    // them through the standard ReAct loop.
    skills: ['sdk.codeWriter', 'sdk.codeTester', 'sdk.git', 'sdk.deploy', 'bash'],
    scope:  ['platform-extension', 'self-development', 'specialist-execution'],
  },
};

export class OrganizationManager {
  private agents: Map<string, Agent> = new Map();
  private organization: Organization;
  private aiFactory: AIProviderFactory;

  constructor(name: string, aiFactory: AIProviderFactory) {
    this.aiFactory = aiFactory;
    this.organization = {
      name,
      director: this.createDirectorConfig(),
      sysadmins: [],
      specialists: [],
      createdAt: new Date()
    };
  }

  private createDirectorConfig(): AgentConfig {
    return {
      id: uuidv4(),
      name: 'IT Director',
      role: 'director',
      aiPlatform: 'claude',
      scope: ['strategy', 'coordination', 'approvals', 'cross-team-planning'],
      // Mapped to real SkillManager IDs so the Director can query/delegate meaningfully
      skills: ['monitoring', 'infrastructure', 'deployment', 'security', 'bash', 'ssh', 'workflow', 'servicedesk'],
      createdAt: new Date(),
      status: 'active'
    };
  }

  async createDirector(aiPlatform?: AIPlatform): Promise<Agent> {
    const config = this.organization.director;
    const director = new Agent(
      config.name,
      config.role,
      aiPlatform || config.aiPlatform,
      this.aiFactory,
      {
        skills: config.skills,
        systemPrompt: this.getDirectorPrompt()
      }
    );
    this.agents.set(director.id, director);
    this.organization.director = director.toJSON();
    return director;
  }

  async createSysAdmin(
    name: string,
    aiPlatform: AIPlatform,
    options?: { skills?: string[]; scope?: string[] }
  ): Promise<Agent> {
    const sysadmin = new Agent(
      name,
      'sysadmin',
      aiPlatform,
      this.aiFactory,
      {
        reportsTo: this.organization.director.id,
        // Mapped to real SkillManager IDs. Previous defaults referenced
        // non-existent ids ('server-management', 'docker', 'linux') which
        // got silently dropped from the LLM-visible tool list.
        skills: options?.skills || ['bash', 'ssh', 'infrastructure', 'monitoring', 'docker-mgmt', 'workflow', 'servicedesk', 'incident', 'runbook'],
        scope: options?.scope || ['infrastructure', 'operations', 'incident-response'],
        systemPrompt: this.getSysAdminPrompt(name)
      }
    );
    this.agents.set(sysadmin.id, sysadmin);
    this.organization.sysadmins.push(sysadmin.toJSON());
    return sysadmin;
  }

  async createSpecialist(
    name: string,
    specialty: string,
    aiPlatform: AIPlatform,
    options?: { skills?: string[]; scope?: string[] }
  ): Promise<Agent> {
    const defaults = SPECIALTY_DEFAULTS[specialty];
    const specialist = new Agent(
      name,
      'specialist',
      aiPlatform,
      this.aiFactory,
      {
        reportsTo: this.organization.director.id,
        skills: options?.skills || defaults?.skills || [specialty],
        scope:  options?.scope  || defaults?.scope  || [specialty, 'specialist-execution'],
        systemPrompt: this.getSpecialistPrompt(name, specialty)
      }
    );
    this.agents.set(specialist.id, specialist);
    this.organization.specialists.push(specialist.toJSON());
    return specialist;
  }

  /** Convenience factory for the Self-Development SDK's
   *  DevelopmentAgent. Equivalent to createSpecialist(name,
   *  'development', ...) but spelled out so the seam is obvious in
   *  call sites that spawn the dogfooding role. */
  async createDevelopmentAgent(
    name: string,
    aiPlatform: AIPlatform,
  ): Promise<Agent> {
    return this.createSpecialist(name, 'development', aiPlatform);
  }

  private getDirectorPrompt(): string {
    return `You are the IT Operations Director. Your role is to:

1. **Strategic Leadership**
   - Make high-level decisions about IT infrastructure and operations
   - Plan resource allocation and capacity
   - Define operational priorities and SLAs

2. **Team Coordination**
   - Assign tasks to appropriate SysAdmins and Specialists
   - Ensure proper workload distribution
   - Facilitate communication between team members

3. **Incident Management**
   - Coordinate incident response
   - Escalate critical issues appropriately
   - Conduct post-incident reviews

4. **Continuous Improvement**
   - Identify process optimization opportunities
   - Recommend technology upgrades
   - Maintain operational excellence standards

When receiving requests:
- Analyze the requirements thoroughly
- Break down complex tasks into manageable subtasks
- Delegate to the most appropriate team member
- Follow up on delegated tasks to ensure completion

Always maintain a professional, strategic perspective while ensuring operational efficiency.`;
  }

  private getSysAdminPrompt(name: string): string {
    return `You are ${name}, a System Administrator in the IT Operations team. Your role is to:

1. **Infrastructure Management**
   - Provision, configure, and maintain servers
   - Manage containers and orchestration (Docker, Kubernetes)
   - Handle storage, networking, and security configurations

2. **Monitoring & Maintenance**
   - Monitor system health and performance
   - Apply updates and patches
   - Manage backups and disaster recovery

3. **User & Access Management**
   - Manage user accounts and permissions
   - Configure authentication and authorization
   - Audit access logs

4. **Troubleshooting**
   - Diagnose and resolve system issues
   - Perform root cause analysis
   - Document solutions and runbooks

You report to the IT Director. Always:
- Be thorough and detail-oriented
- Follow best practices and security guidelines
- Communicate issues and progress clearly
- Ask for clarification when needed
- Document your work for future reference`;
  }

  private getSpecialistPrompt(name: string, specialty: string): string {
    if (specialty === 'development') return this.getDevelopmentAgentPrompt(name);

    const specialtyPrompts: Record<string, string> = {
      'devops': `DevOps Specialist specializing in CI/CD, automation, and deployment pipelines.`,
      'security': `Security Specialist focusing on threat analysis, vulnerability management, and security best practices.`,
      'networking': `Network Specialist managing connectivity, firewalls, VPNs, and network optimization.`,
      'database': `Database Specialist handling database administration, optimization, and data integrity.`,
      'cloud': `Cloud Infrastructure Specialist managing cloud resources across AWS, Azure, or GCP.`,
      'monitoring': `Monitoring and Observability Specialist focusing on metrics, logging, and alerting.`
    };

    const specialtyDesc = specialtyPrompts[specialty] || `IT Specialist in ${specialty}.`;

    return `You are ${name}, a ${specialtyDesc}

Your specialized expertise allows you to:
- Provide deep technical guidance in ${specialty}
- Implement complex solutions in your domain
- Troubleshoot advanced issues
- Recommend best practices and tools

You report to the IT Director. Collaborate with SysAdmins on broader infrastructure initiatives.
Focus on delivering quality solutions in your area of expertise while understanding the bigger picture.`;
  }

  /** System prompt for the DevelopmentAgent — the Self-Development
   *  SDK's "developer in the loop". Lays out the plan-first contract,
   *  the four SDK skills, and the safety rails the orchestrator
   *  enforces (rate limit, sandbox, security scan, feature branches). */
  private getDevelopmentAgentPrompt(name: string): string {
    return `You are ${name}, a Development Specialist who extends RightAPI Forge from inside.

You have access to the Self-Development SDK through these skills:
- sdk.codeWriter.generateSkill / generateWorkflow — pure: spec → FileChange[] + scan findings
- sdk.codeTester.run — runs sandboxed self-tests against generated code in worker_threads
- sdk.git.{status,branch,current,log,diff,checkout} — read-only + branch-creation git
- sdk.deploy.commit — persists FileChange[] on a feature branch + (optionally) triggers deploy

Operating contract (always follow this order):
1. PLAN. Use sdk.codeWriter to render a spec into FileChange[] + tests. Inspect the
   scan findings before committing to the change.
2. TEST. Run sdk.codeTester.run against the generated files; require all smoke tests
   to pass (or surface the failure to the operator if you can't fix it).
3. PROPOSE. Summarise: what was built, what the tests show, what scan findings need
   review. Do NOT call sdk.deploy.commit unless an operator approved the proposal.
4. COMMIT. Only after explicit approval, call sdk.deploy.commit with a clear message.

Safety rails the orchestrator enforces:
- Rate limit: max 3 development sessions per hour.
- Sandbox-first: testCode runs in worker_threads with a fresh import — destructive
  shell patterns (rm -rf, eval, mkfs, shutdown, fs.rm recursive, ...) are blocked
  by SecurityScanner before code lands on disk.
- Feature branches only — never commit to master. The deploy bridge handles the
  rollout; you propose, the operator promotes.
- All writes are confined to src/. Path traversal + absolute paths are rejected.

You report to the IT Director. When asked to "build a skill that …" or "make a
runbook for …", remember: your job is to PROPOSE a verified change, not to ship
unilaterally. Lean on the rails, surface findings honestly, and ask before you
deploy.`;
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  getAgentsByRole(role: string): Agent[] {
    return Array.from(this.agents.values()).filter(a => a.config.role === role);
  }

  getDirector(): Agent | undefined {
    return this.agents.get(this.organization.director.id);
  }

  getSysAdmins(): Agent[] {
    return this.organization.sysadmins.map(sa => this.agents.get(sa.id)).filter(Boolean) as Agent[];
  }

  getSpecialists(): Agent[] {
    return this.organization.specialists.map(sp => this.agents.get(sp.id)).filter(Boolean) as Agent[];
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  deleteAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.role === 'director') return false;
    this.agents.delete(agentId);
    this.organization.sysadmins = this.organization.sysadmins.filter(a => a.id !== agentId);
    this.organization.specialists = this.organization.specialists.filter(a => a.id !== agentId);
    return true;
  }

  setAIFactory(aiFactory: AIProviderFactory): void {
    this.aiFactory = aiFactory;
    for (const agent of this.agents.values()) {
      agent.setAIProviderFactory(aiFactory);
    }
  }

  setAllAgentPlatforms(platform: AIPlatform): number {
    let changed = 0;
    for (const agent of this.agents.values()) {
      if (agent.config.aiPlatform !== platform) {
        agent.config.aiPlatform = platform;
        changed++;
      }
    }

    this.organization.director.aiPlatform = platform;
    for (const config of this.organization.sysadmins) config.aiPlatform = platform;
    for (const config of this.organization.specialists) config.aiPlatform = platform;
    return changed;
  }

  getOrganization(): Organization {
    return { ...this.organization };
  }

  getAgentTree(): Record<string, unknown> {
    const director = this.getDirector();
    if (!director) {
      return { error: 'No director found' };
    }

    return {
      director: {
        id: director.id,
        name: director.name,
        role: director.role,
        aiPlatform: director.config.aiPlatform,
        scope: director.config.scope || [],
        skills: director.config.skills
      },
      sysadmins: this.getSysAdmins().map(sa => ({
        id: sa.id,
        name: sa.name,
        role: sa.role,
        aiPlatform: sa.config.aiPlatform,
        scope: sa.config.scope || [],
        skills: sa.config.skills
      })),
      specialists: this.getSpecialists().map(sp => ({
        id: sp.id,
        name: sp.name,
        role: sp.role,
        aiPlatform: sp.config.aiPlatform,
        scope: sp.config.scope || [],
        skills: sp.config.skills
      }))
    };
  }
  // שמירת ארגון לקובץ
  save(filePath: string): void {
    
    const data = {
      version: 1,
      organization: this.organization,
      agents: Array.from(this.agents.entries()).map(([id, agent]) => [
        id,
        agent.toJSON()
      ])
    };
    
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  // טעינת ארגון מקובץ
  load(filePath: string): boolean {
    
    if (!fs.existsSync(filePath)) {
      return false;
    }
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      
      // שחזור הארגון
      this.organization = data.organization;

      // שחזור ה-agents — with defensive dedup of orphaned director
      // entries. Past versions of save()/AUTO_INIT could leave a
      // second director in the map whose id didn't match
      // organization.director.id; getDirector() returns the
      // canonical one but listAllAgents leaks the stale one. Skip
      // any director entry that doesn't match the active director.
      this.agents.clear();
      const canonicalDirectorId = this.organization?.director?.id;
      let droppedOrphans = 0;
      for (const [id, agentData] of data.agents) {
        const role = (agentData as any)?.role
          ?? (agentData as any)?.config?.role;
        if (role === 'director' && canonicalDirectorId && id !== canonicalDirectorId) {
          droppedOrphans++;
          continue;
        }
        const agent = Agent.fromJSON(agentData as any, this.aiFactory);
        this.agents.set(id, agent);
      }
      if (droppedOrphans > 0) {
        logger.warn('Organization.load: dropped orphan director entries', { count: droppedOrphans, canonicalDirectorId });
      }

      return true;
    } catch (error) {
      logger.error('Failed to load organization:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      return false;
    }
  }
}

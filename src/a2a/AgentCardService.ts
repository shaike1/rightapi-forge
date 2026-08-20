import type { OrganizationManager } from '../agents/Organization.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type {
  A2AAgentCard,
  A2ASkillCard,
  A2ASystemCard,
} from './A2ATypes.js';

const PROTOCOL_VERSION = 'a2a/1.0';
const PLATFORM_VERSION = '1.0.0';

const ROLE_DESCRIPTIONS: Record<string, string> = {
  director: 'IT Operations Director — orchestrates the agent mesh, delegates tasks, escalates critical issues, maintains situational awareness across all domains.',
  sysadmin: 'System Administrator — handles infrastructure monitoring, server management, deployments, backups, and routine IT operations.',
  specialist: 'Domain Specialist — provides deep expertise in a specific IT domain such as security, networking, cloud, or Microsoft 365.',
};

export class AgentCardService {
  private organization: OrganizationManager;
  private skillManager: SkillManager;
  private baseUrl: string;

  constructor(organization: OrganizationManager, skillManager: SkillManager) {
    this.organization = organization;
    this.skillManager = skillManager;
    this.baseUrl = (process.env.PUBLIC_URL || 'http://localhost:19123').replace(/\/$/, '');
  }

  // Map a skill ID + its commands to an A2A skill card
  private buildSkillCard(skillId: string): A2ASkillCard {
    const skill = this.skillManager.get(skillId);
    if (!skill) {
      return {
        id: skillId,
        name: skillId,
        description: `Skill: ${skillId}`,
        tags: [],
        examples: [],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      };
    }

    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [skill.category],
      examples: (skill.commands || []).slice(0, 5).map(c => c.name),
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['text/plain', 'application/json'],
    };
  }

  // Generate an A2A Agent Card for a single agent
  getAgentCard(agentId: string): A2AAgentCard | null {
    const agent = this.organization.getAgent(agentId);
    if (!agent) return null;

    const role: string = (agent.config?.role || agent.role || 'sysadmin') as string;
    const name: string = agent.config?.name || (agent as any).name || agentId;
    const skillIds: string[] = agent.config?.skills || (agent as any).skills || [];

    const skillCards = skillIds
      .map(id => this.buildSkillCard(id))
      .filter(Boolean);

    return {
      name,
      description: ROLE_DESCRIPTIONS[role] || `IT Operations agent — role: ${role}`,
      url: `${this.baseUrl}/a2a/agents/${agentId}`,
      provider: {
        organization: 'itops-agents',
        url: this.baseUrl,
      },
      version: PLATFORM_VERSION,
      documentationUrl: `${this.baseUrl}/a2a.html`,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      authentication: {
        schemes: ['Bearer'],
        credentials: `${this.baseUrl}/api/auth/login`,
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: skillCards,
      metadata: {
        agentId,
        role,
        platform: agent.config?.aiPlatform || (agent as any).aiPlatform || 'claude',
        status: agent.config?.status || 'active',
        reportsTo: agent.config?.reportsTo || null,
      },
    };
  }

  // All agent cards (active agents only)
  getAllAgentCards(): A2AAgentCard[] {
    return this.organization
      .getAllAgents()
      .filter(a => (a.config?.status || 'active') === 'active')
      .map(a => this.getAgentCard(a.config?.id || (a as any).id))
      .filter((c): c is A2AAgentCard => c !== null);
  }

  // System-level card — represents the whole platform
  getSystemCard(): A2ASystemCard {
    const agentCards = this.getAllAgentCards();
    const allSkills = this.skillManager.getEnabled();

    // Deduplicate skills across agents for the system card
    const systemSkills: A2ASkillCard[] = allSkills.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [skill.category],
      examples: (skill.commands || []).slice(0, 5).map(c => c.name),
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['text/plain', 'application/json'],
    }));

    return {
      name: 'itops-agents',
      description: 'Self-hosted IT Operations Agent Mesh — autonomous multi-agent platform with A2A protocol support. Manages infrastructure, incidents, runbooks, workflows, and Jira integration.',
      url: `${this.baseUrl}/a2a/agents`,
      provider: {
        organization: 'itops-agents',
        url: this.baseUrl,
      },
      version: PLATFORM_VERSION,
      documentationUrl: `${this.baseUrl}/a2a.html`,
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      authentication: {
        schemes: ['Bearer'],
        credentials: `${this.baseUrl}/api/auth/login`,
      },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: systemSkills,
      agents: agentCards,
      totalAgents: agentCards.length,
      totalSkills: systemSkills.length,
      protocol: PROTOCOL_VERSION,
      metadata: {
        protocol: PROTOCOL_VERSION,
        generatedAt: new Date().toISOString(),
        endpoints: {
          discovery: `${this.baseUrl}/.well-known/agent.json`,
          agents: `${this.baseUrl}/a2a/agents`,
          login: `${this.baseUrl}/api/auth/login`,
        },
      },
    };
  }
}

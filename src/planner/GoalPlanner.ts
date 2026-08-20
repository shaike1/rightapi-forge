import { v4 as uuidv4 } from 'uuid';
import type { AIProviderFactory } from '../ai/factory.js';

export interface PlanNode {
  id: string;
  task: string;
  description: string;
  assignedAgent?: string;
  requiredSkills: string[];
  deps: string[]; // node IDs this depends on
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  retries: number;
}

export interface Plan {
  id: string;
  goal: string;
  nodes: PlanNode[];
  status: 'planning' | 'running' | 'done' | 'failed' | 'paused';
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  createdBy?: string;
  progress: number; // 0-100
}

export class GoalPlanner {
  constructor(private aiFactory: AIProviderFactory) {}

  async decompose(
    goal: string,
    context: { availableAgents: string[]; availableSkills: string[] }
  ): Promise<Plan> {
    const provider = await this.aiFactory.getDefaultProvider();

    const agentList = context.availableAgents.length
      ? context.availableAgents.join(', ')
      : 'Alice (SysAdmin), Bob (SysAdmin), Eve (SysAdmin), Charlie (Specialist), Diana (Specialist)';

    const skillList = context.availableSkills.length
      ? context.availableSkills.join(', ')
      : 'monitoring, security, backup, networking, deployment, database, performance, bash, ssh, infrastructure';

    const prompt = `You are an expert IT operations planner. Decompose the following goal into an actionable task DAG (directed acyclic graph).

GOAL: "${goal}"

AVAILABLE AGENTS: ${agentList}
AVAILABLE SKILLS: ${skillList}

Rules:
- Create 3-8 specific, actionable tasks
- Each task must be completable by one agent
- deps array contains IDs of tasks that must complete BEFORE this task starts
- Assign the most appropriate agent to each task based on their role/skills
- Be specific about what each task does

Respond with ONLY valid JSON in this exact format:
{
  "nodes": [
    {
      "id": "n1",
      "task": "short task title (max 60 chars)",
      "description": "detailed description of exactly what to do",
      "assignedAgent": "agent name or null",
      "requiredSkills": ["skill1"],
      "deps": []
    }
  ]
}`;

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an IT ops planner. Return valid JSON only. No markdown fences.',
      maxTokens: 1024,
      temperature: 0.3,
    });

    const clean = response.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    const parsed = JSON.parse(clean) as { nodes: Omit<PlanNode, 'status' | 'retries'>[] };

    const nodes: PlanNode[] = parsed.nodes.map((n) => ({
      ...n,
      status: 'pending',
      retries: 0,
    }));

    const now = new Date();
    return {
      id: uuidv4(),
      goal,
      nodes,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      progress: 0,
    };
  }

  computeProgress(plan: Plan): number {
    if (plan.nodes.length === 0) return 0;
    const done = plan.nodes.filter((n) => n.status === 'done' || n.status === 'skipped').length;
    return Math.round((done / plan.nodes.length) * 100);
  }

  getReadyNodes(plan: Plan): PlanNode[] {
    return plan.nodes.filter((node) => {
      if (node.status !== 'pending') return false;
      return node.deps.every((depId) => {
        const dep = plan.nodes.find((n) => n.id === depId);
        return dep?.status === 'done' || dep?.status === 'skipped';
      });
    });
  }

  isComplete(plan: Plan): boolean {
    return plan.nodes.every((n) =>
      ['done', 'failed', 'skipped'].includes(n.status)
    );
  }

  hasFailed(plan: Plan): boolean {
    return plan.nodes.some((n) => n.status === 'failed');
  }
}

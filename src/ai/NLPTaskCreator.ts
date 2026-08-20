import type { AIProviderFactory } from './factory.js';

export interface ParsedTask {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  suggestedAgent?: string;
  requiredSkills: string[];
  estimatedDuration: string;
  tags: string[];
  confidence: number;
}

export interface NLPTaskResult {
  parsed: ParsedTask;
  taskId?: string;
  created: boolean;
  raw: string;
}

export class NLPTaskCreator {
  constructor(private factory: AIProviderFactory) {}

  async parse(input: string, availableAgents: string[] = [], availableSkills: string[] = []): Promise<ParsedTask> {
    const provider = await this.factory.getDefaultProvider();

    const prompt = `You are an IT operations task manager. Parse this natural language request into a structured task.

REQUEST: "${input}"

AVAILABLE AGENTS: ${availableAgents.length ? availableAgents.join(', ') : 'Alice, Bob, Eve, Charlie, Diana'}
AVAILABLE SKILLS: ${availableSkills.length ? availableSkills.join(', ') : 'monitoring, security, backup, networking, deployment, database, performance'}

Respond with ONLY valid JSON:
{
  "title": "concise task title (max 60 chars)",
  "description": "detailed description of what needs to be done",
  "priority": "low|medium|high|critical",
  "suggestedAgent": "best agent name or null",
  "requiredSkills": ["skill1", "skill2"],
  "estimatedDuration": "e.g. 30 minutes, 2 hours",
  "tags": ["tag1", "tag2"],
  "confidence": 0.0-1.0
}`;

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an IT ops task parser. Return valid JSON only.',
      maxTokens: 512,
      temperature: 0.2,
    });

    const clean = response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(clean) as ParsedTask;
  }

  async suggest(context: { currentTasks: any[]; agentWorkload: Record<string, number> }): Promise<string[]> {
    const provider = await this.factory.getDefaultProvider();

    const prompt = `Based on current IT operations context, suggest 3-5 proactive tasks.

CURRENT TASKS: ${context.currentTasks.map(t => `[${t.status}] ${t.title}`).join('; ') || 'none'}
AGENT WORKLOAD: ${JSON.stringify(context.agentWorkload)}

Respond with JSON array of suggestion strings only:
["suggestion 1", "suggestion 2", ...]`;

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an IT ops advisor. Return JSON array only.',
      maxTokens: 256,
      temperature: 0.5,
    });

    const clean = response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(clean) as string[];
  }
}

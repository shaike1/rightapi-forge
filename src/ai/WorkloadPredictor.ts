import type { AIProviderFactory } from './factory.js';

export interface WorkloadPrediction {
  agentId: string;
  currentLoad: number;        // 0-100
  predictedLoad1h: number;
  predictedLoad4h: number;
  predictedLoad24h: number;
  recommendation: 'available' | 'busy' | 'overloaded' | 'idle';
  bestForTask?: boolean;
  reason: string;
}

export interface AssignmentRecommendation {
  recommendedAgent: string;
  confidence: number;
  alternativeAgents: string[];
  reasoning: string;
  predictions: WorkloadPrediction[];
}

export class WorkloadPredictor {
  constructor(private factory: AIProviderFactory) {}

  async predict(agents: any[], tasks: any[], targetTask?: any): Promise<AssignmentRecommendation> {
    const provider = await this.factory.getDefaultProvider();

    const agentSummary = agents.map(a => ({
      id: a.id || a.name,
      name: a.name,
      status: a.status,
      skills: a.skills || [],
      activeTasks: tasks.filter(t => t.assignedAgent === (a.id || a.name) && t.status === 'in-progress').length,
      completedToday: tasks.filter(t => t.assignedAgent === (a.id || a.name) && t.status === 'completed').length,
    }));

    const taskSummary = targetTask ? {
      title: targetTask.title,
      priority: targetTask.priority,
      requiredSkills: targetTask.requiredSkills || [],
    } : null;

    const prompt = `You are an IT operations workload balancer. Analyze agent capacity and recommend optimal assignment.

AGENTS:
${JSON.stringify(agentSummary, null, 2)}

RECENT TASKS COUNT: ${tasks.length}

${taskSummary ? `TARGET TASK:\n${JSON.stringify(taskSummary, null, 2)}` : 'Provide general workload analysis.'}

Respond with ONLY valid JSON:
{
  "recommendedAgent": "agent name",
  "confidence": 0.0-1.0,
  "alternativeAgents": ["agent2", "agent3"],
  "reasoning": "explanation",
  "predictions": [
    {
      "agentId": "name",
      "currentLoad": 0-100,
      "predictedLoad1h": 0-100,
      "predictedLoad4h": 0-100,
      "predictedLoad24h": 0-100,
      "recommendation": "available|busy|overloaded|idle",
      "bestForTask": true|false,
      "reason": "brief reason"
    }
  ]
}`;

    const response = await provider.chat({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are an IT workload optimizer. Return valid JSON only.',
      maxTokens: 1024,
      temperature: 0.3,
    });

    const clean = response.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    return JSON.parse(clean) as AssignmentRecommendation;
  }
}

// Smart Task Assignment Service

import { MemoryIntegration } from '../automation/MemoryIntegration.js';

export interface AgentScore {
  agentId: string;
  agentName: string;
  role: string;
  score: number;
  reasons: string[];
  metrics: {
    successRate: number;
    totalInteractions: number;
    relevantExperience: number;
    currentWorkload: number;
  };
}

export interface TaskRecommendation {
  taskId: string;
  taskTitle: string;
  taskCategory: string;
  priority: string;
  topAgents: AgentScore[];
  recommendedAgent: AgentScore;
}

export class TaskAssignment {
  private static instance: TaskAssignment;
  private memory: MemoryIntegration;
  private agentWorkload: Map<string, number>;

  private constructor() {
    this.memory = MemoryIntegration.getInstance();
    this.agentWorkload = new Map();
  }

  static getInstance(): TaskAssignment {
    if (!TaskAssignment.instance) {
      TaskAssignment.instance = new TaskAssignment();
    }
    return TaskAssignment.instance;
  }

  setAgentWorkload(agentId: string, workload: number): void {
    this.agentWorkload.set(agentId, workload);
  }

  getAgentWorkload(agentId: string): number {
    return this.agentWorkload.get(agentId) || 0;
  }

  scoreAgent(
    agentId: string,
    agentName: string,
    agentRole: string,
    taskCategory: string,
    taskPriority: string,
    skills: string[] = []
  ): AgentScore {
    let score = 0;
    const reasons: string[] = [];

    const insights = this.memory.getLearningInsights(agentId);
    const workload = this.getAgentWorkload(agentId);

    // 1. Success Rate (0-30 points)
    if (insights.totalInteractions > 0) {
      const successRate = insights.successRate;
      const successScore = (successRate / 100) * 30;
      score += successScore;
      reasons.push(`Success rate: ${successRate}%`);
    } else {
      score += 15;
      reasons.push('No track record - neutral');
    }

    // 2. Role and Capacity (0-25 points)
    const roleScores: Record<string, number> = {
      'director': 15,
      'sysadmin': 25,
      'specialist': 20,
      'assistant': 10
    };
    const roleScore = roleScores[agentRole] || 15;
    score += roleScore;
    reasons.push(`Role capacity: ${agentRole}`);

    // 3. Task Experience (0-20 points)
    const relevantTasks = insights.mostCommonTasks.filter((t: string) => 
      t.toLowerCase().includes(taskCategory.toLowerCase()) ||
      taskCategory.toLowerCase().includes(t.toLowerCase())
    );
    
    const experienceScore = Math.min(relevantTasks.length * 10, 20);
    score += experienceScore;
    
    if (relevantTasks.length > 0) {
      reasons.push(`Relevant experience: ${relevantTasks.length} similar tasks`);
    }

    // 4. Skill Match (0-20 points)
    const matchedSkills = skills.filter(skill => 
      skill.toLowerCase().includes(taskCategory.toLowerCase()) ||
      taskCategory.toLowerCase().includes(skill.toLowerCase())
    );
    const skillScore = Math.min(matchedSkills.length * 5, 20);
    score += skillScore;
    
    if (matchedSkills.length > 0) {
      reasons.push(`Skills match: ${matchedSkills.join(', ')}`);
    }

    // 5. Workload Adjustment (-15 to +10 points)
    if (workload === 0) {
      score += 10;
      reasons.push('Available (no current tasks)');
    } else if (workload <= 2) {
      score += 5;
      reasons.push(`Light workload: ${workload} active tasks`);
    } else if (workload <= 5) {
      reasons.push(`Moderate workload: ${workload} active tasks`);
    } else {
      score -= 10;
      reasons.push(`Heavy workload: ${workload} active tasks`);
    }

    // 6. Priority Bonus (0-15 points for high-priority matching)
    if (taskPriority === 'critical' && agentRole === 'sysadmin') {
      score += 15;
      reasons.push('Critical task + sysadmin role match');
    } else if (taskPriority === 'high' && (agentRole === 'sysadmin' || agentRole === 'specialist')) {
      score += 10;
      reasons.push('High-priority task + qualified role');
    }

    // 7. Activity Bonus (0-10 points)
    if (insights.recentTrends.includes('High activity')) {
      score += 5;
      reasons.push('Recently active');
    }
    if (insights.recentTrends.includes('High success rate')) {
      score += 5;
      reasons.push('Recent high performance');
    }

    // Cap score at 100
    score = Math.min(Math.max(score, 0), 100);

    return {
      agentId,
      agentName,
      role: agentRole,
      score: Math.round(score),
      reasons,
      metrics: {
        successRate: insights.successRate,
        totalInteractions: insights.totalInteractions,
        relevantExperience: relevantTasks.length,
        currentWorkload: workload
      }
    };
  }

  getRecommendation(
    agents: Array<{ id: string; name: string; role: string; skills?: string[] }>,
    taskId: string,
    taskTitle: string,
    taskCategory: string,
    priority: string
  ): TaskRecommendation {
    const scores = agents.map(agent => 
      this.scoreAgent(
        agent.id,
        agent.name,
        agent.role,
        taskCategory,
        priority,
        agent.skills || []
      )
    );

    // Sort by score (descending)
    scores.sort((a, b) => b.score - a.score);

    return {
      taskId,
      taskTitle,
      taskCategory,
      priority,
      topAgents: scores,
      recommendedAgent: scores[0]
    };
  }
}

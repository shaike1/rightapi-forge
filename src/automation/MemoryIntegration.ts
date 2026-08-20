// Memory Integration Service

import { AutomationEngine } from './AutomationEngine.js';

export interface InteractionContext {
  agentId: string;
  agentName: string;
  message: string;
  response: string;
  success: boolean;
}

export class MemoryIntegration {
  private static instance: MemoryIntegration;
  private engine: AutomationEngine;

  private constructor() {
    this.engine = AutomationEngine.getInstance();
  }

  static getInstance(): MemoryIntegration {
    if (!MemoryIntegration.instance) {
      MemoryIntegration.instance = new MemoryIntegration();
    }
    return MemoryIntegration.instance;
  }

  recordInteraction(ctx: InteractionContext): void {
    const { agentId, message, success } = ctx;

    let type: "task" | "chat" | "command" = "chat";
    if (message.toLowerCase().includes("deploy")) {
      type = "command";
    } else if (message.toLowerCase().includes("task")) {
      type = "task";
    }

    const summary = (success ? "+" : "-") + " " + message.substring(0, 50);

    this.engine.recordInteraction(agentId, {
      timestamp: new Date(),
      type,
      summary,
      success
    });
  }

  getLearningInsights(agentId: string): {
    totalInteractions: number;
    successRate: number;
    mostCommonTasks: string[];
    recentTrends: string[];
  } {
    const all = this.engine.getRecentInteractions(agentId, 100);

    const successCount = all.filter((i: any) => i.success).length;
    const successRate = all.length > 0 ? (successCount / all.length) * 100 : 0;

    const tasks = all.filter((i: any) => i.type === "task").map((i: any) => i.summary);

    const taskCounts: Record<string, number> = {};
    tasks.forEach((t: string) => {
      taskCounts[t] = (taskCounts[t] || 0) + 1;
    });

    const mostCommonTasks = Object.entries(taskCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t]) => t);

    const recent = all.slice(-10);
    const recentSuccess = recent.filter((i: any) => i.success).length;
    const recentTrends: string[] = [];

    if (recent.length >= 8) {
      recentTrends.push("High activity");
    }

    if (recent.length > 0 && (recentSuccess / recent.length) * 100 >= 90) {
      recentTrends.push("High success rate");
    }

    return {
      totalInteractions: all.length,
      successRate: Math.round(successRate),
      mostCommonTasks,
      recentTrends
    };
  }
}

import { v4 as uuidv4 } from 'uuid';

// ── NLP Task Parser ──────────────────────────────────────────────────────────

export interface ParsedTask {
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  suggestedAgent?: string;
  suggestedSkills: string[];
  estimatedDurationMin: number;
  tags: string[];
  confidence: number;
}

const PRIORITY_KEYWORDS = {
  critical: ['urgent', 'critical', 'asap', 'immediately', 'down', 'outage', 'broken', 'emergency', 'פתאומי', 'קריטי', 'דחוף'],
  high: ['high', 'important', 'soon', 'today', 'needed', 'required', 'must', 'חשוב', 'מהר'],
  low: ['low', 'whenever', 'eventually', 'sometime', 'backlog', 'נמוך', 'בהמשך']
};

const SKILL_PATTERNS: Array<{ pattern: RegExp; skills: string[]; agent?: string; durationMin: number }> = [
  { pattern: /deploy|release|rollout|push to (prod|staging)/i, skills: ['deploy', 'ci-cd'], agent: 'DevOps', durationMin: 30 },
  { pattern: /backup|snapshot|dump|archive/i, skills: ['backup', 'storage'], agent: 'SysAdmin', durationMin: 20 },
  { pattern: /monitor|alert|check health|status|uptime/i, skills: ['health-check', 'monitoring'], agent: 'SysAdmin', durationMin: 10 },
  { pattern: /security|vuln|cve|patch|pentest|audit/i, skills: ['security-scan', 'compliance'], agent: 'Security', durationMin: 60 },
  { pattern: /database|db|sql|query|migration|index/i, skills: ['database', 'backup'], agent: 'DBA', durationMin: 45 },
  { pattern: /docker|container|k8s|kubernetes|pod|namespace/i, skills: ['docker-mgmt', 'kubernetes'], agent: 'DevOps', durationMin: 25 },
  { pattern: /log|trace|debug|diagnose|investigate/i, skills: ['log-analysis', 'diagnostics'], agent: 'SysAdmin', durationMin: 30 },
  { pattern: /scale|autoscal|load|traffic|performance/i, skills: ['scaling', 'load-balancer'], agent: 'DevOps', durationMin: 20 },
  { pattern: /cert|ssl|tls|https|certificate/i, skills: ['certificates', 'security'], agent: 'Security', durationMin: 15 },
  { pattern: /ci\/cd|pipeline|build|test|jest|mocha/i, skills: ['ci-cd', 'testing'], agent: 'DevOps', durationMin: 40 },
  { pattern: /restart|reboot|service|daemon|systemd/i, skills: ['service-mgmt'], agent: 'SysAdmin', durationMin: 5 },
  { pattern: /disk|storage|space|cleanup|prune/i, skills: ['disk-mgmt', 'cleanup'], agent: 'SysAdmin', durationMin: 15 }
];

export function parseNaturalLanguageTask(input: string): ParsedTask {
  const lower = input.toLowerCase();

  // Priority detection
  let priority: ParsedTask['priority'] = 'medium';
  let priorityConfidence = 0;
  for (const [p, keywords] of Object.entries(PRIORITY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        priority = p as ParsedTask['priority'];
        priorityConfidence += 0.2;
        break;
      }
    }
  }

  // Skill + agent detection
  const matchedSkills: string[] = [];
  let suggestedAgent: string | undefined;
  let estimatedDurationMin = 15;
  let skillConfidence = 0;

  for (const sp of SKILL_PATTERNS) {
    if (sp.pattern.test(input)) {
      matchedSkills.push(...sp.skills);
      if (sp.agent && !suggestedAgent) suggestedAgent = sp.agent;
      estimatedDurationMin = Math.max(estimatedDurationMin, sp.durationMin);
      skillConfidence += 0.3;
    }
  }

  // Deduplicate skills
  const skills = [...new Set(matchedSkills)];

  // Extract tags (words > 4 chars that aren't stopwords)
  const stopwords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'need', 'please', 'should', 'could', 'would', 'make', 'sure', 'also', 'then', 'when', 'they', 'them', 'their']);
  const tags = input
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/gi, '').toLowerCase())
    .filter(w => w.length > 4 && !stopwords.has(w))
    .slice(0, 5);

  // Generate title from first sentence / meaningful phrase
  const title = extractTitle(input);
  const description = input.trim();

  const confidence = Math.min(0.95, 0.5 + priorityConfidence + Math.min(skillConfidence, 0.4));

  return {
    title,
    description,
    priority,
    suggestedAgent,
    suggestedSkills: skills,
    estimatedDurationMin,
    tags,
    confidence
  };
}

function extractTitle(input: string): string {
  // Use first sentence or first 60 chars
  const sentence = input.split(/[.!?\n]/)[0].trim();
  return sentence.length > 60 ? sentence.slice(0, 57) + '...' : sentence;
}

// ── Smart Task Routing ────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  role: string;
  skills: string[];
  currentLoad: number; // 0-1
  available: boolean;
}

export interface RoutingDecision {
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  alternatives: Array<{ agentId: string; agentName: string; score: number }>;
}

export function smartRoute(task: ParsedTask, agents: Agent[]): RoutingDecision | null {
  const available = agents.filter(a => a.available);
  if (!available.length) return null;

  const scored = available.map(agent => {
    let score = 0;

    // Skill match (40%)
    const skillMatch = task.suggestedSkills.filter(s => agent.skills.includes(s)).length;
    score += (skillMatch / Math.max(task.suggestedSkills.length, 1)) * 40;

    // Role match (30%)
    if (task.suggestedAgent && agent.role.toLowerCase().includes(task.suggestedAgent.toLowerCase())) {
      score += 30;
    } else if (task.suggestedAgent && agent.name.toLowerCase().includes(task.suggestedAgent.toLowerCase())) {
      score += 20;
    }

    // Load balancing (30%) — prefer less loaded agents
    score += (1 - agent.currentLoad) * 30;

    // Priority boost — for critical tasks, pick the most skilled regardless of load
    if (task.priority === 'critical') {
      score += skillMatch * 10;
    }

    return { agent, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  const skillMatch = task.suggestedSkills.filter(s => best.agent.skills.includes(s));
  const reason = skillMatch.length > 0
    ? `Best match for skills: ${skillMatch.join(', ')} (load: ${Math.round(best.agent.currentLoad * 100)}%)`
    : `Lowest load agent (${Math.round(best.agent.currentLoad * 100)}%)`;

  return {
    agentId: best.agent.id,
    agentName: best.agent.name,
    reason,
    score: Math.round(best.score),
    alternatives: scored.slice(1, 3).map(s => ({
      agentId: s.agent.id,
      agentName: s.agent.name,
      score: Math.round(s.score)
    }))
  };
}

// ── Agent Memory ──────────────────────────────────────────────────────────────

export interface AgentMemoryEntry {
  id: string;
  agentId: string;
  type: 'task-outcome' | 'preference' | 'skill-learned' | 'pattern';
  content: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  relevanceScore: number;
}

export class AgentMemory {
  private entries: Map<string, AgentMemoryEntry[]> = new Map(); // agentId -> entries

  remember(agentId: string, entry: Omit<AgentMemoryEntry, 'id' | 'createdAt'>): void {
    if (!this.entries.has(agentId)) this.entries.set(agentId, []);
    const list = this.entries.get(agentId)!;
    list.push({ ...entry, id: uuidv4(), createdAt: new Date() });
    // Keep last 100 per agent
    if (list.length > 100) list.splice(0, list.length - 100);
  }

  recall(agentId: string, query?: string, limit = 10): AgentMemoryEntry[] {
    const list = this.entries.get(agentId) || [];
    let results = [...list];

    if (query) {
      const q = query.toLowerCase();
      results = results.filter(e =>
        e.content.toLowerCase().includes(q) ||
        JSON.stringify(e.metadata || {}).toLowerCase().includes(q)
      );
    }

    return results
      .sort((a, b) => b.relevanceScore - a.relevanceScore || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  getInsights(agentId: string) {
    const list = this.entries.get(agentId) || [];
    const outcomes = list.filter(e => e.type === 'task-outcome');
    const success = outcomes.filter(e => e.metadata?.success).length;
    const patterns = list.filter(e => e.type === 'pattern');

    return {
      totalMemories: list.length,
      taskOutcomes: outcomes.length,
      successRate: outcomes.length ? Math.round((success / outcomes.length) * 100) : 0,
      learnedPatterns: patterns.length,
      recentActivity: list.slice(-5).map(e => ({ type: e.type, content: e.content.slice(0, 80), at: e.createdAt }))
    };
  }

  getAllAgentInsights() {
    const result: Record<string, any> = {};
    this.entries.forEach((_, agentId) => {
      result[agentId] = this.getInsights(agentId);
    });
    return result;
  }
}

// ── Workload Predictor ────────────────────────────────────────────────────────

export interface WorkloadPrediction {
  agentId: string;
  currentLoad: number;
  predictedLoad1h: number;
  predictedLoad4h: number;
  recommendation: 'scale-up' | 'scale-down' | 'optimal' | 'critical';
  pendingTasks: number;
}

export function predictWorkload(
  agents: Agent[],
  taskQueue: Array<{ priority: string; agentId?: string }>
): WorkloadPrediction[] {
  return agents.map(agent => {
    const assigned = taskQueue.filter(t => t.agentId === agent.id);
    const criticalPending = assigned.filter(t => t.priority === 'critical').length;
    const totalPending = assigned.length;

    const predictedLoad1h = Math.min(1, agent.currentLoad + totalPending * 0.1);
    const predictedLoad4h = Math.min(1, predictedLoad1h * 0.8); // assumption: tasks complete

    let recommendation: WorkloadPrediction['recommendation'];
    if (agent.currentLoad > 0.85 || criticalPending > 2) recommendation = 'critical';
    else if (predictedLoad1h > 0.7) recommendation = 'scale-up';
    else if (agent.currentLoad < 0.2 && totalPending === 0) recommendation = 'scale-down';
    else recommendation = 'optimal';

    return {
      agentId: agent.id,
      currentLoad: Math.round(agent.currentLoad * 100),
      predictedLoad1h: Math.round(predictedLoad1h * 100),
      predictedLoad4h: Math.round(predictedLoad4h * 100),
      recommendation,
      pendingTasks: totalPending
    };
  });
}

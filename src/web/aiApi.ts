import express from 'express';
import { parseNaturalLanguageTask, smartRoute, AgentMemory, predictWorkload, Agent } from '../ai/AIIntelligence.js';

// Shared agent memory instance
export const agentMemory = new AgentMemory();

// Mock agent data (in production, this would come from AgentManager)
function getMockAgents(): Agent[] {
  return [
    { id: 'director', name: 'IT Director', role: 'Director', skills: ['orchestration', 'planning', 'monitoring'], currentLoad: 0.3, available: true },
    { id: 'alice', name: 'Alice', role: 'SysAdmin', skills: ['health-check', 'service-mgmt', 'monitoring', 'log-analysis', 'backup', 'disk-mgmt', 'cleanup'], currentLoad: 0.5, available: true },
    { id: 'bob', name: 'Bob', role: 'SysAdmin', skills: ['deploy', 'ci-cd', 'docker-mgmt', 'kubernetes', 'scaling', 'load-balancer', 'testing'], currentLoad: 0.2, available: true },
    { id: 'charlie', name: 'Charlie', role: 'Security', skills: ['security-scan', 'compliance', 'certificates', 'security'], currentLoad: 0.4, available: true },
    { id: 'diana', name: 'Diana', role: 'DBA', skills: ['database', 'backup', 'storage', 'diagnostics'], currentLoad: 0.6, available: true },
    { id: 'eve', name: 'Eve', role: 'DevOps', skills: ['ci-cd', 'deploy', 'docker-mgmt', 'kubernetes', 'testing', 'scaling'], currentLoad: 0.1, available: true }
  ];
}

export function createAIRouter(): express.Router {
  const router = express.Router();

  // ── NLP Task Parser ────────────────────────────────────────────────────────

  router.post('/parse-task', (req, res) => {
    const { text } = req.body;
    if (!text?.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    const parsed = parseNaturalLanguageTask(text);
    const agents = getMockAgents();
    const routing = smartRoute(parsed, agents);

    res.json({ parsed, routing });
  });

  // ── Smart Routing ──────────────────────────────────────────────────────────

  router.post('/route', (req, res) => {
    const { taskText, skills, priority } = req.body;
    if (!taskText && !skills) {
      res.status(400).json({ error: 'taskText or skills required' });
      return;
    }

    const parsed = taskText
      ? parseNaturalLanguageTask(taskText)
      : { title: 'Manual task', description: '', priority: priority || 'medium', suggestedSkills: skills || [], suggestedAgent: undefined, estimatedDurationMin: 15, tags: [], confidence: 0.8 };

    const agents = getMockAgents();
    const routing = smartRoute(parsed as any, agents);

    res.json({ routing, parsed });
  });

  // ── Agent Memory ──────────────────────────────────────────────────────────

  router.get('/memory/:agentId', (req, res) => {
    const { agentId } = req.params;
    const { query, limit } = req.query as Record<string, string>;
    const memories = agentMemory.recall(String(agentId), query, limit ? parseInt(limit) : 10);
    const insights = agentMemory.getInsights(String(agentId));
    res.json({ memories, insights, agentId });
  });

  router.post('/memory/:agentId', (req, res) => {
    const { agentId } = req.params;
    const { type, content, metadata, relevanceScore } = req.body;
    if (!type || !content) {
      res.status(400).json({ error: 'type and content required' });
      return;
    }
    agentMemory.remember(String(agentId), {
      agentId: String(agentId),
      type,
      content,
      metadata,
      relevanceScore: relevanceScore || 0.5
    });
    res.json({ success: true });
  });

  router.get('/memory', (_req, res) => {
    const insights = agentMemory.getAllAgentInsights();
    res.json({ insights, agentCount: Object.keys(insights).length });
  });

  // ── Workload Prediction ───────────────────────────────────────────────────

  router.get('/workload', (req, res) => {
    const agents = getMockAgents();
    const taskQueue: any[] = []; // In production: pull from task manager
    const predictions = predictWorkload(agents, taskQueue);

    const summary = {
      critical: predictions.filter(p => p.recommendation === 'critical').length,
      scaleUp: predictions.filter(p => p.recommendation === 'scale-up').length,
      optimal: predictions.filter(p => p.recommendation === 'optimal').length,
      scaleDown: predictions.filter(p => p.recommendation === 'scale-down').length
    };

    res.json({ predictions, summary, agentCount: agents.length });
  });

  // ── Suggestions ──────────────────────────────────────────────────────────

  router.get('/suggestions', (_req, res) => {
    const agents = getMockAgents();
    const predictions = predictWorkload(agents, []);

    const suggestions = [];

    // Overloaded agents
    const overloaded = predictions.filter(p => p.recommendation === 'critical' || p.recommendation === 'scale-up');
    if (overloaded.length) {
      suggestions.push({
        type: 'warning',
        title: overloaded.length + ' agent(s) overloaded',
        description: overloaded.map(p => {
          const a = agents.find(ag => ag.id === p.agentId);
          return a?.name + ' (' + p.currentLoad + '%)';
        }).join(', '),
        action: 'Consider reassigning tasks or adding capacity'
      });
    }

    // Underutilized agents
    const idle = predictions.filter(p => p.recommendation === 'scale-down');
    if (idle.length) {
      suggestions.push({
        type: 'info',
        title: idle.length + ' agent(s) underutilized',
        description: idle.map(p => {
          const a = agents.find(ag => ag.id === p.agentId);
          return a?.name + ' (' + p.currentLoad + '%)';
        }).join(', '),
        action: 'Assign more tasks to balance the workload'
      });
    }

    // Generic suggestions
    suggestions.push(
      { type: 'tip', title: 'Use NLP task creation', description: 'Try /api/ai/parse-task to auto-assign tasks intelligently', action: null },
      { type: 'tip', title: 'Review agent memory', description: 'Check agent learning patterns to optimize task routing', action: null }
    );

    res.json({ suggestions, count: suggestions.length });
  });

  // ── AI Status ─────────────────────────────────────────────────────────────

  router.get('/status', (_req, res) => {
    const insights = agentMemory.getAllAgentInsights();
    const totalMemories = Object.values(insights).reduce((s: number, i: any) => s + i.totalMemories, 0);
    res.json({
      status: 'operational',
      features: ['nlp-task-parser', 'smart-routing', 'agent-memory', 'workload-predictor', 'suggestions'],
      agentCount: getMockAgents().length,
      totalMemories,
      version: '14.0.0'
    });
  });

  return router;
}

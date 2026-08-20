import express, { type Request, type Response } from 'express';

const router = express.Router();

interface AgentConfig {
  agentId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  skills: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const agentConfigs = new Map<string, AgentConfig>();

const defaultAgents = [
  { agentId: 'alice', model: 'openai/gpt-4', skills: ['system-admin', 'monitoring'] },
  { agentId: 'bob', model: 'openai/gpt-4', skills: ['security', 'audit'] },
  { agentId: 'eve', model: 'openai/gpt-4', skills: ['networking', 'firewall'] },
  { agentId: 'charlie', model: 'openai/gpt-4', skills: ['backup', 'recovery'] },
  { agentId: 'diana', model: 'openai/gpt-4', skills: ['optimization', 'performance'] }
];

defaultAgents.forEach(agent => {
  agentConfigs.set(agent.agentId, {
    ...agent,
    temperature: 0.7,
    maxTokens: 2000,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date()
  });
});

router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, configs: Array.from(agentConfigs.values()) });
});

router.get('/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || '');
  const config = agentConfigs.get(agentId);
  if (!config) {
    res.status(404).json({ error: 'Agent config not found' });
    return;
  }
  res.json({ success: true, config });
});

router.put('/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || '');
  const config = agentConfigs.get(agentId);
  if (!config) {
    res.status(404).json({ error: 'Agent config not found' });
    return;
  }

  const { model, temperature, maxTokens, skills, enabled } = req.body || {};
  if (model) config.model = String(model);
  if (temperature !== undefined) config.temperature = Number(temperature);
  if (maxTokens !== undefined) config.maxTokens = Number(maxTokens);
  if (Array.isArray(skills)) config.skills = skills.map((s: unknown) => String(s));
  if (enabled !== undefined) config.enabled = Boolean(enabled);
  config.updatedAt = new Date();
  agentConfigs.set(agentId, config);

  res.json({ success: true, message: 'Agent config updated successfully', config });
});

router.post('/', (req: Request, res: Response) => {
  const { agentId, model, skills, temperature, maxTokens } = req.body || {};
  const key = String(agentId || '').trim();
  if (!key || !model) {
    res.status(400).json({ error: 'agentId and model are required' });
    return;
  }
  if (agentConfigs.has(key)) {
    res.status(400).json({ error: 'Agent config already exists' });
    return;
  }

  const config: AgentConfig = {
    agentId: key,
    model: String(model),
    skills: Array.isArray(skills) ? skills.map((s: unknown) => String(s)) : [],
    temperature: temperature === undefined ? 0.7 : Number(temperature),
    maxTokens: maxTokens === undefined ? 2000 : Number(maxTokens),
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  agentConfigs.set(key, config);
  res.json({ success: true, message: 'Agent config created successfully', config });
});

router.delete('/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId || '');
  if (!agentConfigs.has(agentId)) {
    res.status(404).json({ error: 'Agent config not found' });
    return;
  }
  agentConfigs.delete(agentId);
  res.json({ success: true, message: 'Agent config deleted successfully' });
});

export default router;

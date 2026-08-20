// /api/agents/:id/{message,message/stream} + /api/roundtable[/sync]
// — agent chat surfaces with delegation, tool-calling, multi-turn
// context, and SSE streaming. Extracted from server.ts.
//
// This is the heaviest extraction in the refactor: ~750 LOC of
// handlers with extensive dependency wiring (AI provider routing,
// agent delegation logic, tool dispatch, chat history, audit).
// Logic is preserved 1:1 with the inline blocks.
//
// Two router factories are exported so server.ts can mount each at
// its own prefix without further glue:
//
//   app.use('/api/agents', createAgentChatRouter(deps))
//     → POST /:id/message
//     → POST /:id/message/stream
//
//   app.use('/api/roundtable', createRoundtableRouter(deps))
//     → POST /
//     → POST /sync
//
// Both routers take the same deps object — passing one bundle
// keeps server.ts mounts symmetric.

import { Router, type Request, type Response } from 'express';

interface AgentLike {
  id: string;
  name: string;
  role?: string;
  type?: string;
  systemPrompt?: string;
  config?: { name?: string };
}

interface OrganizationLike {
  getAgent: (id: string) => AgentLike | null;
  getAllAgents: () => AgentLike[];
}

interface ChatHistoryStoreLike {
  getHistory: (sessionKey: string) => Array<{ role: 'user' | 'assistant'; text: string; timestamp?: string }>;
  append: (sessionKey: string, role: 'user' | 'assistant', text: string) => unknown;
  clear: (sessionKey: string) => void;
}

interface AgentBusLike {
  send: (msg: { fromAgentId: string; toAgentId: string; content: string; kind: string }) => unknown;
}

interface IncidentManagerLike {
  create: (input: { title: string; description: string; severity: string; source: string; assignedTo?: string }) => { id: string; title: string; severity: string };
}

interface CommandClassification {
  level: 'safe' | 'moderate' | 'blocked';
  reason?: string;
}

interface CommandResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

type AuthResult = { ok: boolean; reason?: string; username?: string };
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

export interface AgentChatApiDeps {
  organization: OrganizationLike;
  chatHistoryStore: ChatHistoryStoreLike;
  agentBus: AgentBusLike;
  agentToolDefinitions: any[];
  incidentManager: IncidentManagerLike;
  searchKB: (query: string, limit?: number) => Array<{ title: string; content: string }>;
  pushNotification: (n: { type: string; title: string; message: string; agentId?: string; agentName?: string; source?: string }) => void;
  memoryStore: (agentId: string, key: string, value: string, category?: string) => unknown;
  memoryRecall: (agentId: string, query: string, limit?: number) => Array<{ key: string; value: string }>;
  getMemoryContext: (agentId: string, userMsg: string) => string;
  classifyCommand: (cmd: string) => CommandClassification;
  executeCommand: (cmd: string, timeoutMs?: number) => Promise<CommandResult>;
  recordDelegation: (from: string, to: string, question: string, durationMs: number) => void;
  recordToolExecution: (agent: string, command: string, level: string, ok: boolean) => void;
  recordMessage: (agentId: string, user: string, delegated: boolean) => void;
  recordRoundtable: (question: string, participants: string[], durationMs: number) => void;
  audit: (entry: { action: string; actor: string; target: string; details: string; success: boolean; category: string }) => void;
  log: { error: (msg: string, ctx?: Record<string, unknown>) => void };
  validateAuth: AuthCheck;
}

const NORMALIZE = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const TECHNICAL_KEYWORDS = [
  'server', 'disk', 'cpu', 'memory', 'ram', 'docker', 'container', 'vm', 'virtual',
  'network', 'dns', 'firewall', 'vpn', 'routing', 'subnet', 'port', 'nginx', 'proxy',
  'backup', 'restore', 'recovery', 'snapshot', 'rsync', 'storage',
  'security', 'ssl', 'tls', 'certificate', 'auth', 'password', 'ssh', 'key', 'vulnerability',
  'deploy', 'cicd', 'ci/cd', 'pipeline', 'build', 'release', 'github action',
  'code', 'review', 'refactor', 'test', 'bug', 'error', 'crash', 'log',
  'install', 'update', 'upgrade', 'patch', 'package', 'service', 'systemctl',
  'monitor', 'alert', 'performance', 'load', 'latency', 'timeout',
];
const STRATEGIC_KEYWORDS = [
  'team', 'plan', 'strategy', 'priority', 'schedule', 'who are you', 'your role',
  'status', 'overview', 'summary', 'roadmap', 'recommend', 'advice', 'opinion',
  'budget', 'resource', 'capacity', 'meeting', 'coordinate', 'organize',
];

const DOMAIN_MAP: Array<{ keywords: string[]; agentName: string }> = [
  { keywords: ['secur', 'auth', 'ssl', 'tls', 'cert', 'harden', 'vuln', 'encrypt', 'credential', 'compli', 'audit', 'permiss', 'iam', 'rbac', 'acl'], agentName: 'Ops Diana' },
  { keywords: ['network', 'dns', 'vpn', 'firewall', 'route', 'subnet', 'port', 'nginx', 'proxy', 'load', 'connect', 'latency', 'tailscale'], agentName: 'Ops Bravo' },
  { keywords: ['backup', 'storage', 'recover', 'restore', 'snapshot', 'rsync', 'archive', 'retention', 'replicate'], agentName: 'Ops Charlie' },
  { keywords: ['deploy', 'cicd', 'pipeline', 'release', 'github', 'action', 'compose'], agentName: 'Dev Builder' },
  { keywords: ['review', 'code', 'architect', 'refactor', 'quality', 'pattern', 'design', 'document'], agentName: 'Dev Reviewer' },
  { keywords: ['infra', 'server', 'docker', 'disk', 'system', 'monitor', 'linux', 'perform', 'hardware', 'cpu', 'memory', 'ram', 'vm', 'virtual', 'host', 'provision', 'config', 'install', 'package', 'service'], agentName: 'Ops Alpha' },
];

function readAiConfig() {
  return {
    aiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    aiModel: process.env.OPENAI_MODEL || 'gpt-5',
    aiKey: process.env.OPENAI_API_KEY || '',
  };
}

export async function callChatCompletionsAPI(
  baseUrl: string, apiKey: string, model: string,
  systemPrompt: string, userContent: string, maxTokens = 2048,
): Promise<string> {
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`AI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// SSE reassembly for OpenAI-compatible /v1/chat/completions responses.
// Only used for the delegation tool-call (single small tool, fits the size limit).
async function parseAiResponse(resp: Response): Promise<any> {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  const raw = await resp.text();
  if (!raw.startsWith('data:')) return JSON.parse(raw);
  let content = '';
  let role = 'assistant';
  let toolCalls: any[] | undefined;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') break;
    try {
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.role) role = delta.role;
      if (delta.content) content += delta.content;
      if (delta.tool_calls) {
        if (!toolCalls) toolCalls = [];
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? toolCalls.length;
          if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[idx].id = tc.id;
          if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    } catch { /* skip malformed chunks */ }
  }
  const msg: any = { role, content: content || null };
  if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
  return { choices: [{ message: msg, finish_reason: 'stop' }] };
}

export function createAgentChatRouter(deps: AgentChatApiDeps): Router {
  const router = Router();
  const {
    organization, chatHistoryStore, agentBus, agentToolDefinitions, incidentManager,
    searchKB, pushNotification, memoryStore, memoryRecall, getMemoryContext,
    classifyCommand, executeCommand, recordDelegation, recordToolExecution, recordMessage,
    audit, log, validateAuth,
  } = deps;

  router.post('/:id/message', async (req: Request, res: Response) => {
    const agentId = req.params.id;
    const { message, content } = req.body;
    const userMessage = message || content;

    if (!userMessage) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const auth = validateAuth(req.header('authorization') || undefined);
    const sessionUser = auth.username || 'anonymous';
    const sessionKey = `${sessionUser}:${agentId}`;
    const _chatStartTime = Date.now();

    const allAgents = organization.getAllAgents();
    const agent = organization.getAgent(agentId) ||
      allAgents.find(a => a.name === agentId || a.name.toLowerCase() === agentId.toLowerCase() || NORMALIZE(a.name) === NORMALIZE(agentId));

    if (!agent) {
      res.status(404).json({ error: 'Agent not found', agentId });
      return;
    }

    const agentName = agent.name || agentId;
    const agentRole = agent.role || agent.type || 'assistant';
    const storedPrompt = agent.systemPrompt || '';
    const systemPrompt = storedPrompt || `You are ${agentName}, an AI agent. Role: ${agentRole}. Be concise and helpful.`;

    const { aiBaseUrl, aiModel, aiKey } = readAiConfig();
    const chatHistory = chatHistoryStore.getHistory(sessionKey);
    const historyContext = chatHistory.slice(-10).map(m =>
      m.role === 'user' ? `User: ${m.text}` : `Assistant: ${m.text}`,
    ).join('\n');
    const historyBlock = historyContext ? `\n\n[CONVERSATION HISTORY]\n${historyContext}\n` : '';

    async function callAI(sysPrompt: string, userMsg: string, opts?: { tools?: any[]; toolChoice?: any }): Promise<any> {
      const memCtx = getMemoryContext(agentId, userMsg);
      if (opts?.tools && opts.tools.length > 0) {
        const combined = `[INSTRUCTIONS]\n${sysPrompt}${memCtx}${historyBlock}\n\n[USER MESSAGE]\n${userMsg}`;
        const body: any = {
          model: aiModel, stream: false, max_tokens: 2048,
          messages: [{ role: 'user', content: combined }],
          tools: opts.tools, tool_choice: opts.toolChoice || 'none',
        };
        const resp = await fetch(`${aiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` },
          body: JSON.stringify(body),
        });
        if (!resp.ok) throw new Error(`AI ${resp.status}: ${await resp.text()}`);
        return parseAiResponse(resp);
      }
      const fullSystem = `${sysPrompt}${memCtx}${historyBlock}`;
      const text = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, fullSystem, userMsg);
      return { choices: [{ message: { role: 'assistant', content: text } }] };
    }

    const canDelegate = agentRole === 'director' || agentRole === 'manager';
    const msgLower = userMessage.toLowerCase();
    const hasTechnical = TECHNICAL_KEYWORDS.some(kw => msgLower.includes(kw));
    const hasStrategic = STRATEGIC_KEYWORDS.some(kw => msgLower.includes(kw));
    const shouldDelegate = canDelegate && hasTechnical && !hasStrategic;

    const delegationTargets = allAgents
      .filter(a => a.id !== agent.id && a.name !== agentName)
      .map(a => ({ name: a.name, role: a.role || a.type, skills: (a as any).skills || [] }));

    const delegationTool = {
      type: 'function',
      function: {
        name: 'delegate_to_agent',
        description: 'Delegate to specialist. Available: ' + delegationTargets.map(a => a.name + ' (' + (a.skills || []).slice(0, 3).join(', ') + ')').join('; '),
        parameters: {
          type: 'object',
          properties: {
            agent_name: { type: 'string', description: 'Specialist: ' + delegationTargets.map(a => a.name).join(', ') },
            task_description: { type: 'string', description: 'Full task for the specialist.' },
            reason: { type: 'string', description: 'Why this specialist.' },
          },
          required: ['agent_name', 'task_description'],
        },
      },
    };

    try {
      let finalReply = '';
      let delegatedTo: string | null = null;

      if (shouldDelegate) {
        const delegData = await callAI(systemPrompt, userMessage, {
          tools: [delegationTool],
          toolChoice: { type: 'function', function: { name: 'delegate_to_agent' } },
        });
        const tc = delegData.choices?.[0]?.message?.tool_calls?.[0];
        if (tc && tc.function?.name === 'delegate_to_agent') {
          let args: any;
          try { args = JSON.parse(tc.function.arguments); } catch { args = { agent_name: 'Ops Alpha', task_description: userMessage }; }
          const targetName = args.agent_name;
          const taskDesc = args.task_description;
          const reason = args.reason || '';

          let targetAgent = allAgents.find(a => a.id !== agent.id && (a.name === targetName || a.name.toLowerCase() === targetName.toLowerCase() || NORMALIZE(a.name) === NORMALIZE(targetName)));
          if (!targetAgent) {
            const fullContext = NORMALIZE(targetName) + ' ' + NORMALIZE(taskDesc || '') + ' ' + NORMALIZE(userMessage || '');
            let bestScore = 0;
            let bestAgent: string | null = null;
            for (const mapping of DOMAIN_MAP) {
              const score = mapping.keywords.filter(kw => fullContext.includes(kw)).length;
              if (score > bestScore) { bestScore = score; bestAgent = mapping.agentName; }
            }
            if (bestAgent) targetAgent = allAgents.find(a => a.name === bestAgent);
          }

          if (targetAgent) {
            delegatedTo = targetAgent.name;
            const targetPrompt = targetAgent.systemPrompt || `You are ${delegatedTo}. Be technical and helpful.`;
            const delegMsg = `[Delegated from ${agentName}]: ${taskDesc}\n\nOriginal user question: ${userMessage}`;
            try {
              let specReply = 'Specialist unavailable.';
              const specText = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, targetPrompt, delegMsg);
              if (specText) specReply = specText;
              finalReply = `*${agentName} delegated this to ${delegatedTo}${reason ? ' (' + reason + ')' : ''}:*\n\n${specReply}`;
              recordDelegation(agentName, delegatedTo!, userMessage, Date.now() - _chatStartTime);
            } catch (e: any) {
              log.error('[AgentChat] Specialist error:', { err: e.message });
              finalReply = `Tried to delegate to ${delegatedTo} but got error: ${e.message}`;
            }
          } else {
            const fallback = await callAI(systemPrompt, userMessage);
            finalReply = fallback.choices?.[0]?.message?.content || 'Could not generate response.';
          }
        } else {
          const fallback = await callAI(systemPrompt, userMessage);
          finalReply = fallback.choices?.[0]?.message?.content || 'Could not generate response.';
        }
      } else {
        const directData = await callAI(systemPrompt, userMessage);
        finalReply = directData.choices?.[0]?.message?.content || 'Could not generate response.';
      }

      recordMessage(agentId, sessionUser, !!delegatedTo);
      audit({ action: 'chat_message', actor: sessionUser, target: agentId, details: userMessage.slice(0, 80), success: true, category: 'chat' });
      if (delegatedTo) audit({ action: 'delegation', actor: agentId, target: delegatedTo, details: userMessage.slice(0, 80), success: true, category: 'delegation' });

      chatHistoryStore.append(sessionKey, 'user', userMessage);
      chatHistoryStore.append(sessionKey, 'assistant', finalReply);

      try {
        agentBus.send({ fromAgentId: agent.id || agentId, toAgentId: agent.id || agentId, content: '[Chat] ' + userMessage.substring(0, 200), kind: 'message' });
      } catch { /* ok */ }

      res.json({
        success: true,
        reply: finalReply,
        response: finalReply,
        delegatedTo: delegatedTo || undefined,
        agentName,
        message: { from: agentName, to: 'user', message: userMessage, timestamp: new Date().toISOString(), status: 'delivered' },
      });
    } catch (err: any) {
      log.error('[AgentChat] Error:', { err: err.message });
      res.json({
        success: true,
        reply: `[${agentName}] Error: ${err.message}`,
        message: { from: agentName, to: 'user', message: userMessage, timestamp: new Date().toISOString(), status: 'error' },
      });
    }
  });

  router.post('/:id/message/stream', async (req: Request, res: Response) => {
    const agentId = req.params.id;
    const { message, content: msgContent } = req.body;
    const userMessage = message || msgContent;
    if (!userMessage) { res.status(400).json({ error: 'Message is required' }); return; }

    const auth = validateAuth(req.header('authorization') || undefined);
    const sessionUser = auth.username || 'anonymous';
    const sessionKey = `${sessionUser}:${agentId}`;

    const allAgents = organization.getAllAgents();
    const agent = organization.getAgent(agentId) ||
      allAgents.find(a => a.name === agentId || a.name.toLowerCase() === agentId.toLowerCase() || NORMALIZE(a.name) === NORMALIZE(agentId));
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const agentName = agent.name || agentId;
    const agentRole = agent.role || agent.type || 'assistant';
    const storedPrompt = agent.systemPrompt || '';
    const systemPrompt = storedPrompt || `You are ${agentName}, an AI agent. Role: ${agentRole}. Be concise and helpful.`;
    const { aiBaseUrl, aiModel, aiKey } = readAiConfig();

    const chatHistory = chatHistoryStore.getHistory(sessionKey);
    const historyContext = chatHistory.slice(-10).map(m =>
      m.role === 'user' ? `User: ${m.text}` : `Assistant: ${m.text}`,
    ).join('\n');
    const historyBlock = historyContext ? `\n\n[CONVERSATION HISTORY]\n${historyContext}\n` : '';

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    try {
      const msgLower = userMessage.toLowerCase();
      const hasTechnical = TECHNICAL_KEYWORDS.some(kw => msgLower.includes(kw));
      const hasStrategic = STRATEGIC_KEYWORDS.some(kw => msgLower.includes(kw));
      const canDelegate = agentRole === 'director' || agentRole === 'manager';
      const shouldDelegate = canDelegate && hasTechnical && !hasStrategic;

      let delegatedTo: string | null = null;
      let targetPromptForStream = systemPrompt;
      let msgForStream = userMessage;

      if (shouldDelegate) {
        sendEvent('status', { type: 'delegating', message: 'Routing to specialist...' });
        const delegTargets = allAgents.filter(a => a.id !== agent.id).map(a => a.name);
        const delegTool = { type: 'function', function: { name: 'delegate_to_agent', description: 'Delegate. Available: ' + delegTargets.join(', '), parameters: { type: 'object', properties: { agent_name: { type: 'string' }, task_description: { type: 'string' }, reason: { type: 'string' } }, required: ['agent_name', 'task_description'] } } };
        const delegCombined = `[INSTRUCTIONS]\n${systemPrompt}${historyBlock}\n\n[USER MESSAGE]\n${userMessage}`;
        const delegResp = await fetch(`${aiBaseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiKey}` }, body: JSON.stringify({ model: aiModel, stream: false, max_tokens: 1024, messages: [{ role: 'user', content: delegCombined }], tools: [delegTool], tool_choice: { type: 'function', function: { name: 'delegate_to_agent' } } }) });

        if (delegResp.ok) {
          const dd = await parseAiResponse(delegResp) as any;
          const tc = dd.choices?.[0]?.message?.tool_calls?.[0];
          if (tc?.function?.name === 'delegate_to_agent') {
            let args: any; try { args = JSON.parse(tc.function.arguments); } catch { args = { agent_name: 'Ops Alpha', task_description: userMessage }; }
            const targetName = args.agent_name; const taskDesc = args.task_description; const reason = args.reason || '';
            let targetAgent = allAgents.find(a => a.id !== agent.id && (a.name === targetName || a.name.toLowerCase() === targetName.toLowerCase() || NORMALIZE(a.name) === NORMALIZE(targetName)));
            if (!targetAgent) {
              const fc = NORMALIZE(targetName) + ' ' + NORMALIZE(taskDesc || '') + ' ' + NORMALIZE(userMessage || '');
              let bs = 0; let ba: string | null = null;
              for (const m of DOMAIN_MAP) { const s = m.keywords.filter(k => fc.includes(k)).length; if (s > bs) { bs = s; ba = m.agentName; } }
              if (ba) targetAgent = allAgents.find(a => a.name === ba);
            }
            if (targetAgent) {
              delegatedTo = targetAgent.name;
              targetPromptForStream = targetAgent.systemPrompt || `You are ${delegatedTo}. Be technical and helpful.`;
              msgForStream = `[Delegated from ${agentName}]: ${taskDesc}\nOriginal user question: ${userMessage}`;
              sendEvent('status', { type: 'delegated', agent: delegatedTo, reason });
            }
          }
        }
      }

      const streamSystem = `${targetPromptForStream}${historyBlock}`;
      let fullReply = '';

      try {
        const finalContent = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, streamSystem, msgForStream);
        if (finalContent) {
          fullReply = finalContent;
          const chunkSize = 50;
          for (let i = 0; i < finalContent.length; i += chunkSize) {
            sendEvent('token', { content: finalContent.slice(i, i + chunkSize) });
          }
        }
        sendEvent('done', { delegatedTo, agentName, toolsUsed: 0 });
      } catch (e: any) {
        sendEvent('error', { message: e.message });
      }

      chatHistoryStore.append(sessionKey, 'user', userMessage);
      if (fullReply) chatHistoryStore.append(sessionKey, 'assistant', fullReply);
      if (!res.writableEnded) res.end();
    } catch (err: any) {
      sendEvent('error', { message: err.message });
      if (!res.writableEnded) res.end();
    }
  });

  return router;
}

export function createRoundtableRouter(deps: AgentChatApiDeps): Router {
  const router = Router();
  const {
    organization, chatHistoryStore, agentToolDefinitions, classifyCommand, executeCommand,
    recordToolExecution, recordRoundtable, validateAuth,
  } = deps;

  router.post('/', async (req: Request, res: Response) => {
    const { message, content: msgContent, agents: requestedAgents } = req.body;
    const userMessage = message || msgContent;
    if (!userMessage) { res.status(400).json({ error: 'Message is required' }); return; }

    const auth = validateAuth(req.header('authorization') || undefined);
    const sessionUser = auth.username || 'anonymous';
    const { aiBaseUrl, aiModel, aiKey } = readAiConfig();

    const allAgents = organization.getAllAgents();
    const director = allAgents.find(a => a.role === 'director' || a.type === 'director');

    let participants: AgentLike[];
    if (requestedAgents && Array.isArray(requestedAgents) && requestedAgents.length > 0) {
      participants = allAgents.filter(a => requestedAgents.some((r: string) => a.name === r || NORMALIZE(a.name) === NORMALIZE(r)));
    } else {
      participants = allAgents.filter(a => a.role !== 'director' && a.type !== 'director');
    }

    if (participants.length === 0) {
      res.status(400).json({ error: 'No agents available for roundtable' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (event: string, data: any) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    const _rtStart = Date.now();
    sendEvent('status', { type: 'started', question: userMessage, participants: participants.map(a => a.name) });

    try {
      const specialistPromises = participants.map(async (agent) => {
        const agentPrompt = agent.systemPrompt || `You are ${agent.name}. Be concise and helpful.`;
        const rtUserMsg = `[ROUNDTABLE DISCUSSION]\nThe IT Director has asked the whole team this question. Give your perspective from your domain expertise. Be concise (2-4 paragraphs max). Focus on what is relevant to YOUR specialty.\n\n[QUESTION]\n${userMessage}`;
        try {
          const text = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, agentPrompt, rtUserMsg, 1024);
          return { agent: agent.name, role: agent.role || agent.type, response: text || 'No response', ok: true };
        } catch (err: any) {
          return { agent: agent.name, role: agent.role || agent.type, response: `Error: ${err.message}`, ok: false };
        }
      });

      const results = await Promise.all(specialistPromises.map(async (p, idx) => {
        const result = await p;
        sendEvent('agent_response', { agent: result.agent, role: result.role, response: result.response.slice(0, 200) + (result.response.length > 200 ? '...' : ''), index: idx });
        return result;
      }));

      sendEvent('status', { type: 'synthesizing', message: 'Director is synthesizing responses...' });

      const directorPrompt = director ? (director.systemPrompt || 'You are the IT Director.') : 'You are the IT Director. Synthesize your team responses.';
      const synthesisInput = results.map(r => `### ${r.agent} (${r.role}):\n${r.response}`).join('\n\n---\n\n');
      const synthesisUserMsg = `[TASK]\nYour team has provided their perspectives on a question. Synthesize their responses into a clear, actionable summary. Highlight key points from each specialist, note any conflicts or gaps, and provide your overall recommendation.\n\n[ORIGINAL QUESTION]\n${userMessage}\n\n[TEAM RESPONSES]\n${synthesisInput}`;

      let synthesis = 'Could not synthesize responses.';
      try {
        const synthText = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, directorPrompt, synthesisUserMsg);
        if (synthText) synthesis = synthText;
      } catch { /* use fallback */ }

      const chunkSize = 80;
      for (let i = 0; i < synthesis.length; i += chunkSize) {
        sendEvent('token', { content: synthesis.slice(i, i + chunkSize) });
      }

      const rtDuration = Date.now() - _rtStart;
      recordRoundtable(userMessage, results.map(r => r.agent), rtDuration);

      sendEvent('done', {
        participants: results.map(r => ({ agent: r.agent, role: r.role, ok: r.ok })),
        synthesizedBy: director ? director.name : 'System',
      });

      chatHistoryStore.append(`${sessionUser}:roundtable`, 'user', userMessage);
      chatHistoryStore.append(`${sessionUser}:roundtable`, 'assistant', `[Roundtable: ${results.map(r => r.agent).join(', ')}]\n\n${synthesis}`);

      if (!res.writableEnded) res.end();
    } catch (err: any) {
      sendEvent('error', { message: err.message });
      if (!res.writableEnded) res.end();
    }
  });

  router.post('/sync', async (req: Request, res: Response) => {
    const { message, content: msgContent, agents: requestedAgents } = req.body;
    const userMessage = message || msgContent;
    if (!userMessage) { res.status(400).json({ error: 'Message is required' }); return; }

    const auth = validateAuth(req.header('authorization') || undefined);
    const sessionUser = auth.username || 'anonymous';
    const { aiBaseUrl, aiModel, aiKey } = readAiConfig();

    const allAgents = organization.getAllAgents();
    const director = allAgents.find(a => a.role === 'director' || a.type === 'director');

    let participants: AgentLike[];
    if (requestedAgents && Array.isArray(requestedAgents) && requestedAgents.length > 0) {
      participants = allAgents.filter(a => requestedAgents.some((r: string) => a.name === r || NORMALIZE(a.name) === NORMALIZE(r)));
    } else {
      participants = allAgents.filter(a => a.role !== 'director' && a.type !== 'director');
    }

    if (participants.length === 0) { res.status(400).json({ error: 'No agents available' }); return; }

    try {
      const results = await Promise.all(participants.map(async (agent) => {
        const prompt = agent.systemPrompt || `You are ${agent.name}.`;
        const rtMsg = `[ROUNDTABLE]\nGive your perspective from your domain. Be concise (2-3 paragraphs).\n\n[QUESTION]\n${userMessage}`;
        try {
          const text = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, prompt, rtMsg, 1024);
          return { agent: agent.name, role: agent.role || agent.type, response: text || 'No response', ok: true };
        } catch (e: any) { return { agent: agent.name, role: agent.role || agent.type, response: e.message, ok: false }; }
      }));

      const dirPrompt = director ? (director.systemPrompt || 'You are the IT Director.') : 'You are the IT Director.';
      const synthInput = results.map(r => `### ${r.agent}:\n${r.response}`).join('\n\n---\n\n');
      const synthMsg = `[TASK]\nSynthesize team responses into an actionable summary.\n\n[QUESTION]\n${userMessage}\n\n[TEAM RESPONSES]\n${synthInput}`;
      let synthesis = 'Could not synthesize.';
      try { const t = await callChatCompletionsAPI(aiBaseUrl, aiKey, aiModel, dirPrompt, synthMsg); if (t) synthesis = t; } catch { /* use fallback */ }

      chatHistoryStore.append(`${sessionUser}:roundtable`, 'user', userMessage);
      chatHistoryStore.append(`${sessionUser}:roundtable`, 'assistant', synthesis);

      res.json({ success: true, question: userMessage, responses: results, synthesis, synthesizedBy: director ? director.name : 'System' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

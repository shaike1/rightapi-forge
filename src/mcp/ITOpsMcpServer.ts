/**
 * IT Ops MCP Server
 * Exposes IT ops tools via the Model Context Protocol (HTTP/SSE transport).
 * Mount at /mcp on the Express app: app.use('/mcp', createMcpRouter(deps))
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Router, type Request, type Response } from 'express';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { Organization } from '../agents/Organization.js';
import type { SkillManager } from '../skills/SkillManager.js';
import type { RunbookEngine } from '../runbooks/RunbookEngine.js';
import { getAgents, sendMessage, getMessages, getTasks, createTask, updateTaskStatus } from './LetThemTalkService.js';

export interface McpDeps {
  incidentManager: IncidentManager;
  organization: Organization;
  skillManager: SkillManager;
  runbookEngine: RunbookEngine;
}

export function createMcpRouter(deps: McpDeps): Router {
  const router = Router();

  // Each request gets a fresh transport (stateless HTTP mode)
  router.all('/', async (req: Request, res: Response) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}

function buildMcpServer(deps: McpDeps): McpServer {
  const { incidentManager, organization, skillManager, runbookEngine } = deps;

  const server = new McpServer({
    name: 'itops-agents',
    version: '1.0.0',
  });

  // ── Incidents ──────────────────────────────────────────────────────────────

  server.tool(
    'list_incidents',
    'List IT incidents. Optionally filter by status (open|investigating|resolved|closed) or severity (low|medium|high|critical).',
    {
      status: z.enum(['open', 'investigating', 'resolved', 'closed']).optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async ({ status, severity, limit }) => {
      const all = incidentManager.list();
      const filtered = all
        .filter(i => !status || i.status === status)
        .filter(i => !severity || i.severity === severity)
        .slice(0, limit);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(filtered.map(i => ({
            id: i.id, title: i.title, severity: i.severity,
            status: i.status, source: i.source, createdAt: i.createdAt,
            assignedTo: i.assignedTo,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'get_incident',
    'Get full details of a specific incident by ID, including timeline.',
    { id: z.string().describe('Incident ID') },
    async ({ id }) => {
      const inc = incidentManager.get(id);
      if (!inc) return { content: [{ type: 'text', text: `Incident ${id} not found` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(inc, null, 2) }] };
    },
  );

  server.tool(
    'create_incident',
    'Create a new IT incident.',
    {
      title: z.string().min(1).describe('Short incident title'),
      description: z.string().optional().describe('Detailed description'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      source: z.string().optional().describe('Source system (e.g. monitoring, manual, alert)'),
    },
    async ({ title, description, severity, source }) => {
      const inc = incidentManager.create({
        title,
        description,
        severity,
        source: (source as any) ?? 'manual',
      });
      return {
        content: [{ type: 'text', text: `Created incident ${inc.id}: ${inc.title} (${inc.severity})` }],
      };
    },
  );

  server.tool(
    'update_incident',
    'Update an existing incident — change status, severity, assignee, or title.',
    {
      id: z.string().describe('Incident ID'),
      status: z.enum(['open', 'investigating', 'resolved', 'closed']).optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      assignedTo: z.string().optional(),
      title: z.string().optional(),
    },
    async ({ id, ...patch }) => {
      const updated = incidentManager.update(id, patch);
      if (!updated) return { content: [{ type: 'text', text: `Incident ${id} not found` }], isError: true };
      return { content: [{ type: 'text', text: `Updated incident ${id}: status=${updated.status}, severity=${updated.severity}` }] };
    },
  );

  server.tool(
    'get_incident_stats',
    'Get a summary of incident counts by status and severity.',
    {},
    async () => {
      const stats = incidentManager.getStats();
      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    },
  );

  // ── Agents ─────────────────────────────────────────────────────────────────

  server.tool(
    'list_agents',
    'List all operations agents and their current status.',
    { status: z.string().optional().describe('Filter by status (active|idle|error)') },
    async ({ status }) => {
      const agents = organization.getAllAgents();
      const filtered = status ? agents.filter((a: any) => a.status === status) : agents;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(filtered.map((a: any) => ({
            id: a.id, name: a.name, type: a.type, role: a.role, status: a.status,
          })), null, 2),
        }],
      };
    },
  );

  // ── Skills ─────────────────────────────────────────────────────────────────

  server.tool(
    'list_skills',
    'List all available IT ops skills/tools.',
    {},
    async () => {
      const skills = skillManager.getAll();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(skills.map((s: any) => ({
            name: s.name, description: s.description, enabled: s.enabled !== false,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'execute_skill',
    'Execute an IT ops skill/tool by name with parameters. Use list_skills to find available skill names.',
    {
      skill: z.string().describe('Skill name (e.g. "jira.create", "shell.exec", "monitoring.check")'),
      params: z.record(z.unknown()).optional().describe('Skill parameters as key-value pairs'),
    },
    async ({ skill, params }) => {
      try {
        const result = await skillManager.execute(skill, params ?? {});
        return { content: [{ type: 'text', text: String(result) }] };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Skill execution failed: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );

  // ── Runbooks ───────────────────────────────────────────────────────────────

  server.tool(
    'list_runbooks',
    'List all available runbook templates.',
    {},
    async () => {
      const templates = runbookEngine.listTemplates();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(templates.map((t: any) => ({
            id: t.id, name: t.name, description: t.description,
            category: t.category, steps: t.steps?.length ?? 0,
          })), null, 2),
        }],
      };
    },
  );

  server.tool(
    'run_runbook',
    'Execute a runbook template by ID. Returns the run ID for tracking.',
    {
      templateId: z.string().describe('Runbook template ID (from list_runbooks)'),
      triggeredBy: z.string().default('mcp').describe('Who/what triggered this run'),
    },
    async ({ templateId, triggeredBy }) => {
      try {
        const run = runbookEngine.executeRun(templateId, triggeredBy);
        return {
          content: [{ type: 'text', text: `Runbook started: run ID ${run.id}, status: ${run.status}` }],
        };
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Failed to start runbook: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_runbook_run',
    'Get the current status and step details of a runbook run.',
    { runId: z.string().describe('Runbook run ID') },
    async ({ runId }) => {
      const run = runbookEngine.getRun(runId);
      if (!run) return { content: [{ type: 'text', text: `Run ${runId} not found` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }] };
    },
  );


  // ── Bridge / let-them-talk tools ─────────────────────────────────────────────

  server.tool(
    'bridge_list_agents',
    'List all agents currently registered in the let-them-talk bridge, with their online/offline status.',
    {},
    async () => {
      const agents = getAgents();
      return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
    },
  );

  server.tool(
    'bridge_send_message',
    'Send a message from one agent to another (or broadcast to all) via the let-them-talk bridge.',
    {
      from: z.string().describe('Sender agent name'),
      to: z.string().describe('Recipient agent name, or "all" for broadcast'),
      content: z.string().describe('Message content'),
      type: z.enum(['message', 'task', 'broadcast', 'handoff']).default('message'),
    },
    async ({ from, to, content, type }) => {
      try {
        const msg = sendMessage(from, to, content, type);
        return { content: [{ type: 'text', text: JSON.stringify(msg, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: String(e) }], isError: true };
      }
    },
  );

  server.tool(
    'bridge_read_messages',
    'Read messages from the let-them-talk bridge. Filter by recipient, sender, or since timestamp.',
    {
      to: z.string().optional().describe('Filter by recipient (agent name or ll\)'),
      from: z.string().optional().describe('Filter by sender'),
      since: z.string().optional().describe('ISO timestamp — only return messages after this time'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ to, from, since, limit }) => {
      const msgs = getMessages({ to, from, since, limit });
      return { content: [{ type: 'text', text: JSON.stringify(msgs, null, 2) }] };
    },
  );

  server.tool(
    'bridge_create_task',
    'Create a task in the let-them-talk bridge and assign it to an agent.',
    {
      title: z.string().describe('Task title / description'),
      assigned_to: z.string().describe('Agent to assign the task to'),
      assigned_by: z.string().describe('Agent or system creating the task'),
    },
    async ({ title, assigned_to, assigned_by }) => {
      try {
        const task = createTask(title, assigned_to, assigned_by);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: String(e) }], isError: true };
      }
    },
  );

  server.tool(
    'bridge_update_task',
    'Update the status of a task in the let-them-talk bridge.',
    {
      taskId: z.string().describe('Task ID'),
      status: z.enum(['pending', 'in_progress', 'done', 'failed']).describe('New status'),
    },
    async ({ taskId, status }) => {
      const task = updateTaskStatus(taskId, status);
      if (!task) return { content: [{ type: 'text', text: String(e) }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
    },
  );

  return server;
}

/** Tool catalogue for the React UI */
export const MCP_TOOLS_CATALOGUE = [
  { name: 'list_incidents',    category: 'Incidents', description: 'List incidents with optional status/severity filter' },
  { name: 'get_incident',      category: 'Incidents', description: 'Get full incident details + timeline by ID' },
  { name: 'create_incident',   category: 'Incidents', description: 'Create a new incident with severity and source' },
  { name: 'update_incident',   category: 'Incidents', description: 'Update incident status, severity, or assignee' },
  { name: 'get_incident_stats', category: 'Incidents', description: 'Summary counts by status and severity' },
  { name: 'list_agents',       category: 'Agents',   description: 'List all agents and their current status' },
  { name: 'list_skills',       category: 'Skills',   description: 'List all available IT ops skills' },
  { name: 'execute_skill',     category: 'Skills',   description: 'Execute a skill by name with parameters' },
  { name: 'list_runbooks',     category: 'Runbooks', description: 'List all runbook templates' },
  { name: 'run_runbook',       category: 'Runbooks', description: 'Execute a runbook template by ID' },
  { name: 'get_runbook_run',   category: 'Runbooks', description: 'Get status and step details of a run' },

  { name: 'bridge_list_agents',   category: 'Bridge', description: 'List agents in let-them-talk bridge' },
  { name: 'bridge_send_message',  category: 'Bridge', description: 'Send a message between agents via bridge' },
  { name: 'bridge_read_messages', category: 'Bridge', description: 'Read bridge messages with optional filters' },
  { name: 'bridge_create_task',   category: 'Bridge', description: 'Create and assign a task via bridge' },
  { name: 'bridge_update_task',   category: 'Bridge', description: 'Update task status in bridge' },
];

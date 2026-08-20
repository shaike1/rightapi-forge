// Bridges external MCP servers (managed by McpClientManager) into the
// agent's skill catalogue. Three commands:
//
//   mcp.list_servers   → snapshot of every connected, agent-exposed server
//   mcp.list_tools     → tools available on one server (or all servers)
//   mcp.call_tool      → invoke `<serverId>.<toolName>` with a JSON args blob
//
// The set of *external* tools is dynamic — servers can expose new tools at
// any time — so we deliberately don't try to mirror them as individual
// commands. The agent calls mcp.list_tools, then mcp.call_tool with the
// chosen name. This keeps the SkillManager's Command shape static while
// still letting agents reach any tool a connected server exposes.
//
// WorkflowSkill / DelegationSkill use the same dynamic-dispatch pattern.

import type { Skill } from '../types/index.js';
import { encode, ok, fail } from './SkillResult.js';
import type { McpClientManager } from '../integrations/mcp/McpClientManager.js';

export class McpToolsSkill {
  constructor(private readonly manager: McpClientManager) {}

  getSkill(): Skill {
    return {
      id: 'mcp',
      name: 'External MCP Tools',
      description: 'Discover and invoke tools on connected Model Context Protocol servers (e.g. OpenClaw)',
      category: 'general',
      enabled: true,
      commands: [
        {
          name: 'mcp.list_servers',
          description: 'List external MCP servers wired to ITOps and their connection status',
          handler: 'listServers',
        },
        {
          name: 'mcp.list_tools',
          description: 'List tools available on a connected MCP server. Omit `serverId` to list across all servers.',
          handler: 'listTools',
          parameters: { serverId: 'string?' },
        },
        {
          name: 'mcp.call_tool',
          description: 'Invoke a tool on an MCP server. Provide `serverId`, `tool`, and a JSON `args` object.',
          handler: 'callTool',
          parameters: { serverId: 'string', tool: 'string', args: 'object' },
        },
      ],
    };
  }

  async listServers(): Promise<string> {
    try {
      const summaries = this.manager.listSummaries()
        .filter(s => s.def.exposeToAgents !== false)
        .map(s => ({
          id: s.def.id,
          name: s.def.name,
          transport: s.def.transport,
          status: s.status.status,
          tools: s.status.toolCount,
        }));
      return encode(ok(summaries, `${summaries.length} MCP server(s) exposed to agents`));
    } catch (e) {
      return encode(fail(e instanceof Error ? e.message : String(e)));
    }
  }

  async listTools(params: { serverId?: string } = {}): Promise<string> {
    try {
      if (params.serverId) {
        const tools = await this.manager.listTools(params.serverId);
        return encode(ok(
          tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          `${tools.length} tool(s) on ${params.serverId}`,
        ));
      }
      const flat = this.manager.listExposedToolsForAgents().map(({ serverId, tool }) => ({
        serverId,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      return encode(ok(flat, `${flat.length} tool(s) across connected servers`));
    } catch (e) {
      return encode(fail(e instanceof Error ? e.message : String(e)));
    }
  }

  async callTool(params: { serverId?: string; tool?: string; args?: unknown } = {}): Promise<string> {
    if (!params.serverId) return encode(fail('missing serverId'));
    if (!params.tool) return encode(fail('missing tool'));
    const args = (params.args && typeof params.args === 'object')
      ? params.args as Record<string, unknown>
      : {};
    try {
      const result = await this.manager.callTool(params.serverId, params.tool, args);
      if (result.isError) {
        return encode(fail(safeStringify(result.content), `tool ${params.tool} returned an error`));
      }
      return encode(ok(result.content, `invoked ${params.serverId}/${params.tool}`));
    } catch (e) {
      return encode(fail(e instanceof Error ? e.message : String(e)));
    }
  }
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

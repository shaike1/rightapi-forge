// Manages the fleet of MCP-client connections. Owns the McpServerStore (so
// API mutations land on disk), wires up auto-connect on boot, and exposes
// the small surface the rest of the codebase needs:
//   - listSummaries() for the UI
//   - listExposedToolsForAgents() for the agent-facing skill bridge
//   - callTool() — used by both the API and agents
//
// Bootstrap merges three sources, in order of precedence:
//   1. Definitions persisted via the API (/data/itops-agents/mcp-clients.json)
//   2. MCP_SERVERS env var — JSON array, useful for declarative deploys
//   3. OPENCLAW_MCP_URL env var — convenience shortcut for the
//      one-server case the user already has running.

import { logger } from '../../utils/logger.js';
import { McpClient } from './McpClient.js';
import { McpServerStore } from './McpServerStore.js';
import type {
  McpServerDef,
  McpServerSummary,
  McpToolCallResult,
  McpToolDescriptor,
} from './types.js';

export class McpClientManager {
  private clients = new Map<string, McpClient>();
  private store: McpServerStore;

  constructor(store?: McpServerStore) {
    this.store = store ?? new McpServerStore();
  }

  /** Hydrate from disk + env, then kick off auto-connect for enabled
   *  servers. Failures during connect are logged but never throw — a bad
   *  remote should not prevent the rest of the process from booting. */
  async init(): Promise<void> {
    const seenIds = new Set<string>();
    for (const def of this.store.list()) {
      this.clients.set(def.id, new McpClient(def));
      seenIds.add(def.id);
    }

    for (const def of parseEnvServers()) {
      // Env-defined servers win over store entries with the same id only if
      // the store didn't already have one — operators can override per-deploy
      // via the env, but persisted UI changes still take precedence.
      if (!seenIds.has(def.id)) {
        this.store.upsert(def);
        this.clients.set(def.id, new McpClient(def));
        seenIds.add(def.id);
      }
    }

    const openclawDef = parseOpenclawDefault();
    if (openclawDef && !seenIds.has(openclawDef.id)) {
      this.store.upsert(openclawDef);
      this.clients.set(openclawDef.id, new McpClient(openclawDef));
    }

    // Kick connections off in the background — a slow or unreachable
    // server should never delay server boot. Failures are logged on the
    // client object's status.
    for (const client of this.clients.values()) {
      if (client.getDef().enabled === false) continue;
      void client.connect().catch(err => {
        logger.warn('[McpClientManager] auto-connect failed', {
          id: client.getDef().id,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  list(): McpClient[] {
    return Array.from(this.clients.values());
  }

  listSummaries(): McpServerSummary[] {
    return this.list().map(c => toSummary(c));
  }

  get(id: string): McpClient | undefined {
    return this.clients.get(id);
  }

  /** Add or update a server definition and bring it online. If the server
   *  already exists this disconnects the old transport first — config
   *  changes (URL, headers, auth) need a fresh socket. */
  async upsert(def: McpServerDef): Promise<McpClient> {
    if (!def.id || !/^[a-zA-Z0-9_.-]+$/.test(def.id)) {
      throw new Error('server id must match [a-zA-Z0-9_.-]+');
    }
    this.store.upsert(def);
    const existing = this.clients.get(def.id);
    if (existing) {
      await existing.disconnect();
      existing.updateDef(def);
    }
    const client = existing ?? new McpClient(def);
    if (!existing) this.clients.set(def.id, client);
    if (def.enabled !== false) {
      try { await client.connect(); }
      catch (e) {
        logger.warn('[McpClientManager] connect after upsert failed', {
          id: def.id, err: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return client;
  }

  async remove(id: string): Promise<boolean> {
    const client = this.clients.get(id);
    if (!client) return this.store.delete(id);
    await client.disconnect();
    this.clients.delete(id);
    this.store.delete(id);
    return true;
  }

  async connect(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) throw new Error(`unknown server: ${id}`);
    await client.connect();
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (!client) throw new Error(`unknown server: ${id}`);
    await client.disconnect();
  }

  async listTools(id: string): Promise<McpToolDescriptor[]> {
    const client = this.requireConnected(id);
    return client.refreshTools();
  }

  async callTool(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<McpToolCallResult> {
    const client = this.requireConnected(id);
    return client.callTool(name, args, opts);
  }

  /** Surface the connected, agent-exposed tools as a flat list. The
   *  returned descriptors are namespaced as `<serverId>.<toolName>` so the
   *  agent skill can route the call back to the right server. */
  listExposedToolsForAgents(): Array<{ serverId: string; serverName: string; tool: McpToolDescriptor }> {
    const out: Array<{ serverId: string; serverName: string; tool: McpToolDescriptor }> = [];
    for (const client of this.clients.values()) {
      const def = client.getDef();
      if (def.exposeToAgents === false) continue;
      if (!client.isConnected()) continue;
      for (const tool of client.getCachedTools()) {
        out.push({ serverId: def.id, serverName: def.name, tool });
      }
    }
    return out;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.list().map(c => c.disconnect()));
  }

  private requireConnected(id: string): McpClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`unknown server: ${id}`);
    if (!client.isConnected()) {
      throw new Error(`server "${id}" is not connected`);
    }
    return client;
  }
}

function toSummary(client: McpClient): McpServerSummary {
  const def = client.getDef();
  const status = client.getStatus();
  return {
    def: {
      id: def.id,
      name: def.name,
      description: def.description,
      transport: def.transport,
      url: def.url,
      headers: def.headers,
      command: def.command,
      args: def.args,
      enabled: def.enabled !== false,
      exposeToAgents: def.exposeToAgents !== false,
      hasAuthToken: !!def.authToken,
    },
    status,
  };
}

function parseEnvServers(): McpServerDef[] {
  const raw = process.env.MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: McpServerDef[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && entry.id && entry.transport) {
        out.push(entry as McpServerDef);
      }
    }
    return out;
  } catch (e) {
    logger.warn('[McpClientManager] MCP_SERVERS env var is not valid JSON', {
      err: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

function parseOpenclawDefault(): McpServerDef | null {
  const url = process.env.OPENCLAW_MCP_URL;
  if (!url) return null;
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'OpenClaw chat-gateway (MCP)',
    transport: 'http',
    url,
    authToken: process.env.OPENCLAW_GATEWAY_TOKEN || undefined,
    enabled: true,
    exposeToAgents: true,
  };
}

let singleton: McpClientManager | null = null;
export function getMcpClientManager(): McpClientManager {
  if (!singleton) singleton = new McpClientManager();
  return singleton;
}

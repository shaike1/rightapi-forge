// Thin wrapper around the official `@modelcontextprotocol/sdk` Client.
// Owns one connection (transport + SDK Client) and exposes the small slice
// of MCP we actually use here: list_tools and call_tool. Connection
// lifecycle is intentionally explicit — the manager calls connect() /
// disconnect() and treats this object as restartable.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '../../utils/logger.js';
import type {
  McpConnectionStatus,
  McpServerDef,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from './types.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class McpClient {
  private client: Client | null = null;
  private transport: unknown = null;
  private status: McpConnectionStatus = 'disconnected';
  private lastError?: string;
  private lastConnectedAt?: string;
  private cachedTools: McpToolDescriptor[] = [];

  constructor(private def: McpServerDef) {}

  /** Allow the manager to swap the underlying definition without dropping the
   *  cached status. The caller is expected to disconnect first if anything
   *  transport-affecting changed. */
  updateDef(def: McpServerDef): void {
    this.def = def;
  }

  getDef(): McpServerDef {
    return this.def;
  }

  getStatus(): McpServerStatus {
    return {
      id: this.def.id,
      name: this.def.name,
      transport: this.def.transport,
      status: this.status,
      enabled: this.def.enabled !== false,
      exposeToAgents: this.def.exposeToAgents !== false,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      toolCount: this.cachedTools.length,
    };
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  /** Establish a fresh connection. Idempotent — if already connected, this
   *  returns immediately. Throws on failure so callers can decide whether
   *  to retry; the catch site stores the error on `lastError`. */
  async connect(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'connected') return;
    this.status = 'connecting';
    this.lastError = undefined;
    try {
      this.transport = await this.buildTransport();
      this.client = new Client(
        { name: 'itops-agents', version: '1.0.0' },
        { capabilities: {} },
      );
      // SDK's connect() requires the transport's exact union type; we
      // type-erase here because we already validated the shape in
      // buildTransport().
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.client.connect(this.transport as any);
      this.status = 'connected';
      this.lastConnectedAt = new Date().toISOString();
      // Eagerly cache tools so getStatus() reports a sensible count.
      try { await this.refreshTools(); } catch { /* best effort */ }
      logger.info('[McpClient] connected', {
        id: this.def.id, transport: this.def.transport, tools: this.cachedTools.length,
      });
    } catch (e) {
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : String(e);
      // Best-effort cleanup so a half-built transport doesn't leak.
      await this.safeClose();
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this.safeClose();
    this.status = 'disconnected';
  }

  private async safeClose(): Promise<void> {
    try { await this.client?.close(); } catch { /* ignore */ }
    try {
      const t = this.transport as { close?: () => Promise<void> | void } | null;
      if (t && typeof t.close === 'function') await t.close();
    } catch { /* ignore */ }
    this.client = null;
    this.transport = null;
  }

  /** Build the transport for the configured kind. Validation lives here so
   *  the connect path can stay linear. */
  private async buildTransport(): Promise<unknown> {
    const def = this.def;
    if (def.transport === 'http') {
      if (!def.url) throw new Error('http transport requires url');
      const opts: { requestInit?: { headers: Record<string, string> } } = {};
      const headers: Record<string, string> = { ...(def.headers ?? {}) };
      if (def.authToken) headers.Authorization = `Bearer ${def.authToken}`;
      if (Object.keys(headers).length > 0) opts.requestInit = { headers };
      return new StreamableHTTPClientTransport(new URL(def.url), opts);
    }
    if (def.transport === 'sse') {
      if (!def.url) throw new Error('sse transport requires url');
      const headers: Record<string, string> = { ...(def.headers ?? {}) };
      if (def.authToken) headers.Authorization = `Bearer ${def.authToken}`;
      const opts = Object.keys(headers).length > 0
        ? { requestInit: { headers } }
        : undefined;
      return new SSEClientTransport(new URL(def.url), opts);
    }
    if (def.transport === 'stdio') {
      if (!def.command) throw new Error('stdio transport requires command');
      return new StdioClientTransport({
        command: def.command,
        args: def.args ?? [],
        env: def.env,
      });
    }
    throw new Error(`unknown transport: ${(def as { transport: string }).transport}`);
  }

  /** List tools. Caches the result so the UI doesn't pay a round-trip for
   *  status pages. */
  async refreshTools(): Promise<McpToolDescriptor[]> {
    if (!this.client) throw new Error('not connected');
    const resp = await this.client.listTools();
    const list = Array.isArray(resp?.tools) ? resp.tools : [];
    this.cachedTools = list.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return this.cachedTools;
  }

  getCachedTools(): McpToolDescriptor[] {
    return this.cachedTools.slice();
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<McpToolCallResult> {
    if (!this.client) throw new Error('not connected');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const callPromise = this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs },
    );
    const result = await callPromise as {
      content?: unknown;
      isError?: boolean;
    };
    return {
      content: result?.content ?? null,
      isError: result?.isError === true,
    };
  }
}

/**
 * A2APeerClient — calls another agent's A2A task endpoint on the same server.
 * Phase 3: Agent-calls-Agent
 *
 * Uses localhost HTTP so it reuses all existing auth/route logic without
 * needing a separate inter-process channel.
 */
import { v4 as uuidv4 } from 'uuid';
import type {
  A2AMessage,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATaskSendParams,
} from './A2ATypes.js';
import type { A2ATaskRecord } from './A2ATaskStore.js';

export interface PeerInvokeOptions {
  /** ID of the parent task that is spawning this sub-task */
  parentTaskId?: string;
  sessionId?: string;
  /** Max ms to wait for the peer task to reach a terminal state */
  timeoutMs?: number;
  /**
   * Phase 4: For external agents, provide their full task endpoint URL.
   * If omitted, defaults to `${baseUrl}/a2a/agents/${agentId}` (internal).
   */
  taskEndpoint?: string;
  /**
   * Phase 4: Auth config for external agents (bearer token, API key, etc.)
   * If omitted for external agents, no auth header is sent.
   */
  authConfig?: import('./ExternalAgentRegistry.js').ExternalAgentAuthConfig;
}

export class A2APeerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
  ) {}

  /**
   * Send a task to another agent and wait for it to complete.
   * Returns the completed (or failed) task record.
   */
  async invoke(
    agentId: string,
    message: A2AMessage,
    options: PeerInvokeOptions = {},
  ): Promise<A2ATaskRecord> {
    const { parentTaskId, sessionId, timeoutMs = 30_000, taskEndpoint, authConfig } = options;

    // Phase 4: external agents have their own URL; internal agents use localhost routing
    const endpoint = taskEndpoint ?? `${this.baseUrl}/a2a/agents/${agentId}`;
    const isExternal = !!taskEndpoint;

    const rpc: A2AJsonRpcRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tasks/send',
      params: {
        id: uuidv4(),
        sessionId,
        message,
        metadata: parentTaskId ? { parentTaskId } : undefined,
      } as unknown as Record<string, unknown>,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (!isExternal) {
      // Internal: use our own server's Bearer token
      headers['Authorization'] = `Bearer ${this.internalToken}`;
    } else if (authConfig && authConfig.type !== 'none') {
      // External: apply configured auth scheme
      if (authConfig.type === 'bearer' && authConfig.token) {
        headers['Authorization'] = `Bearer ${authConfig.token}`;
      } else if (authConfig.type === 'apikey' && authConfig.token) {
        const headerName = authConfig.header ?? 'X-Api-Key';
        headers[headerName] = authConfig.token;
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`Peer HTTP error ${res.status} invoking ${isExternal ? 'external' : ''} agent ${agentId}`);
    }

    const resp = (await res.json()) as A2AJsonRpcResponse<A2ATaskRecord>;
    if (resp.error) {
      throw new Error(`Peer RPC error: ${resp.error.message}`);
    }

    const task = resp.result!;
    return this._pollUntilDone(task.id, timeoutMs);
  }

  private async _pollUntilDone(taskId: string, timeoutMs: number): Promise<A2ATaskRecord> {
    const TERMINAL = ['completed', 'failed', 'canceled'];
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const r = await fetch(`${this.baseUrl}/a2a/tasks/${taskId}`, {
          headers: { 'Authorization': `Bearer ${this.internalToken}` },
        });
        if (!r.ok) break;
        const task = (await r.json()) as A2ATaskRecord;
        if (TERMINAL.includes(task.status.state)) return task;
      } catch {
        // network hiccup — retry
      }
    }

    throw new Error(`Peer task ${taskId} did not complete within ${timeoutMs}ms`);
  }
}

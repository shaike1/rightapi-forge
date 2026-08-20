// Shared types for the MCP-client integration. Server definitions are the
// minimum shape needed to (re)open a connection — secrets land in headers
// at request time but the structured fields persist as-is.

export type McpTransportKind = 'http' | 'sse' | 'stdio';

export interface McpServerDef {
  /** Stable id; URL-safe slug. */
  id: string;
  /** Human label shown in the UI. */
  name: string;
  /** Optional description. */
  description?: string;
  transport: McpTransportKind;

  /** http / sse: target URL. */
  url?: string;
  /** http / sse: optional bearer token. */
  authToken?: string;
  /** http / sse: extra headers (e.g. {"X-API-Key": "…"}). */
  headers?: Record<string, string>;

  /** stdio: executable command. */
  command?: string;
  /** stdio: argv. */
  args?: string[];
  /** stdio: env passed to the child. */
  env?: Record<string, string>;

  /** When false the manager won't auto-connect on boot. */
  enabled?: boolean;
  /** When true, agents may call this server's tools via the `mcp` skill. */
  exposeToAgents?: boolean;
}

export type McpConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpTransportKind;
  status: McpConnectionStatus;
  enabled: boolean;
  exposeToAgents: boolean;
  /** ISO timestamp of last successful connect. */
  lastConnectedAt?: string;
  /** Most recent error string, if any. */
  lastError?: string;
  /** Cached tool count from the last listTools(). */
  toolCount: number;
}

export interface McpToolCallResult {
  /** Free-form structured content returned by the server, normalised
   *  through the SDK shape — usually `{ content: [{type, text}, …] }`. */
  content: unknown;
  /** True when the server flagged the call as an error result. */
  isError: boolean;
}

/** Public summary of a server, suitable for the UI / API response. Combines
 *  the configured definition with its current runtime status, never
 *  including the auth token. */
export interface McpServerSummary {
  def: Omit<McpServerDef, 'authToken' | 'env'> & { hasAuthToken: boolean };
  status: McpServerStatus;
}

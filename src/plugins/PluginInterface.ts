// PluginInterface — types every built-in or third-party integration plugin
// implements. The PluginManager dispatches lifecycle + event hooks against
// this surface.
//
// All hooks are optional except onLoad/onUnload — a plugin that only emits
// metrics (e.g. Prometheus) doesn't need to know about incidents, and a
// plugin that only forwards incidents to a paging tool (PagerDuty) doesn't
// need to receive metric ticks.
//
// Plugins MUST NOT import platform internals directly. They get everything
// they need through PluginContext — that's what makes plugins testable
// against a mock context, and what lets us swap dependencies (logger,
// HTTP client, etc.) without touching plugin code.

import type { logger as baseLogger } from '../utils/logger.js';
import type { Incident } from '../persistence/SqliteStore.js';
import type { Problem } from '../incidents/ProblemStore.js';
import type { Asset } from '../cmdb/AssetStore.js';
import type { Change } from '../changes/ChangeStore.js';
import type { KnowledgeArticle } from '../knowledge/KnowledgeStore.js';

/** Same shape as the platform logger — kept here as a structural type so
 *  plugin code doesn't reach into `src/utils/`. */
export type PluginLogger = typeof baseLogger;
import type { MonitoredServer } from '../monitoring/ServerRegistry.js';
import type { MetricSample } from '../monitoring/MetricsHistoryStore.js';
import type { RunbookRun } from '../runbooks/RunbookTypes.js';

// ── Config schema ──────────────────────────────────────────────────────

/** Description of one config field. The frontend renders the form from
 *  these; the backend validates incoming PUT bodies against them. */
export interface PluginConfigField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'url' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  helpText?: string;
}

// ── Event payloads ─────────────────────────────────────────────────────

export interface AlertPayload {
  ruleId?: string;
  ruleName: string;
  metric?: string;
  server?: string;
  value?: number;
  threshold?: number;
  operator?: string;
  severity: string;
  firedAt: string;
  message?: string;
}

export interface MetricCollectedPayload {
  server: MonitoredServer;
  samples: MetricSample[];
}

/** External incident shape — when a plugin pulls incidents from a remote
 *  system (PagerDuty, OpsGenie, etc.) it normalises them into this shape
 *  so the dashboard can render a unified inbox. */
export interface ExternalIncident {
  externalId: string;
  source: string;             // plugin id
  title: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  status?: string;
  url?: string;
  openedAt?: string;
  raw?: unknown;              // original payload for debugging
}

// ── Context passed to onLoad ───────────────────────────────────────────

/** What a plugin can do at runtime. Each field is intentionally narrow —
 *  for example we expose `incidents.create()` for plugins that want to
 *  import incidents from a remote system, but NOT direct access to the
 *  sqlite store. */
export interface PluginContext {
  /** Per-plugin logger with `pluginId` baked in. */
  logger: PluginLogger;
  /** Plugin id — handy for log lines + audit entries. */
  pluginId: string;

  incidents: {
    create: (params: {
      title: string;
      description?: string;
      severity?: 'low' | 'medium' | 'high' | 'critical';
      source?: string;
      sourceRef?: string;
      serverId?: string | null;
    }) => Incident;
    resolve: (id: string, resolution: string) => Incident | null;
    escalate: (id: string, reason: string) => Incident | null;
    list: (filter?: { status?: string; severity?: string }) => Incident[];
    get: (id: string) => (Incident & { timeline: unknown[] }) | null;
  };

  servers: {
    list: () => MonitoredServer[];
    get: (id: string) => MonitoredServer | null;
  };

  metrics: {
    /** Most-recent samples for one server. */
    latest: (serverId: string) => MetricSample[];
  };

  audit: {
    log: (action: string, detail?: string) => void;
  };

  /** Sandboxed HTTP client. Times out at 10s by default, sets a User-Agent,
   *  and never throws on non-2xx (returns `{ ok: false, status }` instead).
   *  Plugins should NOT import `fetch` or other HTTP libraries directly. */
  http: PluginHttp;
}

export interface PluginHttpResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON if the response body is JSON-shaped, otherwise the raw
   *  string. Lazy: not invoked unless the plugin reads it. */
  body: () => Promise<unknown>;
  text: () => Promise<string>;
}

export interface PluginHttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface PluginHttp {
  get(url: string, opts?: PluginHttpOptions): Promise<PluginHttpResponse>;
  post(url: string, body: unknown, opts?: PluginHttpOptions): Promise<PluginHttpResponse>;
  put(url: string, body: unknown, opts?: PluginHttpOptions): Promise<PluginHttpResponse>;
  delete(url: string, opts?: PluginHttpOptions): Promise<PluginHttpResponse>;
}

// ── The plugin contract itself ────────────────────────────────────────

export interface ITOpsPlugin {
  /** Stable id — used as the SQLite primary key + the URL path segment. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly configSchema: PluginConfigField[];

  /** Called when the plugin is enabled (and on every config change). The
   *  plugin should establish connections, register webhooks, etc. Throw
   *  to signal a config error — the manager will surface the message in
   *  `last_error` and leave the plugin disabled. */
  onLoad(config: Record<string, unknown>, context: PluginContext): Promise<void>;

  /** Called on disable or before reload. Plugins should release sockets,
   *  cancel timers, etc. Errors here are logged but don't block other
   *  cleanup paths. */
  onUnload(): Promise<void>;

  // Lifecycle hooks — all optional. Implementations must be idempotent
  // and fast (<1s typical). The manager invokes them fire-and-forget;
  // a slow plugin won't block other plugins or the core path.
  onIncidentCreated?(incident: Incident): Promise<void>;
  onIncidentResolved?(incident: Incident): Promise<void>;
  onIncidentEscalated?(incident: Incident, level: number): Promise<void>;
  onMetricCollected?(payload: MetricCollectedPayload): Promise<void>;
  onRunbookCompleted?(run: RunbookRun): Promise<void>;
  onAlertFired?(alert: AlertPayload): Promise<void>;

  /** Fired when the recurring-incident detector groups a new set of
   *  incidents into a Problem. Plugins use this to notify their
   *  external systems that something keeps happening — typically
   *  worth a separate ticket from the individual incident pages. */
  onProblemCreated?(problem: Problem): Promise<void>;

  /** Fired when a new CMDB asset is created — either auto-discovered
   *  from the ServerRegistry or operator-created via /api/assets. Plugins
   *  use this to mirror assets into an external CMDB (ServiceNow, etc.)
   *  or to push fresh inventory rows into an asset tracker. Updates do
   *  NOT fire — listen via getExternalStatus / poll if you need them. */
  onAssetCreated?(asset: Asset): Promise<void>;

  /** Fired when a new change-management record is created — by an
   *  operator via /api/changes, by a runbook execution that
   *  auto-logs, or by an auto-remediation. Plugins use this to push
   *  the change into an external change calendar (ServiceNow,
   *  Atlassian, etc.). */
  onChangeCreated?(change: Change): Promise<void>;

  /** Fired exactly once per change when status transitions to a
   *  terminal value (completed/failed/rolled_back). Plugins use this
   *  to close the corresponding external ticket and emit a deploy
   *  notification. */
  onChangeCompleted?(change: Change): Promise<void>;

  /** Fired when a Knowledge Base article is created — by an operator
   *  via /api/knowledge or by the auto-draft hook that runs on
   *  high-severity incident resolution. Plugins use this to mirror
   *  KB content into an external help-center (Notion, Confluence,
   *  Intercom, …). Article updates and upvotes do NOT fire — listen
   *  via getExternalStatus / poll if you need them. */
  onArticleCreated?(article: KnowledgeArticle): Promise<void>;

  /** Operator-facing "is this thing healthy?" probe. Surfaced in
   *  /api/integrations/:id/status — small JSON object the frontend
   *  renders next to the toggle. */
  getExternalStatus?(): Promise<Record<string, unknown>>;

  /** Pull incidents from the external system. Used by future "unified
   *  inbox" view. */
  getExternalIncidents?(): Promise<ExternalIncident[]>;

  /** Push an incident state change back to the external system. The
   *  manager calls this in addition to onIncidentResolved/etc when an
   *  explicit sync is requested. */
  syncIncident?(incident: Incident): Promise<void>;

  /** Optional: contribute extra lines to the existing /metrics endpoint.
   *  When present, the manager appends the returned text verbatim. This
   *  is how PrometheusPlugin exposes its counters/gauges without
   *  replacing the hand-rolled /metrics handler. */
  renderPrometheus?(): string;
}

// PluginManager — registry + lifecycle for event-driven integration plugins.
//
// Responsibilities:
//   - Hold the in-memory roster of built-in (and, later, marketplace)
//     plugins, identified by id.
//   - Persist enable/disable state + encrypted config to the
//     `integration_plugins` SQLite table.
//   - Validate configs against each plugin's declared configSchema before
//     calling onLoad — surface schema errors as `last_error` rather than
//     a crash.
//   - Fan platform events out to enabled plugins, with strict error
//     isolation: a plugin that throws is logged + the error stored, but
//     never blocks the next plugin or the core call path.
//   - Provide a `testConnection` helper so the Settings UI can validate
//     credentials without flipping the enabled flag.
//
// Design choices that took thought:
//
// 1. Hook dispatch is fire-and-forget. The caller doesn't await — a slow
//    PagerDuty round-trip must not block an incident from being created.
//    Errors are caught inside the wrapper so the unhandled-rejection
//    handler doesn't take down the process either.
//
// 2. Plugin code is bundled with the platform (built-ins under
//    src/plugins/builtin/). The SQLite row only stores config + enabled
//    state; the plugin object itself is found by id in the in-memory
//    registry. Third-party plugins are out of scope for v1 — they'd go
//    through PluginLoader (the existing script-runner system) on a
//    different namespace.
//
// 3. Loading happens lazily: enabling a plugin invokes onLoad once;
//    onLoad failure leaves the row in `enabled=0` with `last_error`
//    populated so the UI can show the error and the operator can fix
//    the config without losing it.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';
import type {
  ITOpsPlugin, PluginContext, PluginConfigField, AlertPayload,
  MetricCollectedPayload, ExternalIncident,
} from './PluginInterface.js';
import type { PluginConfigEncryption } from './PluginConfigEncryption.js';
import type { Incident } from '../persistence/SqliteStore.js';
import type { RunbookRun } from '../runbooks/RunbookTypes.js';
import type { Problem } from '../incidents/ProblemStore.js';
import type { Asset } from '../cmdb/AssetStore.js';
import type { Change } from '../changes/ChangeStore.js';
import type { KnowledgeArticle } from '../knowledge/KnowledgeStore.js';

const HOOK_TIMEOUT_MS = 10_000;

export interface PluginStatusRow {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  configSchema: PluginConfigField[];
  /** Config returned to the UI has all `password` fields redacted. */
  config: Record<string, unknown> | null;
  installedAt: string;
  updatedAt: string;
  lastError: string | null;
  /** False before the first successful onLoad — distinguishes "enabled and
   *  running" from "enabled in DB but onLoad failed". */
  loaded: boolean;
}

interface Row {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: number;
  config: string | null;       // encrypted envelope
  last_error: string | null;
  installed_at: string;
  updated_at: string;
}

export interface PluginManagerDeps {
  dbPath: string;
  encryption: PluginConfigEncryption;
  /** Factory that produces the per-plugin PluginContext. The factory takes
   *  the plugin id so the logger / audit log lines can be tagged. */
  contextFor: (pluginId: string) => PluginContext;
}

export class PluginManager {
  private readonly db: Database.Database;
  private readonly encryption: PluginConfigEncryption;
  private readonly contextFor: (id: string) => PluginContext;

  /** Registered plugin objects, keyed by id. Populated by register() —
   *  rows in the DB without a matching registration are ignored (e.g.
   *  after uninstalling a built-in). */
  private readonly registry = new Map<string, ITOpsPlugin>();

  /** Plugins whose onLoad has succeeded — fan-out iterates this set. */
  private readonly loaded = new Set<string>();

  constructor(deps: PluginManagerDeps) {
    const dir = dirname(deps.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(deps.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.encryption = deps.encryption;
    this.contextFor = deps.contextFor;
    logger.info('[PluginManager] opened', { dbPath: deps.dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_plugins (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        version       TEXT NOT NULL,
        description   TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 0,
        config        TEXT,
        last_error    TEXT,
        installed_at  TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      -- Boot-time scan filters by enabled=1; index makes startup linear
      -- in the enabled count instead of total plugin count.
      CREATE INDEX IF NOT EXISTS idx_integration_plugins_enabled ON integration_plugins(enabled);
    `);
  }

  // ─── Registration ─────────────────────────────────────────────────────

  /** Make a plugin known to the manager. Creates the SQLite row on first
   *  registration; subsequent calls only refresh version/description so
   *  built-in upgrades land cleanly. */
  register(plugin: ITOpsPlugin): void {
    if (this.registry.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" already registered`);
    }
    this.registry.set(plugin.id, plugin);
    const existing = this.getRow(plugin.id);
    const now = new Date().toISOString();
    if (!existing) {
      this.db.prepare(`
        INSERT INTO integration_plugins (id, name, version, description, enabled, config, last_error, installed_at, updated_at)
        VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)
      `).run(plugin.id, plugin.name, plugin.version, plugin.description, now, now);
    } else if (existing.version !== plugin.version || existing.name !== plugin.name || existing.description !== plugin.description) {
      this.db.prepare(`
        UPDATE integration_plugins SET name = ?, version = ?, description = ?, updated_at = ? WHERE id = ?
      `).run(plugin.name, plugin.version, plugin.description, now, plugin.id);
    }
  }

  /** Load every plugin whose row is enabled. Call at boot, after all
   *  built-ins are registered. */
  async loadEnabled(): Promise<void> {
    const rows = this.db.prepare('SELECT id FROM integration_plugins WHERE enabled = 1').all() as Array<{ id: string }>;
    for (const r of rows) {
      const plugin = this.registry.get(r.id);
      if (!plugin) continue;
      try {
        await this.invokeLoad(plugin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.setLastError(plugin.id, msg);
        logger.warn('[PluginManager] onLoad failed at boot', { pluginId: plugin.id, err: msg });
        // Stay enabled in DB so the UI shows "enabled but errored" — flip
        // only if explicit disable() is called. This avoids silently
        // disabling a plugin whose remote API is briefly unreachable.
      }
    }
  }

  /** Stop every loaded plugin. Used by graceful shutdown — best-effort,
   *  errors only log. */
  async shutdown(): Promise<void> {
    for (const id of Array.from(this.loaded)) {
      const plugin = this.registry.get(id);
      if (!plugin) continue;
      try {
        await plugin.onUnload();
      } catch (e) {
        logger.warn('[PluginManager] onUnload threw', { pluginId: id, err: e instanceof Error ? e.message : String(e) });
      }
      this.loaded.delete(id);
    }
  }

  // ─── CRUD-ish surface for the API ─────────────────────────────────────

  list(): PluginStatusRow[] {
    return Array.from(this.registry.values()).map(p => this.viewOf(p));
  }

  get(id: string): PluginStatusRow | null {
    const p = this.registry.get(id);
    return p ? this.viewOf(p) : null;
  }

  /** Persist a new config + (re)load the plugin if enabled. Throws when
   *  the schema rejects the incoming body so the API can return 400. */
  async setConfig(id: string, config: Record<string, unknown>): Promise<PluginStatusRow> {
    const plugin = this.registry.get(id);
    if (!plugin) throw new Error(`Unknown plugin "${id}"`);
    // Validate the merged result, not just the incoming patch — for
    // password fields the empty string is a "keep existing" sentinel,
    // so the incoming patch can legitimately not include them.
    const merged = this.mergeWithStored(plugin, config);
    this.validateConfig(plugin, merged);
    const envelope = this.encryption.encrypt(merged);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE integration_plugins SET config = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(envelope, now, id);
    // If currently loaded, restart with the new config so the change
    // takes effect immediately. Failures keep the new config but flip
    // last_error + drop from loaded set.
    if (this.loaded.has(id)) {
      try { await plugin.onUnload(); } catch (e) {
        logger.warn('[PluginManager] onUnload during setConfig threw', { pluginId: id, err: e instanceof Error ? e.message : String(e) });
      }
      this.loaded.delete(id);
      if (this.isEnabled(id)) {
        await this.invokeLoad(plugin).catch(e => this.setLastError(id, e instanceof Error ? e.message : String(e)));
      }
    }
    return this.viewOf(plugin);
  }

  async enable(id: string): Promise<PluginStatusRow> {
    const plugin = this.registry.get(id);
    if (!plugin) throw new Error(`Unknown plugin "${id}"`);
    this.db.prepare('UPDATE integration_plugins SET enabled = 1, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    await this.invokeLoad(plugin).catch(e => {
      const msg = e instanceof Error ? e.message : String(e);
      this.setLastError(id, msg);
      // Leave enabled=1 — see loadEnabled() rationale.
      throw new Error(`enable() onLoad failed: ${msg}`);
    });
    return this.viewOf(plugin);
  }

  async disable(id: string): Promise<PluginStatusRow> {
    const plugin = this.registry.get(id);
    if (!plugin) throw new Error(`Unknown plugin "${id}"`);
    if (this.loaded.has(id)) {
      try { await plugin.onUnload(); } catch (e) {
        logger.warn('[PluginManager] onUnload threw on disable', { pluginId: id, err: e instanceof Error ? e.message : String(e) });
      }
      this.loaded.delete(id);
    }
    this.db.prepare('UPDATE integration_plugins SET enabled = 0, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return this.viewOf(plugin);
  }

  /** Run onLoad against a candidate config without persisting anything.
   *  Used by POST /api/integrations/:id/test so the Settings UI can
   *  validate credentials before saving. */
  async testConnection(id: string, candidateConfig: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    const plugin = this.registry.get(id);
    if (!plugin) return { ok: false, error: `Unknown plugin "${id}"` };
    try {
      this.validateConfig(plugin, candidateConfig);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    try {
      await plugin.onLoad(candidateConfig, this.contextFor(plugin.id));
      try { await plugin.onUnload(); } catch { /* test must not leak side effects */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Surfaced through GET /api/integrations/:id/status. Returns whatever
   *  the plugin emits + a tiny `loaded` flag. */
  async externalStatus(id: string): Promise<Record<string, unknown>> {
    const plugin = this.registry.get(id);
    if (!plugin) return { loaded: false, error: `Unknown plugin "${id}"` };
    if (!this.loaded.has(id)) return { loaded: false };
    if (!plugin.getExternalStatus) return { loaded: true };
    try {
      const out = await plugin.getExternalStatus();
      return { loaded: true, ...(out ?? {}) };
    } catch (e) {
      return { loaded: true, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async externalIncidents(id: string): Promise<ExternalIncident[]> {
    const plugin = this.registry.get(id);
    if (!plugin || !plugin.getExternalIncidents || !this.loaded.has(id)) return [];
    try {
      return await plugin.getExternalIncidents();
    } catch (e) {
      logger.warn('[PluginManager] getExternalIncidents threw', { pluginId: id, err: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  // ─── Hook fan-out ─────────────────────────────────────────────────────

  notifyIncidentCreated(incident: Incident): void {
    this.fanOut('onIncidentCreated', plugin => plugin.onIncidentCreated?.(incident));
  }
  notifyIncidentResolved(incident: Incident): void {
    this.fanOut('onIncidentResolved', plugin => plugin.onIncidentResolved?.(incident));
  }
  notifyIncidentEscalated(incident: Incident, level: number): void {
    this.fanOut('onIncidentEscalated', plugin => plugin.onIncidentEscalated?.(incident, level));
  }
  notifyMetricCollected(payload: MetricCollectedPayload): void {
    this.fanOut('onMetricCollected', plugin => plugin.onMetricCollected?.(payload));
  }
  notifyRunbookCompleted(run: RunbookRun): void {
    this.fanOut('onRunbookCompleted', plugin => plugin.onRunbookCompleted?.(run));
  }
  notifyAlertFired(alert: AlertPayload): void {
    this.fanOut('onAlertFired', plugin => plugin.onAlertFired?.(alert));
  }
  notifyProblemCreated(problem: Problem): void {
    this.fanOut('onProblemCreated', plugin => plugin.onProblemCreated?.(problem));
  }
  notifyAssetCreated(asset: Asset): void {
    this.fanOut('onAssetCreated', plugin => plugin.onAssetCreated?.(asset));
  }
  notifyChangeCreated(change: Change): void {
    this.fanOut('onChangeCreated', plugin => plugin.onChangeCreated?.(change));
  }
  notifyChangeCompleted(change: Change): void {
    this.fanOut('onChangeCompleted', plugin => plugin.onChangeCompleted?.(change));
  }
  notifyArticleCreated(article: KnowledgeArticle): void {
    this.fanOut('onArticleCreated', plugin => plugin.onArticleCreated?.(article));
  }

  /** Concatenate the Prometheus output of every loaded plugin that
   *  implements renderPrometheus(). Used by the existing /metrics handler
   *  to append plugin-contributed lines. */
  renderPrometheus(): string {
    const out: string[] = [];
    for (const id of this.loaded) {
      const plugin = this.registry.get(id);
      if (!plugin?.renderPrometheus) continue;
      try {
        const text = plugin.renderPrometheus();
        if (text) out.push(text);
      } catch (e) {
        logger.warn('[PluginManager] renderPrometheus threw', { pluginId: id, err: e instanceof Error ? e.message : String(e) });
      }
    }
    return out.join('\n');
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /** True when the plugin's DB row says `enabled = 1`. */
  private isEnabled(id: string): boolean {
    const row = this.getRow(id);
    return !!row && row.enabled === 1;
  }

  private getRow(id: string): Row | null {
    const row = this.db.prepare('SELECT * FROM integration_plugins WHERE id = ?').get(id) as Row | undefined;
    return row ?? null;
  }

  private setLastError(id: string, message: string): void {
    this.db.prepare('UPDATE integration_plugins SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(message.slice(0, 500), new Date().toISOString(), id);
  }

  /** Resolve stored config + call onLoad. Bumps `loaded` set on success. */
  private async invokeLoad(plugin: ITOpsPlugin): Promise<void> {
    const config = this.readStoredConfig(plugin.id) ?? {};
    this.validateConfig(plugin, config);
    await plugin.onLoad(config, this.contextFor(plugin.id));
    this.loaded.add(plugin.id);
    this.db.prepare('UPDATE integration_plugins SET last_error = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), plugin.id);
  }

  private readStoredConfig(id: string): Record<string, unknown> | null {
    const row = this.getRow(id);
    if (!row || !row.config) return null;
    try {
      return this.encryption.decrypt<Record<string, unknown>>(row.config);
    } catch (e) {
      logger.warn('[PluginManager] decrypt failed', { pluginId: id, err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** Merge an incoming partial config with whatever is already stored,
   *  so an operator can update a single field without resending the
   *  whole shape. Empty-string values for password fields are dropped
   *  (so the masked '*****' redaction the UI shows can be safely
   *  round-tripped without nuking the real value). */
  private mergeWithStored(plugin: ITOpsPlugin, incoming: Record<string, unknown>): Record<string, unknown> {
    const stored = this.readStoredConfig(plugin.id) ?? {};
    const merged: Record<string, unknown> = { ...stored };
    for (const field of plugin.configSchema) {
      const v = incoming[field.key];
      if (v === undefined) continue;
      if (field.type === 'password' && typeof v === 'string' && v.length === 0) continue;
      merged[field.key] = v;
    }
    return merged;
  }

  private validateConfig(plugin: ITOpsPlugin, config: Record<string, unknown>): void {
    for (const field of plugin.configSchema) {
      const v = config[field.key];
      if (field.required && (v === undefined || v === null || v === '')) {
        throw new Error(`config.${field.key} is required`);
      }
      if (v === undefined || v === null) continue;
      switch (field.type) {
        case 'string':
        case 'password':
        case 'url':
        case 'select':
          if (typeof v !== 'string') throw new Error(`config.${field.key} must be a string`);
          break;
        case 'number':
          if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`config.${field.key} must be a number`);
          break;
        case 'boolean':
          if (typeof v !== 'boolean') throw new Error(`config.${field.key} must be a boolean`);
          break;
      }
      if (field.type === 'select' && field.options && !field.options.some(o => o.value === v)) {
        throw new Error(`config.${field.key} must be one of: ${field.options.map(o => o.value).join(', ')}`);
      }
    }
  }

  private viewOf(plugin: ITOpsPlugin): PluginStatusRow {
    const row = this.getRow(plugin.id);
    const enabled = !!row && row.enabled === 1;
    const stored = this.readStoredConfig(plugin.id);
    const redacted = stored ? this.redactConfig(plugin, stored) : null;
    return {
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      enabled,
      configSchema: plugin.configSchema,
      config: redacted,
      installedAt: row?.installed_at ?? new Date().toISOString(),
      updatedAt: row?.updated_at ?? new Date().toISOString(),
      lastError: row?.last_error ?? null,
      loaded: this.loaded.has(plugin.id),
    };
  }

  /** Replace `password`-type fields with a fixed redaction so the API
   *  response (and the React form pre-fill) never carries the real
   *  secret. The empty-string special case in mergeWithStored handles
   *  the round-trip on save. */
  private redactConfig(plugin: ITOpsPlugin, config: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...config };
    for (const field of plugin.configSchema) {
      if (field.type === 'password' && typeof out[field.key] === 'string' && (out[field.key] as string).length > 0) {
        out[field.key] = '__REDACTED__';
      }
    }
    return out;
  }

  /** Run a hook on every loaded plugin with strict per-plugin isolation.
   *  Fire-and-forget — does not await; promises that reject are caught and
   *  logged here so unhandled-rejection handlers stay quiet. */
  private fanOut(hookName: string, invoke: (plugin: ITOpsPlugin) => Promise<void> | undefined): void {
    for (const id of this.loaded) {
      const plugin = this.registry.get(id);
      if (!plugin) continue;
      let result: Promise<void> | undefined;
      try {
        result = invoke(plugin);
      } catch (e) {
        // Synchronous throw from the plugin's hook body.
        this.recordHookError(id, hookName, e);
        continue;
      }
      if (!result) continue;
      // Wrap in a timeout so a stuck network call doesn't pile up.
      withTimeout(result, HOOK_TIMEOUT_MS).catch(e => this.recordHookError(id, hookName, e));
    }
  }

  private recordHookError(id: string, hook: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[PluginManager] hook threw', { pluginId: id, hook, err: msg });
    this.setLastError(id, `${hook}: ${msg}`);
  }

  // ─── Test hooks ──────────────────────────────────────────────────────

  _isLoaded(id: string): boolean { return this.loaded.has(id); }
  _registered(): string[] { return Array.from(this.registry.keys()); }

  close(): void { this.db.close(); }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`plugin hook timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

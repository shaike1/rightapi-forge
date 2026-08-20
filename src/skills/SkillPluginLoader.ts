// Plugin hot-reload for SkillManager.
//
// Watches a plugins directory and dynamically (un)registers skills as files
// land, change, or disappear — no server restart needed. Plugins are ESM
// modules that default-export `{ skill, executor }`. Anything malformed gets
// logged + skipped; nothing here is allowed to crash the host process.
//
// Design notes:
//   - We use `fs.watch` (built-in, no chokidar dep) with a per-path debounce
//     because editors and rsync fire 2–4 events per save.
//   - Reloads use a cache-busting query string on the import URL. Node's ESM
//     loader keys its module cache by URL, so `file:///x.js?v=2` returns a
//     fresh evaluation. The previous instance is dropped from SkillManager
//     via unregister() before the new one is registered.
//   - Built-in skills are protected: a plugin file that re-uses a built-in
//     skill ID is rejected, since shadowing core capabilities is almost
//     always a bug and a clear failure beats silent breakage.

import fs from 'fs';
import path from 'path';
import url from 'url';
import { createLogger } from '../observability/Logger.js';
import type { Skill } from '../types/index.js';
import type { SkillManager } from './SkillManager.js';

const log = createLogger({ component: 'plugin-loader' });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SkillExecutor = Record<string, (...args: any[]) => Promise<string>>;

export interface PluginModule {
  skill: Skill;
  executor: SkillExecutor;
}

export interface PluginLoaderOptions {
  /** Directory to scan + watch. Created if missing. */
  pluginDir: string;
  /** Filename suffix that marks a plugin file. Default: ".plugin.js". */
  suffix?: string;
  /** Debounce window for fs.watch events (ms). Default: 200. */
  debounceMs?: number;
  /** When true, plugins under this dir run in a Worker thread sandbox
   *  (see SandboxedPluginRunner). Permissions come from the plugin's
   *  default export `permissions` field; missing fields default to
   *  most-restrictive. The default is false to preserve existing
   *  in-process behaviour for first-party plugins. */
  sandbox?: boolean;
  /** When sandbox=true, this is forwarded to SandboxedPluginRunner so
   *  plugin host.callSkill() can dispatch back into SkillManager
   *  (subject to the plugin's permission allowlist). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sandboxSkillManager?: any;
}

interface LoadedPlugin {
  filePath: string;
  skillId: string;
  loadedAt: number;
  /** Set for sandboxed plugins so unload can terminate the worker. */
  dispose?: () => Promise<void>;
}

/**
 * Hot-reload manager. Construct, then `await loader.start()` to scan + watch.
 * Call `loader.stop()` from a shutdown hook.
 */
export class SkillPluginLoader {
  private readonly skillManager: SkillManager;
  private readonly pluginDir: string;
  private readonly suffix: string;
  private readonly debounceMs: number;
  private readonly sandbox: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sandboxSkillManager: any | undefined;

  /** filePath → loaded plugin record. Lets remove events know which skill to
   *  unregister, since by the time the file is gone we can't read its export. */
  private readonly byPath: Map<string, LoadedPlugin> = new Map();
  /** skillId → filePath. Guards against two plugin files claiming the same id. */
  private readonly byId: Map<string, string> = new Map();

  /** Cache-busting counter; appended as ?v=N to import URLs so reload works
   *  on every change (Node otherwise serves the cached module). */
  private importEpoch = 0;

  /** Active fs.watch handle. Null until start(); null again after stop(). */
  private watcher: fs.FSWatcher | null = null;
  /** Pending debounce timers keyed by absolute file path. */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private stopped = false;

  constructor(skillManager: SkillManager, opts: PluginLoaderOptions) {
    this.skillManager        = skillManager;
    this.pluginDir           = path.resolve(opts.pluginDir);
    this.suffix              = opts.suffix    ?? '.plugin.js';
    this.debounceMs          = opts.debounceMs ?? 200;
    this.sandbox             = opts.sandbox ?? false;
    this.sandboxSkillManager = opts.sandboxSkillManager ?? skillManager;
  }

  /** Scan the directory and load every plugin file. Safe to call multiple
   *  times — each call diffs against currently loaded plugins. */
  async loadAll(): Promise<{ loaded: number; failed: number }> {
    fs.mkdirSync(this.pluginDir, { recursive: true });
    // Drop a sibling package.json marking the dir as ESM so Node doesn't
    // emit MODULE_TYPELESS_PACKAGE_JSON on every plugin load. We only write
    // it if missing so an operator who wants a different config can override.
    const pkg = path.join(this.pluginDir, 'package.json');
    if (!fs.existsSync(pkg)) {
      try { fs.writeFileSync(pkg, '{"type":"module"}\n', 'utf8'); }
      catch { /* read-only dir is fine; the warning is just noise */ }
    }
    let loaded = 0, failed = 0;
    for (const entry of fs.readdirSync(this.pluginDir)) {
      if (!entry.endsWith(this.suffix)) continue;
      const full = path.join(this.pluginDir, entry);
      const okLoad = await this.loadOne(full);
      if (okLoad) loaded++; else failed++;
    }
    log.info('initial plugin scan complete', { dir: this.pluginDir, loaded, failed });
    return { loaded, failed };
  }

  /** Begin watching the plugin directory. Performs an initial scan first so
   *  callers don't need to invoke loadAll() separately. */
  async start(): Promise<void> {
    await this.loadAll();
    try {
      this.watcher = fs.watch(this.pluginDir, { persistent: false }, (event, filename) => {
        if (this.stopped || !filename) return;
        if (typeof filename !== 'string' || !filename.endsWith(this.suffix)) return;
        const full = path.join(this.pluginDir, filename);
        this.scheduleHandleEvent(full);
      });
      log.info('plugin watcher started', { dir: this.pluginDir, suffix: this.suffix });
    } catch (err: any) {
      // Watching is best-effort — if it can't start (e.g. inotify exhausted),
      // we keep the skills loaded and just lose hot-reload. Logging at warn
      // level so an operator notices without the process crashing.
      log.warn('plugin watcher failed to start; hot-reload disabled', {
        err: err?.message,
        dir: this.pluginDir,
      });
    }
  }

  /** Stop the watcher + clear pending debounce timers + terminate any
   *  live sandbox workers. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    // Tear down sandbox workers in parallel — each terminate is short.
    const disposers: Array<Promise<void>> = [];
    for (const rec of this.byPath.values()) {
      if (rec.dispose) disposers.push(rec.dispose().catch(() => undefined));
    }
    if (disposers.length > 0) await Promise.all(disposers);
  }

  /** Returns the list of currently-loaded plugin skill IDs. Used by tests +
   *  the /api/plugins endpoint. */
  list(): Array<{ skillId: string; filePath: string; loadedAt: number }> {
    return Array.from(this.byPath.values()).map(p => ({ ...p }));
  }

  // ---- internals -------------------------------------------------------

  private scheduleHandleEvent(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.handleEvent(filePath);
    }, this.debounceMs);
    this.debounceTimers.set(filePath, t);
  }

  private async handleEvent(filePath: string): Promise<void> {
    const exists = fs.existsSync(filePath);
    if (!exists) {
      const removed = this.unloadByPath(filePath);
      if (removed) log.info('plugin removed', { filePath, skillId: removed });
      return;
    }
    await this.loadOne(filePath);
  }

  /** Load (or reload) a single plugin file. Returns true on success.
   *  Errors are caught and logged — never thrown to the caller.
   *
   *  When `sandbox=true`, instead of importing the module into this
   *  process, we hand it to SandboxedPluginRunner: a Worker thread
   *  loads the plugin under a permission manifest, and the executor
   *  we register with SkillManager is a remote-call shim. From the
   *  rest of the SkillManager's perspective nothing changes — it
   *  dispatches as usual; the worker boundary is invisible to callers. */
  async loadOne(filePath: string): Promise<boolean> {
    try {
      if (this.sandbox) return await this.loadOneSandboxed(filePath);
      return await this.loadOneInProcess(filePath);
    } catch (err: any) {
      log.warn('plugin load failed', { filePath, err: err?.message ?? String(err) });
      return false;
    }
  }

  private async loadOneInProcess(filePath: string): Promise<boolean> {
    // Bump the epoch so the import URL is unique across reloads. Node's ESM
    // loader caches by URL string, so without this we'd get the stale module.
    this.importEpoch++;
    const importUrl = `${url.pathToFileURL(filePath).href}?v=${this.importEpoch}`;
    const mod = await import(importUrl);
    const plugin = (mod?.default ?? mod) as PluginModule | undefined;

    const validation = validatePlugin(plugin);
    if (!validation.ok) {
      log.warn('plugin rejected: invalid shape', { filePath, reason: validation.reason });
      return false;
    }
    const { skill, executor } = plugin as PluginModule;

    if (!this.acceptRegistration(filePath, skill)) return false;

    this.skillManager.unregister(skill.id);
    this.skillManager.registerWithExecutor(skill, executor as SkillExecutor);
    const record: LoadedPlugin = { filePath, skillId: skill.id, loadedAt: Date.now() };
    this.byPath.set(filePath, record);
    this.byId.set(skill.id, filePath);
    log.info('plugin loaded', { filePath, skillId: skill.id, commands: skill.commands.length, sandbox: false });
    return true;
  }

  private async loadOneSandboxed(filePath: string): Promise<boolean> {
    // Inspect the plugin file for its declared permissions BEFORE handing
    // it to a worker. We do this by re-importing in-process briefly to
    // pull the manifest — this is safe because we don't *call* anything
    // from the module here, just read its exported `permissions` field.
    // For belt-and-braces, the worker also re-validates structural
    // shape on load.
    this.importEpoch++;
    const inspectUrl = `${url.pathToFileURL(filePath).href}?inspect=${this.importEpoch}`;
    const mod = await import(inspectUrl);
    const plugin = (mod?.default ?? mod) as PluginModule | undefined;
    const validation = validatePlugin(plugin);
    if (!validation.ok) {
      log.warn('plugin rejected: invalid shape', { filePath, reason: validation.reason });
      return false;
    }
    const skill = (plugin as PluginModule).skill;
    if (!this.acceptRegistration(filePath, skill)) return false;

    const { SandboxedPluginRunner } = await import('./sandbox/SandboxedPluginRunner.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const declared = (plugin as { permissions?: any }).permissions;
    const sandboxed = await SandboxedPluginRunner.load({
      pluginFile: filePath,
      pluginDir:  this.pluginDir,
      permissions: declared,
      skillManager: this.sandboxSkillManager,
    });

    // Tear down any prior sandbox running under this file path.
    const prev = this.byPath.get(filePath);
    if (prev?.dispose) {
      try { await prev.dispose(); } catch { /* ignore */ }
    }
    if (prev && prev.skillId !== skill.id) {
      this.skillManager.unregister(prev.skillId);
      this.byId.delete(prev.skillId);
    }

    this.skillManager.unregister(skill.id);
    this.skillManager.registerWithExecutor(sandboxed.skill, sandboxed.executor as SkillExecutor);
    const record: LoadedPlugin = {
      filePath, skillId: skill.id, loadedAt: Date.now(),
      dispose: () => sandboxed.dispose(),
    };
    this.byPath.set(filePath, record);
    this.byId.set(skill.id, filePath);
    log.info('plugin loaded', {
      filePath, skillId: skill.id, commands: skill.commands.length, sandbox: true,
      permissions: sandboxed.permissions,
    });
    return true;
  }

  /** Common gating: refuses to register a skill that collides with a
   *  built-in or another plugin's id. Returns true when the registration
   *  may proceed. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private acceptRegistration(filePath: string, skill: any): boolean {
    if (this.skillManager.isBuiltin(skill.id)) {
      log.warn('plugin rejected: collides with built-in skill', { filePath, skillId: skill.id });
      return false;
    }
    const owner = this.byId.get(skill.id);
    if (owner && owner !== filePath) {
      log.warn('plugin rejected: skill id already owned by another plugin', {
        filePath, skillId: skill.id, owner,
      });
      return false;
    }
    return true;
  }

  /** Remove a plugin given its file path. Returns the skill id that was
   *  unregistered (or null if the path wasn't tracked). For sandboxed
   *  plugins the worker is also terminated. */
  unloadByPath(filePath: string): string | null {
    const rec = this.byPath.get(filePath);
    if (!rec) return null;
    this.skillManager.unregister(rec.skillId);
    this.byPath.delete(filePath);
    this.byId.delete(rec.skillId);
    if (rec.dispose) {
      // Best-effort: don't await here so callers (the file watcher) stay
      // responsive. The worker termination request is already in flight.
      void rec.dispose().catch((err) => {
        log.warn('plugin dispose failed', { filePath, err: err?.message ?? String(err) });
      });
    }
    return rec.skillId;
  }
}

/** Cheap shape check that doesn't require running the executor. Anything
 *  that fails this is rejected at the door so a malformed file can't take
 *  out the dispatch table. */
function validatePlugin(plugin: PluginModule | undefined): { ok: true } | { ok: false; reason: string } {
  if (!plugin || typeof plugin !== 'object') return { ok: false, reason: 'no default export object' };
  const skill = (plugin as PluginModule).skill;
  const executor = (plugin as PluginModule).executor;
  if (!skill || typeof skill !== 'object') return { ok: false, reason: 'missing `skill`' };
  if (!executor || typeof executor !== 'object') return { ok: false, reason: 'missing `executor`' };
  if (typeof skill.id !== 'string' || skill.id.length === 0) return { ok: false, reason: 'skill.id missing' };
  if (!Array.isArray(skill.commands)) return { ok: false, reason: 'skill.commands not an array' };
  for (const cmd of skill.commands) {
    if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed command entry' };
    if (typeof cmd.name !== 'string')    return { ok: false, reason: 'command.name missing' };
    if (typeof cmd.handler !== 'string') return { ok: false, reason: 'command.handler missing' };
    const fn = (executor as Record<string, unknown>)[cmd.handler];
    if (typeof fn !== 'function') {
      return { ok: false, reason: `executor missing handler "${cmd.handler}"` };
    }
  }
  return { ok: true };
}

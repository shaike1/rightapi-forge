// Dynamic plugin loader for RightAPI Forge
// Loads ES module plugins from the plugins directory at runtime

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  entrypoint: string;       // relative to plugin dir, e.g. "index.js"
  permissions?: string[];   // which agent roles can use this plugin
  tags?: string[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  loadedAt: string;
  status: 'active' | 'error';
  error?: string;
  // The module's exported execute function
  execute?: (command: string, args: Record<string, unknown>, context: PluginContext) => Promise<string>;
  // All commands this plugin provides
  commands?: string[];
}

export interface PluginContext {
  agentId: string;
  role: string;
  username?: string;
}

export class PluginLoader {
  private pluginsDir: string;
  private loaded: Map<string, LoadedPlugin> = new Map();

  constructor(pluginsDir: string) {
    this.pluginsDir = pluginsDir;
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  getPluginsDir(): string { return this.pluginsDir; }

  listLoaded(): LoadedPlugin[] {
    return Array.from(this.loaded.values());
  }

  getPlugin(id: string): LoadedPlugin | undefined {
    return this.loaded.get(id);
  }

  async loadAll(): Promise<{ loaded: number; errors: number }> {
    let loaded = 0;
    let errors = 0;
    if (!fs.existsSync(this.pluginsDir)) return { loaded, errors };
    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const result = await this.loadPlugin(entry.name);
      if (result.status === 'active') loaded++;
      else errors++;
    }
    return { loaded, errors };
  }

  async loadPlugin(pluginId: string): Promise<LoadedPlugin> {
    const dir = path.join(this.pluginsDir, pluginId);
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      const result: LoadedPlugin = {
        manifest: { id: pluginId, name: pluginId, description: '', version: '0.0.0', author: '', category: 'custom', entrypoint: 'index.js' },
        dir,
        loadedAt: new Date().toISOString(),
        status: 'error',
        error: 'Missing plugin.json manifest'
      };
      this.loaded.set(pluginId, result);
      return result;
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
    } catch (e) {
      const result: LoadedPlugin = {
        manifest: { id: pluginId, name: pluginId, description: '', version: '0.0.0', author: '', category: 'custom', entrypoint: 'index.js' },
        dir,
        loadedAt: new Date().toISOString(),
        status: 'error',
        error: `Invalid plugin.json: ${e instanceof Error ? e.message : String(e)}`
      };
      this.loaded.set(pluginId, result);
      return result;
    }

    const entryPath = path.join(dir, manifest.entrypoint);
    if (!fs.existsSync(entryPath)) {
      const result: LoadedPlugin = {
        manifest,
        dir,
        loadedAt: new Date().toISOString(),
        status: 'error',
        error: `Entrypoint not found: ${manifest.entrypoint}`
      };
      this.loaded.set(pluginId, result);
      return result;
    }

    try {
      // Cache-bust with file hash so re-load works
      const hash = createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex').slice(0, 8);
      const fileUrl = pathToFileURL(entryPath).href + `?v=${hash}`;
      const mod = await import(fileUrl);
      const result: LoadedPlugin = {
        manifest,
        dir,
        loadedAt: new Date().toISOString(),
        status: 'active',
        execute: typeof mod.execute === 'function' ? mod.execute as LoadedPlugin['execute'] : undefined,
        commands: Array.isArray(mod.commands) ? mod.commands as string[] : []
      };
      this.loaded.set(pluginId, result);
      return result;
    } catch (e) {
      const result: LoadedPlugin = {
        manifest,
        dir,
        loadedAt: new Date().toISOString(),
        status: 'error',
        error: `Load failed: ${e instanceof Error ? e.message : String(e)}`
      };
      this.loaded.set(pluginId, result);
      return result;
    }
  }

  async unloadPlugin(pluginId: string): Promise<boolean> {
    if (!this.loaded.has(pluginId)) return false;
    this.loaded.delete(pluginId);
    return true;
  }

  async installFromScript(pluginId: string, manifest: PluginManifest, script: string): Promise<LoadedPlugin> {
    const dir = path.join(this.pluginsDir, pluginId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, manifest.entrypoint), script, 'utf8');
    return this.loadPlugin(pluginId);
  }

  uninstallPlugin(pluginId: string): boolean {
    const dir = path.join(this.pluginsDir, pluginId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    this.loaded.delete(pluginId);
    return true;
  }
}

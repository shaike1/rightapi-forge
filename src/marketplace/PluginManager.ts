// Plugin System Core
import { Skill } from '../types/index.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export interface PluginMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  repository?: string;
  license?: string;
  dependencies?: string[];
  tags?: string[];
}

export interface Plugin {
  metadata: PluginMetadata;
  skill: Skill;
  enabled: boolean;
  installedAt: Date;
  updatedAt: Date;
  source: 'builtin' | 'community' | 'local';
}

export class PluginManager extends EventEmitter {
  private plugins: Map<string, Plugin> = new Map();
  private pluginDir: string;
  
  constructor(pluginDir: string = '/data/itops-agents/plugins') {
    super();
    this.pluginDir = pluginDir;
    this.ensurePluginDir();
  }
  
  private ensurePluginDir(): void {
    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
    }
  }
  
  registerPlugin(plugin: Plugin): void {
    this.plugins.set(plugin.metadata.id, plugin);
    this.emit('plugin-registered', plugin);
    console.log(`[PluginManager] Registered plugin: ${plugin.metadata.name} v${plugin.metadata.version}`);
  }
  
  unregisterPlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    
    this.plugins.delete(pluginId);
    this.emit('plugin-unregistered', plugin);
    console.log(`[PluginManager] Unregistered plugin: ${plugin.metadata.name}`);
    
    return true;
  }
  
  getPlugin(pluginId: string): Plugin | undefined {
    return this.plugins.get(pluginId);
  }
  
  getAllPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }
  
  getEnabledPlugins(): Plugin[] {
    return Array.from(this.plugins.values()).filter(p => p.enabled);
  }
  
  enablePlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    
    plugin.enabled = true;
    plugin.updatedAt = new Date();
    this.emit('plugin-enabled', plugin);
    
    return true;
  }
  
  disablePlugin(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return false;
    
    plugin.enabled = false;
    plugin.updatedAt = new Date();
    this.emit('plugin-disabled', plugin);
    
    return true;
  }
  
  searchPlugins(query: string): Plugin[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.plugins.values()).filter(p => 
      p.metadata.name.toLowerCase().includes(lowerQuery) ||
      p.metadata.description.toLowerCase().includes(lowerQuery) ||
      p.metadata.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }
  
  getPluginsByCategory(category: string): Plugin[] {
    return Array.from(this.plugins.values()).filter(p => 
      p.metadata.category === category
    );
  }
  
  installPlugin(metadata: PluginMetadata, skillClass: any): Plugin {
    const skill = new skillClass() as Skill;
    
    const plugin: Plugin = {
      metadata,
      skill,
      enabled: true,
      installedAt: new Date(),
      updatedAt: new Date(),
      source: 'community'
    };
    
    this.registerPlugin(plugin);
    return plugin;
  }
  
  uninstallPlugin(pluginId: string): boolean {
    return this.unregisterPlugin(pluginId);
  }
}

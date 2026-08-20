// Gateway Service for Mission Control - manages distributed runtime environments

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import type { GatewayConfig } from '../types/index.js';

export interface GatewayHealthCheck {
  gatewayId: string;
  status: 'connected' | 'disconnected' | 'degraded';
  lastHeartbeat: Date;
  responseTime?: number;
  error?: string;
}

export class GatewayService {
  private gateways: Map<string, GatewayConfig> = new Map();
  private dataPath: string;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private healthCheckCallbacks: Map<string, (health: GatewayHealthCheck) => void> = new Map();

  constructor(dataPath: string = './data/gateways.json') {
    this.dataPath = dataPath;
    this.ensureDataDir();
    this.load();
    this.startHeartbeatMonitor();
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.dataPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private startHeartbeatMonitor(intervalMs: number = 60000): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.checkAllGateways();
    }, intervalMs);
  }

  private stopHeartbeatMonitor(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Register a new gateway
  registerGateway(config: Omit<GatewayConfig, 'id' | 'lastHeartbeat'>): GatewayConfig {
    const gateway: GatewayConfig = {
      id: uuidv4(),
      ...config,
      lastHeartbeat: new Date()
    };

    this.gateways.set(gateway.id, gateway);
    this.save();
    return gateway;
  }

  // Get a gateway by ID
  getGateway(id: string): GatewayConfig | undefined {
    return this.gateways.get(id);
  }

  // Get all gateways
  getAllGateways(): GatewayConfig[] {
    return Array.from(this.gateways.values());
  }

  // Get gateways by status
  getGatewaysByStatus(status: GatewayConfig['status']): GatewayConfig[] {
    return Array.from(this.gateways.values()).filter(g => g.status === status);
  }

  // Get gateways by type
  getGatewaysByType(type: GatewayConfig['type']): GatewayConfig[] {
    return Array.from(this.gateways.values()).filter(g => g.type === type);
  }

  // Update gateway configuration
  updateGateway(id: string, updates: Partial<Omit<GatewayConfig, 'id'>>): GatewayConfig | null {
    const gateway = this.gateways.get(id);
    if (!gateway) return null;

    const updated = {
      ...gateway,
      ...updates
    };

    this.gateways.set(id, updated);
    this.save();
    return updated;
  }

  // Remove a gateway
  removeGateway(id: string): boolean {
    if (!this.gateways.has(id)) return false;

    this.gateways.delete(id);
    this.save();
    return true;
  }

  // Record a heartbeat from a gateway
  recordHeartbeat(id: string, responseTime?: number): GatewayConfig | null {
    const gateway = this.gateways.get(id);
    if (!gateway) return null;

    gateway.lastHeartbeat = new Date();
    gateway.status = 'connected';

    // Notify health check callbacks
    const health: GatewayHealthCheck = {
      gatewayId: id,
      status: 'connected',
      lastHeartbeat: gateway.lastHeartbeat,
      responseTime
    };

    this.notifyHealthCheck(health);

    this.save();
    return gateway;
  }

  // Mark a gateway as degraded
  markDegraded(id: string, error?: string): GatewayConfig | null {
    const gateway = this.gateways.get(id);
    if (!gateway) return null;

    gateway.status = 'degraded';

    const health: GatewayHealthCheck = {
      gatewayId: id,
      status: 'degraded',
      lastHeartbeat: gateway.lastHeartbeat || new Date(),
      error
    };

    this.notifyHealthCheck(health);

    this.save();
    return gateway;
  }

  // Mark a gateway as disconnected
  markDisconnected(id: string, error?: string): GatewayConfig | null {
    const gateway = this.gateways.get(id);
    if (!gateway) return null;

    gateway.status = 'disconnected';

    const health: GatewayHealthCheck = {
      gatewayId: id,
      status: 'disconnected',
      lastHeartbeat: gateway.lastHeartbeat || new Date(),
      error
    };

    this.notifyHealthCheck(health);

    this.save();
    return gateway;
  }

  // Add an agent to a gateway
  addAgentToGateway(gatewayId: string, agentId: string): boolean {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return false;

    if (!gateway.agentIds.includes(agentId)) {
      gateway.agentIds.push(agentId);
      this.save();
    }
    return true;
  }

  // Remove an agent from a gateway
  removeAgentFromGateway(gatewayId: string, agentId: string): boolean {
    const gateway = this.gateways.get(gatewayId);
    if (!gateway) return false;

    gateway.agentIds = gateway.agentIds.filter(id => id !== agentId);
    this.save();
    return true;
  }

  // Get agents for a gateway
  getAgentsForGateway(gatewayId: string): string[] {
    const gateway = this.gateways.get(gatewayId);
    return gateway?.agentIds || [];
  }

  // Check if a gateway has a specific capability
  gatewayHasCapability(gatewayId: string, capability: string): boolean {
    const gateway = this.gateways.get(gatewayId);
    return gateway?.capabilities.includes(capability) || false;
  }

  // Find gateways by capability
  findGatewaysByCapability(capability: string): GatewayConfig[] {
    return Array.from(this.gateways.values()).filter(g =>
      g.capabilities.includes(capability) && g.status === 'connected'
    );
  }

  // Get the best gateway for a task (simple load balancing)
  getBestGateway(capability?: string, excludeIds: string[] = []): GatewayConfig | null {
    const candidates = Array.from(this.gateways.values()).filter(g =>
      g.status === 'connected' &&
      !excludeIds.includes(g.id) &&
      (!capability || g.capabilities.includes(capability))
    );

    if (candidates.length === 0) return null;

    // Sort by number of agents (load balancing)
    candidates.sort((a, b) => a.agentIds.length - b.agentIds.length);

    return candidates[0];
  }

  // Health check for all gateways
  private async checkAllGateways(): Promise<void> {
    const now = Date.now();
    const timeoutMs = 120000; // 2 minutes

    for (const [id, gateway] of this.gateways) {
      if (gateway.type === 'local') {
        // Local gateways are always considered connected
        continue;
      }

      const lastHeartbeat = gateway.lastHeartbeat?.getTime() || 0;
      const timeSinceHeartbeat = now - lastHeartbeat;

      if (timeSinceHeartbeat > timeoutMs) {
        if (gateway.status === 'connected') {
          this.markDisconnected(id, 'Heartbeat timeout');
        }
      }
    }
  }

  // Register health check callback
  onHealthCheck(gatewayId: string, callback: (health: GatewayHealthCheck) => void): void {
    this.healthCheckCallbacks.set(gatewayId, callback);
  }

  // Remove health check callback
  offHealthCheck(gatewayId: string): void {
    this.healthCheckCallbacks.delete(gatewayId);
  }

  // Notify health check callbacks
  private notifyHealthCheck(health: GatewayHealthCheck): void {
    const callback = this.healthCheckCallbacks.get(health.gatewayId);
    if (callback) {
      try {
        callback(health);
      } catch (error) {
        logger.error('Health check callback error:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      }
    }
  }

  // Get statistics
  getStats(): {
    total: number;
    connected: number;
    disconnected: number;
    degraded: number;
    byType: Record<string, number>;
    totalAgents: number;
  } {
    const gateways = Array.from(this.gateways.values());
    const byType: Record<string, number> = {};

    for (const gateway of gateways) {
      byType[gateway.type] = (byType[gateway.type] || 0) + 1;
    }

    return {
      total: gateways.length,
      connected: gateways.filter(g => g.status === 'connected').length,
      disconnected: gateways.filter(g => g.status === 'disconnected').length,
      degraded: gateways.filter(g => g.status === 'degraded').length,
      byType,
      totalAgents: gateways.reduce((sum, g) => sum + g.agentIds.length, 0)
    };
  }

  // Persistence
  save(): void {
    const data = {
      version: 1,
      gateways: Array.from(this.gateways.entries())
    };
    fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2), 'utf8');
  }

  load(): boolean {
    if (!fs.existsSync(this.dataPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(this.dataPath, 'utf8');
      const data = JSON.parse(content);

      for (const [id, gateway] of data.gateways || []) {
        if (gateway.lastHeartbeat) {
          gateway.lastHeartbeat = new Date(gateway.lastHeartbeat);
        }
        this.gateways.set(id, gateway);
      }

      return true;
    } catch (error) {
      logger.error('Failed to load gateways:', { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      return false;
    }
  }

  // Export/Import
  export(): string {
    const data = {
      version: 1,
      exportDate: new Date().toISOString(),
      gateways: Array.from(this.gateways.entries())
    };
    return JSON.stringify(data, null, 2);
  }

  import(jsonData: string, mode: 'merge' | 'replace' = 'merge'): { success: boolean; imported: number; errors?: string[] } {
    const errors: string[] = [];
    let imported = 0;

    try {
      const data = JSON.parse(jsonData);

      if (data.version !== 1) {
        return { success: false, imported: 0, errors: ['Invalid version'] };
      }

      if (mode === 'replace') {
        this.gateways.clear();
      }

      for (const [id, gateway] of data.gateways || []) {
        try {
          if (!this.gateways.has(id)) {
            if (gateway.lastHeartbeat) {
              gateway.lastHeartbeat = new Date(gateway.lastHeartbeat);
            }
            this.gateways.set(id, gateway);
            imported++;
          }
        } catch (e) {
          errors.push(`Failed to import gateway ${id}: ${e}`);
        }
      }

      this.save();

      return {
        success: true,
        imported,
        errors: errors.length > 0 ? errors : undefined
      };
    } catch (error) {
      return {
        success: false,
        imported: 0,
        errors: [`Failed to parse JSON: ${error}`]
      };
    }
  }

  // Cleanup
  destroy(): void {
    this.stopHeartbeatMonitor();
    this.healthCheckCallbacks.clear();
  }
}

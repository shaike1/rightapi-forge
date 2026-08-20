// Multi-Tenant Organization Manager
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface TenantOrganization {
  id: string;
  name: string;
  displayName: string;
  domain?: string;
  adminEmail: string;
  tier: 'free' | 'pro' | 'enterprise';
  maxAgents: number;
  maxTasks: number;
  features: string[];
  createdAt: Date;
  updatedAt: Date;
  active: boolean;
  settings: {
    timezone?: string;
    language?: string;
    theme?: string;
    notifications?: boolean;
  };
}

export interface TenantUsage {
  orgId: string;
  agents: number;
  tasks: number;
  apiCalls: number;
  storageBytes: number;
  lastUpdated: Date;
}

export class TenantManager extends EventEmitter {
  private tenants: Map<string, TenantOrganization> = new Map();
  private usage: Map<string, TenantUsage> = new Map();
  private dataPath: string;
  
  constructor(dataPath: string = '/data/itops-agents/tenants') {
    super();
    this.dataPath = dataPath;
    this.ensureDataDir();
    this.load();
  }
  
  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
  }
  
  createTenant(data: Omit<TenantOrganization, 'id' | 'createdAt' | 'updatedAt' | 'active'>): TenantOrganization {
    const id = uuidv4();
    const now = new Date();
    
    const tenant: TenantOrganization = {
      ...data,
      id,
      createdAt: now,
      updatedAt: now,
      active: true
    };
    
    this.tenants.set(id, tenant);
    
    // Initialize usage tracking
    this.usage.set(id, {
      orgId: id,
      agents: 0,
      tasks: 0,
      apiCalls: 0,
      storageBytes: 0,
      lastUpdated: now
    });
    
    this.save();
    this.emit('tenant-created', tenant);
    
    console.log(`[TenantManager] Created tenant: ${tenant.name} (${tenant.tier})`);
    
    return tenant;
  }
  
  updateTenant(id: string, updates: Partial<TenantOrganization>): TenantOrganization | null {
    const tenant = this.tenants.get(id);
    if (!tenant) return null;
    
    Object.assign(tenant, updates);
    tenant.updatedAt = new Date();
    
    this.save();
    this.emit('tenant-updated', tenant);
    
    return tenant;
  }
  
  deleteTenant(id: string): boolean {
    const tenant = this.tenants.get(id);
    if (!tenant) return false;
    
    this.tenants.delete(id);
    this.usage.delete(id);
    
    this.save();
    this.emit('tenant-deleted', tenant);
    
    return true;
  }
  
  getTenant(id: string): TenantOrganization | undefined {
    return this.tenants.get(id);
  }
  
  getTenantByName(name: string): TenantOrganization | undefined {
    return Array.from(this.tenants.values()).find(t => t.name === name);
  }
  
  getAllTenants(): TenantOrganization[] {
    return Array.from(this.tenants.values());
  }
  
  getActiveTenants(): TenantOrganization[] {
    return Array.from(this.tenants.values()).filter(t => t.active);
  }
  
  suspendTenant(id: string): boolean {
    const tenant = this.tenants.get(id);
    if (!tenant) return false;
    
    tenant.active = false;
    tenant.updatedAt = new Date();
    
    this.save();
    this.emit('tenant-suspended', tenant);
    
    return true;
  }
  
  reactivateTenant(id: string): boolean {
    const tenant = this.tenants.get(id);
    if (!tenant) return false;
    
    tenant.active = true;
    tenant.updatedAt = new Date();
    
    this.save();
    this.emit('tenant-reactivated', tenant);
    
    return true;
  }
  
  updateUsage(orgId: string, usage: Partial<TenantUsage>): void {
    const current = this.usage.get(orgId);
    if (!current) return;
    
    Object.assign(current, usage);
    current.lastUpdated = new Date();
    
    this.save();
  }
  
  getUsage(orgId: string): TenantUsage | undefined {
    return this.usage.get(orgId);
  }
  
  checkLimits(orgId: string, resource: 'agents' | 'tasks'): { allowed: boolean; limit: number; current: number } {
    const tenant = this.tenants.get(orgId);
    const usage = this.usage.get(orgId);
    
    if (!tenant || !usage) {
      return { allowed: false, limit: 0, current: 0 };
    }
    
    const limit = resource === 'agents' ? tenant.maxAgents : tenant.maxTasks;
    const current = resource === 'agents' ? usage.agents : usage.tasks;
    
    return {
      allowed: current < limit,
      limit,
      current
    };
  }
  
  private save(): void {
    try {
      const tenantsFile = path.join(this.dataPath, 'tenants.json');
      const usageFile = path.join(this.dataPath, 'usage.json');
      
      fs.writeFileSync(
        tenantsFile,
        JSON.stringify(Array.from(this.tenants.entries()), null, 2),
        'utf8'
      );
      
      fs.writeFileSync(
        usageFile,
        JSON.stringify(Array.from(this.usage.entries()), null, 2),
        'utf8'
      );
    } catch (error) {
      console.error('[TenantManager] Failed to save:', error);
    }
  }
  
  private load(): void {
    try {
      const tenantsFile = path.join(this.dataPath, 'tenants.json');
      const usageFile = path.join(this.dataPath, 'usage.json');
      
      if (fs.existsSync(tenantsFile)) {
        const data = JSON.parse(fs.readFileSync(tenantsFile, 'utf8'));
        this.tenants = new Map(data);
        console.log(`[TenantManager] Loaded ${this.tenants.size} tenant(s)`);
      }
      
      if (fs.existsSync(usageFile)) {
        const data = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
        this.usage = new Map(data);
      }
    } catch (error) {
      console.error('[TenantManager] Failed to load:', error);
    }
  }
}

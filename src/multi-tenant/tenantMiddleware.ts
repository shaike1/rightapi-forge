// Tenant context middleware
import { Request, Response, NextFunction } from 'express';
import { TenantManager } from '../multi-tenant/TenantManager.js';

export interface TenantRequest extends Request {
  tenant?: {
    id: string;
    name: string;
    tier: string;
  };
}

export function createTenantMiddleware(tenantManager: TenantManager) {
  return (req: TenantRequest, res: Response, next: NextFunction) => {
    // Extract tenant from header, subdomain, or path
    const tenantId = req.header('X-Tenant-ID');
    const tenantName = req.header('X-Tenant-Name');
    
    if (!tenantId && !tenantName) {
      // No tenant specified - use default single-tenant mode
      next();
      return;
    }
    
    let tenant = tenantId 
      ? tenantManager.getTenant(tenantId)
      : tenantManager.getTenantByName(tenantName || '');
    
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    
    if (!tenant.active) {
      res.status(403).json({ error: 'Tenant suspended' });
      return;
    }
    
    // Attach tenant context
    req.tenant = {
      id: tenant.id,
      name: tenant.name,
      tier: tenant.tier
    };
    
    next();
  };
}

export function requireTenant(req: TenantRequest, res: Response, next: NextFunction) {
  if (!req.tenant) {
    res.status(400).json({ error: 'Tenant context required' });
    return;
  }
  next();
}

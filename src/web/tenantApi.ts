// Multi-Tenant API router
import express from 'express';
import { TenantManager } from '../multi-tenant/TenantManager.js';

export function createTenantRouter(tenantManager: TenantManager): express.Router {
  const router = express.Router();
  
  // List all tenants
  router.get('/tenants', (req, res) => {
    const active = req.query.active as string | undefined;
    
    let tenants = active === 'true' 
      ? tenantManager.getActiveTenants()
      : tenantManager.getAllTenants();
    
    res.json({ tenants, count: tenants.length });
  });
  
  // Get single tenant
  router.get('/tenants/:id', (req, res) => {
    const tenant = tenantManager.getTenant(String(req.params.id));
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json(tenant);
  });
  
  // Create tenant
  router.post('/tenants', (req, res) => {
    const { name, displayName, domain, adminEmail, tier, maxAgents, maxTasks, features, settings } = req.body;
    
    if (!name || !displayName || !adminEmail) {
      res.status(400).json({ error: 'Missing required fields: name, displayName, adminEmail' });
      return;
    }
    
    // Check if tenant already exists
    if (tenantManager.getTenantByName(name)) {
      res.status(409).json({ error: 'Tenant already exists' });
      return;
    }
    
    try {
      const tenant = tenantManager.createTenant({
        name,
        displayName,
        domain,
        adminEmail,
        tier: tier || 'free',
        maxAgents: maxAgents || 5,
        maxTasks: maxTasks || 50,
        features: features || [],
        settings: settings || {}
      });
      
      res.json({ success: true, tenant });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  
  // Update tenant
  router.patch('/tenants/:id', (req, res) => {
    const tenant = tenantManager.updateTenant(String(req.params.id), req.body);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json({ success: true, tenant });
  });
  
  // Delete tenant
  router.delete('/tenants/:id', (req, res) => {
    const deleted = tenantManager.deleteTenant(String(req.params.id));
    if (!deleted) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json({ success: true });
  });
  
  // Suspend tenant
  router.post('/tenants/:id/suspend', (req, res) => {
    const success = tenantManager.suspendTenant(String(req.params.id));
    if (!success) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json({ success: true });
  });
  
  // Reactivate tenant
  router.post('/tenants/:id/reactivate', (req, res) => {
    const success = tenantManager.reactivateTenant(String(req.params.id));
    if (!success) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json({ success: true });
  });
  
  // Get tenant usage
  router.get('/tenants/:id/usage', (req, res) => {
    const usage = tenantManager.getUsage(String(req.params.id));
    if (!usage) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    res.json(usage);
  });
  
  // Check limits
  router.get('/tenants/:id/limits', (req, res) => {
    const id = String(req.params.id);
    const agents = tenantManager.checkLimits(id, 'agents');
    const tasks = tenantManager.checkLimits(id, 'tasks');
    
    res.json({
      agents,
      tasks
    });
  });
  
  // Get stats
  router.get('/stats', (_req, res) => {
    const tenants = tenantManager.getAllTenants();
    const active = tenants.filter(t => t.active).length;
    const byTier = {
      free: tenants.filter(t => t.tier === 'free').length,
      pro: tenants.filter(t => t.tier === 'pro').length,
      enterprise: tenants.filter(t => t.tier === 'enterprise').length
    };
    
    res.json({
      total: tenants.length,
      active,
      suspended: tenants.length - active,
      byTier
    });
  });
  
  return router;
}

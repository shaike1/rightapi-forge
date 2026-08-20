import express, { type Request, type Response } from 'express';
import { CredentialCatalogStore } from '../security/CredentialCatalogStore.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const CREDENTIAL_CATALOG_PATH = process.env.CREDENTIAL_CATALOG_PATH || '/data/itops-agents/credential-catalog.json';
const store = new CredentialCatalogStore(CREDENTIAL_CATALOG_PATH);

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function logEvent(action: string, req: Request, details: Record<string, unknown> = {}): void {
  logger.info(JSON.stringify({
    event: 'credential_catalog',
    action,
    actor: req.header('x-auth-user') || 'unknown',
    at: new Date().toISOString(),
    ...details
  }));
}

router.get('/', (req: Request, res: Response) => {
  try {
    const active = parseBoolean(req.query.active);
    const entries = store.list({
      agentId: req.query.agentId ? String(req.query.agentId) : undefined,
      environment: req.query.environment ? String(req.query.environment) : undefined,
      system: req.query.system ? String(req.query.system) : undefined,
      scope: req.query.scope ? String(req.query.scope) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      active
    });
    logEvent('list', req, { count: entries.length });
    res.json({ success: true, entries });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list credential catalog', details: (error as Error).message });
  }
});

router.post('/', (req: Request, res: Response) => {
  try {
    const entry = store.create({
      name: req.body?.name,
      agentId: req.body?.agentId,
      environment: req.body?.environment,
      system: req.body?.system,
      scope: req.body?.scope,
      description: req.body?.description,
      tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
      active: parseBoolean(req.body?.active)
    });
    logEvent('create', req, { id: entry.id });
    res.status(201).json({ success: true, entry });
  } catch (error) {
    res.status(400).json({ error: 'Failed to create catalog entry', details: (error as Error).message });
  }
});

router.put('/:id', (req: Request, res: Response) => {
  try {
    const entry = store.update(String(req.params.id), {
      name: req.body?.name,
      agentId: req.body?.agentId,
      environment: req.body?.environment,
      system: req.body?.system,
      scope: req.body?.scope,
      description: req.body?.description,
      tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
      active: parseBoolean(req.body?.active)
    });
    if (!entry) {
      res.status(404).json({ error: 'Catalog entry not found' });
      return;
    }
    logEvent('update', req, { id: entry.id });
    res.json({ success: true, entry });
  } catch (error) {
    res.status(400).json({ error: 'Failed to update catalog entry', details: (error as Error).message });
  }
});

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const hardDelete = parseBoolean(req.query.hardDelete) === true;
    const deleted = store.delete(String(req.params.id), !hardDelete);
    if (!deleted) {
      res.status(404).json({ error: 'Catalog entry not found' });
      return;
    }
    logEvent('delete', req, { id: String(req.params.id), hardDelete });
    res.json({ success: true, deleted: true, hardDelete });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete catalog entry', details: (error as Error).message });
  }
});

export default router;

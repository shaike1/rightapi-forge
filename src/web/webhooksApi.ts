// /api/webhooks/* — Phase-38 webhook trigger management. Extracted
// from server.ts.
//
// Routes (mount at /api/webhooks):
//   GET    /                  no auth
//   GET    /:id
//   POST   /
//   PATCH  /:id
//   POST   /:id/regenerate    rotates the inbound secret
//   DELETE /:id
//
// The inbound trigger handler `POST /api/hook/:id` lives elsewhere
// (different prefix); only the management surface is here.
//
// Behavior preserved 1:1 — secrets are masked in list responses,
// not in get-by-id; same as the inline blocks.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';

export interface WebhookDefLike {
  id: string;
  name: string;
  description: string;
  secret: string;
  enabled: boolean;
  action: 'notification' | 'incident' | 'automation' | 'agent';
  actionConfig: Record<string, any>;
  lastTriggered?: string;
  triggerCount: number;
  createdAt: string;
}

export interface WebhooksApiDeps {
  webhookDefs: WebhookDefLike[];
  saveWebhooks: () => void;
  generateWebhookSecret: () => string;
}

export function createWebhooksRouter(deps: WebhooksApiDeps): Router {
  const router = Router();
  const { webhookDefs, saveWebhooks, generateWebhookSecret } = deps;

  router.get('/', (_req: Request, res: Response) => {
    const safe = webhookDefs.map(w => ({
      id: w.id, name: w.name, description: w.description, enabled: w.enabled,
      action: w.action, actionConfig: w.actionConfig,
      lastTriggered: w.lastTriggered, triggerCount: w.triggerCount,
      createdAt: w.createdAt,
      url: `/api/hook/${w.id}`,
      secret: w.secret.slice(0, 8) + '...',
    }));
    res.json({ webhooks: safe, total: safe.length });
  });

  router.get('/:id', (req: Request, res: Response) => {
    const wh = webhookDefs.find(w => w.id === req.params.id);
    if (!wh) { res.status(404).json({ error: 'Webhook not found' }); return; }
    res.json({ ...wh, url: `/api/hook/${wh.id}` });
  });

  router.post('/', (req: Request, res: Response) => {
    const { name, description, action, actionConfig } = req.body || {};
    if (!name || !action) {
      res.status(400).json({ error: 'name and action required' });
      return;
    }
    const wh: WebhookDefLike = {
      id: crypto.randomUUID(),
      name,
      description: description || '',
      secret: generateWebhookSecret(),
      enabled: true,
      action,
      actionConfig: actionConfig || {},
      triggerCount: 0,
      createdAt: new Date().toISOString(),
    };
    webhookDefs.push(wh);
    saveWebhooks();
    res.status(201).json({ ...wh, url: `/api/hook/${wh.id}` });
  });

  router.patch('/:id', (req: Request, res: Response) => {
    const wh = webhookDefs.find(w => w.id === req.params.id);
    if (!wh) { res.status(404).json({ error: 'Webhook not found' }); return; }
    const { name, description, action, actionConfig, enabled } = req.body || {};
    if (name !== undefined) wh.name = name;
    if (description !== undefined) wh.description = description;
    if (action !== undefined) wh.action = action;
    if (actionConfig !== undefined) wh.actionConfig = actionConfig;
    if (enabled !== undefined) wh.enabled = enabled;
    saveWebhooks();
    res.json({ ...wh, url: `/api/hook/${wh.id}` });
  });

  router.post('/:id/regenerate', (req: Request, res: Response) => {
    const wh = webhookDefs.find(w => w.id === req.params.id);
    if (!wh) { res.status(404).json({ error: 'Webhook not found' }); return; }
    wh.secret = generateWebhookSecret();
    saveWebhooks();
    res.json({ id: wh.id, secret: wh.secret, url: `/api/hook/${wh.id}` });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const idx = webhookDefs.findIndex(w => w.id === req.params.id);
    if (idx === -1) { res.status(404).json({ error: 'Webhook not found' }); return; }
    webhookDefs.splice(idx, 1);
    saveWebhooks();
    res.json({ success: true });
  });

  return router;
}

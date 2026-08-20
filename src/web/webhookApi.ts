import express from 'express';
import { WebhookManager } from '../webhooks/WebhookManager.js';

export function createWebhookRouter(manager: WebhookManager): express.Router {
  const router = express.Router();

  router.get('/stats', (_req, res) => res.json(manager.getStats()));

  router.get('/', (_req, res) => {
    res.json({ webhooks: manager.list(), count: manager.list().length });
  });

  router.post('/', (req, res) => {
    const { name, url, events, secret, enabled, headers } = req.body;
    if (!name || !url || !events?.length) {
      res.status(400).json({ error: 'name, url, events required' });
      return;
    }
    const wh = manager.create({ name, url, events, secret, enabled: enabled !== false, headers });
    res.json({ success: true, webhook: wh });
  });

  router.patch('/:id', (req, res) => {
    const wh = manager.update(String(req.params.id), req.body);
    if (!wh) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ success: true, webhook: wh });
  });

  router.delete('/:id', (req, res) => {
    const ok = manager.delete(String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ success: true });
  });

  router.post('/:id/test', async (req, res) => {
    const result = await manager.testWebhook(String(req.params.id));
    res.json(result);
  });

  router.get('/:id/deliveries', (req, res) => {
    const limit = parseInt(String(req.query.limit || '50'));
    const deliveries = manager.getDeliveries(String(req.params.id), limit);
    res.json({ deliveries, count: deliveries.length });
  });

  router.get('/deliveries/all', (req, res) => {
    const limit = parseInt(String(req.query.limit || '100'));
    const deliveries = manager.getDeliveries(undefined, limit);
    res.json({ deliveries, count: deliveries.length });
  });

  return router;
}

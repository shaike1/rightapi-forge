// /api/push — PWA Web Push subscription management.
//
// Routes:
//   GET  /vapid-public-key   public — needed before subscribing
//   POST /subscribe          authenticated — save subscription for current user
//   POST /unsubscribe        authenticated — remove subscription
//   POST /test               authenticated — send self a test notification
//
// The vapid-public-key route is intentionally unauthenticated: a
// browser must fetch the server's VAPID public key BEFORE it can
// produce a subscription, and any forged subscription handed to
// /subscribe still needs a valid bearer token to attach to a user.

import { Router } from 'express';
import type { PushService } from '../notifications/PushService.js';
import type { AuthValidation } from '../security/AuthService.js';

export interface PushApiDeps {
  pushService: PushService;
  validateAuth: (authHeader: string | undefined, permission?: string) => AuthValidation & { ok: boolean };
  logError?: (msg: string, ctx: Record<string, unknown>) => void;
}

export function createPushRouter(deps: PushApiDeps): Router {
  const router = Router();
  const { pushService, validateAuth, logError } = deps;

  router.get('/vapid-public-key', (_req, res) => {
    res.json({ publicKey: pushService.getVapidPublicKey() });
  });

  // Open to any authenticated principal — admin, operator, viewer,
  // requester. Push notifications are a per-user convenience feature
  // and don't expose any new privileged surface.
  router.post('/subscribe', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined);
    if (!auth.ok || !auth.username) {
      res.status(403).json({ error: auth.reason || 'Unauthorized' });
      return;
    }
    try {
      const row = pushService.subscribe(auth.username, req.body);
      res.status(201).json({ subscription: row });
    } catch (e: any) {
      logError?.('push.subscribe failed', { user: auth.username, err: e?.message });
      res.status(400).json({ error: e?.message || 'subscribe failed' });
    }
  });

  router.post('/unsubscribe', (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined);
    if (!auth.ok || !auth.username) {
      res.status(403).json({ error: auth.reason || 'Unauthorized' });
      return;
    }
    const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint is required' });
      return;
    }
    const removed = pushService.unsubscribe(auth.username, endpoint);
    res.json({ removed });
  });

  router.post('/test', async (req, res) => {
    const auth = validateAuth(req.header('authorization') || undefined);
    if (!auth.ok || !auth.username) {
      res.status(403).json({ error: auth.reason || 'Unauthorized' });
      return;
    }
    const result = await pushService.sendNotification(auth.username, {
      title: 'RightAPI Forge test notification',
      body: 'If you see this, push is working.',
      url: '/app/',
      tag: 'test',
    });
    res.json(result);
  });

  return router;
}

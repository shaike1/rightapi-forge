import express from 'express';
import { AlertManager } from '../alerting/AlertManager.js';

export function createAlertingRouter(alertManager: AlertManager): express.Router {
  const router = express.Router();

  // ── Stats ─────────────────────────────────────────────────────────────────

  router.get('/stats', (_req, res) => {
    res.json(alertManager.getStats());
  });

  // ── Alerts ────────────────────────────────────────────────────────────────

  router.get('/alerts', (req, res) => {
    const { status, severity, source, limit } = req.query as Record<string, string>;
    const alerts = alertManager.getAlerts({
      status: status as any,
      severity: severity as any,
      source: source as any,
      limit: limit ? parseInt(limit) : undefined
    });
    res.json({ alerts, count: alerts.length });
  });

  router.post('/alerts', (req, res) => {
    const { title, message, severity, source, labels, annotations } = req.body;
    if (!title || !message || !severity || !source) {
      res.status(400).json({ error: 'title, message, severity, source required' });
      return;
    }
    const alert = alertManager.fire({ title, message, severity, source, labels, annotations });
    res.json({ success: true, alert });
  });

  router.post('/alerts/:id/acknowledge', (req, res) => {
    const alert = alertManager.acknowledge(String(req.params.id), req.body.by || 'api');
    if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }
    res.json({ success: true, alert });
  });

  router.post('/alerts/:id/resolve', (req, res) => {
    const alert = alertManager.resolve(String(req.params.id));
    if (!alert) { res.status(404).json({ error: 'Alert not found' }); return; }
    res.json({ success: true, alert });
  });

  // ── Channels ──────────────────────────────────────────────────────────────

  router.get('/channels', (_req, res) => {
    const channels = alertManager.getChannels();
    res.json({ channels, count: channels.length });
  });

  router.post('/channels', (req, res) => {
    const { name, type, enabled, config, minSeverity } = req.body;
    if (!name || !type) { res.status(400).json({ error: 'name and type required' }); return; }
    const ch = alertManager.addChannel({ name, type, enabled: enabled !== false, config: config || {}, minSeverity: minSeverity || 'warning' });
    res.json({ success: true, channel: ch });
  });

  router.patch('/channels/:id', (req, res) => {
    const ch = alertManager.updateChannel(String(req.params.id), req.body);
    if (!ch) { res.status(404).json({ error: 'Channel not found' }); return; }
    res.json({ success: true, channel: ch });
  });

  router.delete('/channels/:id', (req, res) => {
    const ok = alertManager.deleteChannel(String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Channel not found' }); return; }
    res.json({ success: true });
  });

  // ── Routes ────────────────────────────────────────────────────────────────

  router.get('/routes', (_req, res) => {
    const routes = alertManager.getRoutes();
    res.json({ routes, count: routes.length });
  });

  router.post('/routes', (req, res) => {
    const { name, matchers, channels, enabled, cooldownMinutes } = req.body;
    if (!name || !channels) { res.status(400).json({ error: 'name and channels required' }); return; }
    const route = alertManager.addRoute({ name, matchers: matchers || [], channels, enabled: enabled !== false, cooldownMinutes: cooldownMinutes || 30 });
    res.json({ success: true, route });
  });

  router.patch('/routes/:id', (req, res) => {
    const route = alertManager.updateRoute(String(req.params.id), req.body);
    if (!route) { res.status(404).json({ error: 'Route not found' }); return; }
    res.json({ success: true, route });
  });

  router.delete('/routes/:id', (req, res) => {
    const ok = alertManager.deleteRoute(String(req.params.id));
    if (!ok) { res.status(404).json({ error: 'Route not found' }); return; }
    res.json({ success: true });
  });

  // ── Test ──────────────────────────────────────────────────────────────────

  router.post('/test', (req, res) => {
    const severity = req.body.severity || 'warning';
    const alert = alertManager.fire({
      title: 'Test Alert — ' + severity.toUpperCase(),
      message: 'This is a test notification from RightAPI Forge alerting system.',
      severity,
      source: 'manual',
      labels: { test: 'true' }
    });
    res.json({ success: true, alert });
  });

  return router;
}

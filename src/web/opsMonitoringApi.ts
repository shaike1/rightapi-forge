import express from 'express';
import { OperationalInsightsService } from '../monitoring/OperationalInsightsService.js';

export function createOpsMonitoringRouter(service: OperationalInsightsService): express.Router {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json(service.getHealthSnapshot());
  });

  router.get('/alerts', (_req, res) => {
    const alerts = service.getAlerts();
    res.json({
      alerts,
      count: alerts.length,
      open: alerts.filter(alert => alert.status === 'open').length
    });
  });

  router.get('/alerts/stats', (_req, res) => {
    res.json(service.getAlertStats());
  });

  router.post('/alerts/:id/ack', (req, res) => {
    const alert = service.acknowledgeAlert(String(req.params.id || ''));
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ success: true, alert });
  });

  router.post('/alerts/:id/resolve', (req, res) => {
    const alert = service.resolveAlert(String(req.params.id || ''));
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ success: true, alert });
  });

  router.post('/alerts/test', (req, res) => {
    const alert = service.createTestAlert({
      title: req.body?.title,
      message: req.body?.message,
      severity: req.body?.severity,
      source: req.body?.source
    });
    res.json({ success: true, alert });
  });

  router.post('/alerts/escalation-sweep', (_req, res) => {
    const escalated = service.runEscalationSweep();
    res.json({ success: true, escalated });
  });

  return router;
}

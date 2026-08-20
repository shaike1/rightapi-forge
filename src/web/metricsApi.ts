import express from 'express';
import {
  MetricsExporter,
  collectSystemMetrics,
  collectAgentMetrics,
  collectTaskMetrics,
  collectAlertMetrics,
  collectGatewayMetrics,
  collectWsMetrics
} from '../observability/MetricsExporter.js';
import { realtimeBus } from '../realtime/RealtimeBus.js';

export function createMetricsRouter(deps: {
  apiGateway?: any;
}): express.Router {
  const router = express.Router();

  // PAssistant text format
  router.get('/', async (_req, res) => {
    const exporter = new MetricsExporter();

    // System
    collectSystemMetrics(exporter);

    // WebSocket
    collectWsMetrics(exporter, realtimeBus.getStats());

    // API Gateway
    if (deps.apiGateway) {
      collectGatewayMetrics(exporter, deps.apiGateway.getStats());
    }

    // Mock agent data (production: pull from AgentManager)
    collectAgentMetrics(exporter, [
      { id: 'director', name: 'IT Director', role: 'Director', currentLoad: 0.3, available: true },
      { id: 'alice', name: 'Alice', role: 'SysAdmin', currentLoad: 0.5, available: true },
      { id: 'bob', name: 'Bob', role: 'SysAdmin', currentLoad: 0.2, available: true },
      { id: 'charlie', name: 'Charlie', role: 'Security', currentLoad: 0.4, available: true },
      { id: 'diana', name: 'Diana', role: 'DBA', currentLoad: 0.6, available: true },
      { id: 'eve', name: 'Eve', role: 'DevOps', currentLoad: 0.1, available: true }
    ]);

    // Mock task metrics
    collectTaskMetrics(exporter, { total: 42, running: 4, completed: 35, failed: 2, pending: 1 });

    // Mock alert metrics
    collectAlertMetrics(exporter, {
      open: 2, acknowledged: 1, resolved: 8,
      bySeverity: { critical: 0, high: 1, medium: 1, low: 0 }
    });

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(exporter.render());
  });

  // JSON format for convenience
  router.get('/json', async (_req, res) => {
    const exporter = new MetricsExporter();
    collectSystemMetrics(exporter);
    collectWsMetrics(exporter, realtimeBus.getStats());
    if (deps.apiGateway) collectGatewayMetrics(exporter, deps.apiGateway.getStats());

    // Return as structured JSON
    res.json({
      timestamp: new Date(),
      process: {
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptimeSec: Math.round(process.uptime())
      },
      ws: realtimeBus.getStats(),
      gateway: deps.apiGateway?.getStats() || null
    });
  });

  return router;
}

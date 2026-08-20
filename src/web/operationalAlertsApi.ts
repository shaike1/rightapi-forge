import { Router, type Request, type Response } from 'express';
import type {
  AlertManager,
  AlertSeverity,
  AlertSource,
  AlertStatus
} from '../alerting/AlertManager.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';

type AuthResult = {
  ok: boolean;
  reason?: string;
  username?: string;
};
type AuthCheck = (authHeader: string | undefined, permission?: string) => AuthResult;

interface CorrelationEngineLike {
  getGroups: () => unknown;
  getStats: () => unknown;
}

export interface OperationalAlertsApiDeps {
  alertManager: AlertManager;
  refreshAlerts: () => void | Promise<void>;
  correlationEngine: CorrelationEngineLike;
  incidentManager: IncidentManager;
  validateAuth: AuthCheck;
}

export function createOperationalAlertsRouter(deps: OperationalAlertsApiDeps): Router {
  const router = Router();
  const {
    alertManager,
    refreshAlerts,
    correlationEngine,
    incidentManager,
    validateAuth
  } = deps;

  function authenticate(req: Request, res: Response, permission: string): AuthResult | null {
    const auth = validateAuth(req.header('authorization') || undefined, permission);
    if (!auth.ok) {
      res.status(403).json({ error: auth.reason || 'Forbidden' });
      return null;
    }
    return auth;
  }

  async function refresh(res: Response): Promise<boolean> {
    try {
      await refreshAlerts();
      return true;
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to refresh alerts'
      });
      return false;
    }
  }

  router.get('/', async (req: Request, res: Response) => {
    if (!authenticate(req, res, 'security.read')) return;
    if (!await refresh(res)) return;

    const { status, severity, source } = req.query as Record<string, string>;
    let alerts = alertManager.getAlerts({
      severity: severity as AlertSeverity | undefined,
      source: source as AlertSource | undefined
    });
    if (status === 'active') {
      alerts = alerts.filter(alert => alert.status !== 'resolved');
    } else if (status) {
      alerts = alerts.filter(alert => alert.status === status as AlertStatus);
    }
    res.json({ alerts, count: alerts.length });
  });

  router.get('/stats', async (req: Request, res: Response) => {
    if (!authenticate(req, res, 'security.read')) return;
    if (!await refresh(res)) return;
    res.json(alertManager.getStats());
  });

  router.get('/correlations', (req: Request, res: Response) => {
    if (!authenticate(req, res, 'security.read')) return;
    res.json(correlationEngine.getGroups());
  });

  router.get('/correlations/stats', (req: Request, res: Response) => {
    if (!authenticate(req, res, 'security.read')) return;
    res.json(correlationEngine.getStats());
  });

  const acknowledge = async (req: Request, res: Response) => {
    const auth = authenticate(req, res, 'security.write');
    if (!auth) return;
    if (!await refresh(res)) return;
    const alert = alertManager.acknowledge(String(req.params.id), auth.username || 'api');
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ success: true, alert });
  };

  router.put('/:id/acknowledge', acknowledge);
  router.post('/:id/acknowledge', acknowledge);

  router.post('/:id/assign', async (req: Request, res: Response) => {
    const auth = authenticate(req, res, 'security.write');
    if (!auth) return;
    if (!await refresh(res)) return;
    const assignedTo = String(req.body?.assignedTo || auth.username || '').trim();
    if (!assignedTo) {
      res.status(400).json({ error: 'assignedTo is required' });
      return;
    }
    const alert = alertManager.assign(String(req.params.id), assignedTo);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ success: true, alert });
  });

  router.post('/:id/resolve', (req: Request, res: Response) => {
    if (!authenticate(req, res, 'security.write')) return;
    const alert = alertManager.resolve(String(req.params.id));
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }
    res.json({ success: true, alert });
  });

  router.post('/:id/incident', async (req: Request, res: Response) => {
    const auth = authenticate(req, res, 'security.write');
    if (!auth) return;
    if (!await refresh(res)) return;
    const alert = alertManager.getAlert(String(req.params.id));
    if (!alert) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    if (alert.incidentId) {
      const existing = incidentManager.get(alert.incidentId);
      if (existing) {
        res.json({ success: true, incident: existing, alert, created: false });
        return;
      }
    }

    const incident = incidentManager.create({
      title: alert.title,
      description: `${alert.message}\n\nAlert ID: ${alert.id}`,
      severity:
        alert.severity === 'critical'
          ? 'critical'
          : alert.severity === 'warning'
          ? 'medium'
          : 'low',
      assignedTo: alert.assignedTo,
      source: 'alert-rule',
      sourceRef: `durable-alert:${alert.id}`,
      serverId: alert.labels.serverId || null,
      dedupBy: 'sourceRef',
      createdBy: auth.username || null
    });
    const linked = alertManager.linkIncident(alert.id, incident.id);
    res.json({ success: true, incident, alert: linked, created: true });
  });

  return router;
}

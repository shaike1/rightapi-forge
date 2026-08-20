import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { AlertManager } from '../alerting/AlertManager.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { createOperationalAlertsRouter } from './operationalAlertsApi.js';

async function startApp() {
  const dataPath = mkdtempSync(path.join(os.tmpdir(), 'itops-alert-api-'));
  const alertManager = new AlertManager(path.join(dataPath, 'alerts'));
  const incidentManager = new IncidentManager(
    new SqliteIncidentStore(path.join(dataPath, 'incidents.db'))
  );
  const condition = {
    key: 'server:core-1:cpu',
    title: 'High CPU on core-1',
    message: 'CPU is at 91%',
    severity: 'critical' as const,
    labels: {
      attentionId: 'server-core-1',
      serverId: 'core-1'
    },
    annotations: {
      recommendedAction: 'Inspect the busiest process.'
    }
  };
  let active = true;
  const refreshAlerts = () => {
    alertManager.reconcile('monitoring', active ? [condition] : []);
  };

  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createOperationalAlertsRouter({
    alertManager,
    refreshAlerts,
    correlationEngine: {
      getGroups: () => [],
      getStats: () => ({ total: 0 })
    },
    incidentManager,
    validateAuth: (header, permission) => {
      if (header !== 'Bearer valid') return { ok: false, reason: 'Forbidden' };
      return {
        ok: permission === 'security.read' || permission === 'security.write',
        username: 'operator@example.com'
      };
    }
  }));

  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    alertManager,
    incidentManager,
    setActive(value: boolean) {
      active = value;
    },
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => {
      incidentManager.dispose();
      try {
        rmSync(dataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') {
          throw error;
        }
      }
      resolve();
    }))
  };
}

const authHeaders = {
  authorization: 'Bearer valid',
  'content-type': 'application/json'
};

test('alert feed requires read permission and returns reconciled monitoring alerts', async () => {
  const app = await startApp();
  try {
    const forbidden = await fetch(`${app.base}/api/alerts`);
    assert.equal(forbidden.status, 403);

    const response = await fetch(
      `${app.base}/api/alerts?source=monitoring&status=active`,
      { headers: authHeaders }
    );
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.count, 1);
    assert.equal(body.alerts[0].labels.attentionId, 'server-core-1');
  } finally {
    await app.close();
  }
});

test('operators can acknowledge, assign, and create one linked incident', async () => {
  const app = await startApp();
  try {
    const feed = await fetch(`${app.base}/api/alerts`, { headers: authHeaders });
    const alert = ((await feed.json()) as any).alerts[0];

    const acknowledged = await fetch(
      `${app.base}/api/alerts/${alert.id}/acknowledge`,
      { method: 'PUT', headers: authHeaders, body: '{}' }
    );
    assert.equal(acknowledged.status, 200);
    assert.equal(((await acknowledged.json()) as any).alert.acknowledgedBy, 'operator@example.com');

    const assigned = await fetch(
      `${app.base}/api/alerts/${alert.id}/assign`,
      { method: 'POST', headers: authHeaders, body: '{}' }
    );
    assert.equal(assigned.status, 200);
    assert.equal(((await assigned.json()) as any).alert.assignedTo, 'operator@example.com');

    const firstIncident = await fetch(
      `${app.base}/api/alerts/${alert.id}/incident`,
      { method: 'POST', headers: authHeaders, body: '{}' }
    );
    const firstBody = await firstIncident.json() as any;
    assert.equal(firstIncident.status, 200);
    assert.equal(firstBody.created, true);
    assert.equal(firstBody.incident.assignedTo, 'operator@example.com');

    const secondIncident = await fetch(
      `${app.base}/api/alerts/${alert.id}/incident`,
      { method: 'POST', headers: authHeaders, body: '{}' }
    );
    const secondBody = await secondIncident.json() as any;
    assert.equal(secondBody.created, false);
    assert.equal(secondBody.incident.id, firstBody.incident.id);
  } finally {
    await app.close();
  }
});

test('reconciliation auto-resolves a monitoring alert after recovery', async () => {
  const app = await startApp();
  try {
    const feed = await fetch(`${app.base}/api/alerts`, { headers: authHeaders });
    const alert = ((await feed.json()) as any).alerts[0];
    app.setActive(false);

    const active = await fetch(
      `${app.base}/api/alerts?status=active`,
      { headers: authHeaders }
    );
    assert.equal(((await active.json()) as any).count, 0);
    assert.equal(app.alertManager.getAlert(alert.id)?.status, 'resolved');
  } finally {
    await app.close();
  }
});

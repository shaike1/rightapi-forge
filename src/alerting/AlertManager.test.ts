import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AlertManager } from './AlertManager.js';

function withManager(run: (manager: AlertManager, dataPath: string) => void): void {
  const dataPath = mkdtempSync(path.join(os.tmpdir(), 'itops-alert-manager-'));
  try {
    run(new AlertManager(dataPath), dataPath);
  } finally {
    rmSync(dataPath, { recursive: true, force: true });
  }
}

test('reconcile preserves one active alert and resolves it after recovery', () => {
  withManager((manager) => {
    const first = manager.reconcile('monitoring', [{
      key: 'server:core-1:cpu',
      title: 'High CPU on core-1',
      message: 'CPU is at 91%',
      severity: 'critical',
      labels: { serverId: 'core-1' }
    }])[0];

    const second = manager.reconcile('monitoring', [{
      key: 'server:core-1:cpu',
      title: 'High CPU on core-1',
      message: 'CPU is at 94%',
      severity: 'critical',
      labels: { serverId: 'core-1' }
    }])[0];

    assert.equal(second.id, first.id);
    assert.equal(second.count, 2);
    assert.equal(second.message, 'CPU is at 94%');
    assert.equal(manager.getAlerts({ status: 'firing' }).length, 1);

    manager.reconcile('monitoring', []);
    assert.equal(manager.getAlert(first.id)?.status, 'resolved');
    assert.ok(manager.getAlert(first.id)?.resolvedAt instanceof Date);
  });
});

test('acknowledgement and assignment survive reconciliation and reload', () => {
  withManager((manager, dataPath) => {
    const alert = manager.reconcile('monitoring', [{
      key: 'agent:worker-1:success-rate',
      title: 'Low success rate',
      message: 'Success rate is 52%',
      severity: 'critical'
    }])[0];

    manager.acknowledge(alert.id, 'operator@example.com');
    manager.assign(alert.id, 'operator@example.com');
    manager.reconcile('monitoring', [{
      key: 'agent:worker-1:success-rate',
      title: 'Low success rate',
      message: 'Success rate is 61%',
      severity: 'warning'
    }]);

    const reloaded = new AlertManager(dataPath).getAlert(alert.id);
    assert.equal(reloaded?.status, 'acknowledged');
    assert.equal(reloaded?.acknowledgedBy, 'operator@example.com');
    assert.equal(reloaded?.assignedTo, 'operator@example.com');
    assert.equal(reloaded?.severity, 'warning');
    assert.ok(reloaded?.acknowledgedAt instanceof Date);
  });
});

test('fire creates a new alert after the previous fingerprint is resolved', () => {
  withManager((manager) => {
    const first = manager.fire({
      title: 'Manual check failed',
      message: 'First failure',
      severity: 'warning',
      source: 'manual'
    });
    manager.resolve(first.id);

    const second = manager.fire({
      title: 'Manual check failed',
      message: 'Second failure',
      severity: 'critical',
      source: 'manual'
    });

    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'firing');
    assert.equal(manager.getAlerts().length, 2);
  });
});

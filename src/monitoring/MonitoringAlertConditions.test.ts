import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMonitoringAlertConditions } from './MonitoringAlertConditions.js';

test('buildMonitoringAlertConditions prioritizes unreachable servers', () => {
  const conditions = buildMonitoringAlertConditions([{
    ip: '10.0.0.2',
    name: 'db-1',
    reachable: false,
    error: 'SSH timeout'
  }], []);

  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].severity, 'critical');
  assert.equal(conditions[0].labels?.attentionId, 'server-10.0.0.2');
  assert.match(conditions[0].message, /SSH timeout/);
});

test('buildMonitoringAlertConditions emits only the worst saturated signal', () => {
  const conditions = buildMonitoringAlertConditions([{
    ip: '10.0.0.3',
    name: 'app-1',
    reachable: true,
    cpu: 82,
    memUsedPct: 91,
    diskUsedPct: 70
  }], []);

  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].severity, 'critical');
  assert.equal(conditions[0].labels?.signal, 'memory');
});

test('buildMonitoringAlertConditions clears healthy servers and agents', () => {
  const conditions = buildMonitoringAlertConditions([{
    ip: '10.0.0.4',
    name: 'app-2',
    reachable: true,
    cpu: 20,
    memUsedPct: 30,
    diskUsedPct: 40
  }], [{
    agentId: 'agent-1',
    name: 'agent-1',
    successRate: 98,
    executions: { error: 0 }
  }]);

  assert.deepEqual(conditions, []);
});

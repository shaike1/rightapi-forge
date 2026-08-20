import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutonomyAttemptStore } from './AutonomyAttemptStore.js';

test('persists attributable phases and terminal classifications', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-attempts-'));
  try {
    const dbPath = path.join(root, 'attempts.db');
    const store = new AutonomyAttemptStore(dbPath);
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const attempt = store.start({ incidentId: 'INC-1', taskId: 'T-1', agentId: 'A-1', agentName: 'Alice', at: startedAt });
    store.addPhase(attempt.id, { kind: 'agent_execution', status: 'success', details: { iterations: 2 } });
    store.addPhase(attempt.id, { kind: 'tool_execution', status: 'success', details: { successful: 3, failed: 0 } });
    const concluded = store.conclude(attempt.id, 'verified_autonomous', 'verification_passed', { verification: 'passed' })!;

    assert.equal(concluded.classification, 'verified_autonomous');
    assert.equal(concluded.verification, 'passed');
    assert.ok((concluded.durationMs || 0) >= 60_000);
    assert.deepEqual(concluded.phases.map(phase => phase.kind), ['dispatch', 'agent_execution', 'tool_execution', 'terminal']);
    store.close();

    const reopened = new AutonomyAttemptStore(dbPath);
    assert.equal(reopened.get(attempt.id)?.classification, 'verified_autonomous');
    assert.equal(reopened.latestForIncident('INC-1')?.id, attempt.id);
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expires unfinished attempts and terminal classification is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-attempts-'));
  try {
    const store = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
    const old = store.start({ incidentId: 'INC-old', agentId: 'A', agentName: 'Agent', at: '2026-01-01T00:00:00.000Z' });
    const fresh = store.start({ incidentId: 'INC-new', agentId: 'A', agentName: 'Agent', at: '2026-02-01T00:00:00.000Z' });
    assert.equal(store.expireInProgress('2026-01-15T00:00:00.000Z'), 1);
    assert.equal(store.get(old.id)?.classification, 'failed');
    assert.equal(store.get(fresh.id)?.classification, 'in_progress');
    store.conclude(old.id, 'verified_autonomous', 'late_update');
    assert.equal(store.get(old.id)?.classification, 'failed');
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agent reliability stays neutral for sparse history and rewards verified outcomes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-reliability-'));
  try {
    const store = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
    const first = store.start({ incidentId: 'INC-1', agentId: 'A', agentName: 'Alice' });
    store.conclude(first.id, 'verified_autonomous', 'verified');
    assert.equal(store.reliabilityForAgent('A').bonus, 0, 'one sample must not influence routing');
    for (const id of ['2', '3', '4']) {
      const attempt = store.start({ incidentId: `INC-${id}`, agentId: 'A', agentName: 'Alice' });
      store.conclude(attempt.id, 'assisted', 'verified fallback');
    }
    const reliable = store.reliabilityForAgent('A');
    assert.equal(reliable.samples, 4);
    assert.equal(reliable.successRate, 1);
    assert.equal(reliable.bonus, 10);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

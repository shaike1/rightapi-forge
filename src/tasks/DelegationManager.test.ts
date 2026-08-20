import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DelegationManager } from './DelegationManager.js';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-delegation-test-'));
  return path.join(dir, name);
}

test('delegation lifecycle follows allowed transitions', () => {
  const manager = new DelegationManager(tempFile('delegations.json'));
  const delegation = manager.create({
    parentTaskId: 'task-1',
    requesterAgentId: 'agent-a',
    assigneeAgentId: 'agent-b',
    objective: 'perform operation'
  });
  assert.equal(delegation.state, 'proposed');

  const approved = manager.transition({
    delegationId: delegation.id,
    nextState: 'approved'
  });
  assert.equal(approved.state, 'approved');

  const dispatched = manager.transition({
    delegationId: delegation.id,
    nextState: 'dispatched'
  });
  assert.equal(dispatched.state, 'dispatched');

  const accepted = manager.transition({
    delegationId: delegation.id,
    nextState: 'accepted'
  });
  assert.equal(accepted.state, 'accepted');

  const completed = manager.transition({
    delegationId: delegation.id,
    nextState: 'completed'
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.history.length, 5);
});

test('delegation lifecycle rejects invalid transitions', () => {
  const manager = new DelegationManager(tempFile('delegations.json'));
  const delegation = manager.create({
    parentTaskId: 'task-2',
    requesterAgentId: 'agent-a',
    assigneeAgentId: 'agent-b',
    objective: 'invalid transition test'
  });
  assert.throws(() => {
    manager.transition({
      delegationId: delegation.id,
      nextState: 'completed'
    });
  }, /Invalid delegation transition/);
});

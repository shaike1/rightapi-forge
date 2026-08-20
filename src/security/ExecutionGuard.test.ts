import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToolExecution } from './ExecutionGuard.js';

test('ExecutionGuard enforces safe commands as autonomous', () => {
  const d = evaluateToolExecution({ command: 'monitor.cpu', agentRole: 'sysadmin' });
  assert.equal(d.allowed, true);
  assert.equal(d.outcome, 'allow');
});

test('ExecutionGuard blocks standard/privileged without approval', () => {
  const d = evaluateToolExecution({ command: 'deploy.start', agentRole: 'sysadmin', providedCredentialScopes: ['deploy:write'] });
  assert.equal(d.allowed, false);
  assert.equal(d.outcome, 'approval_required');
  assert.match(d.reason || '', /requires explicit approval/);
});

test('ExecutionGuard allows risky with approval AND rollbackReady', () => {
  const d = evaluateToolExecution({ command: 'deploy.start', agentRole: 'sysadmin', providedCredentialScopes: ['deploy:write'], approved: true, rollbackReady: true });
  assert.equal(d.allowed, true);
  assert.equal(d.outcome, 'allow');
});

test('ExecutionGuard strictly blocks destructive commands regardless of approval', () => {
  const d = evaluateToolExecution({ command: 'docker.exec', agentRole: 'sysadmin', providedCredentialScopes: ['docker:exec'], approved: true });
  assert.equal(d.allowed, false);
  assert.equal(d.outcome, 'blocked');
  assert.match(d.reason || '', /destructive/i);
});

test('k8s.restart requires approval, then allows approved sysadmin action', () => {
  const pending = evaluateToolExecution({ command: 'k8s.restart', agentRole: 'sysadmin' });
  assert.equal(pending.outcome, 'approval_required');
  assert.equal(pending.risk, 'standard');
  assert.equal(pending.sandbox, 'k8s_admin');

  const approved = evaluateToolExecution({ command: 'k8s.restart', agentRole: 'sysadmin', approved: true });
  assert.equal(approved.outcome, 'allow');
});

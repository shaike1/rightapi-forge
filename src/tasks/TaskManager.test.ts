import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskManager } from './TaskManager.js';

function createTask(manager: TaskManager): string {
  const task = manager.createTask({
    title: 'unit-test-task',
    description: 'test task',
    ownerId: 'tester',
    category: 'security'
  });
  return task.id;
}

test('rollback preview marks checkpoint optional for non-risky history', () => {
  const manager = new TaskManager();
  const taskId = createTask(manager);
  manager.appendOperation(taskId, {
    actorId: 'agent-1',
    actorType: 'agent',
    type: 'execution',
    summary: 'Execution completed for server.info',
    details: '[risk:safe] collect host facts',
    status: 'success'
  });

  const preview = manager.getRollbackPreview(taskId);
  assert.equal(preview.checkpointPolicy.required, false);
  assert.equal(preview.checkpointPolicy.satisfied, true);
  assert.ok(preview.impactClasses.includes('infrastructure'));
});

test('rollback apply is blocked when risky execution exists without checkpoint', () => {
  const manager = new TaskManager();
  const taskId = createTask(manager);
  manager.appendOperation(taskId, {
    actorId: 'agent-1',
    actorType: 'agent',
    type: 'execution',
    summary: 'Execution completed for docker.exec',
    details: '[risk:destructive] changed container filesystem',
    status: 'success'
  });

  assert.throws(
    () => manager.applyRollback(taskId, { actorId: 'operator' }),
    /Rollback blocked: .*rollback checkpoints are available\./
  );
});

test('rollback apply succeeds for risky execution when checkpoint exists', () => {
  const manager = new TaskManager();
  const taskId = createTask(manager);
  const op = manager.appendOperation(taskId, {
    actorId: 'agent-1',
    actorType: 'agent',
    type: 'execution',
    summary: 'Execution completed for docker.exec',
    details: '[risk:destructive] changed container filesystem',
    status: 'success'
  });
  manager.addRollbackCheckpoint(taskId, {
    label: 'before-container-change',
    rollbackPlan: 'Restore container snapshot and restart.',
    operationId: op.id,
    impactClasses: ['infrastructure', 'data'],
    required: true
  });

  const task = manager.applyRollback(taskId, { actorId: 'operator' });
  assert.equal(task.status, 'rolled_back');
});

test('rollback preview includes deployment impact class for deploy operations', () => {
  const manager = new TaskManager();
  const taskId = createTask(manager);
  manager.appendOperation(taskId, {
    actorId: 'agent-1',
    actorType: 'agent',
    type: 'execution',
    summary: 'Execution completed for deploy.start',
    details: '[risk:privileged] started rollout',
    status: 'success'
  });

  const preview = manager.getRollbackPreview(taskId);
  assert.equal(preview.checkpointPolicy.required, true);
  assert.ok(preview.impactClasses.includes('deployment'));
});

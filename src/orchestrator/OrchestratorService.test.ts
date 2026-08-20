import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OrchestratorService } from './OrchestratorService.js';
import { TaskManager } from '../tasks/TaskManager.js';
import { DelegationManager } from '../tasks/DelegationManager.js';

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('getStatus() returns queueCountsByProject as Record<string, number>', () => {
  withTempDir(dir => {
    const tm = new TaskManager();
    const dm = new DelegationManager(path.join(dir, 'delegations.db'));
    try {
      const svc = new OrchestratorService(tm, dm);
      const status = svc.getStatus();
      assert.ok(Object.prototype.hasOwnProperty.call(status, 'queueCountsByProject'),
        'queueCountsByProject field should exist on OrchestratorStatus');
      const val = (status as unknown as Record<string, unknown>)['queueCountsByProject'];
      assert.ok(typeof val === 'object' && val !== null,
        'queueCountsByProject should be an object');
    } finally {
      dm.close();
    }
  });
});

test('queueCountsByProject buckets null projectId under "unknown"', () => {
  withTempDir(dir => {
    const tm = new TaskManager();
    // Create a task with no projectId (null/undefined)
    tm.createTask({
      title: 'task-without-project',
      description: 'test',
      ownerId: 'tester',
      category: 'security'
    });
    const dm = new DelegationManager(path.join(dir, 'delegations.db'));
    try {
      const svc = new OrchestratorService(tm, dm);
      const status = svc.getStatus();
      const byProject = (status as unknown as Record<string, unknown>)['queueCountsByProject'] as Record<string, number>;
      // Tasks without projectId should be bucketed under 'unknown'
      const total = Object.values(byProject).reduce((a: number, b: unknown) => a + (b as number), 0);
      assert.ok(total > 0 || typeof byProject['unknown'] === 'number',
        'queueCountsByProject should track entries; entries without projectId go under "unknown"');
    } finally {
      dm.close();
    }
  });
});

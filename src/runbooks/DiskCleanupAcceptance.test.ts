import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillManager } from '../skills/SkillManager.js';
import { encode, ok } from '../skills/SkillResult.js';
import { WorkflowRegistry, WorkflowJsonExecutor } from '../workflows/index.js';
import { RunbookLibrary } from './RunbookLibrary.js';

/** Fake bash skill that always succeeds with a canned survey line. */
function fakeBashSkill() {
  return {
    skill: {
      id: 'bash', name: 'bash', description: 'fake bash', category: 'shell' as const,
      enabled: true,
      commands: [{ name: 'bash.exec', description: 'run a command', handler: 'run' }],
    },
    executor: { run: async () => encode(ok({ stdout: 'Filesystem  100G  80G  20G  80% /' }, 'surveyed')) } as any,
  };
}

test('Acceptance: disk-full runbook surveys automatically and pauses for approval', async () => {
  const start = Date.now();

  // Load the real disk-cleanup workflow into a registry.
  const registry = new WorkflowRegistry({ workflowDir: '/tmp/itops-acceptance-wf' });
  const lib = new RunbookLibrary();
  lib.loadAll(registry);
  const diskWf = registry.get('library.disk-cleanup');
  assert.ok(diskWf, 'library.disk-cleanup must exist');

  // Mock bash so no real SSH runs.
  const sm = new SkillManager();
  sm.registerWithExecutor(fakeBashSkill().skill, fakeBashSkill().executor);
  const exec = new WorkflowJsonExecutor({ skillManager: sm });

  const run = await exec.execute(diskWf, { inputs: { host: 'app-node-01' } });

  const duration = Date.now() - start;

  // 1. survey steps complete successfully and automatically.
  assert.equal(run.steps[0].status, 'success', 'before snapshot');
  assert.equal(run.steps[1].status, 'success', 'large_files');
  assert.equal(run.steps[2].status, 'success', 'tmp_survey');
  assert.equal(run.steps[3].status, 'success', 'old_logs');

  // 2. The destructive step is gated — it does NOT run.
  assert.equal(run.status, 'pending_approval', 'Run must pause at approval gate');
  assert.equal(run.awaitingApproval?.stepId, 'cleanup_gate');
  const deleteStep = run.steps.find(s => s.id === 'delete_old_logs');
  assert.equal(deleteStep, undefined, 'delete step must not run before approval');

  // 3. The whole automatic phase completes in well under 5 minutes.
  assert.ok(duration < 5 * 60 * 1000, `Must run in under 5 minutes (took ${duration}ms)`);
});

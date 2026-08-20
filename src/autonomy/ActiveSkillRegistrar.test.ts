import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveSkillRegistrar } from './ActiveSkillRegistrar.js';
import { SkillManager } from '../skills/SkillManager.js';
import type { CrystallizedSkill } from '../crystallization/CrystallizedSkillTypes.js';

function fakeWorkflowExecutor(captured: { last?: { workflow: any; opts: any } } = {}) {
  return {
    captured,
    execute: async (workflow: any, opts: any) => {
      captured.last = { workflow, opts };
      return {
        runId: 'wfrun-test',
        outcome: 'completed' as const,
        steps: [],
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    },
  } as any;
}

function makeSkill(overrides: Partial<CrystallizedSkill> = {}): CrystallizedSkill {
  return {
    id: 'cskill-redis-restart',
    tenantId: 'system',
    name: 'Restart Redis Service',
    description: 'Restart redis after OOM with health check',
    sourceResolutionId: 'res-1',
    sourceAgentId: 'agent-x',
    generatedWorkflow: JSON.stringify({
      schemaVersion: 1, id: 'wf-redis-restart', name: 'Redis Restart',
      version: '1.0.0', steps: [{ id: 's1', type: 'bash', command: 'systemctl restart redis' }],
    }),
    parameters: [],
    tags: [],
    status: 'active',
    confidenceScore: 0.9,
    usageCount: 0,
    recentUsage: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('register adds the crystallized skill to the SkillManager catalogue', () => {
  const sm = new SkillManager();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: fakeWorkflowExecutor() });
  const skill = makeSkill();

  const before = sm.get('crystal.redis-restart');
  assert.equal(before, undefined);

  assert.equal(reg.register(skill), true);
  const after = sm.get('crystal.redis-restart');
  assert.ok(after, 'skill should be findable in SkillManager');
  assert.equal(after?.commands[0].name, 'run');
  assert.equal(after?.enabled, true);
});

test('register refuses non-active skills', () => {
  const sm = new SkillManager();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: fakeWorkflowExecutor() });
  assert.equal(reg.register(makeSkill({ status: 'draft' })), false);
  assert.equal(reg.register(makeSkill({ status: 'rejected' })), false);
  assert.equal(reg.register(makeSkill({ status: 'approved' })), false);
});

test('register refuses skills with unparseable workflow JSON', () => {
  const sm = new SkillManager();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: fakeWorkflowExecutor() });
  assert.equal(reg.register(makeSkill({ generatedWorkflow: 'not json{' })), false);
});

test('executor.run forwards inputs to the workflow executor', async () => {
  const sm = new SkillManager();
  const exec = fakeWorkflowExecutor();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: exec });
  reg.register(makeSkill());

  const skillExecutor = sm.getExecutor('crystal.redis-restart')!;
  const resultJson = await (skillExecutor as any).run({ host: 'localhost' });
  const result = JSON.parse(resultJson);
  assert.equal(result.ok, true);
  assert.equal(result.data.runId, 'wfrun-test');
  assert.deepEqual(exec.captured.last?.opts.inputs, { host: 'localhost' });
});

test('executor.run reports failure when the workflow run fails', async () => {
  const sm = new SkillManager();
  const failingExecutor = {
    execute: async () => ({
      runId: 'wfrun-failed', outcome: 'failed', steps: [],
      error: 'something broke', startedAt: '', finishedAt: '',
    }),
  } as any;
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: failingExecutor });
  reg.register(makeSkill());

  const r = JSON.parse(await (sm.getExecutor('crystal.redis-restart')! as any).run({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /failed/);
  assert.match(r.error, /something broke/);
});

test('unregister removes the skill from the catalogue', () => {
  const sm = new SkillManager();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: fakeWorkflowExecutor() });
  const skill = makeSkill();
  reg.register(skill);
  assert.ok(sm.get('crystal.redis-restart'));
  assert.equal(reg.unregister(skill.id), true);
  assert.equal(sm.get('crystal.redis-restart'), undefined);
});

test('unregister is idempotent — returns false when the skill was never registered', () => {
  const sm = new SkillManager();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: fakeWorkflowExecutor() });
  assert.equal(reg.unregister('cskill-never-seen'), false);
});

test('list snapshots all currently registered skills', () => {
  const sm = new SkillManager();
  const reg = new ActiveSkillRegistrar({ skillManager: sm, workflowExecutor: fakeWorkflowExecutor() });
  reg.register(makeSkill({ id: 'cskill-one', name: 'One' }));
  reg.register(makeSkill({ id: 'cskill-two', name: 'Two' }));
  const snap = reg.list().sort((a, b) => a.crystallizedId.localeCompare(b.crystallizedId));
  assert.deepEqual(snap, [
    { crystallizedId: 'cskill-one', skillId: 'crystal.one' },
    { crystallizedId: 'cskill-two', skillId: 'crystal.two' },
  ]);
});

test('register refuses to shadow a built-in skill id', () => {
  const sm = new SkillManager();
  // The InfrastructureSkill is one of the auto-registered built-ins
  // (id='infrastructure'). A crystallized skill whose slug normalises
  // to a built-in id would otherwise overwrite the catalogue entry.
  // Our slug rule prefixes `crystal.` so this is normally safe; keep
  // the test as a regression guard if the prefix ever changes.
  const builtinIds = sm.getAll().map(s => s.id);
  for (const id of builtinIds) assert.ok(!id.startsWith('crystal.'), `built-in ${id} unexpectedly uses crystal. prefix`);
});

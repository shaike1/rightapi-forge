import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxValidator } from './SandboxValidator.js';
import type { CrystallizedSkill } from './../crystallization/CrystallizedSkillTypes.js';

function makeSkill(workflow: object): CrystallizedSkill {
  return {
    id: 'cskill-test',
    tenantId: 'system',
    name: 'test',
    description: '',
    sourceResolutionId: '',
    sourceAgentId: 'agent-x',
    generatedWorkflow: JSON.stringify(workflow),
    parameters: [],
    tags: [],
    status: 'approved',
    confidenceScore: 0.9,
    usageCount: 0,
    recentUsage: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as CrystallizedSkill;
}

// Force host-exec mode so tests don't depend on docker being present
// in CI. Each test instantiates a fresh validator so env doesn't leak.
function newHostValidator(opts: { perCommandMs?: number } = {}): SandboxValidator {
  const v = new SandboxValidator({ enabled: true, perCommandMs: opts.perCommandMs ?? 4000, totalMs: 12_000, dockerAvailable: false });
  v.setDockerAvailable(false);
  return v;
}

test('disabled validator reports ok with mode:disabled', async () => {
  const v = new SandboxValidator({ enabled: false });
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: 'true' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'disabled');
});

test('passes a workflow whose only bash step succeeds', async () => {
  const v = newHostValidator();
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: 'echo hello' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].status, 'ok');
});

test('passes a workflow with chained safe commands', async () => {
  const v = newHostValidator();
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: 'echo first && echo ok' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('blocks a workflow that contains a destructive command', async () => {
  const v = newHostValidator();
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: 'rm -rf /tmp/foo' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.steps[0].status, 'blocked');
  assert.match(r.reason ?? '', /blocked/);
});

test('fails a workflow whose bash step exits non-zero', async () => {
  const v = newHostValidator();
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: 'false' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.steps[0].status, 'failed');
});

test('fails a workflow whose bash step exceeds the per-command timeout', async () => {
  const v = newHostValidator({ perCommandMs: 250 });
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: 'sleep 5' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.steps[0].status, 'failed');
});

test('skips non-bash steps and reports mode:skipped when nothing was validated', async () => {
  const v = newHostValidator();
  const skill = makeSkill({ steps: [
    { id: 's1', type: 'skill', skill: 'monitor.systemHealth', params: {} },
    { id: 's2', type: 'api_call', url: 'https://example.com' },
  ] });
  const r = await v.validate(skill);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.mode, 'skipped');
  assert.equal(r.steps.length, 2);
  assert.ok(r.steps.every(s => s.status === 'skipped'));
});

test('strips template placeholders before running the command', async () => {
  // ${steps.foo.ok} should become 'true'; the rest disappear so the
  // shell still parses. This shouldn't fail.
  const v = newHostValidator();
  const command = process.platform === 'win32'
    ? 'echo ${steps.previous.ok} && echo "host=${inputs.host}"'
    : '${steps.previous.ok} && echo "host=${inputs.host}"';
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('rejects a workflow whose JSON is unparseable', async () => {
  const v = newHostValidator();
  const skill: CrystallizedSkill = {
    ...makeSkill({}),
    generatedWorkflow: 'not json{',
  } as CrystallizedSkill;
  const r = await v.validate(skill);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /JSON unparseable/);
});

test('rejects a bash step with an empty command', async () => {
  const v = newHostValidator();
  const skill = makeSkill({ steps: [{ id: 's1', type: 'bash', command: '   ' }] });
  const r = await v.validate(skill);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.steps[0].status, 'failed');
  assert.match(r.steps[0].reason ?? '', /empty command/);
});

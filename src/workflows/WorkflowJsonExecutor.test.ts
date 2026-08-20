import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillManager } from '../skills/SkillManager.js';
import { encode, ok, fail } from '../skills/SkillResult.js';
import { validateWorkflowDef, type WorkflowDef } from './WorkflowDef.js';
import { WorkflowJsonExecutor } from './WorkflowJsonExecutor.js';
import { WorkflowRegistry } from './WorkflowRegistry.js';

/** Minimal skill harness: registers a fake skill executing scripted handlers. */
function fakeSkill(id: string, command: string, handler: (params: any) => string) {
  return {
    skill: {
      id, name: id, description: 'fake', category: 'monitoring' as const,
      enabled: true,
      commands: [{ name: command, description: 'fake', handler: 'run' }],
    },
    executor: { run: async (params: any) => handler(params) } as any,
  };
}

function makeSm(): SkillManager {
  const sm = new SkillManager();
  // ping → echoes back the message param.
  const ping = fakeSkill('ping', 'ping.do', (p) => encode(ok({ msg: p.message }, 'pinged')));
  // boom → always fails.
  const boom = fakeSkill('boom', 'boom.do', () => encode(fail('boom!')));
  // pickone → returns a chosen value for conditional/data testing.
  const pickone = fakeSkill('pickone', 'pickone.do', (p) =>
    encode(ok({ severity: p.severity, count: p.count ?? 0 }, 'picked')),
  );
  sm.registerWithExecutor(ping.skill, ping.executor);
  sm.registerWithExecutor(boom.skill, boom.executor);
  sm.registerWithExecutor(pickone.skill, pickone.executor);
  return sm;
}

// ─── Schema validation ───────────────────────────────────────────────────

test('validateWorkflowDef rejects missing top-level fields', () => {
  const v = validateWorkflowDef({});
  assert.equal(v.ok, false);
  const paths = v.errors.map(e => e.path).sort();
  assert.deepEqual(paths, ['/id', '/name', '/schemaVersion', '/steps', '/version']);
});

test('validateWorkflowDef rejects duplicate step ids', () => {
  const wf = {
    schemaVersion: 1, id: 'wf', name: 'w', version: '1',
    steps: [
      { id: 'a', type: 'skill', skill: 'ping.do' },
      { id: 'a', type: 'skill', skill: 'ping.do' },
    ],
  };
  const v = validateWorkflowDef(wf);
  assert.equal(v.ok, false);
  assert.ok(v.errors.find(e => /duplicate step id/.test(e.message)));
});

test('validateWorkflowDef rejects unknown step references in conditional', () => {
  const wf = {
    schemaVersion: 1, id: 'wf', name: 'w', version: '1',
    steps: [
      { id: 'gate', type: 'conditional', when: '${inputs.x}', then: 'missing' },
    ],
  };
  const v = validateWorkflowDef(wf);
  assert.equal(v.ok, false);
  assert.ok(v.errors.find(e => /references unknown step id/.test(e.message)));
});

test('validateWorkflowDef accepts a well-formed workflow', () => {
  const wf = {
    schemaVersion: 1, id: 'wf', name: 'OK', version: '1.0',
    inputs: [{ name: 'host', type: 'string', required: true }],
    steps: [{ id: 's', type: 'skill', skill: 'ping.do', params: { message: '${inputs.host}' } }],
  };
  const v = validateWorkflowDef(wf);
  assert.equal(v.ok, true);
  assert.equal(v.workflow!.id, 'wf');
});

// ─── Execution ──────────────────────────────────────────────────────────

test('executor expands templates and returns step output', async () => {
  const sm = makeSm();
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'echo', name: 'echo', version: '1',
    inputs: [{ name: 'name', type: 'string' }],
    steps: [{ id: 'p', type: 'skill', skill: 'ping.do', params: { message: 'hello ${inputs.name}' } }],
  };
  const run = await exec.execute(wf, { inputs: { name: 'world' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, 'success');
  assert.equal((run.steps[0].output as any).data.msg, 'hello world');
});

test('a step can read another step output via ${steps.<id>.data.<path>}', async () => {
  const sm = makeSm();
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'chain', name: 'chain', version: '1',
    steps: [
      { id: 'first',  type: 'skill', skill: 'pickone.do', params: { severity: 'high', count: 7 } },
      { id: 'second', type: 'skill', skill: 'ping.do',
        params: { message: 'sev=${steps.first.data.severity} n=${steps.first.data.count}' } },
    ],
  };
  const run = await exec.execute(wf);
  assert.equal(run.status, 'completed');
  assert.equal((run.steps[1].output as any).data.msg, 'sev=high n=7');
});

test('failed step honours onError=continue', async () => {
  const sm = makeSm();
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'recover', name: 'recover', version: '1',
    steps: [
      { id: 'bad',  type: 'skill', skill: 'boom.do', onError: 'continue' },
      { id: 'good', type: 'skill', skill: 'ping.do', params: { message: 'after-bad' } },
    ],
  };
  const run = await exec.execute(wf);
  assert.equal(run.status, 'completed');
  assert.equal(run.steps[0].status, 'failed');
  assert.equal(run.steps[1].status, 'success');
});

test('failed step with onError=fail aborts the run', async () => {
  const sm = makeSm();
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'abort', name: 'abort', version: '1',
    steps: [
      { id: 'bad',  type: 'skill', skill: 'boom.do' },
      { id: 'good', type: 'skill', skill: 'ping.do', params: { message: 'never' } },
    ],
  };
  const run = await exec.execute(wf);
  assert.equal(run.status, 'failed');
  assert.equal(run.steps.length, 1);
  assert.match(run.error!, /boom!/);
});

test('onError={goto:<id>} jumps to the named recovery step', async () => {
  const sm = makeSm();
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'goto', name: 'goto', version: '1',
    steps: [
      { id: 'bad',     type: 'skill', skill: 'boom.do',  onError: { goto: 'recover' } },
      { id: 'normal',  type: 'skill', skill: 'ping.do',  params: { message: 'normal' } },
      { id: 'recover', type: 'skill', skill: 'ping.do',  params: { message: 'recovered' } },
    ],
  };
  const run = await exec.execute(wf);
  assert.equal(run.status, 'completed');
  // 'normal' should be skipped, 'recover' should run.
  const ids = run.steps.map(s => s.id);
  assert.ok(ids.includes('bad'));
  assert.ok(ids.includes('recover'));
  assert.ok(!ids.includes('normal'));
});

test('conditional step takes the then branch when the value matches', async () => {
  const sm = makeSm();
  const exec = new WorkflowJsonExecutor({ skillManager: sm });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'cond', name: 'cond', version: '1',
    inputs: [{ name: 'sev', type: 'string' }],
    steps: [
      { id: 'gate',   type: 'conditional', when: '${inputs.sev}', equals: 'critical', then: 'page', else: 'log' },
      { id: 'page',   type: 'skill', skill: 'ping.do', params: { message: 'paging' } },
      { id: 'log',    type: 'skill', skill: 'ping.do', params: { message: 'logging' } },
    ],
  };
  const a = await exec.execute(wf, { inputs: { sev: 'critical' } });
  const aIds = a.steps.map(s => s.id);
  assert.ok(aIds.includes('page'));
  assert.ok(!aIds.includes('log'));

  const b = await exec.execute(wf, { inputs: { sev: 'low' } });
  const bIds = b.steps.map(s => s.id);
  assert.ok(bIds.includes('log'));
  assert.ok(!bIds.includes('page'));
});

test('approval_gate pauses the run when no token is provided, resumes when one is', async () => {
  const sm = makeSm();
  const approvals = {
    validate: ({ token, command }: { token?: string; command: string }) =>
      token === 'good-token' ? { valid: true, payload: { approver: 'alice' } } : { valid: false, reason: 'bad' },
  } as any;
  const exec = new WorkflowJsonExecutor({ skillManager: sm, approvals });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'gated', name: 'gated', version: '1',
    steps: [
      { id: 'gate', type: 'approval_gate', command: 'deploy.prod' },
      { id: 'go',   type: 'skill', skill: 'ping.do', params: { message: 'deploying' } },
    ],
  };
  // No token → run pauses.
  const paused = await exec.execute(wf);
  assert.equal(paused.status, 'pending_approval');
  assert.equal(paused.awaitingApproval?.stepId, 'gate');
  assert.equal(paused.steps.length, 1);
  // Resume with token → run completes.
  const completed = await exec.execute(wf, { approvals: { gate: 'good-token' } });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[0].status, 'success');
  assert.equal(completed.steps[1].status, 'success');
});

test('api_call step uses fetchImpl and surfaces the parsed body', async () => {
  const sm = makeSm();
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl: any = async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ status: 'ok', host: 'example' }), { status: 200 });
  };
  const exec = new WorkflowJsonExecutor({ skillManager: sm, fetchImpl });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'http', name: 'http', version: '1',
    inputs: [{ name: 'host', type: 'string' }],
    steps: [
      { id: 'fetch', type: 'api_call', url: 'https://example.test/${inputs.host}/status' },
    ],
  };
  const run = await exec.execute(wf, { inputs: { host: 'box1' } });
  assert.equal(run.status, 'completed');
  assert.equal(calls[0].url, 'https://example.test/box1/status');
  assert.equal((run.steps[0].output as any).data.host, 'example');
});

test('api_call step marks failure when status is not in expectStatus', async () => {
  const sm = makeSm();
  const fetchImpl: any = async () => new Response('nope', { status: 502 });
  const exec = new WorkflowJsonExecutor({ skillManager: sm, fetchImpl });
  const wf: WorkflowDef = {
    schemaVersion: 1, id: 'h2', name: 'h2', version: '1',
    steps: [{ id: 'f', type: 'api_call', url: 'https://x.test', expectStatus: [200], onError: 'continue' }],
  };
  const run = await exec.execute(wf);
  assert.equal(run.status, 'completed');
  assert.equal(run.steps[0].status, 'failed');
  assert.match(run.steps[0].error!, /502/);
});

// ─── Registry ───────────────────────────────────────────────────────────

test('WorkflowRegistry loads valid files and rejects malformed ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-wfreg-'));
  try {
    const good = {
      schemaVersion: 1, id: 'good', name: 'good', version: '1',
      steps: [{ id: 's', type: 'skill', skill: 'ping.do' }],
    };
    fs.writeFileSync(path.join(dir, 'good.workflow.json'), JSON.stringify(good), 'utf8');
    fs.writeFileSync(path.join(dir, 'bad.workflow.json'),  '{ this is not json', 'utf8');
    const reg = new WorkflowRegistry({ workflowDir: dir });
    const r = reg.loadAll();
    assert.equal(r.loaded, 1);
    assert.equal(r.failed, 1);
    assert.ok(reg.get('good'));
    assert.equal(reg.recentFailures().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WorkflowRegistry.registerFromObject validates inline definitions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-wfreg-inline-'));
  try {
    const reg = new WorkflowRegistry({ workflowDir: dir });
    const okRes = reg.registerFromObject({
      schemaVersion: 1, id: 'inl', name: 'i', version: '1',
      steps: [{ id: 's', type: 'skill', skill: 'ping.do' }],
    });
    assert.equal(okRes.ok, true);
    assert.ok(reg.get('inl'));
    const badRes = reg.registerFromObject({ schemaVersion: 1, id: '', name: '', version: '', steps: [] });
    assert.equal(badRes.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

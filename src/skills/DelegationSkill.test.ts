import test from 'node:test';
import assert from 'node:assert/strict';
import { DelegationSkill, type AgentFinder } from './DelegationSkill.js';
import type { Agent, ExecuteTaskResult } from '../agents/Agent.js';
import type { SkillManager } from './SkillManager.js';

// Minimal Agent stand-in. Only the fields/methods DelegationSkill touches.
function fakeAgent(name: string, role: string, opts?: {
  result?: Partial<ExecuteTaskResult>;
  throws?: string;
  delayMs?: number;
}): Agent {
  const id = `agent-${name}`;
  const calls: any[] = [];
  const fake = {
    id,
    name,
    role,
    config: { id, name, role, skills: [], scope: [] as string[] } as any,
    async executeTaskDetailed(task: any, _sm: any, opts2?: any): Promise<ExecuteTaskResult> {
      calls.push({ task, opts: opts2 });
      if (opts?.delayMs) await new Promise(r => setTimeout(r, opts.delayMs!));
      if (opts?.throws) throw new Error(opts.throws);
      return {
        result: 'sub-task answer',
        outcome: 'success',
        iterations: 1,
        steps: [{ iteration: 0, tool: 'mock.tool', durationMs: 1 }],
        durationMs: 1,
        ...opts?.result,
      } as ExecuteTaskResult;
    },
  } as unknown as Agent;
  (fake as any)._calls = calls;
  return fake;
}

function makeFinder(agents: Agent[]): AgentFinder {
  return {
    getAllAgents: () => agents,
    getAgent: (id: string) => agents.find(a => a.id === id),
    getAgentsByRole: (role: string) => agents.filter(a => a.role === role),
  };
}

const stubSkillManager = {} as SkillManager;

test('delegate.ask routes by name and forwards depth+1 to target', async () => {
  const eve = fakeAgent('eve', 'specialist');
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice, eve]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateAsk(
    { targetAgent: 'eve', task: 'check firewall' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0, taskId: 'parent-1' }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.agent.name, 'eve');
  assert.equal(parsed.data.toolsUsed[0], 'mock.tool');
  assert.match(parsed.data.answer, /sub-task answer/);

  const calls = (eve as any)._calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.delegationDepth, 1, 'target should be invoked at depth+1');
  assert.match(calls[0].task.description, /alice has delegated/);
});

test('delegate.ask refuses when depth has hit MAX_DEPTH', async () => {
  const eve = fakeAgent('eve', 'specialist');
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice, eve]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateAsk(
    { targetAgent: 'eve', task: 'go deeper' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: DelegationSkill.MAX_DEPTH }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /reached the cap of 3/);
  assert.equal((eve as any)._calls.length, 0, 'target should never be invoked');
});

test('delegate.ask refuses self-delegation', async () => {
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateAsk(
    { targetAgent: 'alice', task: 'mirror' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /cannot delegate to itself/);
});

test('delegate.ask resolves a role to the least-loaded agent', async () => {
  const eveBusy = fakeAgent('eve', 'specialist');
  const eve2 = fakeAgent('eve2', 'specialist');
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice, eveBusy, eve2]));
  skill.setSkillManager(stubSkillManager);
  // Pretend eve is already running 2 tasks; eve2 should get the work.
  (skill as any).activeTaskCount.set(eveBusy.id, 2);

  const out = await skill.delegateAsk(
    { targetAgent: 'specialist', task: 'investigate' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.agent.name, 'eve2', 'should pick the idle specialist over the busy one');
});

test('delegate.ask reports a clean error when target name is unknown', async () => {
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateAsk(
    { targetAgent: 'nobody', task: 'whatever' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /no agent matched/);
});

test('delegate.ask surfaces failure-derived confidence on partial outcome', async () => {
  const eve = fakeAgent('eve', 'specialist', {
    result: { outcome: 'partial', iterations: 9, steps: [{ iteration: 0, tool: 't', durationMs: 1, error: 'boom' }] }
  });
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice, eve]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateAsk(
    { targetAgent: 'eve', task: 'check' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.confidence, 'low');
});

test('delegate.broadcast asks every matching agent and aggregates results', async () => {
  const eve = fakeAgent('eve', 'specialist');
  const eve2 = fakeAgent('eve2', 'specialist');
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice, eve, eve2]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateBroadcast(
    { role: 'specialist', task: 'investigate' },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.total, 2);
  assert.equal(parsed.data.successes, 2);
  assert.deepEqual(parsed.data.results.map((r: any) => r.agent).sort(), ['eve', 'eve2']);
});

test('delegate.ask honours timeout', async () => {
  const eve = fakeAgent('eve', 'specialist', { delayMs: 50 });
  const alice = fakeAgent('alice', 'sysadmin');
  const skill = new DelegationSkill();
  skill.setFinder(makeFinder([alice, eve]));
  skill.setSkillManager(stubSkillManager);

  const out = await skill.delegateAsk(
    { targetAgent: 'eve', task: 'slow', timeout: 10 },
    { callerAgentId: alice.id, callerAgentName: 'alice', delegationDepth: 0 }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /timed out after 10ms/);
});

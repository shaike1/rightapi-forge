import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRouter } from './AgentRouter.js';
import type { Agent } from './Agent.js';

function fakeAgent(name: string, role: string, skills: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    role,
    config: { id: `agent-${name}`, name, role, skills, scope: [] },
  } as unknown as Agent;
}

test('picks the agent whose skill matches the task keywords', () => {
  const eve = fakeAgent('eve', 'specialist', ['network-diag']);
  const bob = fakeAgent('bob', 'specialist', ['database']);
  const router = new AgentRouter();
  const pick = router.pickAgent({ task: 'firewall is dropping tcp packets on port 443' }, [eve, bob]);
  assert.ok(pick);
  assert.equal(pick!.agent.name, 'eve');
  assert.match(pick!.reason, /matching skills/);
});

test('honours hard role filter', () => {
  const eve = fakeAgent('eve', 'specialist', ['security']);
  const bob = fakeAgent('bob', 'sysadmin', ['security']);
  const router = new AgentRouter();
  const pick = router.pickAgent({ task: 'investigate suspicious sudo entry', role: 'specialist' }, [eve, bob]);
  assert.ok(pick);
  assert.equal(pick!.agent.role, 'specialist');
});

test('honours hard skill filter', () => {
  const eve = fakeAgent('eve', 'specialist', ['network-diag']);
  const bob = fakeAgent('bob', 'specialist', ['database']);
  const router = new AgentRouter();
  const pick = router.pickAgent({ task: 'check db', skill: 'database' }, [eve, bob]);
  assert.ok(pick);
  assert.equal(pick!.agent.name, 'bob');
});

test('penalises busy agents', () => {
  const eve1 = fakeAgent('eve1', 'specialist', ['network-diag']);
  const eve2 = fakeAgent('eve2', 'specialist', ['network-diag']);
  const router = new AgentRouter({
    loadSource: { getActiveTaskCount: (id) => id === eve1.id ? 3 : 0 },
  });
  const pick = router.pickAgent({ task: 'check firewall' }, [eve1, eve2]);
  assert.equal(pick!.agent.name, 'eve2');
  // The full ranking should have eve1 below eve2 by exactly the load penalty.
  const all = router.scoreAll({ task: 'check firewall' }, [eve1, eve2]);
  const e1 = all.find(p => p.agent.name === 'eve1')!;
  const e2 = all.find(p => p.agent.name === 'eve2')!;
  assert.equal(e2.score - e1.score, 15); // 3 active tasks × 5 = 15
  assert.match(e1.reason, /busy/);
});

test('rewards / penalises past success rate after at least 3 delegations', () => {
  const eve = fakeAgent('eve', 'specialist', ['network-diag']);
  const bob = fakeAgent('bob', 'specialist', ['network-diag']);
  const router = new AgentRouter({
    historySource: {
      getDelegationStatsByAssignee: () => new Map([
        [eve.id, { total: 10, completed: 9, rejected: 1, avgDurationMs: 2000 }],
        [bob.id, { total: 10, completed: 3, rejected: 7, avgDurationMs: 8000 }],
      ]),
    },
  });
  const pick = router.pickAgent({ task: 'firewall' }, [eve, bob]);
  assert.equal(pick!.agent.name, 'eve');
  // 90 % → +8, 30 % → -4 → 12-point swing
  const all = router.scoreAll({ task: 'firewall' }, [eve, bob]);
  const e = all.find(p => p.agent.name === 'eve')!;
  const b = all.find(p => p.agent.name === 'bob')!;
  assert.ok(e.score - b.score >= 12);
});

test('skips success-rate signal when fewer than 3 historical delegations', () => {
  const eve = fakeAgent('eve', 'specialist', ['network-diag']);
  const router = new AgentRouter({
    historySource: {
      getDelegationStatsByAssignee: () => new Map([
        [eve.id, { total: 1, completed: 1, rejected: 0, avgDurationMs: 1000 }],
      ]),
    },
  });
  const all = router.scoreAll({ task: 'firewall' }, [eve]);
  assert.equal(all[0].breakdown.successRate, undefined, 'tiny sample size should be ignored');
});

test('returns null when no candidate clears the minimum score', () => {
  const eve = fakeAgent('eve', 'specialist', ['database']);
  const router = new AgentRouter({ minimumScore: 50 });
  const pick = router.pickAgent({ task: 'something unrelated to any skill' }, [eve]);
  assert.equal(pick, null);
});

test('caller-requested skill adds a strong bonus', () => {
  const eve = fakeAgent('eve', 'specialist', ['network-diag']);
  const router = new AgentRouter();
  const without = router.scoreAll({ task: 'do something networky' }, [eve])[0];
  const withSkill = router.scoreAll({ task: 'do something networky', skill: 'network-diag' }, [eve])[0];
  assert.equal(withSkill.score - without.score, 25);
  assert.match(withSkill.reason, /caller-requested skill/);
});

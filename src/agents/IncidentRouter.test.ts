import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAgentForIncident } from './IncidentRouter.js';
import { AgentWorkloadTracker } from './AgentWorkloadTracker.js';

// Minimal Agent shape — pickAgentForIncident only reads id, name, role,
// and config.skills. We avoid constructing a real Agent (which would
// require an AIProviderFactory) by satisfying the shape directly.
type FakeAgent = { id: string; name: string; role: string; config: { skills: string[] } };
function fakeAgent(id: string, name: string, role: string, skills: string[] = []): FakeAgent {
  return { id, name, role, config: { skills } };
}

test('returns null when org has no agents', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pick = pickAgentForIncident({ id: 'INC-1', title: 'X', severity: 'medium' }, [] as any);
  assert.equal(pick, null);
});

test('skill keyword match wins over round-robin', () => {
  const agents = [
    fakeAgent('a-1', 'Alice', 'sysadmin', ['monitoring']),
    fakeAgent('a-2', 'Bob',   'sysadmin', ['network-diag']),
    fakeAgent('a-3', 'Carol', 'sysadmin', ['security']),
  ];
  const pick = pickAgentForIncident(
    { id: 'INC-1', title: 'Disk usage critical on web-01', severity: 'high' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents as any,
  );
  assert.ok(pick);
  // 'monitoring' keywords cover disk/cpu/memory — Alice should win.
  assert.equal(pick?.agent.id, 'a-1');
  assert.ok(pick && pick.score > 0);
});

test('busy agents get a load penalty', () => {
  const agents = [
    fakeAgent('a-1', 'Alice', 'sysadmin', ['monitoring']),
    fakeAgent('a-2', 'Bob',   'sysadmin', ['monitoring']),
  ];
  const tracker = new AgentWorkloadTracker(null);
  tracker.assign({ agentId: 'a-1', agentName: 'Alice', incidentId: 'INC-prev', incidentTitle: 'busy' });
  const pick = pickAgentForIncident(
    { id: 'INC-2', title: 'Disk usage high', severity: 'medium' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents as any,
    tracker,
  );
  assert.equal(pick?.agent.id, 'a-2', 'idle peer wins over busy agent with the same skills');
});

test('falls back to round-robin when no keyword matches', () => {
  const agents = [
    fakeAgent('a-1', 'Alice', 'sysadmin', []),
    fakeAgent('a-2', 'Bob',   'sysadmin', []),
  ];
  const pick = pickAgentForIncident(
    { id: 'INC-1', title: 'Mystery happening', severity: 'low' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents as any,
  );
  assert.ok(pick);
  assert.match(pick?.reason ?? '', /round-robin/);
  assert.ok(['a-1', 'a-2'].includes(pick?.agent.id ?? ''));
});

test('director-only org still returns the director for critical incidents', () => {
  const agents = [fakeAgent('d-1', 'IT Director', 'director', ['monitoring'])];
  const pick = pickAgentForIncident(
    { id: 'INC-1', title: 'Disk full', severity: 'critical' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents as any,
  );
  assert.equal(pick?.agent.id, 'd-1');
});

test('prefers body agents over director when both match keywords', () => {
  const agents = [
    fakeAgent('d-1', 'IT Director', 'director', ['monitoring']),
    fakeAgent('s-1', 'Sysadmin',    'sysadmin', ['monitoring']),
  ];
  const pick = pickAgentForIncident(
    { id: 'INC-1', title: 'Disk usage', severity: 'high' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents as any,
  );
  assert.equal(pick?.agent.role, 'sysadmin');
});

test('round-robin prefers idle agents over busy ones when no keywords match', () => {
  const agents = [
    fakeAgent('a-1', 'Alice', 'sysadmin', []),
    fakeAgent('a-2', 'Bob',   'sysadmin', []),
  ];
  const tracker = new AgentWorkloadTracker(null);
  tracker.assign({ agentId: 'a-1', agentName: 'Alice', incidentId: 'INC-prev', incidentTitle: 'busy' });
  const pick = pickAgentForIncident(
    { id: 'INC-2', title: 'Some unrecognised problem', severity: 'low' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents as any,
    tracker,
  );
  assert.equal(pick?.agent.id, 'a-2', 'idle agent wins round-robin');
});

test('verified outcome history breaks ties without overpowering workload safety', () => {
  const agents = [
    fakeAgent('a-1', 'Alice', 'sysadmin', ['monitoring']),
    fakeAgent('a-2', 'Bob', 'sysadmin', ['monitoring']),
  ];
  const pick = pickAgentForIncident(
    { id: 'INC-3', title: 'Disk usage high', severity: 'high' },
    agents as any,
    {
      outcomeScore: id => id === 'a-2'
        ? { bonus: 8, samples: 8, successRate: 0.9 }
        : { bonus: -6, samples: 8, successRate: 0.2 },
    },
  );
  assert.equal(pick?.agent.id, 'a-2');
  assert.match(pick?.reason || '', /outcomes\(90%,\+8\)/);

  const tracker = new AgentWorkloadTracker(null);
  tracker.assign({ agentId: 'a-2', agentName: 'Bob', incidentId: 'INC-prev', incidentTitle: 'busy' });
  const safePick = pickAgentForIncident(
    { id: 'INC-4', title: 'Disk usage high', severity: 'high' },
    agents as any,
    {
      workload: tracker,
      outcomeScore: id => id === 'a-2'
        ? { bonus: 10, samples: 20, successRate: 1 }
        : { bonus: 0, samples: 20, successRate: 0.5 },
    },
  );
  assert.equal(safePick?.agent.id, 'a-1', '20-point busy penalty remains stronger than history bonus');
});

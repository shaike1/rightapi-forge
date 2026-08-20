import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentSpecialization, AFFINITY_BONUS_PER_MATCH } from './AgentSpecialization.js';
import { pickAgentForIncident } from './IncidentRouter.js';
import type { Agent } from './Agent.js';

function fresh(): AgentSpecialization {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-affinity-'));
  return new AgentSpecialization(path.join(dir, 'affinity.db'));
}

/** Build a minimal Agent stub the router expects. The router only
 *  reads .id / .name / .role / .config.skills off it, so we can keep
 *  the rest unimplemented. */
function stubAgent(id: string, name: string, role: 'sysadmin' | 'specialist' | 'director' = 'sysadmin'): Agent {
  return {
    id,
    name,
    role,
    config: { id, name, role, skills: [] as string[] },
  } as unknown as Agent;
}

test('AgentSpecialization: set + get round-trip', () => {
  const s = fresh();
  s.set('agent-1', ['vps1', 'vps2']);
  const got = s.get('agent-1');
  assert.ok(got);
  assert.deepEqual(got!.serverIds, ['vps1', 'vps2']);
});

test('AgentSpecialization: set de-duplicates and drops empty entries', () => {
  const s = fresh();
  s.set('agent-1', ['vps1', 'vps1', '', '  ', 'vps2']);
  assert.deepEqual(s.get('agent-1')!.serverIds, ['vps1', 'vps2']);
});

test('AgentSpecialization: hasAffinity returns false when no row', () => {
  const s = fresh();
  assert.equal(s.hasAffinity('nobody', 'vps1'), false);
});

test('AgentSpecialization: ensureSeed only writes when absent', () => {
  const s = fresh();
  const a = s.ensureSeed('agent-1', ['vps1']);
  assert.equal(a.created, true);
  const b = s.ensureSeed('agent-1', ['vps2']);
  assert.equal(b.created, false);
  assert.deepEqual(s.get('agent-1')!.serverIds, ['vps1'], 'second seed did not overwrite');
});

test('AgentSpecialization: set([]) clears affinity', () => {
  const s = fresh();
  s.set('agent-1', ['vps1']);
  s.set('agent-1', []);
  assert.deepEqual(s.get('agent-1')!.serverIds, []);
});

test('AgentSpecialization: persists across re-open (same db path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-affinity-'));
  const dbPath = path.join(dir, 'affinity.db');
  const s1 = new AgentSpecialization(dbPath);
  s1.set('agent-1', ['vps3']);
  const s2 = new AgentSpecialization(dbPath);
  assert.deepEqual(s2.get('agent-1')!.serverIds, ['vps3']);
});

test('pickAgentForIncident: affinity wins between two otherwise-equal agents', () => {
  const s = fresh();
  s.set('agent-bravo', ['vps2']);
  const agents = [stubAgent('agent-alpha', 'Ops Alpha'), stubAgent('agent-bravo', 'Ops Bravo')];
  // Generic title that won't match any keyword skills.
  const pick = pickAgentForIncident(
    { id: 'I1', title: 'Disk cleanup', severity: 'high', serverId: 'vps2' },
    agents,
    { specialization: s },
  );
  assert.ok(pick);
  assert.equal(pick!.agent.id, 'agent-bravo', 'bravo has affinity to vps2');
  assert.match(pick!.reason, /affinity/);
});

test('pickAgentForIncident: no affinity store → same behaviour as before (no crash)', () => {
  const agents = [stubAgent('agent-alpha', 'Ops Alpha')];
  const pick = pickAgentForIncident(
    { id: 'I1', title: 'X', severity: 'medium', serverId: 'vps2' },
    agents,
  );
  assert.ok(pick);
  assert.equal(pick!.agent.id, 'agent-alpha');
});

test('pickAgentForIncident: incident without serverId → affinity ignored', () => {
  const s = fresh();
  s.set('agent-bravo', ['vps2']);
  const agents = [stubAgent('agent-alpha', 'Ops Alpha'), stubAgent('agent-bravo', 'Ops Bravo')];
  // Without serverId, no affinity bonus — round-robin falls back to the
  // first agent in the pool (assuming both are equal-scored).
  const pick = pickAgentForIncident(
    { id: 'I1', title: 'X', severity: 'medium' },
    agents,
    { specialization: s },
  );
  assert.ok(pick);
  // We don't pin which agent — just that affinity didn't influence it
  // (so reason shouldn't mention "affinity").
  assert.doesNotMatch(pick!.reason, /affinity/);
});

test('AFFINITY_BONUS_PER_MATCH is high enough to beat the load penalty', () => {
  // The router applies -20 to busy agents. The affinity bonus must out-
  // weigh that so a busy specialist still wins over a free generalist
  // when keywords don't match.
  assert.ok(AFFINITY_BONUS_PER_MATCH > 20,
    `bonus ${AFFINITY_BONUS_PER_MATCH} should exceed busy penalty (20)`);
});

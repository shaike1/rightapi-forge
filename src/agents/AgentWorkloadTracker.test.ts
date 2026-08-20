import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentWorkloadTracker } from './AgentWorkloadTracker.js';

function freshTracker(persistPath: string | null = null): AgentWorkloadTracker {
  return new AgentWorkloadTracker(persistPath);
}

test('agent starts idle when nothing has been assigned', () => {
  const t = freshTracker();
  assert.equal(t.getStatus('agent-1').status, 'idle');
  assert.equal(t.busyCount(), 0);
});

test('assign marks the agent busy and stores incident details', () => {
  const t = freshTracker();
  const a = t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'Disk full' });
  assert.equal(a.agentId, 'agent-1');
  assert.equal(a.incidentId, 'INC-1');
  const status = t.getStatus('agent-1');
  assert.equal(status.status, 'busy');
  assert.equal(status.currentIncidentId, 'INC-1');
  assert.equal(status.currentIncidentTitle, 'Disk full');
  assert.equal(t.busyCount(), 1);
});

test('release frees the agent and clears the incident reverse map', () => {
  const t = freshTracker();
  t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'X' });
  t.release('agent-1');
  assert.equal(t.getStatus('agent-1').status, 'idle');
  assert.equal(t.getAgentForIncident('INC-1'), null);
  assert.equal(t.busyCount(), 0);
});

test('release is idempotent on never-assigned agents', () => {
  const t = freshTracker();
  t.release('phantom-agent');
  assert.equal(t.busyCount(), 0);
});

test('releaseByIncident returns the agent id and frees them', () => {
  const t = freshTracker();
  t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'X' });
  const freed = t.releaseByIncident('INC-1');
  assert.equal(freed, 'agent-1');
  assert.equal(t.getStatus('agent-1').status, 'idle');
});

test('releaseByIncident returns null when the incident has no assignment', () => {
  const t = freshTracker();
  assert.equal(t.releaseByIncident('INC-missing'), null);
});

test('re-assigning a busy agent to a new incident drops the previous mapping', () => {
  const t = freshTracker();
  t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'X' });
  t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-2', incidentTitle: 'Y' });
  assert.equal(t.getAgentForIncident('INC-1'), null, 'old incident no longer points at agent');
  assert.equal(t.getAgentForIncident('INC-2'), 'agent-1');
  assert.equal(t.busyCount(), 1);
});

test('re-assigning the same incident keeps startedAt stable', async () => {
  const t = freshTracker();
  const first = t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'X' });
  await new Promise(r => setTimeout(r, 5));
  const second = t.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'X' });
  assert.equal(second.startedAt, first.startedAt);
});

test('persistence: assignments survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workload-'));
  const file = path.join(dir, 'workload.json');
  const a = freshTracker(file);
  a.assign({ agentId: 'agent-1', agentName: 'Alice', incidentId: 'INC-1', incidentTitle: 'Disk full' });
  // Reload fresh tracker against the same file.
  const b = freshTracker(file);
  assert.equal(b.getStatus('agent-1').status, 'busy');
  assert.equal(b.getStatus('agent-1').currentIncidentId, 'INC-1');
  assert.equal(b.getAgentForIncident('INC-1'), 'agent-1');
});

test('persistence: corrupt file does not crash the tracker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workload-'));
  const file = path.join(dir, 'workload.json');
  fs.writeFileSync(file, '{not valid json', 'utf8');
  const t = freshTracker(file);
  assert.equal(t.busyCount(), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentMessageBus } from './AgentMessageBus.js';

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-bus-deleg-'));
  return path.join(dir, name);
}

test('delegateTask records a pending delegation and a delegation_request message', () => {
  const bus = new AgentMessageBus(tempFile('bus.json'));
  const { id, threadId } = bus.delegateTask({
    requesterAgentId: 'alice', requesterAgentName: 'alice',
    assigneeAgentId: 'eve',    assigneeAgentName: 'eve',
    parentTaskId: 'task-42',
    objective: 'check firewall',
    context: 'port 443 keeps timing out from web tier',
  });
  assert.match(id, /^deleg-/);
  assert.match(threadId, /^thread-/);

  const records = bus.listDelegations();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'pending');
  assert.equal(records[0].objective, 'check firewall');
  assert.equal(records[0].assigneeAgentId, 'eve');
  assert.equal(records[0].parentTaskId, 'task-42');

  const messages = bus.listMessages({ threadId });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'delegation_request');
  assert.match(messages[0].content, /alice → eve/);
  assert.match(messages[0].content, /port 443/);
});

test('recordDelegationResult posts a response message and closes the record', () => {
  const bus = new AgentMessageBus(tempFile('bus.json'));
  const { id, threadId } = bus.delegateTask({
    requesterAgentId: 'alice', requesterAgentName: 'alice',
    assigneeAgentId: 'eve',    assigneeAgentName: 'eve',
    objective: 'check firewall',
  });

  const updated = bus.recordDelegationResult(id, {
    state: 'completed',
    childTaskId: 'task-99',
    summary: 'firewall rule on tcp/443 was missing — added it',
    durationMs: 4200,
  });
  assert.ok(updated, 'should return the updated record');
  assert.equal(updated!.state, 'completed');
  assert.equal(updated!.childTaskId, 'task-99');
  assert.match(updated!.summary!, /firewall rule on tcp\/443/);
  assert.ok(updated!.completedAt);

  const messages = bus.listMessages({ threadId });
  // newest first; we expect [response, request]
  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'delegation_response');
  assert.equal(messages[1].kind, 'delegation_request');
  assert.match(messages[0].content, /eve completed in 4s/);
});

test('recordDelegationResult marks rejected with error and failed status', () => {
  const bus = new AgentMessageBus(tempFile('bus.json'));
  const { id } = bus.delegateTask({
    requesterAgentId: 'alice', assigneeAgentId: 'eve',
    objective: 'check', requesterAgentName: 'alice', assigneeAgentName: 'eve',
  });
  const updated = bus.recordDelegationResult(id, {
    state: 'rejected',
    error: 'eve timed out',
    durationMs: 30000,
  });
  assert.equal(updated!.state, 'rejected');
  assert.equal(updated!.error, 'eve timed out');

  const responseMsgs = bus.listMessages().filter(m => m.kind === 'delegation_response');
  assert.equal(responseMsgs.length, 1);
  assert.equal(responseMsgs[0].status, 'failed');
});

test('listDelegations filters by requester / assignee / state and limit', () => {
  const bus = new AgentMessageBus(tempFile('bus.json'));
  const a = bus.delegateTask({ requesterAgentId: 'alice', assigneeAgentId: 'eve', objective: 'one', requesterAgentName: 'alice', assigneeAgentName: 'eve' });
  const b = bus.delegateTask({ requesterAgentId: 'alice', assigneeAgentId: 'bob', objective: 'two', requesterAgentName: 'alice', assigneeAgentName: 'bob' });
  bus.delegateTask({ requesterAgentId: 'director', assigneeAgentId: 'eve', objective: 'three', requesterAgentName: 'director', assigneeAgentName: 'eve' });
  bus.recordDelegationResult(a.id, { state: 'completed', summary: 'ok' });
  bus.recordDelegationResult(b.id, { state: 'rejected', error: 'no' });

  const fromAlice = bus.listDelegations({ requesterAgentId: 'alice' });
  assert.equal(fromAlice.length, 2);

  const toEve = bus.listDelegations({ assigneeAgentId: 'eve' });
  assert.equal(toEve.length, 2);

  const completed = bus.listDelegations({ state: 'completed' });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].objective, 'one');

  const limited = bus.listDelegations({ limit: 1 });
  assert.equal(limited.length, 1);
});

test('getDelegationStatsByAssignee aggregates totals + avg duration', () => {
  const bus = new AgentMessageBus(tempFile('bus.json'));
  const a = bus.delegateTask({ requesterAgentId: 'alice', assigneeAgentId: 'eve', objective: '1', requesterAgentName: 'alice', assigneeAgentName: 'eve' });
  const b = bus.delegateTask({ requesterAgentId: 'alice', assigneeAgentId: 'eve', objective: '2', requesterAgentName: 'alice', assigneeAgentName: 'eve' });
  const c = bus.delegateTask({ requesterAgentId: 'alice', assigneeAgentId: 'eve', objective: '3', requesterAgentName: 'alice', assigneeAgentName: 'eve' });
  bus.recordDelegationResult(a.id, { state: 'completed', durationMs: 1000 });
  bus.recordDelegationResult(b.id, { state: 'completed', durationMs: 3000 });
  bus.recordDelegationResult(c.id, { state: 'rejected', durationMs: 500 });

  const stats = bus.getDelegationStatsByAssignee();
  const eve = stats.get('eve');
  assert.ok(eve);
  assert.equal(eve!.total, 3);
  assert.equal(eve!.completed, 2);
  assert.equal(eve!.rejected, 1);
  assert.equal(eve!.avgDurationMs, 1500); // (1000 + 3000 + 500) / 3
});

test('delegations survive a reload from disk', () => {
  const file = tempFile('bus.json');
  const bus = new AgentMessageBus(file);
  const { id } = bus.delegateTask({
    requesterAgentId: 'alice', assigneeAgentId: 'eve', objective: 'persist',
    requesterAgentName: 'alice', assigneeAgentName: 'eve',
  });
  bus.recordDelegationResult(id, { state: 'completed', summary: 'done' });

  const reloaded = new AgentMessageBus(file);
  const records = reloaded.listDelegations();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'completed');
  assert.equal(records[0].summary, 'done');
});

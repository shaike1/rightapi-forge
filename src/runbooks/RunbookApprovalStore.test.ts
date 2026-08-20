import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookApprovalStore } from './RunbookApprovalStore.js';

function newStore(): RunbookApprovalStore {
  const dir = mkdtempSync(join(tmpdir(), 'rb-approval-test-'));
  return new RunbookApprovalStore(join(dir, 'approvals.db'));
}

test('create() persists a pending row and findPendingForStep() retrieves it', () => {
  const s = newStore();
  const a = s.create({
    runId: 'run-1', stepId: 's3', stepDescription: 'Restart service',
    reason: 'requires_approval flag', requestedBy: 'auto:incident_match',
  });
  assert.equal(a.status, 'pending');
  assert.ok(a.id.startsWith('apr-'));
  const found = s.findPendingForStep('run-1', 's3');
  assert.ok(found);
  assert.equal(found!.id, a.id);
});

test('decide(approved) flips status, populates decidedBy/decidedAt/reason', async () => {
  const s = newStore();
  const a = s.create({
    runId: 'run-2', stepId: 'x', stepDescription: 'thing', reason: 'r', requestedBy: 'op1',
  });
  // sleep so decidedAt > requestedAt
  await new Promise(r => setTimeout(r, 20));
  const updated = s.decide(a.id, { status: 'approved', decidedBy: 'admin', reason: 'looks safe' });
  assert.ok(updated);
  assert.equal(updated!.status, 'approved');
  assert.equal(updated!.decidedBy, 'admin');
  assert.equal(updated!.decisionReason, 'looks safe');
  assert.ok(updated!.decidedAt && updated!.decidedAt > updated!.requestedAt);
});

test('decide() on an already-decided row is a no-op', () => {
  const s = newStore();
  const a = s.create({ runId: 'r', stepId: 'x', stepDescription: 't', reason: 'r', requestedBy: 'u' });
  s.decide(a.id, { status: 'rejected', decidedBy: 'admin', reason: 'no' });
  const second = s.decide(a.id, { status: 'approved', decidedBy: 'admin2' });
  // Returns null because no rows updated.
  assert.equal(second, null);
  const stored = s.get(a.id);
  assert.equal(stored!.status, 'rejected');
  assert.equal(stored!.decidedBy, 'admin');
});

test('listPending returns only pending rows in newest-first order', async () => {
  const s = newStore();
  const a1 = s.create({ runId: 'r1', stepId: 's', stepDescription: 'd', reason: 'r', requestedBy: 'u' });
  await new Promise(r => setTimeout(r, 12));
  const a2 = s.create({ runId: 'r2', stepId: 's', stepDescription: 'd', reason: 'r', requestedBy: 'u' });
  s.decide(a1.id, { status: 'approved', decidedBy: 'admin' });
  const pending = s.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, a2.id);
});

test('listForRun returns rows in newest-first order regardless of status', async () => {
  const s = newStore();
  const a1 = s.create({ runId: 'r1', stepId: 's1', stepDescription: 'd', reason: 'r', requestedBy: 'u' });
  await new Promise(r => setTimeout(r, 12));
  const a2 = s.create({ runId: 'r1', stepId: 's2', stepDescription: 'd', reason: 'r', requestedBy: 'u' });
  s.decide(a1.id, { status: 'approved', decidedBy: 'admin' });
  const all = s.listForRun('r1');
  assert.deepEqual(all.map(a => a.id), [a2.id, a1.id]);
});

test('findPendingForStep ignores decided rows', () => {
  const s = newStore();
  const a = s.create({ runId: 'r', stepId: 's', stepDescription: 'd', reason: 'r', requestedBy: 'u' });
  s.decide(a.id, { status: 'approved', decidedBy: 'admin' });
  assert.equal(s.findPendingForStep('r', 's'), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AiDecisionStore } from './AiDecisionStore.js';

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-aidec-'));
  return path.join(dir, 'decisions.db');
}

test('AiDecisionStore inserts and retrieves rows', () => {
  const store = new AiDecisionStore(tmpDb());
  const r = store.insert({
    id: 'dec-1', kind: 'triage', incidentId: 'INC-1',
    confidence: 0.92, reasoning: 'High-confidence disk issue',
    autoApplied: true,
    payload: { severity: 'high', categories: ['disk'] },
  });
  assert.equal(r.id, 'dec-1');
  assert.equal(r.autoApplied, true);
  const fetched = store.get('dec-1');
  assert.equal(fetched?.confidence, 0.92);
  assert.deepEqual(fetched?.payload, { severity: 'high', categories: ['disk'] });
  store.close();
});

test('AiDecisionStore.list filters by kind, incident, outcome, autoApplied, since', () => {
  const store = new AiDecisionStore(tmpDb());
  const now = new Date();
  const old = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
  const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  store.insert({ id: 'a', kind: 'triage',  incidentId: 'INC-1', confidence: 0.9, reasoning: '', autoApplied: true,  payload: {}, createdAt: old });
  store.insert({ id: 'b', kind: 'resolve', incidentId: 'INC-1', confidence: 0.5, reasoning: '', autoApplied: false, payload: {}, createdAt: recent });
  store.insert({ id: 'c', kind: 'triage',  incidentId: 'INC-2', confidence: 0.6, reasoning: '', autoApplied: false, payload: {}, createdAt: recent });

  assert.equal(store.list({ kind: 'triage' }).length, 2);
  assert.equal(store.list({ incidentId: 'INC-1' }).length, 2);
  assert.equal(store.list({ autoApplied: true }).length, 1);
  // since cutoff drops the old one
  const since = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  assert.equal(store.list({ since }).length, 2);
  store.close();
});

test('AiDecisionStore.recordOutcome updates row + sets reviewed metadata', () => {
  const store = new AiDecisionStore(tmpDb());
  store.insert({ id: 'a', kind: 'resolve', incidentId: 'INC-9', confidence: 0.9, reasoning: '', autoApplied: true, payload: {} });
  const updated = store.recordOutcome('a', 'reopened', 'alice')!;
  assert.equal(updated.outcome, 'reopened');
  assert.equal(updated.reviewedBy, 'alice');
  assert.ok(updated.reviewedAt);
  store.close();
});

test('AiDecisionStore.stats aggregates by kind and outcome with success rates', () => {
  const store = new AiDecisionStore(tmpDb());
  store.insert({ id: 'a', kind: 'triage',  incidentId: '1', confidence: 0.9, reasoning: '', autoApplied: true,  payload: {} });
  store.insert({ id: 'b', kind: 'triage',  incidentId: '2', confidence: 0.7, reasoning: '', autoApplied: false, payload: {} });
  store.insert({ id: 'c', kind: 'resolve', incidentId: '3', confidence: 0.95, reasoning: '', autoApplied: true, payload: {} });
  store.recordOutcome('c', 'success');
  store.insert({ id: 'd', kind: 'resolve', incidentId: '4', confidence: 0.85, reasoning: '', autoApplied: true, payload: {} });
  store.recordOutcome('d', 'reopened');

  const s = store.stats();
  assert.equal(s.total, 4);
  assert.equal(s.byKind.triage, 2);
  assert.equal(s.byKind.resolve, 2);
  assert.equal(s.autoApplied, 3);
  assert.equal(s.suggested, 1);
  assert.equal(s.successRateByKind.resolve, 0.5);   // 1 success / (1 success + 1 reopened)
  assert.ok(s.meanConfidenceByKind.triage! > 0.7);
  store.close();
});

test('AiDecisionStore.insert clamps confidence to [0,1]', () => {
  const store = new AiDecisionStore(tmpDb());
  const a = store.insert({ id: 'over', kind: 'triage', incidentId: '1', confidence: 1.5, reasoning: '', autoApplied: false, payload: {} });
  const b = store.insert({ id: 'under', kind: 'triage', incidentId: '1', confidence: -0.5, reasoning: '', autoApplied: false, payload: {} });
  assert.equal(a.confidence, 1);
  assert.equal(b.confidence, 0);
  store.close();
});

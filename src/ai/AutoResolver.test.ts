import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AutoResolver, type KbHit, type RunbookHit } from './AutoResolver.js';
import { AiDecisionStore } from './AiDecisionStore.js';
import { AutonomyAttemptStore } from './AutonomyAttemptStore.js';
import type { Incident } from '../persistence/SqliteStore.js';

function tmpStore(): AiDecisionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-resolver-'));
  return new AiDecisionStore(path.join(dir, 'd.db'));
}

function fakeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'INC-A', title: 'Nginx service down on app-01', description: 'systemctl status nginx → inactive',
    severity: 'medium', status: 'open', assignedTo: null, assignedAgent: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    resolvedAt: null, source: 'agent', sourceRef: 'service:nginx:app-01',
    slaMinutes: 240, serverId: 'app-01', createdBy: null,
    ...overrides,
  };
}

function fakeIm() {
  const notes: any[] = [];
  return {
    notes,
    addNote: (id: string, actor: string, message: string) => { notes.push({ id, actor, message }); return null; },
    get: (id: string) => fakeIncident({ id, status: 'resolved' }),
  };
}

const KB_HIT: KbHit = { id: 'KB-123', title: 'Restart nginx', tags: ['service', 'nginx'], usefulCount: 12 };
const RB_HIT: RunbookHit = { id: 'rb-restart-service', name: 'restart-service', description: 'Restart a systemd service', category: 'service', tags: ['service', 'nginx'], enabled: true };

test('AutoResolver auto-resolves when KB + runbook + non-critical + above threshold', async () => {
  const store = tmpStore();
  const im = fakeIm();
  const runs: any[] = [];
  const resolver = new AutoResolver(
    {
      incidentManager: im as any,
      decisionStore: store,
      knowledgeStore: { search: () => [KB_HIT] },
      runbookEngine: {
        listTemplates: () => [RB_HIT],
        executeRun: async (id, who, opts) => { runs.push({ id, who, opts }); return { id: 'run-1', status: 'running' }; },
      },
    },
    { minConfidence: 0.5 },
  );
  const d = await resolver.evaluate(fakeIncident());
  assert.equal(d.action, 'auto_resolved');
  assert.equal(d.runId, 'run-1');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, 'rb-restart-service');
  assert.ok(im.notes.length > 0);
  store.close();
});

test('AutoResolver never auto-resolves critical incidents — downgrades to suggested', async () => {
  const store = tmpStore();
  const resolver = new AutoResolver(
    {
      incidentManager: fakeIm() as any,
      decisionStore: store,
      knowledgeStore: { search: () => [KB_HIT] },
      runbookEngine: { listTemplates: () => [RB_HIT], executeRun: async () => { throw new Error('should not run'); } },
    },
    { minConfidence: 0.1 },
  );
  const d = await resolver.evaluate(fakeIncident({ severity: 'critical' }));
  assert.equal(d.action, 'suggested_runbook');
  store.close();
});

test('AutoResolver downgrades when confidence is below threshold', async () => {
  const store = tmpStore();
  const resolver = new AutoResolver(
    {
      incidentManager: fakeIm() as any,
      decisionStore: store,
      knowledgeStore: { search: () => [{ id: 'KB-low', title: 'tangentially related', usefulCount: 5 }] },
      runbookEngine: { listTemplates: () => [], executeRun: async () => { throw new Error('nope'); } },
    },
    { minConfidence: 0.95 },
  );
  const d = await resolver.evaluate(fakeIncident({ title: 'tangentially related' }));
  assert.notEqual(d.action, 'auto_resolved');
  assert.equal(d.runbookMatch, null);
  store.close();
});

test('AutoResolver suggests KB when runbook missing', async () => {
  const store = tmpStore();
  const resolver = new AutoResolver(
    {
      incidentManager: fakeIm() as any,
      decisionStore: store,
      knowledgeStore: { search: () => [KB_HIT] },
      runbookEngine: { listTemplates: () => [], executeRun: async () => { throw new Error('nope'); } },
    },
    { minConfidence: 0.5 },
  );
  const d = await resolver.evaluate(fakeIncident());
  assert.equal(d.action, 'suggested_kb');
  assert.equal(d.kbMatch?.id, 'KB-123');
  store.close();
});

test('AutoResolver.trackOutcomes flips reopened/success on aging decisions', () => {
  const store = tmpStore();
  // Seed an old auto-applied decision.
  const oldIso = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  store.insert({ id: 'd-1', kind: 'resolve', incidentId: 'INC-X', confidence: 0.9, reasoning: '', autoApplied: true, payload: { runbookId: 'rb1' }, createdAt: oldIso });
  store.insert({ id: 'd-2', kind: 'resolve', incidentId: 'INC-Y', confidence: 0.9, reasoning: '', autoApplied: true, payload: { runbookId: 'rb1' }, createdAt: oldIso });

  const im = {
    get: (id: string) => id === 'INC-X'
      ? fakeIncident({ id, status: 'open' })   // reopened
      : fakeIncident({ id, status: 'resolved' }), // success
    addNote: () => null,
  };
  const resolver = new AutoResolver(
    { incidentManager: im as any, decisionStore: store },
    {},
  );
  const out = resolver.trackOutcomes();
  assert.equal(out.reviewed, 2);
  assert.equal(out.reopened, 1);
  assert.equal(out.success, 1);
  const d1 = store.get('d-1')!;
  assert.equal(d1.outcome, 'reopened');
  const d2 = store.get('d-2')!;
  assert.equal(d2.outcome, 'success');
  store.close();
});

test('AutoResolver attributes and verifies its runbook attempt by decision id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-resolver-attempt-'));
  const store = new AiDecisionStore(path.join(dir, 'decisions.db'));
  const attempts = new AutonomyAttemptStore(path.join(dir, 'attempts.db'));
  const resolver = new AutoResolver(
    {
      incidentManager: fakeIm() as any,
      decisionStore: store,
      attemptStore: attempts,
      knowledgeStore: { search: () => [KB_HIT] },
      runbookEngine: {
        listTemplates: () => [RB_HIT],
        executeRun: async () => ({ id: 'run-attributed', status: 'running' }),
      },
    },
    { minConfidence: 0.5 },
  );

  await resolver.evaluate(fakeIncident());
  const decision = store.list({ kind: 'resolve', outcome: 'pending', limit: 1 })[0];
  const started = attempts.getByCorrelationId(decision.id);
  assert.equal(started?.source, 'auto_resolver');
  assert.equal(started?.classification, 'in_progress');
  assert.ok(started?.phases.some(p => p.kind === 'tool_execution' && p.status === 'success'));

  resolver.trackOutcomes({ reopenWindowMs: -1 });
  const completed = attempts.getByCorrelationId(decision.id);
  assert.equal(completed?.classification, 'verified_autonomous');
  assert.equal(completed?.verification, 'passed');
  assert.ok(completed?.phases.some(p => p.kind === 'verification' && p.status === 'success'));
  attempts.close();
  store.close();
});

test('AutoResolver.onIncidentCreated returns null when disabled', async () => {
  const store = tmpStore();
  const resolver = new AutoResolver(
    { incidentManager: fakeIm() as any, decisionStore: store },
    { enabled: false },
  );
  const out = await resolver.onIncidentCreated(fakeIncident());
  assert.equal(out, null);
  store.close();
});

test('AutoResolver uses historical success rate when available', async () => {
  const store = tmpStore();
  // Seed two prior successful runs of the same runbook.
  store.insert({ id: 'h1', kind: 'resolve', incidentId: 'past1', confidence: 0.9, reasoning: '', autoApplied: true, payload: { runbookId: 'rb-restart-service' } });
  store.recordOutcome('h1', 'success');
  store.insert({ id: 'h2', kind: 'resolve', incidentId: 'past2', confidence: 0.9, reasoning: '', autoApplied: true, payload: { runbookId: 'rb-restart-service' } });
  store.recordOutcome('h2', 'success');

  const resolver = new AutoResolver(
    {
      incidentManager: fakeIm() as any,
      decisionStore: store,
      knowledgeStore: { search: () => [KB_HIT] },
      runbookEngine: { listTemplates: () => [RB_HIT], executeRun: async () => ({ id: 'run-x', status: 'running' }) },
    },
    { minConfidence: 0.8 },
  );
  const d = await resolver.evaluate(fakeIncident());
  // KB usefulCount=12 (0.45) + runbook match (~0.175) + historical=1.0 (0.20)
  // ≈ 0.825 — above the 0.8 threshold so the resolver auto-applies.
  assert.equal(d.action, 'auto_resolved');
  assert.ok(d.confidence >= 0.8);
  store.close();
});

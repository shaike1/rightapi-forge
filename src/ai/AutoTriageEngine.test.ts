import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AutoTriageEngine, type TriageSuggestion } from './AutoTriageEngine.js';
import { AiDecisionStore } from './AiDecisionStore.js';
import type { Incident } from '../persistence/SqliteStore.js';

function tmpStore(): AiDecisionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-triage-'));
  return new AiDecisionStore(path.join(dir, 'd.db'));
}

function fakeIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'INC-1', title: 'Disk full on app-01', description: '/var/log at 95%',
    severity: 'medium', status: 'open', assignedTo: null, assignedAgent: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    resolvedAt: null, source: 'agent', sourceRef: 'disk:app-01:/var/log',
    slaMinutes: 240, serverId: 'app-01', createdBy: null,
    ...overrides,
  };
}

function fakeIncidentManager() {
  const updates: any[] = [];
  return {
    updates,
    update: (id: string, patch: any) => { updates.push({ id, patch }); return null; },
    assignAgent: undefined as any,
  };
}

const FIXED_SUGGESTION: TriageSuggestion = {
  severity: 'high',
  categories: ['disk', 'service'],
  suggestedAgentId: 'agent-bob',
  suggestedAgentName: 'Bob',
  estimatedResolutionMinutes: 45,
  confidence: 0.92,
  reasoning: 'Disk usage trending up; recent change suggests log rotation regression.',
};

test('AutoTriageEngine.triage auto-applies above the threshold', async () => {
  const store = tmpStore();
  const im = fakeIncidentManager();
  const audit: any[] = [];
  const broadcast: any[] = [];
  const engine = new AutoTriageEngine(
    {
      aiFactory: {} as any,
      incidentManager: im as any,
      decisionStore: store,
      organization: { getAllAgents: () => [{ id: 'agent-bob', name: 'Bob' }] },
      auditLog: (e) => audit.push(e),
      broadcast: (m) => broadcast.push(m),
    },
    { autoApplyThreshold: 0.8, modelOverride: async () => FIXED_SUGGESTION },
  );
  const decision = await engine.triage(fakeIncident());
  assert.equal(decision.autoApplied, true);
  assert.equal(decision.severity, 'high');
  assert.equal(decision.suggestedAgentName, 'Bob');
  assert.ok(im.updates.some(u => u.patch.severity === 'high'));
  assert.equal(audit[0].action, 'triage.auto_applied');
  assert.equal(broadcast[0].type, 'triage_decision');
  assert.equal(store.list({ kind: 'triage' }).length, 1);
  store.close();
});

test('AutoTriageEngine.triage suggests below the threshold without mutating the incident', async () => {
  const store = tmpStore();
  const im = fakeIncidentManager();
  const audit: any[] = [];
  const engine = new AutoTriageEngine(
    { aiFactory: {} as any, incidentManager: im as any, decisionStore: store, auditLog: (e) => audit.push(e) },
    { autoApplyThreshold: 0.95, modelOverride: async () => FIXED_SUGGESTION },
  );
  const decision = await engine.triage(fakeIncident());
  assert.equal(decision.autoApplied, false);
  assert.equal(im.updates.length, 0);
  assert.equal(audit[0].action, 'triage.suggested');
  store.close();
});

test('AutoTriageEngine.onIncidentCreated is a no-op when disabled', async () => {
  const store = tmpStore();
  const engine = new AutoTriageEngine(
    { aiFactory: {} as any, incidentManager: {} as any, decisionStore: store },
    { enabled: false, modelOverride: async () => FIXED_SUGGESTION },
  );
  const out = await engine.onIncidentCreated(fakeIncident());
  assert.equal(out, null);
  assert.equal(store.list({}).length, 0);
  store.close();
});

test('AutoTriageEngine.coerce drops invalid categories and clamps confidence', async () => {
  const store = tmpStore();
  const engine = new AutoTriageEngine(
    { aiFactory: {} as any, incidentManager: fakeIncidentManager() as any, decisionStore: store },
    {
      modelOverride: async () => ({
        severity: 'banana' as any,
        categories: ['disk', 'martian' as any, 'cpu', 'cpu'],
        suggestedAgentId: null,
        suggestedAgentName: null,
        estimatedResolutionMinutes: -100,
        confidence: 2.5,
        reasoning: 'x',
      }),
    },
  );
  const d = await engine.triage(fakeIncident());
  // 'banana' severity isn't valid → falls back to incident.severity ('medium').
  assert.equal(d.severity, 'medium');
  // 'martian' → 'unknown', and duplicates collapse.
  assert.deepEqual([...d.categories].sort(), ['cpu', 'disk', 'unknown']);
  // Confidence clamped + MTTR floored at 1.
  assert.equal(d.confidence, 1);
  assert.equal(d.estimatedResolutionMinutes, 1);
  store.close();
});

test('AutoTriageEngine.updateConfig flips enabled + threshold at runtime', () => {
  const store = tmpStore();
  const engine = new AutoTriageEngine(
    { aiFactory: {} as any, incidentManager: {} as any, decisionStore: store },
    { enabled: true, autoApplyThreshold: 0.7 },
  );
  engine.updateConfig({ enabled: false, autoApplyThreshold: 0.95 });
  const cfg = engine.getConfig();
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.autoApplyThreshold, 0.95);
  store.close();
});

test('AutoTriageEngine resolves agent id when model returned a name', async () => {
  const store = tmpStore();
  const im = fakeIncidentManager();
  const engine = new AutoTriageEngine(
    {
      aiFactory: {} as any,
      incidentManager: im as any,
      decisionStore: store,
      organization: { getAllAgents: () => [{ id: 'agent-bob', name: 'Bob' }, { id: 'agent-alice', name: 'Alice' }] },
    },
    {
      modelOverride: async () => ({
        severity: 'medium', categories: ['service'],
        suggestedAgentId: null, suggestedAgentName: 'Bob',
        estimatedResolutionMinutes: 30, confidence: 0.9, reasoning: 'x',
      }),
    },
  );
  const d = await engine.triage(fakeIncident());
  assert.equal(d.suggestedAgentId, 'agent-bob');
  assert.equal(d.suggestedAgentName, 'Bob');
  store.close();
});

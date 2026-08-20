import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AutoRunbookGenerator, type GeneratedRunbookDraft } from './AutoRunbookGenerator.js';
import { AiDecisionStore } from './AiDecisionStore.js';

function tmpStore(): AiDecisionStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-rb-gen-'));
  return new AiDecisionStore(path.join(dir, 'd.db'));
}

const VALID_DRAFT: GeneratedRunbookDraft = {
  id: 'restart-nginx-when-down',
  name: 'Restart Nginx When Down',
  description: 'Detect, restart, and verify nginx after an outage.',
  category: 'infrastructure',
  tags: ['nginx', 'service'],
  triggerType: 'incident_match',
  triggerConfig: { sourceRefPattern: 'service:nginx:%' },
  steps: [
    { id: 'check-status', type: 'check_metric', description: 'systemctl status nginx' },
    { id: 'restart',      type: 'command',      description: 'systemctl restart nginx' },
    { id: 'verify',       type: 'check_metric', description: 'curl localhost/healthz' },
    { id: 'escalate',     type: 'escalate',     description: 'page on-call if still down' },
  ],
  enabled: true, // model returned true — the coercer must force false
  reasoning: 'Two-step fix: restart then verify, escalate on failure.',
  confidence: 0.82,
};

test('AutoRunbookGenerator.fromPrompt returns a coerced disabled draft', async () => {
  const store = tmpStore();
  const audit: any[] = [];
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store, auditLog: (e) => audit.push(e) },
    { modelOverride: async () => VALID_DRAFT },
  );
  const draft = await gen.fromPrompt({ prompt: 'when nginx goes down, restart it' });
  // Coercion: enabled forced to false; kebab id preserved; steps unchanged.
  assert.equal(draft.enabled, false);
  assert.equal(draft.id, 'restart-nginx-when-down');
  assert.equal(draft.steps.length, 4);
  // Audit entry was the preview path, not saved.
  assert.equal(audit[0].action, 'runbook-gen.previewed');
  // Decision row landed in the store.
  const rows = store.list({ kind: 'runbook-generate' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].autoApplied, false); // preview, not saved
  store.close();
});

test('AutoRunbookGenerator.fromPrompt with save=true persists the draft via saveTemplate', async () => {
  const store = tmpStore();
  const saved: any[] = [];
  const gen = new AutoRunbookGenerator(
    {
      aiFactory: {} as any,
      decisionStore: store,
      saveTemplate: (t) => { saved.push(t); return { id: t.id }; },
    },
    { modelOverride: async () => VALID_DRAFT },
  );
  const draft = await gen.fromPrompt({ prompt: 'p', save: true, actor: 'alice' });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].enabled, false, 'persisted draft must be disabled');
  // Decision row records the save as autoApplied (persisted) but the
  // template itself was still saved as disabled.
  const row = store.list({ kind: 'runbook-generate' })[0];
  assert.equal(row.autoApplied, true);
  store.close();
});

test('AutoRunbookGenerator coerces invalid step types to a notification', async () => {
  const store = tmpStore();
  const dirty: GeneratedRunbookDraft = {
    ...VALID_DRAFT,
    steps: [
      { id: 'a', type: 'command', description: 'real step' },
      { id: 'b', type: 'magic-pony' as any, description: 'invalid' },
      { id: 'c', type: 'wait', description: 'real step 2' },
    ],
  };
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store },
    { modelOverride: async () => dirty },
  );
  const draft = await gen.fromPrompt({ prompt: 'x' });
  assert.equal(draft.steps[0].type, 'command');
  assert.equal(draft.steps[1].type, 'notification');
  assert.match(draft.steps[1].description, /Skipped invalid step type/);
  assert.equal(draft.steps[2].type, 'wait');
  store.close();
});

test('AutoRunbookGenerator dedupes step ids', async () => {
  const store = tmpStore();
  const dup: GeneratedRunbookDraft = {
    ...VALID_DRAFT,
    steps: [
      { id: 'run', type: 'command', description: 's1' },
      { id: 'run', type: 'command', description: 's2' },
      { id: 'run', type: 'command', description: 's3' },
    ],
  };
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store },
    { modelOverride: async () => dup },
  );
  const draft = await gen.fromPrompt({ prompt: 'x' });
  const ids = draft.steps.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'all step ids must be unique after coercion');
  store.close();
});

test('AutoRunbookGenerator returns a placeholder step when model returned none', async () => {
  const store = tmpStore();
  const empty: GeneratedRunbookDraft = { ...VALID_DRAFT, steps: [] };
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store },
    { modelOverride: async () => empty },
  );
  const draft = await gen.fromPrompt({ prompt: 'x' });
  assert.equal(draft.steps.length, 1);
  assert.equal(draft.steps[0].type, 'notification');
  store.close();
});

test('AutoRunbookGenerator.fromResolvedIncident builds a draft from timeline notes', async () => {
  const store = tmpStore();
  let capturedPrompt = '';
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store },
    {
      modelOverride: async ({ prompt }) => {
        capturedPrompt = prompt;
        return { ...VALID_DRAFT, id: 'post-incident-draft' };
      },
    },
  );
  const draft = await gen.fromResolvedIncident({
    incident: { id: 'INC-9', title: 'Disk full', severity: 'high', sourceRef: 'disk:vps1:/', serverId: 'vps1', resolvedBy: 'alice' },
    timeline: [
      { type: 'note',     message: 'cleared /var/log/old', actor: 'alice', timestamp: 'x' },
      { type: 'resolved', message: 'fixed by truncating logs', actor: 'alice', timestamp: 'y' },
      { type: 'updated',  message: 'should be ignored',  actor: 'sys',   timestamp: 'z' },
    ],
  });
  assert.ok(draft);
  assert.match(capturedPrompt, /cleared \/var\/log\/old/);
  assert.match(capturedPrompt, /truncating logs/);
  assert.doesNotMatch(capturedPrompt, /should be ignored/);
  // Incident id is propagated into the decision row.
  const row = store.list({ kind: 'runbook-generate' })[0];
  assert.equal(row.incidentId, 'INC-9');
  store.close();
});

test('AutoRunbookGenerator throws when disabled', async () => {
  const store = tmpStore();
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store },
    { enabled: false, modelOverride: async () => VALID_DRAFT },
  );
  await assert.rejects(() => gen.fromPrompt({ prompt: 'x' }), /disabled/);
  store.close();
});

test('AutoRunbookGenerator normalises non-kebab template id', async () => {
  const store = tmpStore();
  const messy: GeneratedRunbookDraft = { ...VALID_DRAFT, id: 'My Crazy ID!!  with spaces' };
  const gen = new AutoRunbookGenerator(
    { aiFactory: {} as any, decisionStore: store },
    { modelOverride: async () => messy },
  );
  const draft = await gen.fromPrompt({ prompt: 'x' });
  assert.equal(draft.id, 'my-crazy-id-with-spaces');
  store.close();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { draftAppSpecFromMessage } from './AppSpec.js';
import { AppSpecEditor } from './AppSpecEditor.js';

test('editor uses deterministic structured edits for common changes', async () => {
  let called = false; const editor = new AppSpecEditor(async () => { called = true; return '{}'; });
  const result = await editor.edit(draftAppSpecFromMessage('Console'), 'Add a page called Incidents');
  assert.equal(result.pages[1].id, 'incidents'); assert.equal(called, false);
});

test('editor validates AI-generated specifications before accepting a revision', async () => {
  const current = draftAppSpecFromMessage('Console');
  const valid = { ...current, dataModels: [{ id: 'incident', name: 'Incident', description: '', fields: [{ id: 'title', label: 'Title', type: 'text', required: true, unique: false }] }] };
  let instructions = ''; const editor = new AppSpecEditor(async system => { instructions = system; return `\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``; });
  assert.equal((await editor.edit(current, 'Add an incident data model with a required title')).dataModels[0].id, 'incident');
  assert.match(instructions, /field: \{id, label, type, required, unique/);
  const invalid = new AppSpecEditor(async () => '{"source":"process.env.SECRET"}');
  await assert.rejects(() => invalid.edit(current, 'Make an advanced change'), /schemaVersion/);
});

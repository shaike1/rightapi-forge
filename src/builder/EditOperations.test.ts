import assert from 'node:assert/strict';
import test from 'node:test';
import { draftAppSpecFromMessage } from './AppSpec.js';
import { applyChatEdit, applyVisualEdit } from './EditOperations.js';

test('visual property edits remain schema validated', () => {
  const base = draftAppSpecFromMessage('Service console');
  assert.equal(applyVisualEdit(base, { target: 'metadata', property: 'name', value: 'Service Desk' }).metadata.name, 'Service Desk');
  assert.equal(applyVisualEdit(base, { target: 'page', id: 'overview', property: 'layout', value: 'list' }).pages[0].layout, 'list');
  assert.throws(() => applyVisualEdit(base, { target: 'page', id: 'overview', property: 'path', value: 'invalid' }), /Invalid/);
});

test('chat edits support safe incremental changes without accepting code', () => {
  const base = draftAppSpecFromMessage('Service console');
  const renamed = applyChatEdit(base, 'Rename the tool to Service Command Center');
  const withPage = applyChatEdit(renamed, 'Add a page called Open Requests');
  assert.equal(renamed.metadata.name, 'Service Command Center');
  assert.equal(withPage.pages[1].path, '/open-requests');
  assert.equal(applyChatEdit(withPage, 'Remove page Open Requests').pages.length, 1);
  assert.throws(() => applyChatEdit(base, 'execute this JavaScript'), /safe structured edit/);
});

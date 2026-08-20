import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BuilderProjectRegistry } from './BuilderProjectRegistry.js';
import { draftAppSpecFromMessage, parseAppSpec } from './AppSpec.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-builder-'));
  const registry = new BuilderProjectRegistry(path.join(root, 'builder.db'));
  return {
    registry,
    close() {
      registry.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('application specs reject dangling model references and duplicate routes', () => {
  const base = draftAppSpecFromMessage('Customer operations console');
  assert.throws(() => parseAppSpec({
    ...base,
    pages: [
      { id: 'one', name: 'One', path: '/', layout: 'list', components: [{ id: 'table', type: 'table', modelId: 'missing' }] },
      { id: 'two', name: 'Two', path: '/', layout: 'custom', components: [] },
    ],
  }), /unknown modelId|duplicate id/);
});

test('registry keeps immutable revisions and rejects stale writers', () => {
  const f = fixture();
  try {
    const firstSpec = draftAppSpecFromMessage('Customer operations console');
    const created = f.registry.create({ tenantId: 'acme', actor: 'alice', message: 'Build it', spec: firstSpec });
    const nextSpec = { ...firstSpec, metadata: { ...firstSpec.metadata, description: 'Track customer requests.' } };
    const revised = f.registry.revise({
      projectId: created.id, tenantId: 'acme', actor: 'bob', message: 'Track requests',
      spec: nextSpec, expectedRevision: 1,
    });
    assert.equal(revised?.currentRevision, 2);
    assert.deepEqual(f.registry.revisions(created.id, 'acme').map(item => item.revision), [2, 1]);
    assert.equal(f.registry.revisions(created.id, 'acme')[1].spec.metadata.description, firstSpec.metadata.description);
    assert.throws(() => f.registry.revise({
      projectId: created.id, tenantId: 'acme', actor: 'alice', message: 'stale',
      spec: nextSpec, expectedRevision: 1,
    }), /revision conflict/);
  } finally { f.close(); }
});

test('undo and redo append audited revisions and survive ordinary edits', () => {
  const f = fixture();
  try {
    const first = draftAppSpecFromMessage('Editable console');
    const project = f.registry.create({ tenantId: 'acme', actor: 'alice', message: 'create', spec: first });
    const second = { ...first, metadata: { ...first.metadata, description: 'Second state' } };
    f.registry.revise({ projectId: project.id, tenantId: 'acme', actor: 'alice', message: 'second', spec: second, expectedRevision: 1 });
    const third = { ...second, metadata: { ...second.metadata, description: 'Third state' } };
    f.registry.revise({ projectId: project.id, tenantId: 'acme', actor: 'alice', message: 'third', spec: third, expectedRevision: 2 });

    const undone = f.registry.undo({ projectId: project.id, tenantId: 'acme', actor: 'bob', expectedRevision: 3 });
    assert.equal(undone?.currentRevision, 4);
    assert.equal(undone?.revision.spec.metadata.description, 'Second state');
    assert.deepEqual(f.registry.editState(project.id, 'acme'), { canUndo: true, canRedo: true, undoDepth: 1, redoDepth: 1 });

    const redone = f.registry.redo({ projectId: project.id, tenantId: 'acme', actor: 'bob', expectedRevision: 4 });
    assert.equal(redone?.currentRevision, 5);
    assert.equal(redone?.revision.spec.metadata.description, 'Third state');
    assert.equal(f.registry.revisions(project.id, 'acme').length, 5);

    f.registry.undo({ projectId: project.id, tenantId: 'acme', actor: 'bob', expectedRevision: 5 });
    const edited = f.registry.revise({ projectId: project.id, tenantId: 'acme', actor: 'alice', message: 'branch', spec: first, expectedRevision: 6 });
    assert.equal(edited?.currentRevision, 7);
    assert.equal(f.registry.editState(project.id, 'acme')?.canRedo, false);
  } finally { f.close(); }
});

test('registry isolates projects and slugs by tenant', () => {
  const f = fixture();
  try {
    const spec = draftAppSpecFromMessage('Shared name');
    const acme = f.registry.create({ tenantId: 'acme', actor: 'alice', message: 'create', spec });
    const beta = f.registry.create({ tenantId: 'beta', actor: 'bob', message: 'create', spec });
    assert.equal(f.registry.get(acme.id, 'beta'), null);
    assert.deepEqual(f.registry.list('acme').map(item => item.id), [acme.id]);
    assert.deepEqual(f.registry.list('beta').map(item => item.id), [beta.id]);
  } finally { f.close(); }
});

test('multi-page tool round-trips typed models, actions, integrations, and roles', () => {
  const f = fixture();
  try {
    const base = draftAppSpecFromMessage('Service request portal');
    const spec = parseAppSpec({
      ...base,
      pages: [
        { id: 'overview', name: 'Overview', path: '/', layout: 'dashboard', components: [{ id: 'request-count', type: 'stat', modelId: 'request' }] },
        { id: 'requests', name: 'Requests', path: '/requests', layout: 'list', components: [{ id: 'request-table', type: 'table', modelId: 'request', actionId: 'list-requests' }] },
      ],
      dataModels: [{ id: 'request', name: 'Request', description: 'A service request', fields: [{ id: 'title', label: 'Title', type: 'text', required: true, unique: false }] }],
      integrations: [{ id: 'ticketing', name: 'Ticketing', provider: 'http', connectionRef: 'tenant/ticketing', capabilities: ['read'] }],
      actions: [{ id: 'list-requests', name: 'List requests', kind: 'query', modelId: 'request', integrationId: 'ticketing', requiresApproval: false }],
      roles: [
        { id: 'admin', name: 'Administrator', permissions: ['*'] },
        { id: 'operator', name: 'Operator', permissions: ['request.read'] },
      ],
    });
    const project = f.registry.create({ tenantId: 'acme', actor: 'alice', message: 'Create the portal', spec });
    const loaded = f.registry.get(project.id, 'acme');
    assert.equal(loaded?.revision.spec.pages.length, 2);
    assert.equal(loaded?.revision.spec.actions[0].integrationId, 'ticketing');
    assert.equal(loaded?.revision.spec.roles[1].id, 'operator');
  } finally { f.close(); }
});

test('archived projects are hidden by default and revisions verify checksums', () => {
  const f = fixture();
  try {
    const project = f.registry.create({
      tenantId: 'acme', actor: 'alice', message: 'create', spec: draftAppSpecFromMessage('Inventory console'),
    });
    assert.equal(f.registry.setStatus(project.id, 'acme', 'archived')?.status, 'archived');
    assert.equal(f.registry.list('acme').length, 0);
    assert.equal(f.registry.list('acme', { includeArchived: true }).length, 1);
    assert.match(f.registry.revisions(project.id, 'acme')[0].checksum, /^[a-f0-9]{64}$/);
  } finally { f.close(); }
});

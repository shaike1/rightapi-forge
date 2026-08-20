import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, reply, isInternalMessage } from './InternalMessageContract.js';
import { runWithTenant, SYSTEM_TENANT_ID } from '../tenancy/TenantContext.js';

test('envelope() builds a fully-populated envelope under the active tenant', () => {
  runWithTenant({ tenantId: 'acme' }, () => {
    const m = envelope(
      { sender: 'skills', recipient: 'agents.router', type: 'task.created' },
      { taskId: 't1', title: 'first' },
    );
    assert.match(m.id, /^msg-/);
    assert.equal(m.sender, 'skills');
    assert.equal(m.recipient, 'agents.router');
    assert.equal(m.type, 'task.created');
    assert.equal(m.tenantId, 'acme');
    assert.deepEqual(m.payload, { taskId: 't1', title: 'first' });
  });
});

test('envelope() outside any tenant scope falls back to the system tenant', () => {
  const m = envelope({ sender: 's', recipient: 'agents.foo', type: 'a.b' }, {});
  assert.equal(m.tenantId, SYSTEM_TENANT_ID);
});

test('envelope() rejects malformed recipient + type strings', () => {
  assert.throws(() => envelope({ sender: 's', recipient: 'no-dot', type: 'a.b' }, {}), /invalid recipient/);
  assert.throws(() => envelope({ sender: 's', recipient: 'mod.svc', type: 'no-dot' }, {}), /invalid message type/);
  assert.throws(() => envelope({ sender: 's', recipient: 'mod.svc', type: 'A.B' }, {}), /must be dotted lowercase/);
});

test('reply() inherits correlationId + sets causationId from parent', () => {
  const root = envelope({ sender: 'a', recipient: 'b.c', type: 'x.y', correlationId: 'corr-1' }, {});
  const child = reply(root, { sender: 'b', recipient: 'a.d', type: 'x.z' }, { ack: true });
  assert.equal(child.correlationId, 'corr-1');
  assert.equal(child.causationId, root.id);
});

test('reply() falls back to parent.id when parent has no correlationId', () => {
  const root = envelope({ sender: 'a', recipient: 'b.c', type: 'x.y' }, {});
  const child = reply(root, { sender: 'b', recipient: 'a.d', type: 'x.z' }, {});
  assert.equal(child.correlationId, root.id);
});

test('isInternalMessage() recognises a real envelope and rejects garbage', () => {
  const e = envelope({ sender: 's', recipient: 'mod.svc', type: 'a.b' }, { x: 1 });
  assert.equal(isInternalMessage(e), true);
  assert.equal(isInternalMessage(null), false);
  assert.equal(isInternalMessage({ id: 1 }), false);
  assert.equal(isInternalMessage('msg'), false);
});

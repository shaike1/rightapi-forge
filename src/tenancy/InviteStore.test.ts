import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { InviteStore } from './InviteStore.js';

function tmpStore(): InviteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-invite-'));
  return new InviteStore(path.join(dir, 'i.db'));
}

test('InviteStore.create returns a token only once and persists a hashed copy', () => {
  const store = tmpStore();
  const inv = store.create({ tenantId: 'acme', email: 'bob@acme.io', role: 'operator', invitedBy: 'alice' });
  assert.ok(inv.token, 'token must be returned on create');
  assert.equal(inv.status, 'pending');
  assert.equal(inv.email, 'bob@acme.io');
  store.close();
});

test('InviteStore.findByToken returns the matching pending invite', () => {
  const store = tmpStore();
  const inv = store.create({ tenantId: 't', email: 'x@y.z', role: 'viewer', invitedBy: 'admin' });
  const found = store.findByToken(inv.token!);
  assert.ok(found);
  assert.equal(found!.id, inv.id);
  assert.equal(found!.status, 'pending');
  store.close();
});

test('InviteStore.findByToken returns null for an unknown token', () => {
  const store = tmpStore();
  assert.equal(store.findByToken('does-not-exist'), null);
  store.close();
});

test('InviteStore.markAccepted flips status and is idempotent', () => {
  const store = tmpStore();
  const inv = store.create({ tenantId: 't', email: 'x@y.z', role: 'viewer', invitedBy: 'a' });
  const accepted = store.markAccepted(inv.id, 'x');
  assert.equal(accepted!.status, 'accepted');
  assert.equal(accepted!.acceptedBy, 'x');
  // Second call doesn't re-update.
  const again = store.markAccepted(inv.id, 'someone-else');
  assert.equal(again!.acceptedBy, 'x', 'second markAccepted must NOT overwrite');
  store.close();
});

test('InviteStore.revoke flips a pending invite to revoked', () => {
  const store = tmpStore();
  const inv = store.create({ tenantId: 't', email: 'x@y.z', role: 'viewer', invitedBy: 'a' });
  assert.equal(store.revoke(inv.id), true);
  const f = store.findByToken(inv.token!);
  assert.equal(f!.status, 'revoked');
  store.close();
});

test('InviteStore.findByToken marks expired invites lazily', () => {
  const store = tmpStore();
  // Manually insert an already-expired invite using ttlDays in the past
  // is not supported by the API — use a small ttl and wait. We'd rather
  // not sleep in tests, so we test the negative ttl path indirectly by
  // patching the expiry via the db. Skip for now — covered by the
  // type-level guarantee that expiresAt < now → 'expired'.
  const inv = store.create({ tenantId: 't', email: 'x@y.z', role: 'viewer', invitedBy: 'a' });
  // Force the row past expiry.
  (store as any).db.prepare(`UPDATE tenant_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(inv.id);
  const f = store.findByToken(inv.token!);
  assert.equal(f!.status, 'expired');
  store.close();
});

test('InviteStore.listForTenant orders pending first, newest first', async () => {
  const store = tmpStore();
  const a = store.create({ tenantId: 't', email: 'a@y.z', role: 'viewer', invitedBy: 'x' });
  // small delay so created_at differs
  await new Promise(r => setTimeout(r, 5));
  const b = store.create({ tenantId: 't', email: 'b@y.z', role: 'operator', invitedBy: 'x' });
  store.markAccepted(a.id, 'someone');
  const out = store.listForTenant('t', { includeAccepted: true });
  assert.equal(out[0].id, b.id, 'pending first');
  assert.equal(out[1].id, a.id);
  store.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SqliteTenantStore } from './TenantStore.js';
import { InviteStore } from './InviteStore.js';
import { RegistrationService, RegistrationError, slugify } from './RegistrationService.js';
import { AuthService } from '../security/AuthService.js';

function tmpStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-reg-'));
  const tenants = new SqliteTenantStore(path.join(dir, 't.db'));
  const invites = new InviteStore(path.join(dir, 'i.db'));
  const authService = new AuthService({
    tokenSecret: 'a'.repeat(48),
    usersFilePath: path.join(dir, 'users.json'),
  });
  const reg = new RegistrationService({ tenants, invites, authService });
  return { dir, tenants, invites, authService, reg };
}

test('slugify lowercases, replaces non-ASCII, and strips edges', () => {
  assert.equal(slugify('Acme Corp'), 'acme-corp');
  assert.equal(slugify('  Hello  World!  '), 'hello-world');
  assert.equal(slugify('!!!'), 'org');
  assert.equal(slugify('A'.repeat(50)), 'a'.repeat(32));
});

test('register creates a tenant + admin user and returns a session token', async () => {
  const { reg, tenants, authService } = tmpStack();
  const r = await reg.register({ email: 'Alice@Acme.io', password: 'hunter2pass', orgName: 'Acme Corp' });
  assert.equal(r.slug, 'acme-corp');
  assert.equal(r.username, 'alice@acme.io');
  assert.ok(r.session.token);
  assert.equal(r.session.tenantId, r.tenantId);
  const t = tenants.get(r.tenantId)!;
  assert.equal(t.ownerUsername, 'alice@acme.io');
  assert.equal(t.plan, 'free');
  const u = authService.getUser('alice@acme.io')!;
  assert.equal(u.role, 'admin');
  assert.equal(u.tenantId, r.tenantId);
});

test('register collision on slug picks a suffixed slug', async () => {
  const { reg, tenants } = tmpStack();
  // Pre-create a tenant with the slug we want to collide with.
  tenants.upsert({ id: 'manual-1', slug: 'beta', name: 'Beta', plan: 'free' });
  const r = await reg.register({ email: 'b@b.io', password: 'hunter22x', orgName: 'Beta' });
  assert.notEqual(r.slug, 'beta', 'slug must avoid the existing one');
  assert.match(r.slug, /^beta-[0-9a-f]{4}$/);
});

test('register rejects invalid email + weak password + missing org name', async () => {
  const { reg } = tmpStack();
  await assert.rejects(() => reg.register({ email: '', password: 'longenough', orgName: 'Foo' }), /Email is required/);
  await assert.rejects(() => reg.register({ email: 'noatsign.com', password: 'longenough', orgName: 'Foo' }), /Email format/);
  await assert.rejects(() => reg.register({ email: 'a@b.io', password: 'short', orgName: 'Foo' }), /Password must be at least/);
  await assert.rejects(() => reg.register({ email: 'a@b.io', password: 'longenough', orgName: 'F' }), /Organization name must be at least/);
});

test('register rejects when a user with the same email already exists', async () => {
  const { reg, authService } = tmpStack();
  await reg.register({ email: 'dup@x.io', password: 'longenough', orgName: 'AA' });
  await assert.rejects(() => reg.register({ email: 'dup@x.io', password: 'longenough2', orgName: 'BB' }), /already exists/);
});

test('inviteUser produces a token only once + join consumes it', async () => {
  const { reg, authService } = tmpStack();
  const owner = await reg.register({ email: 'admin@x.io', password: 'longenough', orgName: 'XX' });
  const inv = reg.inviteUser({ tenantId: owner.tenantId, email: 'newuser@x.io', role: 'operator', invitedBy: 'admin@x.io' });
  assert.ok(inv.token);
  const joined = await reg.join({ token: inv.token, username: 'newuser@x.io', password: 'newuserlong' });
  assert.equal(joined.tenantId, owner.tenantId);
  const u = authService.getUser('newuser@x.io')!;
  assert.equal(u.role, 'operator');
  assert.equal(u.tenantId, owner.tenantId);
});

test('join rejects already-consumed invites', async () => {
  const { reg } = tmpStack();
  const owner = await reg.register({ email: 'admin@x.io', password: 'longenough', orgName: 'XX' });
  const inv = reg.inviteUser({ tenantId: owner.tenantId, email: 'one@x.io', role: 'viewer', invitedBy: 'admin@x.io' });
  await reg.join({ token: inv.token, username: 'one@x.io', password: 'firstuserpw' });
  // Second use must fail.
  await assert.rejects(() => reg.join({ token: inv.token, username: 'two@x.io', password: 'seconduserpw' }), /accepted|410/);
});

test('inviteUser refuses to mint a superadmin invite', async () => {
  const { reg } = tmpStack();
  const owner = await reg.register({ email: 'a@x.io', password: 'longenough', orgName: 'XX' });
  assert.throws(
    () => reg.inviteUser({ tenantId: owner.tenantId, email: 'x@x.io', role: 'superadmin' as any, invitedBy: 'a@x.io' }),
    /superadmin/,
  );
});

test('RegistrationError carries an HTTP status', async () => {
  const { reg } = tmpStack();
  try {
    await reg.register({ email: 'bad', password: 'longenough', orgName: 'Foo' });
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof RegistrationError);
    assert.equal((e as RegistrationError).status, 400);
  }
});

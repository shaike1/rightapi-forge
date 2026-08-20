import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteRbacStore } from '../../persistence/RbacStore.js';
import { RbacService } from './RbacService.js';
import { permissionsForRole, ROLES } from './RbacTypes.js';

function newSvc(opts?: { fallback?: boolean; cacheTtlMs?: number }): { svc: RbacService; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-rbac-'));
  const store = new SqliteRbacStore(path.join(dir, 'rbac.db'));
  const svc = new RbacService({
    store,
    legacyFallbackToSuperAdmin: opts?.fallback,
    cacheTtlMs: opts?.cacheTtlMs ?? 100,
  });
  return { svc, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('seedBuiltins creates one row per built-in role', async () => {
  const { svc, cleanup } = newSvc();
  try {
    await svc.seedBuiltins();
    const list = await svc.listRoles();
    const ids = list.map(r => r.id).sort();
    assert.deepEqual(ids, [...ROLES].sort());
    for (const r of list) assert.equal(r.builtin, true);
  } finally { cleanup(); }
});

test('permissionsForRole collapses the hierarchy correctly', () => {
  const viewer  = permissionsForRole('viewer');
  const oper    = permissionsForRole('operator');
  const tenant  = permissionsForRole('tenant_admin');
  const sa      = permissionsForRole('super_admin');
  // Viewer is the minimum; everything below should be a subset of every higher tier.
  for (const p of viewer) {
    assert.ok(oper.has(p), `operator missing viewer perm ${p}`);
    assert.ok(tenant.has(p));
    assert.ok(sa.has(p));
  }
  // tenant_admin gains credentials.write; viewer doesn't have it.
  assert.ok(!viewer.has('credentials.write'));
  assert.ok(tenant.has('credentials.write'));
  // Only super_admin has tenants.manage.
  assert.ok(!tenant.has('tenants.manage'));
  assert.ok(sa.has('tenants.manage'));
});

test('user with no assignment falls back to super_admin when legacy fallback is on', async () => {
  const { svc, cleanup } = newSvc({ fallback: true });
  try {
    await svc.seedBuiltins();
    const r = await svc.resolve('legacy-user', 'system');
    assert.equal(r.fromFallback, true);
    assert.equal(r.effectiveRole, 'super_admin');
    assert.ok(r.permissions.has('tenants.manage'));
  } finally { cleanup(); }
});

test('user with no assignment is treated as viewer when legacy fallback is off', async () => {
  const { svc, cleanup } = newSvc({ fallback: false });
  try {
    await svc.seedBuiltins();
    const r = await svc.resolve('locked-down', 'acme');
    assert.equal(r.effectiveRole, 'viewer');
    assert.ok(!r.permissions.has('tenants.manage'));
    assert.ok(r.permissions.has('agents.read'));
  } finally { cleanup(); }
});

test('explicit assignment beats the fallback', async () => {
  const { svc, cleanup } = newSvc({ fallback: true });
  try {
    await svc.seedBuiltins();
    await svc.assign('alice', 'acme', 'operator');
    const r = await svc.resolve('alice', 'acme');
    assert.equal(r.fromFallback, false);
    assert.equal(r.effectiveRole, 'operator');
    assert.ok(r.permissions.has('workflows.execute'));
    // Operator does NOT have credentials.write.
    assert.ok(!r.permissions.has('credentials.write'));
  } finally { cleanup(); }
});

test('a user can have different roles per tenant', async () => {
  const { svc, cleanup } = newSvc();
  try {
    await svc.seedBuiltins();
    await svc.assign('bob', 'acme', 'tenant_admin');
    await svc.assign('bob', 'beta', 'viewer');
    const acme = await svc.resolve('bob', 'acme');
    const beta = await svc.resolve('bob', 'beta');
    assert.equal(acme.effectiveRole, 'tenant_admin');
    assert.equal(beta.effectiveRole, 'viewer');
    assert.ok(acme.permissions.has('credentials.write'));
    assert.ok(!beta.permissions.has('credentials.write'));
  } finally { cleanup(); }
});

test('multiple assignments for the same user+tenant: highest tier wins', async () => {
  const { svc, cleanup } = newSvc();
  try {
    await svc.seedBuiltins();
    await svc.assign('carol', 'acme', 'viewer');
    await svc.assign('carol', 'acme', 'tenant_admin');
    const r = await svc.resolve('carol', 'acme');
    assert.equal(r.effectiveRole, 'tenant_admin');
  } finally { cleanup(); }
});

test('custom role inherits a tier and adds extraPermissions', async () => {
  const { svc, cleanup } = newSvc();
  try {
    await svc.seedBuiltins();
    await svc.upsertCustomRole({
      id: 'creds_operator', name: 'Credentials Operator',
      inheritsFrom: 'operator',
      extraPermissions: ['credentials.write', 'credentials.rotate'],
    });
    await svc.assign('dave', 'acme', 'creds_operator');
    const r = await svc.resolve('dave', 'acme');
    assert.equal(r.effectiveRole, 'operator');
    assert.ok(r.permissions.has('credentials.write'));
    assert.ok(r.permissions.has('credentials.rotate'));
  } finally { cleanup(); }
});

test('cannot create a custom role using a built-in id', async () => {
  const { svc, cleanup } = newSvc();
  try {
    await svc.seedBuiltins();
    await assert.rejects(
      () => svc.upsertCustomRole({ id: 'super_admin', name: 'x', inheritsFrom: 'viewer', extraPermissions: [] }),
      /reserved/,
    );
  } finally { cleanup(); }
});

test('built-in roles cannot be deleted', async () => {
  const { svc, cleanup } = newSvc();
  try {
    await svc.seedBuiltins();
    const ok = await svc.deleteCustomRole('super_admin');
    assert.equal(ok, false);
  } finally { cleanup(); }
});

test('unassign removes the binding and resolution falls back', async () => {
  const { svc, cleanup } = newSvc({ fallback: false });
  try {
    await svc.seedBuiltins();
    await svc.assign('eve', 'acme', 'tenant_admin');
    const before = await svc.resolve('eve', 'acme');
    assert.equal(before.effectiveRole, 'tenant_admin');
    await svc.unassign('eve', 'acme', 'tenant_admin');
    const after = await svc.resolve('eve', 'acme');
    assert.equal(after.fromFallback, true);
    assert.equal(after.effectiveRole, 'viewer');
  } finally { cleanup(); }
});

test('cache is invalidated by a new assignment', async () => {
  const { svc, cleanup } = newSvc({ cacheTtlMs: 60_000 });
  try {
    await svc.seedBuiltins();
    const r1 = await svc.resolve('frank', 'acme');
    assert.equal(r1.effectiveRole, 'super_admin'); // fallback
    await svc.assign('frank', 'acme', 'viewer');
    const r2 = await svc.resolve('frank', 'acme');
    assert.equal(r2.effectiveRole, 'viewer', 'cache must be invalidated by assign()');
  } finally { cleanup(); }
});

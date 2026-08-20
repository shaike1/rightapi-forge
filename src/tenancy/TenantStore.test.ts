import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SqliteTenantStore } from './TenantStore.js';
import { SYSTEM_TENANT_ID } from './TenantContext.js';

function tempDir(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-tenantstore-'));
  return {
    dbPath: path.join(dir, 'tenants.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('opening a fresh store creates the system tenant automatically', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    const sys = store.get(SYSTEM_TENANT_ID);
    assert.ok(sys, 'system tenant should exist');
    assert.equal(sys!.status, 'active');
    store.close();
  } finally { cleanup(); }
});

test('upsert creates a new tenant and round-trips settings JSON', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    const t = store.upsert({ id: 'acme', name: 'Acme', settings: { plan: 'pro', regions: ['us', 'eu'] } });
    assert.equal(t.id, 'acme');
    assert.equal(t.name, 'Acme');
    assert.deepEqual(t.settings.regions, ['us', 'eu']);
    const reread = store.get('acme');
    assert.deepEqual(reread!.settings, { plan: 'pro', regions: ['us', 'eu'] });
    store.close();
  } finally { cleanup(); }
});

test('list returns every tenant including system in created-at order', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    store.upsert({ id: 'acme', name: 'A' });
    store.upsert({ id: 'beta', name: 'B' });
    const ids = store.list().map(t => t.id);
    assert.ok(ids.includes(SYSTEM_TENANT_ID));
    assert.ok(ids.includes('acme'));
    assert.ok(ids.includes('beta'));
    store.close();
  } finally { cleanup(); }
});

test('delete removes a tenant, but never the system tenant', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    store.upsert({ id: 'acme' });
    assert.equal(store.delete('acme'), true);
    assert.equal(store.get('acme'), null);
    // System tenant deletion is refused.
    assert.equal(store.delete(SYSTEM_TENANT_ID), false);
    assert.ok(store.get(SYSTEM_TENANT_ID));
    store.close();
  } finally { cleanup(); }
});

test('upsert preserves createdAt across updates and refreshes updatedAt', async () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    const v1 = store.upsert({ id: 'acme', name: 'Old', settings: {} });
    await new Promise(r => setTimeout(r, 20));
    const v2 = store.upsert({ id: 'acme', name: 'New', settings: {} });
    assert.equal(v1.createdAt, v2.createdAt);
    assert.notEqual(v1.updatedAt, v2.updatedAt);
    store.close();
  } finally { cleanup(); }
});

test('upsert persists the new plan + slug + ownerUsername fields and getBySlug finds them', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    const t = store.upsert({ id: 'acme', slug: 'Acme', name: 'Acme Corp', plan: 'pro', ownerUsername: 'alice' });
    assert.equal(t.slug, 'acme', 'slug must be lowercased');
    assert.equal(t.plan, 'pro');
    assert.equal(t.ownerUsername, 'alice');
    const bySlug = store.getBySlug('ACME');
    assert.equal(bySlug?.id, 'acme', 'getBySlug should be case-insensitive');
    store.close();
  } finally { cleanup(); }
});

test('system tenant gets the enterprise plan automatically (legacy data has no limits)', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    const sys = store.get(SYSTEM_TENANT_ID)!;
    assert.equal(sys.plan, 'enterprise');
    store.close();
  } finally { cleanup(); }
});

test('upsert without a slug derives it from the id, lowercased', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    const t = store.upsert({ id: 'Beta-Co', name: 'Beta' });
    assert.equal(t.slug, 'beta-co');
    store.close();
  } finally { cleanup(); }
});

test('upsert + getByCustomDomain normalises hostnames and round-trips', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    store.upsert({ id: 'acme', name: 'Acme', customDomain: '  Support.Acme.Com.  ' });
    const found = store.getByCustomDomain('support.acme.com');
    assert.equal(found?.id, 'acme');
    assert.equal(found?.customDomain, 'support.acme.com');
    // Clearing returns null.
    store.upsert({ id: 'acme', customDomain: null });
    assert.equal(store.get('acme')?.customDomain, null);
    store.close();
  } finally { cleanup(); }
});

test('custom_domain unique constraint rejects double-claims', () => {
  const { dbPath, cleanup } = tempDir();
  try {
    const store = new SqliteTenantStore(dbPath);
    store.upsert({ id: 'one', customDomain: 'shared.example.com' });
    assert.throws(
      () => store.upsert({ id: 'two', customDomain: 'shared.example.com' }),
      /UNIQUE constraint failed/,
    );
    store.close();
  } finally { cleanup(); }
});

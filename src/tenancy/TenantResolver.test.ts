import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SqliteTenantStore } from './TenantStore.js';
import { TenantResolver } from './TenantResolver.js';
import { SYSTEM_TENANT_ID } from './TenantContext.js';

function tmpStack() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-resolver-'));
  const tenants = new SqliteTenantStore(path.join(dir, 't.db'));
  // Seed two real tenants.
  tenants.upsert({ id: 't-acme', slug: 'acme', name: 'Acme', plan: 'free' });
  tenants.upsert({ id: 't-beta', slug: 'beta', name: 'Beta', plan: 'pro', customDomain: 'support.beta.io' });
  const resolver = new TenantResolver(tenants, { baseDomain: 'itops.example.com' });
  return { dir, tenants, resolver };
}

test('subdomain on the base domain resolves to the matching tenant', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({ hostname: 'acme-itops.example.com' });
  assert.equal(r.source, 'subdomain');
  assert.equal(r.tenant.slug, 'acme');
  assert.equal(r.mismatch, false);
});

test('unknown subdomain returns system + mismatch=true', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({ hostname: 'nosuch-itops.example.com' });
  assert.equal(r.tenant.id, SYSTEM_TENANT_ID);
  assert.equal(r.mismatch, true);
  assert.match(r.mismatchReason ?? '', /No tenant with slug "nosuch"/);
});

test('reserved slugs fall through to JWT resolution', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({
    hostname: 'www-itops.example.com',
    jwtTenantId: 't-acme', jwtRole: 'admin',
  });
  assert.equal(r.source, 'jwt');
  assert.equal(r.tenant.slug, 'acme');
});

test('hostnames that do not match the <slug>-<apex>.<root> pattern fall through to JWT', async () => {
  const { resolver } = tmpStack();
  // Plain subdomain of the root that's not a Beacon tenant URL.
  const r = await resolver.resolve({
    hostname: 'mail.example.com',
    jwtTenantId: 't-acme', jwtRole: 'admin',
  });
  assert.equal(r.source, 'jwt');
  assert.equal(r.tenant.slug, 'acme');
});

test('apex hostname (no subdomain) uses JWT', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({
    hostname: 'itops.example.com',
    jwtTenantId: 't-acme', jwtRole: 'admin',
  });
  assert.equal(r.source, 'jwt');
  assert.equal(r.tenant.slug, 'acme');
});

test('custom domain match beats everything else', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({ hostname: 'support.beta.io' });
  assert.equal(r.source, 'custom_domain');
  assert.equal(r.tenant.slug, 'beta');
});

test('JWT/subdomain mismatch flags 403 — superadmin bypass works', async () => {
  const { resolver } = tmpStack();
  const mismatch = await resolver.resolve({
    hostname: 'acme-itops.example.com',
    jwtTenantId: 't-beta', jwtRole: 'admin',
  });
  assert.equal(mismatch.mismatch, true);
  assert.match(mismatch.mismatchReason ?? '', /belongs to tenant "t-beta"/);

  // Superadmin can drive any subdomain.
  const bypass = await resolver.resolve({
    hostname: 'acme-itops.example.com',
    jwtTenantId: 't-beta', jwtRole: 'superadmin',
  });
  assert.equal(bypass.mismatch, false);
  assert.equal(bypass.tenant.slug, 'acme');
});

test('JWT-only path (no subdomain) works on the legacy single-tenant setup', async () => {
  const { tenants } = tmpStack();
  const resolver = new TenantResolver(tenants);  // no baseDomain
  const r = await resolver.resolve({
    hostname: 'itops.example.com',
    jwtTenantId: 't-acme', jwtRole: 'admin',
  });
  assert.equal(r.source, 'jwt');
  assert.equal(r.tenant.slug, 'acme');
});

test('X-Tenant-ID header is honoured only for admin or superadmin', async () => {
  const { resolver } = tmpStack();
  // Operator with header — header is ignored, falls through to system.
  const operator = await resolver.resolve({
    hostname: '127.0.0.1',
    headerTenantId: 't-acme', jwtRole: 'operator',
  });
  assert.equal(operator.tenant.id, SYSTEM_TENANT_ID);
  // Admin with header — accepted.
  const admin = await resolver.resolve({
    hostname: '127.0.0.1',
    headerTenantId: 't-acme', jwtRole: 'admin',
  });
  assert.equal(admin.source, 'header');
  assert.equal(admin.tenant.slug, 'acme');
});

test('extractSubdomainSlug returns null for unrelated hostnames', () => {
  const { resolver } = tmpStack();
  assert.equal(resolver.extractSubdomainSlug('example.com'), null);
  assert.equal(resolver.extractSubdomainSlug('itops.example.com'), null);          // apex — system tenant
  assert.equal(resolver.extractSubdomainSlug('www-itops.example.com'), null);      // reserved slug
  assert.equal(resolver.extractSubdomainSlug('Acme-itops.example.com'), 'acme');
  assert.equal(resolver.extractSubdomainSlug('a.b-itops.example.com'), null);      // multi-label prefix
  assert.equal(resolver.extractSubdomainSlug('mail.example.com'), null);           // wrong suffix
  assert.equal(resolver.extractSubdomainSlug('acme.itops.example.com'), null);     // old nested pattern
});

test('hostname with port is normalised', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({ hostname: 'acme-itops.example.com:443' });
  assert.equal(r.source, 'subdomain');
  assert.equal(r.tenant.slug, 'acme');
});

test('falls back to system tenant when nothing resolves', async () => {
  const { resolver } = tmpStack();
  const r = await resolver.resolve({ hostname: '127.0.0.1' });
  assert.equal(r.tenant.id, SYSTEM_TENANT_ID);
  assert.equal(r.source, 'system');
  assert.equal(r.mismatch, false);
});

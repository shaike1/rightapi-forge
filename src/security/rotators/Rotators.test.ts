import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { GenericApiKeyRotator } from './GenericApiKeyRotator.js';
import { CertificateRotator, type CertificateBundle } from './CertificateRotator.js';
import { EnvironmentVariableRotator, updateEnvFile } from './EnvironmentVariableRotator.js';
import type { CredentialRecordMeta } from '../CredentialVault.js';

const META: CredentialRecordMeta = {
  id: 'cred-1', agentId: 'agent-1', name: 'svc-key', scope: 'use',
  tenantId: 'system', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  kind: 'api-key',
};

// ─── GenericApiKeyRotator ─────────────────────────────────────────────────

test('GenericApiKeyRotator: posts to endpoint, parses default secret/expiry fields', async () => {
  const calls: Array<{ url: string; method: string; auth?: string; body: any }> = [];
  const fetchImpl: any = async (url: string, init: any) => {
    calls.push({
      url, method: init?.method ?? 'GET',
      auth: init?.headers?.authorization,
      body: JSON.parse(init?.body ?? 'null'),
    });
    return new Response(JSON.stringify({ access_token: 'sk_new_abc', expires_at: '2027-01-01T00:00:00Z' }), { status: 200 });
  };
  const r = new GenericApiKeyRotator({
    endpoint: 'https://idp.example/rotate',
    bearerToken: 'admin-tok',
    fetchImpl,
  });
  const out = await r.rotate(META, 'sk_old');
  assert.equal(out.secret, 'sk_new_abc');
  assert.equal(out.expiresAt, '2027-01-01T00:00:00Z');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://idp.example/rotate');
  assert.equal(calls[0].auth, 'Bearer admin-tok');
  assert.deepEqual(calls[0].body, { id: 'cred-1', name: 'svc-key', agentId: 'agent-1' });
});

test('GenericApiKeyRotator: custom extractors override defaults', async () => {
  const fetchImpl: any = async () =>
    new Response(JSON.stringify({ data: { token: { value: 't_xyz', valid_until: '2099-01-01' } } }), { status: 200 });
  const r = new GenericApiKeyRotator({
    endpoint: 'https://idp.example/rotate',
    fetchImpl,
    extractSecret: (b: any) => b.data.token.value,
    extractExpiry: (b: any) => b.data.token.valid_until,
  });
  const out = await r.rotate(META, null);
  assert.equal(out.secret, 't_xyz');
  assert.equal(out.expiresAt, '2099-01-01');
});

test('GenericApiKeyRotator: non-2xx response throws', async () => {
  const fetchImpl: any = async () => new Response('forbidden', { status: 403 });
  const r = new GenericApiKeyRotator({ endpoint: 'https://idp.example', fetchImpl });
  await assert.rejects(() => r.rotate(META, null), /returned 403/);
});

test('GenericApiKeyRotator: empty secret in response throws (defence in depth)', async () => {
  const fetchImpl: any = async () => new Response(JSON.stringify({ access_token: '' }), { status: 200 });
  const r = new GenericApiKeyRotator({ endpoint: 'https://idp.example', fetchImpl });
  await assert.rejects(() => r.rotate(META, null), /usable secret|missing secret/);
});

// ─── CertificateRotator ──────────────────────────────────────────────────

const opensslAvailable = (() => {
  try {
    const r = spawnSync('openssl', ['version'], { stdio: 'pipe' });
    return r.status === 0;
  } catch { return false; }
})();

test('CertificateRotator: self-signed mode produces a parseable PEM bundle', { skip: !opensslAvailable }, async () => {
  const r = new CertificateRotator({
    mode: 'self-signed',
    commonName: 'rotator-test.local',
    subjectAltNames: ['DNS:rotator-test.local'],
    validDays: 30,
    rsaBits: 2048,
  });
  const out = await r.rotate({ ...META, kind: 'cert' }, null);
  const bundle = JSON.parse(out.secret) as CertificateBundle;
  assert.equal(bundle.mode, 'self-signed');
  assert.match(bundle.certPem, /-----BEGIN CERTIFICATE-----/);
  assert.match(bundle.keyPem,  /-----BEGIN (RSA )?PRIVATE KEY-----/);
  assert.ok(out.expiresAt && new Date(out.expiresAt).getTime() > Date.now());
});

test('CertificateRotator: csr mode invokes the operator-supplied signer', { skip: !opensslAvailable }, async () => {
  let receivedCsr = '';
  const r = new CertificateRotator({
    mode: 'csr',
    commonName: 'svc.local',
    validDays: 90,
    signCsr: async (csrPem) => {
      receivedCsr = csrPem;
      return { certPem: '-----BEGIN CERTIFICATE-----\nFAKE-SIGNED\n-----END CERTIFICATE-----' };
    },
  });
  const out = await r.rotate({ ...META, kind: 'cert' }, null);
  assert.match(receivedCsr, /-----BEGIN CERTIFICATE REQUEST-----/);
  const bundle = JSON.parse(out.secret) as CertificateBundle;
  assert.equal(bundle.mode, 'csr');
  assert.match(bundle.certPem, /FAKE-SIGNED/);
});

test('CertificateRotator: csr mode without signCsr throws on construction', () => {
  assert.throws(
    () => new CertificateRotator({ mode: 'csr', commonName: 'x' }),
    /signCsr callback/,
  );
});

test('CertificateRotator: missing commonName throws', () => {
  assert.throws(
    () => new CertificateRotator({ mode: 'self-signed', commonName: '' }),
    /commonName is required/,
  );
});

// ─── EnvironmentVariableRotator ──────────────────────────────────────────

test('updateEnvFile replaces existing keys + appends missing ones, preserves comments', () => {
  const before = [
    '# my comment',
    'OTHER_KEY=keep-me',
    'DB_PASS=old-secret',
    '',
    'TRAILING=ok',
  ].join('\n');
  const out = updateEnvFile(before, ['DB_PASS', 'NEW_KEY'], 'fresh-value-123');
  // DB_PASS replaced, NEW_KEY appended.
  assert.match(out, /DB_PASS=fresh-value-123/);
  assert.match(out, /NEW_KEY=fresh-value-123/);
  // Untouched lines kept.
  assert.match(out, /^# my comment$/m);
  assert.match(out, /^OTHER_KEY=keep-me$/m);
  assert.match(out, /^TRAILING=ok$/m);
});

test('updateEnvFile shell-escapes values with whitespace or special chars', () => {
  const out = updateEnvFile('K=old\n', ['K'], 'has spaces and "quotes"');
  // The value is wrapped in double quotes; embedded quotes are escaped.
  assert.match(out, /^K="has spaces and \\"quotes\\""$/m);
});

test('EnvironmentVariableRotator rewrites the matching key + emits onWritten hook', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-envrot-'));
  try {
    const filePath = path.join(dir, '.env');
    fs.writeFileSync(filePath, 'EXISTING=old\nDB_PASS=hunter2\n', 'utf8');
    let hooked: { keys: string[]; credId: string } | null = null;
    const r = new EnvironmentVariableRotator({
      filePath,
      mapping: { DB_PASS: cred => cred.name === 'svc-key' },
      generator: () => 'rotated-value-1',
      onWritten: (keys, cred) => { hooked = { keys, credId: cred.id }; },
    });
    const out = await r.rotate(META, 'hunter2');
    assert.equal(out.secret, 'rotated-value-1');
    const text = fs.readFileSync(filePath, 'utf8');
    assert.match(text, /DB_PASS=rotated-value-1/);
    assert.match(text, /EXISTING=old/, 'untouched lines must survive');
    assert.deepEqual(hooked, { keys: ['DB_PASS'], credId: 'cred-1' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* race */ }
  }
});

test('EnvironmentVariableRotator throws when no mapping predicate matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-envrot-nomatch-'));
  try {
    const filePath = path.join(dir, '.env');
    const r = new EnvironmentVariableRotator({
      filePath,
      mapping: { OTHER_KEY: cred => cred.name === 'something-else' },
    });
    await assert.rejects(() => r.rotate(META, null), /no env key in mapping matched/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* race */ }
  }
});

test('EnvironmentVariableRotator: failing onWritten does not fail the rotation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-envrot-hook-fail-'));
  try {
    const filePath = path.join(dir, '.env');
    const r = new EnvironmentVariableRotator({
      filePath,
      mapping: { DB_PASS: () => true },
      generator: () => 'ok-secret',
      onWritten: () => { throw new Error('reload signal failed'); },
    });
    const out = await r.rotate(META, null);
    assert.equal(out.secret, 'ok-secret', 'rotation succeeds even if hook throws');
    const text = fs.readFileSync(filePath, 'utf8');
    assert.match(text, /DB_PASS=ok-secret/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* race */ }
  }
});

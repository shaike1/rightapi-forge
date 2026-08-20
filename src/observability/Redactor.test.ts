import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, looksLikeCredential } from './Redactor.js';

test('redact strips top-level sensitive keys', () => {
  const out = redact({ user: 'alice', password: 'hunter2', apiKey: 'k123' });
  assert.equal(out.user, 'alice');
  assert.match(String(out.password), /REDACTED/);
  assert.match(String(out.apiKey), /REDACTED/);
});

test('redact recurses into nested objects', () => {
  const out = redact({ a: { b: { token: 'abc', plain: 'ok' } } }) as any;
  assert.equal(out.a.b.plain, 'ok');
  assert.match(String(out.a.b.token), /REDACTED/);
});

test('redact handles arrays of objects', () => {
  const out = redact({ items: [{ secret: 's1' }, { secret: 's2' }] }) as any;
  assert.match(String(out.items[0].secret), /REDACTED/);
  assert.match(String(out.items[1].secret), /REDACTED/);
});

test('redact preserves the input object reference when nothing changes', () => {
  const input = { a: 1, b: 'short string' };
  const out = redact(input);
  assert.strictEqual(out, input);
});

test('looksLikeCredential catches JWT/sk-/sk-ant- shapes', () => {
  assert.equal(looksLikeCredential('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc'), true);
  assert.equal(looksLikeCredential('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ12345'), true);
  assert.equal(looksLikeCredential('sk-ant-ABCDEFGHIJKLMNOPQRSTUVWX'), true);
  assert.equal(looksLikeCredential('user-001'), false);
  assert.equal(looksLikeCredential('hello world'), false);
});

test('redact catches credential-shaped strings even with a benign key', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
  const out = redact({ note: jwt }) as any;
  assert.match(String(out.note), /REDACTED/);
});

test('redact truncates very long strings without redacting them', () => {
  const big = 'x'.repeat(5000);
  const out = redact({ chunk: big }) as any;
  assert.ok(String(out.chunk).length < big.length);
  assert.match(String(out.chunk), /\+\d+/);
});

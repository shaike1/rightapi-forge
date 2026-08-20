import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginConfigEncryption } from './PluginConfigEncryption.js';

test('round-trip preserves the original object', () => {
  const enc = new PluginConfigEncryption('test-secret');
  const original = { apiKey: 'pd-abc123', serviceId: 'P12345', extras: { tags: ['prod'] }, count: 7 };
  const envelope = enc.encrypt(original);
  assert.notEqual(envelope, JSON.stringify(original), 'envelope must not equal plaintext JSON');
  const decoded = enc.decrypt<typeof original>(envelope);
  assert.deepEqual(decoded, original);
});

test('two encryptions of the same value produce different ciphertexts (IV randomisation)', () => {
  const enc = new PluginConfigEncryption('k');
  const a = enc.encrypt({ x: 1 });
  const b = enc.encrypt({ x: 1 });
  assert.notEqual(a, b, 'encryptions must not be deterministic');
});

test('decrypt with a different key throws (auth tag mismatch)', () => {
  const a = new PluginConfigEncryption('secret-a');
  const b = new PluginConfigEncryption('secret-b');
  const env = a.encrypt({ token: 'sensitive' });
  assert.throws(() => b.decrypt(env));
});

test('decrypt rejects malformed JSON and bad envelope shape', () => {
  const enc = new PluginConfigEncryption('k');
  assert.throws(() => enc.decrypt('not-json'), /not valid JSON/);
  assert.throws(() => enc.decrypt(JSON.stringify({ v: 2, ciphertext: '', iv: '', tag: '' })), /malformed/);
  assert.throws(() => enc.decrypt(JSON.stringify({ ciphertext: 'x', iv: 'y' })), /malformed/);
});

test('isEnvelope recognises valid envelopes and rejects plaintext', () => {
  const enc = new PluginConfigEncryption('k');
  const env = enc.encrypt({ a: 1 });
  assert.equal(PluginConfigEncryption.isEnvelope(env), true);
  assert.equal(PluginConfigEncryption.isEnvelope('{"plain":"json"}'), false);
  assert.equal(PluginConfigEncryption.isEnvelope(''), false);
  assert.equal(PluginConfigEncryption.isEnvelope(null), false);
});

test('fromEnv prefers PLUGIN_ENCRYPTION_KEY, falls back to JWT_SECRET', () => {
  const e1 = PluginConfigEncryption.fromEnv({ PLUGIN_ENCRYPTION_KEY: 'a', JWT_SECRET: 'b' });
  const e2 = new PluginConfigEncryption('a');
  // Indirect check: a value encrypted by e2 must round-trip through e1.
  const env = e2.encrypt({ x: 'hello' });
  assert.deepEqual(e1.decrypt(env), { x: 'hello' });
});

test('fromEnv falls back to JWT_SECRET when PLUGIN_ENCRYPTION_KEY is unset', () => {
  const e1 = PluginConfigEncryption.fromEnv({ JWT_SECRET: 'fallback-key' });
  const e2 = new PluginConfigEncryption('fallback-key');
  const env = e2.encrypt({ x: 'y' });
  assert.deepEqual(e1.decrypt(env), { x: 'y' });
});

test('fromEnv throws when no secret is available', () => {
  assert.throws(() => PluginConfigEncryption.fromEnv({}), /no encryption key found/);
});

test('throws on construction with empty secret', () => {
  assert.throws(() => new PluginConfigEncryption(''), /non-empty secret/);
});

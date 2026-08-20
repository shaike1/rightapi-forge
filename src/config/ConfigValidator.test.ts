import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, validateAtStartup, DEFAULT_RULES, type EnvRule } from './ConfigValidator.js';

const goodEnv = {
  ADMIN_PASSWORD: 'secret-admin',
  AUTH_TOKEN_SECRET: 'secret-auth',
  CREDENTIAL_MASTER_KEY: 'secret-master',
  ANTHROPIC_API_KEY: 'sk-anthropic',
};

test('validate ok=true when all required vars are set', () => {
  const r = validate(goodEnv);
  assert.equal(r.ok, true);
  // Defaults are applied for everything optional ⇒ defaultsApplied has many entries.
  assert.ok(r.defaultsApplied.length > 5);
});

test('validate flags missing required vars as errors', () => {
  const r = validate({ ANTHROPIC_API_KEY: 'k' }); // no required vars
  assert.equal(r.ok, false);
  const errors = r.issues.filter(i => i.level === 'error');
  const fields = errors.map(e => e.field).sort();
  assert.deepEqual(fields, ['ADMIN_PASSWORD', 'AUTH_TOKEN_SECRET', 'CREDENTIAL_MASTER_KEY']);
});

test('validate warns when neither AI key is set', () => {
  const r = validate({
    ADMIN_PASSWORD: 'a', AUTH_TOKEN_SECRET: 'b', CREDENTIAL_MASTER_KEY: 'c'
  });
  assert.equal(r.ok, true); // missing AI keys is a warn, not an error
  const aiWarn = r.issues.find(i => i.field.includes('ANTHROPIC') && i.level === 'warn');
  assert.ok(aiWarn);
  assert.match(aiWarn!.message, /agents will not be able to think/);
});

test('validate accepts either AI key', () => {
  const r = validate({ ...goodEnv, ANTHROPIC_API_KEY: '' as any, OPENAI_API_KEY: 'k' });
  const aiWarn = r.issues.find(i => i.field.includes('ANTHROPIC') && i.level === 'warn');
  assert.equal(aiWarn, undefined);
});

test('validate flags malformed numerics as errors', () => {
  const r = validate({ ...goodEnv, INCIDENT_SLA_CRITICAL_MIN: 'abc' });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'INCIDENT_SLA_CRITICAL_MIN');
  assert.ok(e);
  assert.equal(e!.level, 'error');
  assert.match(e!.message, /not a valid number/);
});

test('validate flags numerics outside their bounds', () => {
  const r = validate({ ...goodEnv, PORT: '0' });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'PORT');
  assert.ok(e);
  assert.match(e!.message, /below minimum/);
});

test('validate accepts numeric within bounds', () => {
  const r = validate({ ...goodEnv, PORT: '8080' });
  assert.equal(r.ok, true);
});

test('validate warns on unrecognised boolean strings', () => {
  const r = validate({ ...goodEnv, OTEL_ENABLED: 'maybe' });
  // Bool issues are warn-level, so ok stays true.
  assert.equal(r.ok, true);
  const w = r.issues.find(i => i.field === 'OTEL_ENABLED');
  assert.ok(w);
  assert.equal(w!.level, 'warn');
});

test('validate handles empty string the same as missing', () => {
  const r = validate({ ADMIN_PASSWORD: '', AUTH_TOKEN_SECRET: 'x', CREDENTIAL_MASTER_KEY: 'y', ANTHROPIC_API_KEY: 'k' });
  const e = r.issues.find(i => i.field === 'ADMIN_PASSWORD');
  assert.ok(e);
  assert.equal(e!.level, 'error');
});

test('validate respects custom rule sets', () => {
  const rules: EnvRule[] = [{ name: 'CUSTOM', required: true }];
  const r = validate({}, rules);
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].field, 'CUSTOM');
});

test('validateAtStartup with exitOnError:false returns the result instead of exiting', () => {
  // Capture stderr noise from the printed error block.
  const original = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  (process.stderr as any).write = (chunk: any) => { captured.push(chunk.toString()); return true; };

  try {
    const r = validateAtStartup({
      env: { ANTHROPIC_API_KEY: 'k' } as any,
      rules: [{ name: 'X', required: true }],
      exitOnError: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.issues[0].field, 'X');
    // The error block should have been written to stderr.
    assert.match(captured.join(''), /configuration errors/i);
  } finally {
    (process.stderr as any).write = original;
  }
});

test('DEFAULT_RULES is non-empty and contains the documented required vars', () => {
  const requiredFields = DEFAULT_RULES.filter(r => r.required).map(r => r.name).sort();
  assert.deepEqual(requiredFields, ['ADMIN_PASSWORD', 'AUTH_TOKEN_SECRET', 'CREDENTIAL_MASTER_KEY']);
});

test('DB_PROVIDER=postgres requires POSTGRES_URL', () => {
  const r = validate({ ...goodEnv, DB_PROVIDER: 'postgres' });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'POSTGRES_URL');
  assert.ok(e);
  assert.match(e!.message, /required when DB_PROVIDER=postgres/);
});

test('DB_PROVIDER=postgres + valid POSTGRES_URL passes', () => {
  const r = validate({
    ...goodEnv, DB_PROVIDER: 'postgres',
    POSTGRES_URL: 'postgresql://beacon:secret@db:5432/beacon',
  });
  assert.equal(r.ok, true);
});

test('DB_PROVIDER=postgres rejects malformed URL scheme', () => {
  const r = validate({
    ...goodEnv, DB_PROVIDER: 'postgres', POSTGRES_URL: 'mysql://localhost:3306/x',
  });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'POSTGRES_URL');
  assert.ok(e);
  assert.match(e!.message, /postgres:\/\//);
});

test('DB_PROVIDER rejects unknown values', () => {
  const r = validate({ ...goodEnv, DB_PROVIDER: 'mongodb' });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'DB_PROVIDER');
  assert.ok(e);
});

test('DB_PROVIDER=sqlite (default) ignores POSTGRES_URL', () => {
  const r = validate(goodEnv);
  assert.equal(r.ok, true);
  assert.equal(r.issues.find(i => i.field === 'POSTGRES_URL'), undefined);
});

test('MESSAGE_BUS=redis without REDIS_URL is a warn, not an error (factory falls back)', () => {
  const r = validate({ ...goodEnv, MESSAGE_BUS: 'redis' });
  assert.equal(r.ok, true);
  const w = r.issues.find(i => i.field === 'REDIS_URL');
  assert.ok(w);
  assert.equal(w!.level, 'warn');
});

test('MESSAGE_BUS=redis + valid REDIS_URL passes', () => {
  const r = validate({ ...goodEnv, MESSAGE_BUS: 'redis', REDIS_URL: 'redis://localhost:6379' });
  assert.equal(r.ok, true);
  assert.equal(r.issues.find(i => i.field === 'REDIS_URL'), undefined);
});

test('MESSAGE_BUS=redis with malformed scheme is fatal', () => {
  const r = validate({ ...goodEnv, MESSAGE_BUS: 'redis', REDIS_URL: 'http://localhost:6379' });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'REDIS_URL');
  assert.ok(e);
  assert.equal(e!.level, 'error');
});

test('MESSAGE_BUS rejects unknown values', () => {
  const r = validate({ ...goodEnv, MESSAGE_BUS: 'kafka' });
  assert.equal(r.ok, false);
  const e = r.issues.find(i => i.field === 'MESSAGE_BUS');
  assert.ok(e);
});

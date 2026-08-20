import test from 'node:test';
import assert from 'node:assert/strict';
import { ok, fail, encode, runResult } from './SkillResult.js';

test('ok() builds a successful result', () => {
  const r = ok({ count: 3 }, '3 items');
  assert.equal(r.ok, true);
  assert.equal(r.summary, '3 items');
  assert.deepEqual(r.data, { count: 3 });
});

test('fail() builds a failure result; summary defaults to error', () => {
  const r = fail('not found');
  assert.equal(r.ok, false);
  assert.equal(r.summary, 'not found');
  assert.equal(r.error, 'not found');
});

test('encode() returns JSON.stringify of the result', () => {
  const j = encode(ok({ a: 1 }, 'one'));
  const parsed = JSON.parse(j);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, 'one');
  assert.deepEqual(parsed.data, { a: 1 });
});

test('runResult() wraps successful work', async () => {
  const out = await runResult(async () => ({ data: { v: 42 }, summary: 'computed' }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, 'computed');
  assert.deepEqual(parsed.data, { v: 42 });
});

test('runResult() captures thrown errors as fail()', async () => {
  const out = await runResult(async () => { throw new Error('boom'); }, 'op-failed');
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary, 'op-failed');
  assert.equal(parsed.error, 'boom');
});

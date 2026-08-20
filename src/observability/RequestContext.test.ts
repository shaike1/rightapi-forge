import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newRequestId,
  runWithRequest,
  getCurrentRequest,
  getCurrentRequestId,
  setCurrentUserId,
  requestLogFields,
} from './RequestContext.js';

test('newRequestId returns a non-empty string', () => {
  const id = newRequestId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length >= 16);
});

test('runWithRequest makes context visible inside the callback', () => {
  runWithRequest({ requestId: 'req-123' }, () => {
    assert.equal(getCurrentRequestId(), 'req-123');
    assert.deepEqual(requestLogFields(), { requestId: 'req-123' });
  });
});

test('runWithRequest does NOT leak context outside the callback', () => {
  runWithRequest({ requestId: 'req-X' }, () => { /* */ });
  assert.equal(getCurrentRequest(), undefined);
});

test('setCurrentUserId back-fills the active context', () => {
  runWithRequest({ requestId: 'req-X' }, () => {
    setCurrentUserId('alice');
    assert.equal(getCurrentRequest()?.userId, 'alice');
    assert.deepEqual(requestLogFields(), { requestId: 'req-X', userId: 'alice' });
  });
});

test('setCurrentUserId is a no-op outside any scope', () => {
  // Must not throw.
  setCurrentUserId('orphan');
  assert.equal(getCurrentRequest(), undefined);
});

test('requestLogFields returns an empty object outside any scope', () => {
  assert.deepEqual(requestLogFields(), {});
});

test('nested runWithRequest scopes preserve LIFO order', async () => {
  await runWithRequest({ requestId: 'outer' }, async () => {
    assert.equal(getCurrentRequestId(), 'outer');
    await runWithRequest({ requestId: 'inner' }, async () => {
      assert.equal(getCurrentRequestId(), 'inner');
    });
    assert.equal(getCurrentRequestId(), 'outer');
  });
});

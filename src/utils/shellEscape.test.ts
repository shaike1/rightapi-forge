import test from 'node:test';
import assert from 'node:assert/strict';
import { shellEscape, shellJoin, assertSafeIdentifier } from './shellEscape.js';

test('shellEscape wraps simple values in single quotes', () => {
  assert.equal(shellEscape('simple'), "'simple'");
  assert.equal(shellEscape(42), "'42'");
  assert.equal(shellEscape(true), "'true'");
});

test('shellEscape returns empty single quotes for empty / nullish', () => {
  assert.equal(shellEscape(''), "''");
  assert.equal(shellEscape(undefined), "''");
  assert.equal(shellEscape(null), "''");
});

test('shellEscape neutralises shell metacharacters', () => {
  // The escaped result, when fed back through sh, must reproduce the literal
  // string. We verify by confirming the well-known `'\''` join pattern is used.
  assert.equal(shellEscape("don't"), `'don'\\''t'`);
  assert.equal(shellEscape('$(rm -rf /)'), `'$(rm -rf /)'`);
  assert.equal(shellEscape('a; b && c | d > /tmp/x'), `'a; b && c | d > /tmp/x'`);
  assert.equal(shellEscape('back`tick'), `'back\`tick'`);
});

test('shellJoin escapes each arg and space-joins', () => {
  assert.equal(shellJoin(['ls', '-la', '/tmp/with space']), `'ls' '-la' '/tmp/with space'`);
});

test('assertSafeIdentifier accepts safe values, rejects unsafe', () => {
  assert.equal(assertSafeIdentifier('container_1', 'name'), 'container_1');
  assert.equal(assertSafeIdentifier('docker.io/foo:bar', 'image'), 'docker.io/foo:bar');
  assert.throws(() => assertSafeIdentifier('a; rm -rf /', 'name'));
  assert.throws(() => assertSafeIdentifier('', 'name'));
  assert.throws(() => assertSafeIdentifier('a b', 'name'));
});

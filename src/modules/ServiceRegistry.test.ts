import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceRegistry } from './ServiceRegistry.js';

test('register + resolve round-trips a service instance', () => {
  const reg = new ServiceRegistry();
  const obj = { greet: () => 'hello' };
  reg.register({ token: 'agents.greeter', moduleId: 'agents', instance: obj, description: 'fake' });
  const got = reg.resolve<typeof obj>('agents.greeter');
  assert.equal(got.greet(), 'hello');
});

test('resolve throws clearly when token is unknown', () => {
  const reg = new ServiceRegistry();
  assert.throws(() => reg.resolve('agents.missing'), /not registered/);
});

test('tryResolve returns undefined instead of throwing', () => {
  const reg = new ServiceRegistry();
  assert.equal(reg.tryResolve('agents.missing'), undefined);
});

test('register rejects malformed tokens', () => {
  const reg = new ServiceRegistry();
  assert.throws(() => reg.register({ token: 'bad token', moduleId: 'x', instance: {} }), /invalid service token/);
  assert.throws(() => reg.register({ token: 'noModule', moduleId: 'x', instance: {} }), /invalid service token/);
});

test('register rejects when token namespace does not match moduleId', () => {
  const reg = new ServiceRegistry();
  assert.throws(
    () => reg.register({ token: 'agents.greeter', moduleId: 'skills', instance: {} }),
    /does not match moduleId/,
  );
});

test('list() returns descriptors with the instance redacted', () => {
  const reg = new ServiceRegistry();
  reg.register({ token: 'agents.a', moduleId: 'agents', instance: { secret: 'kept' } });
  reg.register({ token: 'skills.b', moduleId: 'skills', instance: { secret: 'kept' }, description: 'desc' });
  const list = reg.list();
  assert.equal(list.length, 2);
  for (const d of list) {
    assert.ok(!('instance' in d), 'instance must not appear in list output');
  }
});

test('reset() clears every registration', () => {
  const reg = new ServiceRegistry();
  reg.register({ token: 'agents.a', moduleId: 'agents', instance: {} });
  reg.reset();
  assert.equal(reg.has('agents.a'), false);
});

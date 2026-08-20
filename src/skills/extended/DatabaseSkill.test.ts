import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSkill } from './DatabaseSkill.js';

function parse(raw: string): any {
  return JSON.parse(raw);
}

function remoteSkill(capture?: { cmd?: string }) {
  const server = { id: 'db1', name: 'db1' } as any;
  return new DatabaseSkill({
    servers: { get: () => server },
    executor: {
      execute: async (_target, cmd) => {
        if (capture) capture.cmd = cmd;
        return { stdout: '123|00:07:00|active|select 1', stderr: '', exitCode: 0 };
      },
    },
  });
}

test('DatabaseSkill.pgLongRunningQueries builds the pg_stat_activity query and honours minMinutes', async () => {
  const capture: { cmd?: string } = {};
  const skill = remoteSkill(capture);

  const r = parse(await skill.pgLongRunningQueries({ serverId: 'db1', minMinutes: 10 }));
  assert.equal(r.ok, true);
  assert.match(capture.cmd || '', /interval.*10 minutes/);
  assert.match(capture.cmd || '', /pg_stat_activity/);
});

test('DatabaseSkill.pgLongRunningQueries defaults minMinutes to 5', async () => {
  const capture: { cmd?: string } = {};
  const skill = remoteSkill(capture);

  await skill.pgLongRunningQueries({ serverId: 'db1' });
  assert.match(capture.cmd || '', /interval.*5 minutes/);
});

test('DatabaseSkill.pgTerminateQuery requires a pid', async () => {
  const skill = remoteSkill();
  const r = parse(await skill.pgTerminateQuery({ serverId: 'db1' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /Missing pid/);
});

test('DatabaseSkill.pgTerminateQuery calls pg_terminate_backend with the pid', async () => {
  const capture: { cmd?: string } = {};
  const skill = remoteSkill(capture);

  const r = parse(await skill.pgTerminateQuery({ serverId: 'db1', pid: 4242 }));
  assert.equal(r.ok, true);
  assert.match(capture.cmd || '', /pg_terminate_backend\(4242\)/);
});

test('DatabaseSkill validates safe identifiers for host/user/database', async () => {
  const skill = remoteSkill();
  const r = parse(await skill.pgLongRunningQueries({ serverId: 'db1', database: 'x; rm -rf /' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /database contains unsafe characters/);
});

test('DatabaseSkill fails closed for unconfigured remote execution', async () => {
  const skill = new DatabaseSkill();
  const r = parse(await skill.pgLongRunningQueries({ serverId: 'db1' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /unconfigured/);
});

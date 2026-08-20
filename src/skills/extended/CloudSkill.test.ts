import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSkill } from './CloudSkill.js';

function parse(raw: string): any {
  return JSON.parse(raw);
}

function remoteSkill(capture?: { file?: string; args?: string[] }) {
  const server = { id: 'vps2', name: 'vps2' } as any;
  return new CloudSkill({
    servers: { get: () => server },
    executor: {
      executeFile: async (_target, file, args) => {
        if (capture) {
          capture.file = file;
          capture.args = args;
        }
        return { stdout: '{}', stderr: '', exitCode: 0 };
      },
    },
  });
}

test('CloudSkill.aws validates service and operation', async () => {
  const skill = remoteSkill();

  let r = parse(await skill.aws({ serverId: 'vps2', service: 'ec2', operation: 'describe-instances' }));
  assert.equal(r.ok, true);

  r = parse(await skill.aws({ service: 'iam', operation: 'list-users' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /service must be one of/);

  r = parse(await skill.aws({ service: 'ec2', operation: 'terminate-instances' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /operation must be a read-only/);
});

test('CloudSkill.gcp validates component, group, and operation', async () => {
  const skill = remoteSkill();

  let r = parse(await skill.gcp({ serverId: 'vps2', component: 'compute', group: 'instances', operation: 'list' }));
  assert.equal(r.ok, true);

  r = parse(await skill.gcp({ component: 'iam', group: 'service-accounts', operation: 'list' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /component must be one of/);

  r = parse(await skill.gcp({ component: 'compute', group: 'instances', operation: 'delete' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /operation must be list or describe/);
});

test('CloudSkill remote execution uses executeFile with argv form', async () => {
  const capture: { file?: string; args?: string[] } = {};
  const skill = remoteSkill(capture);

  const r = parse(await skill.aws({
    serverId: 'vps2',
    service: 'ec2',
    operation: 'describe-instances',
    args: ['--instance-ids', 'i-123'],
  }));
  assert.equal(r.ok, true);
  assert.equal(capture.file, 'aws');
  assert.deepEqual(capture.args, ['ec2', 'describe-instances', '--instance-ids', 'i-123', '--output', 'json']);
});

test('CloudSkill.aws fails closed for unconfigured remote execution', async () => {
  const skill = new CloudSkill();
  const r = parse(await skill.aws({ serverId: 'vps2', service: 'ec2', operation: 'describe-instances' }));
  assert.equal(r.ok, false);
  assert.equal(r.summary, 'aws error');
  assert.match(r.error || '', /unconfigured/);
});

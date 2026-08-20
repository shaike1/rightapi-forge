import test from 'node:test';
import assert from 'node:assert/strict';
import { KubernetesSkill } from './KubernetesSkill.js';

function parse(raw: string): any {
  return JSON.parse(raw);
}

function remoteSkill(capture?: { cmd?: string }) {
  const server = { id: 'vps2', name: 'vps2' } as any;
  return new KubernetesSkill({
    servers: { get: () => server },
    executor: {
      execute: async (_target, cmd) => {
        if (capture) {
          capture.cmd = cmd;
        }
        return { stdout: 'name\npod-1', stderr: '', exitCode: 0 };
      },
    },
  });
}

test('KubernetesSkill.getPods uses RemoteExecutor for remote execution', async () => {
  const capture: { cmd?: string } = {};
  const skill = remoteSkill(capture);

  const r = parse(await skill.getPods({ serverId: 'vps2', namespace: 'kube-system' }));
  assert.equal(r.ok, true);
  assert.equal(capture.cmd, 'kubectl get pods -n kube-system --no-headers');
});

test('KubernetesSkill.getDeployments resolves default namespace if omitted', async () => {
  const capture: { cmd?: string } = {};
  const skill = remoteSkill(capture);

  const r = parse(await skill.getDeployments({ serverId: 'vps2' }));
  assert.equal(r.ok, true);
  assert.equal(capture.cmd, 'kubectl get deployments -n default --no-headers');
});

test('KubernetesSkill.logs tail and pod name', async () => {
  const capture: { cmd?: string } = {};
  const skill = remoteSkill(capture);

  const r = parse(await skill.logs({ serverId: 'vps2', pod: 'app-5d4', tail: 100 }));
  assert.equal(r.ok, true);
  assert.equal(capture.cmd, 'kubectl logs app-5d4 -n default --tail=100');
});

test('KubernetesSkill validates safe identifiers for namespace', async () => {
  const skill = remoteSkill();
  const r = parse(await skill.getPods({ serverId: 'vps2', namespace: 'kube system; rm -rf /' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /namespace contains unsafe characters/);
});

test('KubernetesSkill fails closed for unconfigured remote execution', async () => {
  const skill = new KubernetesSkill();
  // Call via handler (which returns SkillResult JSON representation)
  const r = parse(await skill.getPods({ serverId: 'vps2' }));
  assert.equal(r.ok, false);
  assert.match(r.error || '', /unconfigured/);
});

test('KubernetesSkill.restart and rolloutStatus use RemoteExecutor with rollout commands', async () => {
  const calls: string[] = [];
  const server = { id: 'vps2', name: 'vps2' } as any;
  const skill = new KubernetesSkill({
    servers: { get: () => server },
    executor: {
      execute: async (_target, cmd) => {
        calls.push(cmd);
        return {
          stdout: cmd.includes('rollout status') ? 'deployment "api" successfully rolled out' : 'deployment.apps/api restarted',
          stderr: '',
          exitCode: 0,
        };
      },
    },
  });

  assert.equal(parse(await skill.restart({ serverId: 'vps2', namespace: 'prod', deployment: 'api' })).ok, true);
  assert.equal(parse(await skill.rolloutStatus({ serverId: 'vps2', namespace: 'prod', deployment: 'api', timeoutSeconds: 1 })).ok, true);
  assert.deepEqual(calls, [
    'kubectl rollout restart deployment/api -n prod',
    'kubectl rollout status deployment/api -n prod --timeout=15s',
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketingSink } from '../integrations/TicketingSink.js';
import { evaluateToolExecution } from '../security/ExecutionGuard.js';
import { KubernetesSkill } from '../skills/extended/KubernetesSkill.js';

function parse(raw: string): any {
  return JSON.parse(raw);
}

test('Acceptance: failed pod remediation approves deployment restart, verifies rollout, syncs ticket', async () => {
  const calls: string[] = [];
  const skill = new KubernetesSkill({
    servers: { get: () => ({ id: 'cluster-admin', name: 'cluster-admin' }) as any },
    executor: {
      execute: async (_target, cmd) => {
        calls.push(cmd);
        if (cmd.includes('get pods')) return { stdout: 'api-7d9 CrashLoopBackOff 3/4 5m', stderr: '', exitCode: 0 };
        if (cmd.includes('rollout restart')) return { stdout: 'deployment.apps/api restarted', stderr: '', exitCode: 0 };
        if (cmd.includes('rollout status')) return { stdout: 'deployment "api" successfully rolled out', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
      },
    },
  });

  const pods = parse(await skill.getPods({ serverId: 'cluster-admin', namespace: 'prod' }));
  assert.equal(pods.ok, true);
  assert.match(pods.data.output, /CrashLoopBackOff/);

  const decision = evaluateToolExecution({ command: 'k8s.restart', agentRole: 'sysadmin' });
  assert.equal(decision.outcome, 'approval_required');

  const approved = evaluateToolExecution({ command: 'k8s.restart', agentRole: 'sysadmin', approved: true });
  assert.equal(approved.outcome, 'allow');

  assert.equal(parse(await skill.restart({ serverId: 'cluster-admin', namespace: 'prod', deployment: 'api' })).ok, true);
  const rollout = parse(await skill.rolloutStatus({ serverId: 'cluster-admin', namespace: 'prod', deployment: 'api', timeoutSeconds: 1 }));
  assert.equal(rollout.ok, true);
  assert.match(rollout.data.output, /successfully rolled out/);

  let synced = false;
  const sink = new TicketingSink({
    store: {
      get: (id: string) => ({ id, status: 'resolved', jiraKey: 'OPS-1000', ticketingSynced: false }),
      getTimeline: () => [{ type: 'resolved', message: 'K8s deployment restarted and rollout verified.' }],
      markTicketingSynced: () => { synced = true; },
    } as any,
    getJiraService: () => ({
      isEnabled: () => true,
      transitionTicket: async () => {},
      addCommentToTicket: async () => {},
    }) as any,
  });

  assert.equal(await sink.syncResolvedIncident({ id: 'INC-K8S', status: 'resolved', jiraKey: 'OPS-1000' } as any), true);
  assert.equal(synced, true);
  assert.deepEqual(calls, [
    'kubectl get pods -n prod --no-headers',
    'kubectl rollout restart deployment/api -n prod',
    'kubectl rollout status deployment/api -n prod --timeout=15s',
  ]);
});

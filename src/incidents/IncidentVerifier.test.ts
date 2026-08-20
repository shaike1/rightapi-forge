import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containerFromIncident,
  createIncidentVerifier,
  endpointFromIncident,
  kubernetesTargetFromIncident,
  metricFromIncident,
  networkTargetFromIncident,
  serviceCandidates,
  serviceFromIncident,
} from './IncidentVerifier.js';
import type { Incident } from '../persistence/SqliteStore.js';

function incident(overrides: Partial<Incident>): Incident {
  return {
    id: 'inc-1',
    title: 'CPU overload on vps2',
    description: '',
    severity: 'high',
    status: 'resolved',
    assignedTo: null,
    assignedAgent: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    resolvedAt: new Date(0).toISOString(),
    source: 'alert-rule',
    sourceRef: 'health-monitor:cpu:vps2',
    slaMinutes: 60,
    serverId: 'vps2',
    ...overrides,
  };
}

test('metricFromIncident maps source refs and titles', () => {
  assert.equal(metricFromIncident(incident({ sourceRef: 'health-monitor:disk:vps2', title: 'anything' })), 'disk');
  assert.equal(metricFromIncident(incident({ sourceRef: null, title: 'Memory critical on vps2' })), 'memory');
  assert.equal(metricFromIncident(incident({ sourceRef: null, title: 'Load avg 5m anomaly' })), 'load5');
  assert.equal(metricFromIncident(incident({ sourceRef: 'x', title: 'network down' })), null);
});

test('serviceFromIncident parses health-monitor references and titles', () => {
  assert.equal(serviceFromIncident(incident({ sourceRef: 'health-monitor:service:failed:ssh:vps2' })), 'ssh');
  assert.equal(serviceFromIncident(incident({ sourceRef: null, title: 'Service down: docker' })), 'docker');
});

test('structured verifier targets are parsed without accepting unsafe values', () => {
  assert.deepEqual(serviceCandidates('ssh'), ['ssh', 'sshd']);
  assert.deepEqual(serviceCandidates('ssh;reboot'), []);
  assert.deepEqual(containerFromIncident(incident({ sourceRef: 'container:unhealthy:web-1:vps2' })), { condition: 'unhealthy', name: 'web-1' });
  assert.equal(networkTargetFromIncident(incident({ sourceRef: 'network:unreachable:1.1.1.1' })), '1.1.1.1');
  assert.deepEqual(endpointFromIncident(incident({ sourceRef: 'port:failed:db.internal:5432' })), { kind: 'port', host: 'db.internal', port: 5432 });
  assert.equal((endpointFromIncident(incident({ sourceRef: `http:failed:${encodeURIComponent('https://status.example.test/health')}` })) as any)?.kind, 'http');
  assert.deepEqual(kubernetesTargetFromIncident(incident({ sourceRef: 'k8s:pod:crashloop:payments:api-7d9f' })), {
    kind: 'pod', condition: 'crashloop', namespace: 'payments', name: 'api-7d9f',
  });
  assert.deepEqual(kubernetesTargetFromIncident(incident({ sourceRef: 'kubernetes:deployment:rollout:payments:api.v2' })), {
    kind: 'deployment', condition: 'rollout', namespace: 'payments', name: 'api.v2',
  });
  assert.equal(kubernetesTargetFromIncident(incident({ sourceRef: 'k8s:pod:crashloop:payments;prod:api' })), null);
});

test('remote service verifier passes only when systemd reports active', async () => {
  const executeFile = async () => ({ exitCode: 0, stdout: 'active\n', stderr: '' });
  const verifier = createIncidentVerifier({
    skillManager: { execute: async () => '' },
    getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
    getRemoteExecutor: () => ({ execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }), executeFile } as any),
  });
  const result = await verifier(incident({ sourceRef: 'health-monitor:service:failed:ssh:vps2', title: 'Service down: ssh' }));
  assert.equal(result.ok, true);
  assert.equal(result.conclusive, true);
  assert.match(result.details || '', /ssh is active/);
});

test('remote service verifier distinguishes inactive from an inconclusive probe', async () => {
  for (const scenario of [
    { stdout: 'inactive\n', stderr: '', exitCode: 3, conclusive: true },
    { stdout: '', stderr: 'ssh unavailable', exitCode: 255, conclusive: false },
  ]) {
    const verifier = createIncidentVerifier({
      skillManager: { execute: async () => '' },
      getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
      getRemoteExecutor: () => ({
        execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        executeFile: async () => scenario,
      } as any),
    });
    const result = await verifier(incident({ sourceRef: 'health-monitor:service:failed:ssh:vps2', title: 'Service down: ssh' }));
    assert.equal(result.ok, false);
    assert.equal(result.conclusive, scenario.conclusive);
  }
});

test('service verifier accepts a healthy platform alias', async () => {
  const calls: string[] = [];
  const verifier = createIncidentVerifier({
    skillManager: { execute: async () => '' },
    getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
    getRemoteExecutor: () => ({
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      executeFile: async (_server: any, _file: string, args: string[]) => {
        calls.push(args[1]);
        return args[1] === 'sshd'
          ? { exitCode: 0, stdout: 'active\n', stderr: '' }
          : { exitCode: 4, stdout: 'unknown\n', stderr: '' };
      },
    } as any),
  });
  const result = await verifier(incident({ sourceRef: 'service:failed:ssh:vps2', title: 'Service down: ssh' }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['ssh', 'sshd']);
});

test('container, network, port, and HTTP verifiers use structured remote probes', async () => {
  const scenarios = [
    { sourceRef: 'container:unhealthy:web:vps2', output: 'running|healthy|0|2026-08-19T00:00:00Z', expected: /healthy/ },
    { sourceRef: 'network:unreachable:1.1.1.1', output: '', expected: /reachable/ },
    { sourceRef: 'port:failed:db.internal:5432', output: '', expected: /5432.*reachable/ },
    { sourceRef: `http:failed:${encodeURIComponent('https://status.example.test/health')}`, output: '204', expected: /HTTP 204/ },
  ];
  for (const scenario of scenarios) {
    const verifier = createIncidentVerifier({
      skillManager: { execute: async () => '' },
      getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
      getRemoteExecutor: () => ({
        execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        executeFile: async () => ({ exitCode: 0, stdout: scenario.output, stderr: '' }),
      } as any),
    });
    const result = await verifier(incident({ sourceRef: scenario.sourceRef, title: 'structured failure' }));
    assert.equal(result.ok, true, scenario.sourceRef);
    assert.match(result.details || '', scenario.expected);
  }
});

test('Kubernetes verifier requires pod readiness and a complete deployment rollout', async () => {
  const pod = {
    metadata: {}, status: {
      phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'api', ready: true, state: { running: {} } }],
    },
  };
  const deployment = {
    metadata: { generation: 4 }, spec: { replicas: 3 },
    status: { observedGeneration: 4, updatedReplicas: 3, availableReplicas: 3, unavailableReplicas: 0 },
  };
  const calls: string[][] = [];
  const verifier = createIncidentVerifier({
    skillManager: { execute: async () => '' },
    getServerRegistry: () => ({ get: () => ({ id: 'cluster-admin', name: 'prod-cluster' }) as any }),
    getRemoteExecutor: () => ({
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      executeFile: async (_server: any, file: string, args: string[]) => {
        assert.equal(file, 'kubectl');
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify(args[1] === 'pod' ? pod : deployment), stderr: '' };
      },
    } as any),
  });

  const podResult = await verifier(incident({ serverId: 'cluster-admin', sourceRef: 'k8s:pod:notready:payments:api-7d9f' }));
  const deploymentResult = await verifier(incident({ serverId: 'cluster-admin', sourceRef: 'k8s:deployment:unavailable:payments:api' }));
  assert.equal(podResult.ok, true);
  assert.equal(deploymentResult.ok, true);
  assert.deepEqual(calls[0], ['get', 'pod', 'api-7d9f', '--namespace', 'payments', '--output', 'json']);
  assert.deepEqual(calls[1], ['get', 'deployment', 'api', '--namespace', 'payments', '--output', 'json']);
});

test('Kubernetes verifier distinguishes an unhealthy resource from an unavailable probe', async () => {
  const scenarios = [
    {
      response: { exitCode: 0, stdout: JSON.stringify({ metadata: {}, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } }] } }), stderr: '' },
      conclusive: true,
    },
    { response: { exitCode: 1, stdout: '', stderr: 'Unable to connect to the server' }, conclusive: false },
    { response: { exitCode: 1, stdout: '', stderr: 'Error from server (NotFound): pods "api" not found' }, conclusive: true },
  ];
  for (const scenario of scenarios) {
    const verifier = createIncidentVerifier({
      skillManager: { execute: async () => '' },
      getServerRegistry: () => ({ get: () => ({ id: 'cluster-admin', name: 'prod-cluster' }) as any }),
      getRemoteExecutor: () => ({
        execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        executeFile: async () => scenario.response,
      } as any),
    });
    const result = await verifier(incident({ serverId: 'cluster-admin', sourceRef: 'k8s:pod:crashloop:payments:api' }));
    assert.equal(result.ok, false);
    assert.equal(result.conclusive, scenario.conclusive);
  }
});

test('remote verifier fails while metric remains above threshold', async () => {
  const verifier = createIncidentVerifier({
    skillManager: { execute: async () => '' },
    getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
    getRemoteExecutor: () => ({ execute: async () => ({ exitCode: 0, stdout: 'cpu=175 load1=175 load5=80 memory=20 disk=20\n', stderr: '' }) }),
  });

  const result = await verifier(incident({}));

  assert.equal(result.ok, false);
  assert.match(result.details || '', /cpu still 175%/);
});

test('remote verifier passes when metric is below threshold', async () => {
  const verifier = createIncidentVerifier({
    skillManager: { execute: async () => '' },
    getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
    getRemoteExecutor: () => ({ execute: async () => ({ exitCode: 0, stdout: 'cpu=30 load1=30 load5=20 memory=20 disk=20\n', stderr: '' }) }),
  });

  const result = await verifier(incident({}));

  assert.equal(result.ok, true);
  assert.match(result.details || '', /cpu now 30%/);
});

test('unknown non-manual incidents fail closed', async () => {
  const verifier = createIncidentVerifier({ skillManager: { execute: async () => '' } });

  const result = await verifier(incident({ sourceRef: 'other:thing', title: 'unknown issue', serverId: null }));

  assert.equal(result.ok, false);
  assert.equal(result.conclusive, false);
  assert.match(result.details || '', /no verifier configured/);
});

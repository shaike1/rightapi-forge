import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentIncidentHandler, selectFallbackWorkflow } from './AgentIncidentHandler.js';
import { IncidentManager } from './IncidentManager.js';
import { SqliteIncidentStore, type Incident } from '../persistence/SqliteStore.js';
import { AutonomyAttemptStore } from '../ai/AutonomyAttemptStore.js';
import { IncidentAutoRemediator } from '../self-healing/IncidentAutoRemediator.js';

function freshManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-handler-'));
  return new IncidentManager(new SqliteIncidentStore(path.join(dir, 'incidents.db')));
}

test('success with zero tool steps falls back instead of resolving incident', async () => {
  const incidents = freshManager();
  const inc = incidents.create({ title: 'CPU overloaded', severity: 'high', source: 'health-monitor' as any });
  const task = { id: 'task-1', title: 'investigate', description: '', priority: 'high', category: 'incident-response' };
  const taskManager = {
    getTask: () => task,
    createTask: () => task,
  };
  const agent = {
    id: 'agent-1',
    name: 'Ops Test',
    executeTaskDetailed: async () => ({
      result: 'looks fine',
      outcome: 'success',
      iterations: 0,
      steps: [],
      durationMs: 1,
      limitReached: false,
    }),
  };
  const handler = new AgentIncidentHandler(
    {} as any,
    incidents,
    taskManager as any,
    null,
    null,
    { disableRemediatorFallback: true, disableWorkflowFallback: true },
  );

  const result = await handler.runFor(inc as Incident, agent as any, task.id);

  assert.equal(result.outcome, 'escalated');
  assert.equal(incidents.get(inc.id)?.status, 'investigating');
  assert.ok(incidents.getTimeline(inc.id).some(t => /zero tool steps/.test(t.message)));
});

test('records verified, false-resolution, and human-handoff attempt outcomes', async () => {
  for (const scenario of [
    { name: 'verified', verifierOk: true, toolSteps: 1, expected: 'verified_autonomous', incidentStatus: 'resolved' },
    { name: 'false', verifierOk: false, toolSteps: 1, expected: 'false_resolution', incidentStatus: 'investigating' },
    { name: 'handoff', verifierOk: true, toolSteps: 0, expected: 'human_handoff', incidentStatus: 'investigating' },
  ] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `itops-agent-outcome-${scenario.name}-`));
    const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
    const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
    try {
      incidents.setVerifier(() => ({ ok: scenario.verifierOk, details: scenario.name }));
      const incident = incidents.create({ title: scenario.name, severity: 'high', source: 'health-monitor' as any });
      const task = { id: `task-${scenario.name}`, title: 'investigate', description: '', priority: 'high', category: 'incident-response' };
      const agent = {
        id: 'agent-1', name: 'Ops Test',
        executeTaskDetailed: async () => ({
          result: 'remediated', outcome: 'success', iterations: 1,
          steps: scenario.toolSteps ? [{ tool: 'server.info', output: 'ok' }] : [],
          durationMs: 1, limitReached: false,
        }),
      };
      const handler = new AgentIncidentHandler(
        {} as any,
        incidents,
        { getTask: () => task, createTask: () => task } as any,
        null,
        null,
        { disableRemediatorFallback: true, disableWorkflowFallback: true, attemptStore: attempts },
      );
      await handler.runFor(incident as Incident, agent as any, task.id);
      await new Promise(resolve => setTimeout(resolve, 10));

      const attempt = attempts.latestForIncident(incident.id)!;
      assert.equal(attempt.classification, scenario.expected, scenario.name);
      assert.equal(incidents.get(incident.id)?.status, scenario.incidentStatus, scenario.name);
      assert.ok(attempt.phases.some(phase => phase.kind === 'agent_execution'));
      if (scenario.toolSteps) {
        assert.ok(attempt.phases.some(phase => phase.kind === 'verification'));
      } else {
        assert.ok(attempt.phases.some(phase => phase.kind === 'escalation'));
      }
    } finally {
      attempts.close();
      incidents.incidentStore.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('token-limited run with successful tools resolves only after a passing verifier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-limit-verify-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
  const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
  try {
    incidents.setVerifier(() => ({ ok: true, conclusive: true, details: 'service active' }));
    const incident = incidents.create({ title: 'Service down: ssh', severity: 'critical', source: 'health-monitor' as any, sourceRef: 'health-monitor:service:failed:ssh:vps2' });
    const task = { id: 'task-limit', title: 'investigate', description: '', priority: 'high', category: 'incident-response' };
    const agent = {
      id: 'agent-1', name: 'Ops Test',
      executeTaskDetailed: async () => ({
        result: 'token limit', outcome: 'partial', iterations: 8,
        steps: [{ tool: 'host.exec', output: 'restart complete' }], durationMs: 1,
        limitReached: true, limitType: 'tokens', limitReason: 'budget reached',
      }),
    };
    const handler = new AgentIncidentHandler(
      {} as any, incidents, { getTask: () => task, createTask: () => task } as any,
      null, null, { disableRemediatorFallback: true, disableWorkflowFallback: true, attemptStore: attempts },
    );
    const result = await handler.runFor(incident as Incident, agent as any, task.id);
    assert.equal(result.outcome, 'resolved');
    assert.equal(incidents.get(incident.id)?.status, 'resolved');
    assert.equal(attempts.latestForIncident(incident.id)?.classification, 'verified_autonomous');
    assert.equal(attempts.latestForIncident(incident.id)?.outcome, 'verification_passed_after_limit');
  } finally {
    attempts.close();
    incidents.incidentStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing verifier evidence becomes a handoff instead of a false resolution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-inconclusive-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
  const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
  try {
    incidents.setVerifier(() => ({ ok: false, conclusive: false, details: 'no verifier configured' }));
    const incident = incidents.create({ title: 'Unknown alert', severity: 'high', source: 'system' as any });
    const task = { id: 'task-unknown', title: 'investigate', description: '', priority: 'high', category: 'incident-response' };
    const agent = {
      id: 'agent-1', name: 'Ops Test',
      executeTaskDetailed: async () => ({ result: 'fixed', outcome: 'success', iterations: 1, steps: [{ tool: 'host.exec', output: 'ok' }], durationMs: 1, limitReached: false }),
    };
    const handler = new AgentIncidentHandler(
      {} as any, incidents, { getTask: () => task, createTask: () => task } as any,
      null, null, { disableRemediatorFallback: true, disableWorkflowFallback: true, attemptStore: attempts },
    );
    await handler.runFor(incident as Incident, agent as any, task.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(incidents.get(incident.id)?.status, 'investigating');
    const attempt = attempts.latestForIncident(incident.id);
    assert.equal(attempt?.classification, 'human_handoff');
    assert.equal(attempt?.outcome, 'verification_unavailable');
    assert.equal(attempt?.phases.find(phase => phase.kind === 'verification')?.status, 'pending');
  } finally {
    attempts.close();
    incidents.incidentStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic workflow fallback is recorded immediately as a human handoff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-workflow-handoff-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
  const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
  try {
    const incident = incidents.create({ title: 'Unknown outage', severity: 'high', source: 'system' as any });
    const task = { id: 'task-workflow', title: 'investigate', description: '', priority: 'high', category: 'incident-response' };
    const agent = {
      id: 'agent-1', name: 'Ops Test',
      executeTaskDetailed: async () => ({ result: 'cannot determine', outcome: 'failed', iterations: 1, steps: [], durationMs: 1, limitReached: false }),
    };
    const workflow = {
      listTemplates: () => [{ id: 'incident-response', trigger: 'incident' }],
      startRun: () => ({ id: 'wf-handoff', templateId: 'incident-response' }),
    };
    const handler = new AgentIncidentHandler(
      {} as any, incidents, { getTask: () => task, createTask: () => task } as any,
      null, workflow as any, { disableRemediatorFallback: true, attemptStore: attempts },
    );
    const result = await handler.runFor(incident as Incident, agent as any, task.id);
    assert.equal(result.outcome, 'fallback_workflow');
    assert.equal(attempts.latestForIncident(incident.id)?.classification, 'human_handoff');
    assert.equal(attempts.latestForIncident(incident.id)?.outcome, 'fallback_workflow_handoff');
  } finally {
    attempts.close();
    incidents.incidentStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fallback workflow selection prefers incident-specific triggers', () => {
  const selected = selectFallbackWorkflow([
    { id: 'incident-response', name: 'Incident Response', trigger: 'alert|outage|incident', stages: [] },
    { id: 'service-recovery', name: 'Service Recovery', trigger: 'service down|service:failed', stages: [] },
    { id: 'change', name: 'Change', trigger: '[invalid', stages: [] },
  ], {
    title: 'Service down: ssh', description: 'systemd reports inactive', sourceRef: 'service:failed:ssh:vps2',
  });
  assert.equal(selected?.id, 'service-recovery');
});

test('verified deterministic remediation is attributed as an assisted resolution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-agent-assisted-remediator-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
  const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
  try {
    incidents.setVerifier(() => ({ ok: true, conclusive: true, details: 'ssh is active' }));
    const incident = incidents.create({
      title: 'Service down: ssh', severity: 'critical', source: 'health-monitor' as any,
      sourceRef: 'service:failed:ssh:vps2', serverId: 'vps2',
    });
    const task = { id: 'task-assisted', title: 'investigate', description: '', priority: 'critical', category: 'incident-response' };
    const agent = {
      id: 'agent-1', name: 'Ops Test',
      executeTaskDetailed: async () => ({ result: 'could not restart', outcome: 'failed', iterations: 1, steps: [], durationMs: 1, limitReached: false }),
    };
    const remediator = new IncidentAutoRemediator(incidents, {
      enabled: true,
      serviceAllowlist: ['ssh'],
      getServerRegistry: () => ({ get: () => ({ id: 'vps2', name: 'vps2' }) as any }),
      getRemoteExecutor: () => ({ executeFile: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } as any),
    });
    const handler = new AgentIncidentHandler(
      {} as any, incidents, { getTask: () => task, createTask: () => task } as any,
      remediator, null, { disableWorkflowFallback: true, attemptStore: attempts },
    );
    const result = await handler.runFor(incident as Incident, agent as any, task.id);
    assert.equal(result.outcome, 'resolved');
    assert.equal(incidents.get(incident.id)?.status, 'resolved');
    assert.equal(attempts.latestForIncident(incident.id)?.classification, 'assisted');
    assert.equal(attempts.latestForIncident(incident.id)?.outcome, 'fallback_remediator_verified');
  } finally {
    attempts.close();
    incidents.incidentStore.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

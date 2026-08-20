import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutonomyAttemptStore } from './AutonomyAttemptStore.js';
import { computeAutonomyMetrics } from './AutonomyMetrics.js';
import { AiDecisionStore } from './AiDecisionStore.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

test('acceptance: every terminal outcome is classified into an attributable cohort', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-outcome-acceptance-'));
  try {
    const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
    const decisions = new AiDecisionStore(path.join(root, 'decisions.db'));
    const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
    const skills = { getEnabled: () => [{ id: 'bash', name: 'Bash', commands: [{ name: 'bash.exec' }] }] } as any;
    const now = Date.now();

    function seedIncident(id: string, status: 'resolved' | 'investigating', ageMinutes: number) {
      const createdAt = new Date(now - ageMinutes * 60_000).toISOString();
      const resolvedAt = status === 'resolved' ? new Date(now - 60_000).toISOString() : null;
      incidents.incidentStore.upsert({
        id, title: id, description: '', severity: 'medium', status,
        assignedTo: null, assignedAgent: null, createdAt, updatedAt: resolvedAt || createdAt,
        resolvedAt, source: 'system', sourceRef: null, slaMinutes: 240, serverId: null,
      } as any);
      return createdAt;
    }

    const verifiedAt = seedIncident('INC-verified', 'resolved', 11);
    const assistedAt = seedIncident('INC-assisted', 'resolved', 21);
    seedIncident('INC-handoff', 'resolved', 31);
    seedIncident('INC-legacy-manual', 'resolved', 41);
    const falseAt = seedIncident('INC-false', 'investigating', 15);
    const failedAt = seedIncident('INC-failed', 'investigating', 25);

    const verified = attempts.start({ incidentId: 'INC-verified', taskId: 'T1', agentId: 'A1', agentName: 'Alice', at: verifiedAt });
    attempts.conclude(verified.id, 'verified_autonomous', 'verification_passed', { verification: 'passed' });
    const assisted = attempts.start({ incidentId: 'INC-assisted', taskId: 'T2', agentId: 'A2', agentName: 'Bob', at: assistedAt });
    attempts.addPhase(assisted.id, { kind: 'fallback_remediator', status: 'pending' });
    attempts.conclude(assisted.id, 'assisted', 'fallback_resolved_incident');
    const handoff = attempts.start({ incidentId: 'INC-handoff', taskId: 'T3', agentId: 'A3', agentName: 'Cara' });
    attempts.conclude(handoff.id, 'human_handoff', 'escalated_to_operator');
    const falseAttempt = attempts.start({ incidentId: 'INC-false', taskId: 'T4', agentId: 'A4', agentName: 'Dan', at: falseAt });
    attempts.conclude(falseAttempt.id, 'false_resolution', 'verification_failed', { verification: 'failed' });
    const failed = attempts.start({ incidentId: 'INC-failed', taskId: 'T5', agentId: 'A5', agentName: 'Eve', at: failedAt });
    attempts.conclude(failed.id, 'failed', 'attempt_expired');

    const metrics = computeAutonomyMetrics(incidents, decisions, skills, 24 * 60 * 60 * 1000, attempts);
    assert.equal(metrics.outcomes.totalAttempts, 5);
    assert.equal(metrics.outcomes.terminalAttempts, 5);
    assert.equal(metrics.outcomes.unclassifiedTerminalIncidents, 0);
    assert.deepEqual(metrics.outcomes.byClassification, {
      in_progress: 0, verified_autonomous: 1, assisted: 1,
      false_resolution: 1, failed: 1, human_handoff: 2,
    });
    assert.equal(metrics.autonomousResolutionRate, 1 / 6);
    assert.equal(metrics.falseResolveRate, 0.5);
    assert.equal(metrics.attributionCoverage, 0.75);
    assert.equal(metrics.cohorts.verified_autonomous.count, 1);
    assert.equal(metrics.cohorts.human_handoff.count, 2);
    assert.ok(metrics.window.since);
    assert.equal(metrics.layerCoverage.linux, true);

    attempts.close();
    decisions.close();
    incidents.incidentStore.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolved incidents awaiting verification remain visibly unclassified', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-pending-acceptance-'));
  try {
    const incidents = new IncidentManager(new SqliteIncidentStore(path.join(root, 'incidents.db')));
    const decisions = new AiDecisionStore(path.join(root, 'decisions.db'));
    const attempts = new AutonomyAttemptStore(path.join(root, 'attempts.db'));
    const now = new Date().toISOString();
    incidents.incidentStore.upsert({
      id: 'INC-pending', title: 'pending verification', description: '', severity: 'medium', status: 'resolved',
      assignedTo: null, assignedAgent: null, createdAt: now, updatedAt: now, resolvedAt: now,
      source: 'system', sourceRef: null, slaMinutes: 240, serverId: null,
    } as any);
    attempts.start({ incidentId: 'INC-pending', agentId: 'A1', agentName: 'Alice', at: now });

    const metrics = computeAutonomyMetrics(
      incidents, decisions, { getEnabled: () => [] } as any, 24 * 60 * 60 * 1000, attempts,
    );
    assert.equal(metrics.outcomes.inProgress, 1);
    assert.equal(metrics.outcomes.unclassifiedTerminalIncidents, 1);
    assert.equal(metrics.outcomes.classifiedOutcomes, 0);

    attempts.close();
    decisions.close();
    incidents.incidentStore.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

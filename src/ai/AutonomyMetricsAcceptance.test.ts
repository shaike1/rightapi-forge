import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAutonomyMetrics } from './AutonomyMetrics.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { AiDecisionStore } from './AiDecisionStore.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

test('Acceptance: Autonomy metrics calculates all four SLA targets correctly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-accept-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const decisions = new AiDecisionStore(join(dir, 'decisions.db'));
  const skills = {
    getEnabled: () => [
      { id: 'bash', name: 'Bash', commands: [{ name: 'bash.exec' }] },
      { id: 'docker', name: 'Docker', commands: [{ name: 'docker.ps' }] },
    ],
  } as any;

  // 1. Tool Coverage
  // The fake skill list intentionally includes Linux + Docker only.

  // 2. Controlled DB seeding for predictable timestamps
  const now = Date.now();
  const t1Start = new Date(now - 10 * 60 * 1000).toISOString();
  const t1End   = new Date(now -  5 * 60 * 1000).toISOString(); // duration: 5m
  const t2Start = new Date(now - 20 * 60 * 1000).toISOString();
  const t2End   = new Date(now -  5 * 60 * 1000).toISOString(); // duration: 15m

  incidents.incidentStore.upsert({
    id: 'INC-I1', title: 'I1', description: '', severity: 'medium', status: 'resolved',
    assignedTo: null, assignedAgent: null,
    createdAt: t1Start, updatedAt: t1End, resolvedAt: t1End,
    source: 'manual', sourceRef: null, slaMinutes: 240, serverId: null,
  } as any);

  incidents.incidentStore.upsert({
    id: 'INC-I2', title: 'I2', description: '', severity: 'medium', status: 'resolved',
    assignedTo: null, assignedAgent: null,
    createdAt: t2Start, updatedAt: t2End, resolvedAt: t2End,
    source: 'manual', sourceRef: null, slaMinutes: 240, serverId: null,
  } as any);

  decisions.insert({ id: 'd1', kind: 'resolve', incidentId: 'INC-I1', confidence: 0.9, reasoning: '', autoApplied: true });
  decisions.recordOutcome('d1', 'success');
  decisions.insert({ id: 'd3', kind: 'resolve', incidentId: 'INC-I3', confidence: 0.9, reasoning: '', autoApplied: true });
  decisions.recordOutcome('d3', 'reopened');

  const metrics = computeAutonomyMetrics(incidents, decisions, skills);

  // 3. Assertions map to PLAN.md metrics
  assert.equal(metrics.mttrMinutes, 10, 'MTTR averages (5+15)/2 = 10m');
  assert.equal(metrics.autonomousResolutionRate, 0.5, '1 of 2 resolved incidents was autoApplied');
  assert.equal(metrics.falseResolveRate, 0.5, '1 of 2 autonomous resolutions flipped to reopened');
  
  assert.equal(metrics.layerCoverage.linux, true);
  assert.equal(metrics.layerCoverage.docker, true);
  assert.equal(metrics.layerCoverage.kubernetes, false);
  assert.equal(metrics.layerCoverage.cloud, false);

  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { draftAppSpecFromMessage, parseAppSpec } from './AppSpec.js';
import { AppGenerator } from './AppGenerator.js';
import { artifactChecksumFor, QualityGateRunner } from './QualityGate.js';
import { ToolReleaseManager, ToolReleaseStore, type GitReleaseExporter, type ToolDeploymentAdapter } from './ToolReleaseManager.js';

test('approved release deploys and a failed successor automatically rolls back with audit evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-release-'));
  const store = new ToolReleaseStore(path.join(root, 'builder.db'));
  const exports: string[] = [];
  const exporter: GitReleaseExporter = { export: async ({ release }) => { exports.push(release.id); return { commit: `commit-${release.revision}` }; } };
  let deployCount = 0; const rollbacks: string[] = [];
  const adapter: ToolDeploymentAdapter = {
    deploy: async ({ deploymentId }) => ++deployCount === 1
      ? { healthy: true, runtimeRef: `runtime-${deploymentId}`, health: 'healthy' }
      : { healthy: false, runtimeRef: `runtime-${deploymentId}`, health: 'failed', error: 'synthetic health failure' },
    rollback: async ({ targetRuntimeRef }) => { rollbacks.push(targetRuntimeRef); return { healthy: true, health: 'rollback healthy' }; },
  };
  let tick = Date.parse('2026-08-20T00:00:00.000Z');
  const now = () => new Date(tick++);
  const manager = new ToolReleaseManager(store, exporter, adapter, 'release-manager-test-key-at-least-32-bytes', now);
  const gateRunner = new QualityGateRunner('quality-gate-test-signing-key-32-bytes', { verify: async () => ({ checks: [{ id: 'runtime', status: 'pass', summary: 'passed' }] }) }, 2, now);
  try {
    const base = draftAppSpecFromMessage('Release console');
    const artifact1 = new AppGenerator().generate({ projectId: 'app-1', revision: 1, spec: base, generatedAt: '2026-08-20T00:00:00.000Z' });
    const evidence1 = await gateRunner.run({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'builder', artifact: artifact1 });
    const release1 = manager.request({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'builder', artifactChecksum: artifactChecksumFor(artifact1), evidence: evidence1, spec: base });
    assert.equal(release1.risk, 'low'); assert.equal(release1.requiredApprovals, 1);
    assert.throws(() => manager.review(release1.id, 'acme', 'builder', 'approved'), /cannot approve/);
    const approved1 = manager.review(release1.id, 'acme', 'reviewer', 'approved', 'looks good')!;
    assert.equal(approved1.status, 'approved'); assert.match(approved1.metadataSignature!, /^[a-f0-9]{64}$/);
    const deployed1 = await manager.deploy({ id: release1.id, tenantId: 'acme', actor: 'deployer', artifact: artifact1, evidenceValid: true });
    assert.equal(deployed1.deployment.status, 'healthy'); assert.equal(deployed1.release.status, 'deployed');

    const high = parseAppSpec({ ...base, deploymentTarget: { runtime: 'container', visibility: 'public' }, integrations: [{ id: 'github', name: 'GitHub', provider: 'github', connectionRef: 'managed/github', capabilities: ['issues.write'] }] });
    const artifact2 = new AppGenerator().generate({ projectId: 'app-1', revision: 2, spec: high, generatedAt: '2026-08-20T00:01:00.000Z' });
    const evidence2 = await gateRunner.run({ tenantId: 'acme', projectId: 'app-1', revision: 2, actor: 'builder', artifact: artifact2 });
    const release2 = manager.request({ tenantId: 'acme', projectId: 'app-1', revision: 2, actor: 'builder', artifactChecksum: artifactChecksumFor(artifact2), evidence: evidence2, spec: high, previousSpec: base, previousRevision: 1 });
    assert.equal(release2.risk, 'high'); assert.equal(release2.requiredApprovals, 2);
    assert.equal(manager.review(release2.id, 'acme', 'reviewer-a', 'approved')!.status, 'pending_review');
    assert.equal(manager.review(release2.id, 'acme', 'reviewer-b', 'approved')!.status, 'approved');
    const failed = await manager.deploy({ id: release2.id, tenantId: 'acme', actor: 'deployer', artifact: artifact2, evidenceValid: true });
    assert.equal(failed.release.status, 'failed'); assert.equal(failed.deployment.status, 'rolled_back');
    assert.equal(failed.deployment.rolledBackTo, deployed1.deployment.id);
    assert.deepEqual(rollbacks, [deployed1.deployment.runtimeRef]);
    assert.equal(manager.getDeployment(deployed1.deployment.id, 'acme')?.status, 'healthy');
    assert.ok(manager.events(release2.id, 'acme').some(event => event.action === 'deployment.auto_rollback'));
    assert.deepEqual(exports, [release1.id, release2.id]);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('request rejects mismatched evidence and review rejects duplicate actors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-release-'));
  const store = new ToolReleaseStore(path.join(root, 'builder.db'));
  const manager = new ToolReleaseManager(store, { export: async () => ({ commit: 'x' }) }, { deploy: async () => ({ healthy: true, health: 'ok' }), rollback: async () => ({ healthy: true, health: 'ok' }) }, 'release-manager-test-key-at-least-32-bytes');
  try {
    const spec = draftAppSpecFromMessage('Release console'); const artifact = new AppGenerator().generate({ projectId: 'app-1', revision: 1, spec });
    const evidence = { id: 'gate-1', tenantId: 'acme', projectId: 'other', revision: 1, artifactChecksum: artifactChecksumFor(artifact), gateVersion: '1', passed: true, checks: [], reproducibilityKey: 'x', createdBy: 'x', createdAt: new Date().toISOString(), signature: 'x' } as any;
    assert.throws(() => manager.request({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'builder', artifactChecksum: artifactChecksumFor(artifact), evidence, spec }), /exact artifact/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

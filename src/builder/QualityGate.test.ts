import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { draftAppSpecFromMessage } from './AppSpec.js';
import { AppGenerator, type GeneratedApplication } from './AppGenerator.js';
import { QualityEvidenceRegistry, QualityGateRunner, type GateRuntimeVerifier } from './QualityGate.js';

const runtime: GateRuntimeVerifier = {
  verify: async () => ({ checks: [
    { id: 'build', status: 'pass', summary: 'clean build passed' },
    { id: 'unit', status: 'pass', summary: 'CRUD passed' },
    { id: 'browser', status: 'pass', summary: 'desktop and mobile passed' },
    { id: 'accessibility', status: 'pass', summary: 'axe passed' },
    { id: 'visual', status: 'pass', summary: 'snapshots captured', details: { desktop: 'abc', mobile: 'def' } },
  ] }),
};

function artifact(): GeneratedApplication {
  return new AppGenerator().generate({ projectId: 'app-1', revision: 1, spec: draftAppSpecFromMessage('Customer console'), generatedAt: '2026-01-01T00:00:00.000Z' });
}

test('quality gate produces verifiable and reproducible passing evidence', async () => {
  const runner = new QualityGateRunner('quality-gate-test-signing-key-32-bytes', runtime, 2, () => new Date('2026-01-02T00:00:00.000Z'));
  const first = await runner.run({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'alice', artifact: artifact() });
  const second = await runner.run({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'alice', artifact: artifact() });
  assert.equal(first.passed, true);
  assert.equal(runner.verify(first), true);
  assert.equal(first.reproducibilityKey, second.reproducibilityKey);
  assert.ok(first.checks.some(check => check.id === 'container'));
  assert.ok(first.checks.some(check => check.id === 'visual'));
  first.checks[0]!.summary = 'tampered';
  assert.equal(runner.verify(first), false);
});

test('quality gate rejects credential literals and dependency changes before runtime', async () => {
  let runtimeCalls = 0;
  const runner = new QualityGateRunner('quality-gate-test-signing-key-32-bytes', {
    verify: async (...args) => { runtimeCalls++; return runtime.verify(...args); },
  });
  const vulnerable = artifact();
  replaceFile(vulnerable, 'server/app.mjs', required(vulnerable, 'server/app.mjs') + '\nconst apiKey = "sk_live_this_should_never_ship";\n');
  const vulnerableEvidence = await runner.run({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'alice', artifact: vulnerable });
  assert.equal(vulnerableEvidence.passed, false);
  assert.equal(vulnerableEvidence.checks.find(check => check.id === 'secrets')?.status, 'fail');

  const broken = artifact();
  const manifest = JSON.parse(required(broken, 'package.json'));
  manifest.dependencies.axios = '1.0.0';
  replaceFile(broken, 'package.json', JSON.stringify(manifest, null, 2) + '\n');
  const brokenEvidence = await runner.run({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'alice', artifact: broken });
  assert.equal(brokenEvidence.passed, false);
  assert.equal(brokenEvidence.checks.find(check => check.id === 'dependency-policy')?.status, 'fail');
  assert.equal(runtimeCalls, 0);
});

test('quality evidence registry isolates records by tenant and revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-gates-'));
  const registry = new QualityEvidenceRegistry(path.join(root, 'builder.db'));
  try {
    const runner = new QualityGateRunner('quality-gate-test-signing-key-32-bytes', runtime);
    const evidence = await runner.run({ tenantId: 'acme', projectId: 'app-1', revision: 1, actor: 'alice', artifact: artifact() });
    registry.save(evidence);
    assert.equal(registry.get(evidence.id, 'acme')?.id, evidence.id);
    assert.equal(registry.get(evidence.id, 'beta'), null);
    assert.equal(registry.latestPassing('app-1', 'acme', 1)?.id, evidence.id);
    assert.equal(registry.latestPassing('app-1', 'acme', 2), null);
  } finally {
    registry.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function required(artifactValue: GeneratedApplication, filePath: string): string {
  const file = artifactValue.files.find(item => item.path === filePath);
  assert.ok(file);
  return file.content;
}

function replaceFile(artifactValue: GeneratedApplication, filePath: string, content: string): void {
  const file = artifactValue.files.find(item => item.path === filePath);
  assert.ok(file);
  file.content = content;
  file.sha256 = crypto.createHash('sha256').update(content).digest('hex');
}

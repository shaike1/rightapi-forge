import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OrchestratorReliabilityPolicyStore } from './OrchestratorReliabilityPolicyStore.js';

function withTempPath(run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-policy-store-'));
  try {
    run(path.join(dir, 'orchestrator-reliability-policy.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('orchestrator reliability policy store persists sanitized values', () => {
  withTempPath(filePath => {
    const store = new OrchestratorReliabilityPolicyStore(filePath);
    const first = store.getRecord();
    const updated = store.updateWithOptions({
      autoRecoverEnabled: false,
      stuckThresholdMinutes: 5000,
      retryLimit: 99,
      retryCooldownMinutes: -5
    }, { expectedRevision: first.revision });

    assert.equal(updated.policy.autoRecoverEnabled, false);
    assert.equal(updated.policy.stuckThresholdMinutes, 1440);
    assert.equal(updated.policy.retryLimit, 10);
    assert.equal(updated.policy.retryCooldownMinutes, 1);

    const reloaded = new OrchestratorReliabilityPolicyStore(filePath);
    const reloadedRecord = reloaded.getRecord();
    assert.equal(reloadedRecord.policy.autoRecoverEnabled, false);
    assert.equal(reloadedRecord.policy.stuckThresholdMinutes, 1440);
    assert.equal(reloadedRecord.policy.retryLimit, 10);
    assert.equal(reloadedRecord.policy.retryCooldownMinutes, 1);
  });
});

test('orchestrator reliability policy store enforces revision checks', () => {
  withTempPath(filePath => {
    const store = new OrchestratorReliabilityPolicyStore(filePath);
    assert.throws(
      () => store.updateWithOptions({ retryLimit: 3 }, { expectedRevision: 999 }),
      /Revision mismatch/
    );
  });
});

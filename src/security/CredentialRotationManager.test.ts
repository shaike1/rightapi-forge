import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CredentialVault } from './CredentialVault.js';
import { CredentialRotationManager, type RotationAlert } from './CredentialRotationManager.js';

function newVault(): { vault: CredentialVault; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-rot-'));
  const vault = new CredentialVault(
    path.join(dir, 'credentials.vault.json'),
    'master-key-with-enough-entropy-1234567890ABCDE',
  );
  return { vault, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('listDueForRotation flags credentials past expiry', () => {
  const { vault, cleanup } = newVault();
  try {
    const a = vault.upsert({
      agentId: 'agent', name: 'a', scope: 'use', secret: 's1',
      kind: 'api-key',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    vault.upsert({ agentId: 'agent', name: 'b', scope: 'use', secret: 's2' }); // no expiry
    const due = vault.listDueForRotation();
    assert.equal(due.length, 1);
    assert.equal(due[0].id, a.id);
  } finally {
    cleanup();
  }
});

test('listDueForRotation flags credentials past their interval', () => {
  const { vault, cleanup } = newVault();
  try {
    const created = vault.upsert({
      agentId: 'agent', name: 'old', scope: 'use', secret: 's',
      kind: 'token',
      rotationIntervalDays: 30,
    });
    // Backdate createdAt so the interval is past.
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    // Simulate by writing an explicit lastRotatedAt 40 days back.
    vault.applyRotation(created.id, { secret: 's' });
    // Force lastRotatedAt by replaying through internal state — easier: use
    // setLifecycle to clear, then directly fake via JSON. But here, the
    // upsert path already counts: it sets lastRotatedAt undefined and uses
    // createdAt as the base. So just check with a forward-clock instead.
    const horizon = new Date(Date.now() + 31 * 86_400_000); // 31 days from now
    const due = vault.listDueForRotation({ now: horizon });
    // The single credential should now be due (rotated "now", interval 30d,
    // horizon = now + 31d → due).
    assert.equal(due.length, 1);
    assert.equal(due[0].id, created.id);
    // And not due if we look just before the interval elapses.
    const beforeHorizon = new Date(Date.now() + 5 * 86_400_000);
    assert.equal(vault.listDueForRotation({ now: beforeHorizon }).length, 0);
  } finally {
    cleanup();
  }
});

test('successful rotation swaps the secret and clears prior failure state', async () => {
  const { vault, cleanup } = newVault();
  try {
    const c = vault.upsert({
      agentId: 'a', name: 'k', scope: 'use', secret: 'v1',
      kind: 'api-key',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    vault.markRotationFailure(c.id, 'previous failure');
    const mgr = new CredentialRotationManager(vault, { warnBeforeMs: 0 });
    mgr.registerRotator('api-key', async (meta, current) => {
      assert.equal(current, 'v1');
      assert.equal(meta.id, c.id);
      return { secret: 'v2', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    });
    const res = await mgr.runOnce();
    assert.equal(res.checked, 1);
    assert.equal(res.rotated, 1);
    assert.equal(res.failed, 0);
    assert.equal(vault.resolveSecret(c.id), 'v2');
    const meta = vault.listByAgent('a')[0];
    assert.ok(meta.lastRotatedAt, 'lastRotatedAt should be set after rotation');
    assert.equal(meta.lastRotationFailureMessage, undefined, 'failure should be cleared on success');
  } finally {
    cleanup();
  }
});

test('failed rotation records the failure and emits an alert', async () => {
  const { vault, cleanup } = newVault();
  try {
    const c = vault.upsert({
      agentId: 'a', name: 'k', scope: 'use', secret: 'orig',
      kind: 'api-key',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const alerts: RotationAlert[] = [];
    const mgr = new CredentialRotationManager(vault, {
      warnBeforeMs: 0,
      onAlert: a => alerts.push(a),
    });
    mgr.registerRotator('api-key', async () => { throw new Error('idp 5xx'); });
    const res = await mgr.runOnce();
    assert.equal(res.failed, 1);
    assert.equal(res.rotated, 0);
    // Secret unchanged.
    assert.equal(vault.resolveSecret(c.id), 'orig');
    // Failure persisted.
    const meta = vault.listByAgent('a')[0];
    assert.equal(meta.lastRotationFailureMessage, 'idp 5xx');
    assert.ok(meta.lastRotationFailureAt);
    // Alert emitted.
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].level, 'error');
    assert.match(alerts[0].key, /^rotation-failed:/);
    assert.match(alerts[0].message, /idp 5xx/);
  } finally {
    cleanup();
  }
});

test('credential due with no rotator emits a warn alert without changing state', async () => {
  const { vault, cleanup } = newVault();
  try {
    const c = vault.upsert({
      agentId: 'a', name: 'k', scope: 'use', secret: 'orig',
      kind: 'cert',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const alerts: RotationAlert[] = [];
    const mgr = new CredentialRotationManager(vault, {
      warnBeforeMs: 0,
      onAlert: a => alerts.push(a),
    });
    // No registerRotator('cert', …) call — manager has no way to rotate.
    const res = await mgr.runOnce();
    assert.equal(res.checked, 1);
    assert.equal(res.rotated, 0);
    assert.equal(res.failed, 0);
    assert.equal(res.noRotator, 1);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].level, 'warn');
    assert.match(alerts[0].key, /^no-rotator:/);
    // No persisted failure — it's just an alert, the credential is intact.
    const meta = vault.listByAgent('a')[0];
    assert.equal(meta.lastRotationFailureMessage, undefined);
    assert.equal(vault.resolveSecret(c.id), 'orig');
  } finally {
    cleanup();
  }
});

test('rotator returning empty secret is treated as a failure', async () => {
  const { vault, cleanup } = newVault();
  try {
    const c = vault.upsert({
      agentId: 'a', name: 'k', scope: 'use', secret: 'orig',
      kind: 'api-key',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const alerts: RotationAlert[] = [];
    const mgr = new CredentialRotationManager(vault, {
      warnBeforeMs: 0,
      onAlert: a => alerts.push(a),
    });
    // Bad rotator: returns an empty string instead of a real secret.
    mgr.registerRotator('api-key', async () => ({ secret: '' }));
    const res = await mgr.runOnce();
    assert.equal(res.failed, 1);
    assert.equal(vault.resolveSecret(c.id), 'orig', 'secret must not be replaced with empty');
    assert.match(alerts[0].message, /no secret/);
  } finally {
    cleanup();
  }
});

test('one bad rotator does not block sibling rotations', async () => {
  const { vault, cleanup } = newVault();
  try {
    vault.upsert({
      agentId: 'a', name: 'good', scope: 'use', secret: 'g1',
      kind: 'api-key',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    vault.upsert({
      agentId: 'a', name: 'bad', scope: 'use', secret: 'b1',
      kind: 'token',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const mgr = new CredentialRotationManager(vault, { warnBeforeMs: 0 });
    mgr.registerRotator('api-key', async () => ({ secret: 'g2' }));
    mgr.registerRotator('token',   async () => { throw new Error('boom'); });
    const res = await mgr.runOnce();
    assert.equal(res.rotated, 1);
    assert.equal(res.failed, 1);
    const goodMeta = vault.listByAgent('a').find(m => m.name === 'good')!;
    const badMeta  = vault.listByAgent('a').find(m => m.name === 'bad')!;
    assert.equal(vault.resolveSecret(goodMeta.id), 'g2');
    assert.equal(vault.resolveSecret(badMeta.id), 'b1');
  } finally {
    cleanup();
  }
});

test('start/stop set up a sweep timer that does not block the event loop', async () => {
  const { vault, cleanup } = newVault();
  try {
    const mgr = new CredentialRotationManager(vault, { checkIntervalMs: 5 });
    mgr.start();
    // Immediately stop — exercising the idempotent path.
    mgr.stop();
    mgr.stop();
    // No assertion on timing — the test is just confirming start/stop don't
    // throw and the timer's unref allows the process to exit cleanly.
    assert.equal(mgr.getStatus().lastSweep, null);
  } finally {
    cleanup();
  }
});

test('getStatus surfaces the most recent sweep result', async () => {
  const { vault, cleanup } = newVault();
  try {
    vault.upsert({
      agentId: 'a', name: 'k', scope: 'use', secret: 's',
      kind: 'api-key',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const mgr = new CredentialRotationManager(vault, { warnBeforeMs: 0 });
    mgr.registerRotator('api-key', async () => ({ secret: 's2' }));
    await mgr.runOnce();
    const status = mgr.getStatus();
    assert.ok(status.lastSweepAt);
    assert.equal(status.lastSweep!.rotated, 1);
  } finally {
    cleanup();
  }
});

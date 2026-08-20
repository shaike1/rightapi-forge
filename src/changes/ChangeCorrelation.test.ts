import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChangeStore } from './ChangeStore.js';
import { ChangeCorrelation, _testing } from './ChangeCorrelation.js';
import { AssetStore } from '../cmdb/AssetStore.js';

function tmp(prefix: string): { dir: string; changesPath: string; assetsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, changesPath: join(dir, 'changes.db'), assetsPath: join(dir, 'assets.db') };
}

test('correlate: returns empty when incident has neither asset nor server', () => {
  const { dir, changesPath, assetsPath } = tmp('corr-empty-');
  try {
    const c = new ChangeStore(changesPath);
    const a = new AssetStore(assetsPath);
    const cc = new ChangeCorrelation(c, a);
    const result = cc.correlate({ id: 'INC-1', createdAt: new Date().toISOString() });
    assert.deepEqual(result, []);
    c.close(); a.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('correlate: matches changes scoped to the same server in the time window', () => {
  const { dir, changesPath, assetsPath } = tmp('corr-server-');
  try {
    const changes = new ChangeStore(changesPath);
    const assets = new AssetStore(assetsPath);
    const cc = new ChangeCorrelation(changes, assets);

    // One in-window, one out-of-window, one wrong-server. Only the
    // first should surface.
    changes.create({ type: 'deployment', title: 'within',  serverId: 'srv-1' });
    const outOfWindow = changes.create({ type: 'deployment', title: 'older', serverId: 'srv-1' });
    const wrongSrv   = changes.create({ type: 'config',     title: 'other', serverId: 'srv-2' });
    // Backdate the older row by 6 hours.
    (changes as any)['db'].prepare('UPDATE changes SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - 6 * 3600 * 1000).toISOString(), outOfWindow.id,
    );

    const matches = cc.correlate({
      id: 'INC-1',
      createdAt: new Date().toISOString(),
      serverId: 'srv-1',
    });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].change.title, 'within');
    assert.ok(matches[0].score > 0);
    changes.close(); assets.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('correlate: picks up upstream dependencies', () => {
  const { dir, changesPath, assetsPath } = tmp('corr-up-');
  try {
    const changes = new ChangeStore(changesPath);
    const assets = new AssetStore(assetsPath);
    const cc = new ChangeCorrelation(changes, assets);

    // db ← service (service depends_on db), incident on the service.
    // A change on the db should still match via upstream traversal.
    const db = assets.create({ type: 'database', name: 'pg-primary' });
    const svc = assets.create({ type: 'service',  name: 'api' });
    assets.addRelationship(svc.id, db.id, 'depends_on');

    changes.create({
      type: 'config',
      title: 'restart pg',
      assetId: db.id,
      status: 'completed',
      source: 'runbook',
    });

    // The asset's "auto-discovered server" lookup needs an asset row
    // tied to a serverId. Without one, the server-via lookup is a
    // no-op — only the explicit assetId path matters here.
    const correlated = cc.correlate({
      id: 'INC-1',
      createdAt: new Date().toISOString(),
      assetId: svc.id,
    });
    assert.ok(correlated.length >= 1, 'upstream change should be matched');
    const up = correlated.find(r => r.change.assetId === db.id);
    assert.ok(up, 'expected the db change to surface via upstream');
    assert.ok(up!.reason.includes('upstream'));
    changes.close(); assets.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('correlate: failed + runbook-sourced changes outrank completed manual changes', () => {
  const { dir, changesPath, assetsPath } = tmp('corr-score-');
  try {
    const changes = new ChangeStore(changesPath);
    const assets  = new AssetStore(assetsPath);
    const cc = new ChangeCorrelation(changes, assets);

    // Same asset, same time window, different (status, source). The
    // failed runbook should beat the completed manual edit on score.
    const a = assets.create({ type: 'service', name: 'app' });
    const failedRunbook  = changes.create({ type: 'auto-remediation', title: 'restart failed', assetId: a.id, status: 'failed',    source: 'runbook' });
    const completedManual = changes.create({ type: 'config',           title: 'tune param',     assetId: a.id, status: 'completed', source: 'manual'  });

    const out = cc.correlate({
      id: 'INC-1',
      createdAt: new Date().toISOString(),
      assetId: a.id,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].change.id, failedRunbook.id, 'failed runbook should rank #1');
    assert.equal(out[1].change.id, completedManual.id);
    assert.ok(out[0].score > out[1].score);
    changes.close(); assets.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('correlate: respects maxResults', () => {
  const { dir, changesPath, assetsPath } = tmp('corr-max-');
  try {
    const changes = new ChangeStore(changesPath);
    const assets  = new AssetStore(assetsPath);
    const cc = new ChangeCorrelation(changes, assets);
    const a = assets.create({ type: 'service', name: 's' });
    for (let i = 0; i < 7; i++) changes.create({ type: 'config', title: `t${i}`, assetId: a.id });
    const out = cc.correlate({ id: 'INC-1', createdAt: new Date().toISOString(), assetId: a.id }, { maxResults: 3 });
    assert.equal(out.length, 3);
    changes.close(); assets.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('correlate: ignores changes older than the configured window', () => {
  const { dir, changesPath, assetsPath } = tmp('corr-win-');
  try {
    const changes = new ChangeStore(changesPath);
    const assets  = new AssetStore(assetsPath);
    const cc = new ChangeCorrelation(changes, assets);
    const a = assets.create({ type: 'service', name: 's' });
    const stale = changes.create({ type: 'config', title: 'ancient', assetId: a.id });
    (changes as any)['db'].prepare('UPDATE changes SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - 24 * 3600 * 1000).toISOString(), stale.id,
    );
    const out = cc.correlate({ id: 'INC-1', createdAt: new Date().toISOString(), assetId: a.id });
    assert.equal(out.length, 0, '24h-old row falls outside the default 2h window');
    changes.close(); assets.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('_testing.bucketize maps scores to likelihood', () => {
  assert.equal(_testing.bucketize(0.8), 'likely');
  assert.equal(_testing.bucketize(0.5), 'possible');
  assert.equal(_testing.bucketize(0.2), 'recent');
});

test('_testing.scoreChange degrades with time and proximity', () => {
  const at = new Date('2026-01-01T12:00:00.000Z');
  const window = 2 * 3600 * 1000;
  // Fresh, direct asset, failed runbook — should be highest.
  const fresh = _testing.scoreChange(
    { id: 'A', type: 'auto-remediation', status: 'failed', riskLevel: 'medium', assetId: 'a', serverId: null, title: '', description: '', createdBy: null, scheduledAt: null, startedAt: null, completedAt: null, source: 'runbook', relatedRunbookRunId: null, relatedIncidentId: null, metadata: {}, createdAt: new Date(at.getTime() - 60_000).toISOString(), updatedAt: at.toISOString() } as any,
    at, window, 0, 'direct',
  );
  // Old, upstream depth 2, manual completed — should be much lower.
  const old = _testing.scoreChange(
    { id: 'B', type: 'config', status: 'completed', riskLevel: 'medium', assetId: 'b', serverId: null, title: '', description: '', createdBy: null, scheduledAt: null, startedAt: null, completedAt: null, source: 'manual', relatedRunbookRunId: null, relatedIncidentId: null, metadata: {}, createdAt: new Date(at.getTime() - 1.8 * 3600 * 1000).toISOString(), updatedAt: at.toISOString() } as any,
    at, window, 2, 'upstream',
  );
  assert.ok(fresh.score > old.score, `fresh ${fresh.score} should outscore old ${old.score}`);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DataLifecycleManager } from './DataLifecycleManager.js';

test('dry run is non-destructive and execute archives before pruning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
  const dbPath = path.join(root, 'events.db');
  const jsonPath = path.join(root, 'runs.json');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, old INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO events (old) VALUES (?)');
  for (let index = 0; index < 500; index++) insert.run(index < 400 ? 1 : 0);
  db.close();
  fs.writeFileSync(jsonPath, JSON.stringify([{ id: 1 }, { id: 2 }]));

  const countOld = () => {
    const current = new Database(dbPath);
    try { return (current.prepare('SELECT COUNT(*) AS n FROM events WHERE old = 1').get() as { n: number }).n; }
    finally { current.close(); }
  };
  const manager = new DataLifecycleManager({
    archiveRoot: path.join(root, 'archive'),
    statePath: path.join(root, 'last-run.json'),
    sources: [
      { name: 'events', sourcePath: dbPath, kind: 'sqlite', required: true },
      { name: 'runs', sourcePath: jsonPath, kind: 'json', required: true },
    ],
    resources: [{
      name: 'events', retentionDays: 90, preview: countOld,
      prune: () => {
        const current = new Database(dbPath);
        try { return current.prepare('DELETE FROM events WHERE old = 1').run().changes; }
        finally { current.close(); }
      },
    }],
  });

  const preview = await manager.run({ dryRun: true });
  assert.equal(preview.totalCandidates, 400);
  assert.equal(preview.totalDeleted, 0);
  assert.equal(countOld(), 400);
  assert.equal(manager.listCheckpoints().length, 0);

  const executed = await manager.run({ dryRun: false });
  assert.equal(executed.totalDeleted, 400);
  assert.equal(countOld(), 0);
  assert.ok(executed.checkpoint);
  assert.equal(manager.verifyCheckpoint(executed.checkpoint!.id).ok, true);

  const restoreDir = path.join(root, 'restore');
  const restored = manager.restoreCheckpointTo(executed.checkpoint!.id, restoreDir);
  const restoredDb = new Database(restored.restored.find(file => file.endsWith('.db'))!, { readonly: true });
  assert.equal((restoredDb.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 500);
  restoredDb.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkpoint failure prevents deletion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-fail-'));
  let pruned = false;
  const manager = new DataLifecycleManager({
    archiveRoot: path.join(root, 'archive'), statePath: path.join(root, 'state.json'),
    sources: [{ name: 'missing', sourcePath: path.join(root, 'missing.db'), kind: 'sqlite', required: true }],
    resources: [{ name: 'events', retentionDays: 1, preview: () => 1, prune: () => { pruned = true; return 1; } }],
  });
  await assert.rejects(manager.run({ dryRun: false }), /required lifecycle source is not healthy/);
  assert.equal(pruned, false);
  fs.rmSync(root, { recursive: true, force: true });
});

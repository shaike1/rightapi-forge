import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RecoverySetManager } from './RecoverySetManager.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-recovery-set-test-'));
  const statePath = path.join(root, 'state', 'backup-test.json');
  const sqliteDir = path.join(root, 'sqlite');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(sqliteDir, { recursive: true });
  fs.writeFileSync(statePath, '{"encrypted":"STATE_SECRET"}');

  const stateBackupManager = {
    create: () => ({
      id: 'backup-test', createdAt: new Date().toISOString(), bundlePath: statePath,
      fileCount: 1, existingFileCount: 1, encrypted: true,
    }),
    verify: () => ({ ok: true }),
  };
  const sqliteBackupRunner = {
    runOnce: async () => {
      const one = path.join(sqliteDir, 'one.db');
      const two = path.join(sqliteDir, 'two.db');
      fs.writeFileSync(one, 'SQLITE_SECRET_ONE');
      fs.writeFileSync(two, 'SQLITE_SECRET_TWO');
      const now = new Date().toISOString();
      return {
        startedAt: now, finishedAt: now, durationMs: 1, destDir: sqliteDir,
        results: [
          { name: 'one', ok: true, bytes: 17, durationMs: 1, destPath: one },
          { name: 'two', ok: true, bytes: 17, durationMs: 1, destPath: two },
        ],
        successCount: 2, failureCount: 0, prunedDirs: [],
      };
    },
  };
  return { root, stateBackupManager, sqliteBackupRunner };
}

test('creates an opaque verified recovery set and restores it to an isolated directory', async () => {
  const f = fixture();
  try {
    const manager = new RecoverySetManager({
      rootDir: f.root,
      encryptionSecret: 'recovery-secret-that-is-definitely-32-characters',
      stateBackupManager: f.stateBackupManager,
      sqliteBackupRunner: f.sqliteBackupRunner,
    });
    const recovery = await manager.create({ actorId: 'test' });
    const raw = fs.readFileSync(recovery.archivePath);
    assert.doesNotMatch(raw.toString('utf8'), /STATE_SECRET|SQLITE_SECRET/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(recovery.archivePath).mode & 0o777, 0o600);
    assert.equal(recovery.sqliteCount, 2);

    const verified = await manager.verify(recovery.archivePath);
    assert.equal(verified.ok, true);
    assert.equal(verified.manifest?.entries.length, 3);

    const target = path.join(f.root, 'restore-target');
    const manifest = await manager.restoreTo(recovery.archivePath, target);
    assert.equal(manifest.id, recovery.id);
    assert.equal(fs.readFileSync(path.join(target, 'sqlite', 'one.db'), 'utf8'), 'SQLITE_SECRET_ONE');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('rejects tampered archives, wrong keys, incomplete database backups, and non-empty targets', async () => {
  const f = fixture();
  try {
    const manager = new RecoverySetManager({
      rootDir: f.root,
      encryptionSecret: 'correct-recovery-secret-at-least-32-characters',
      stateBackupManager: f.stateBackupManager,
      sqliteBackupRunner: f.sqliteBackupRunner,
    });
    const recovery = await manager.create();
    const bytes = fs.readFileSync(recovery.archivePath);
    bytes[bytes.length - 20] ^= 0xff;
    fs.writeFileSync(recovery.archivePath, bytes);
    assert.equal((await manager.verify(recovery.archivePath)).ok, false);

    const wrongKey = new RecoverySetManager({
      rootDir: f.root,
      encryptionSecret: 'wrong-recovery-secret-at-least-32-characters',
      stateBackupManager: f.stateBackupManager,
      sqliteBackupRunner: f.sqliteBackupRunner,
    });
    assert.equal((await wrongKey.verify(recovery.archivePath)).ok, false);

    const target = path.join(f.root, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'do not replace');
    await assert.rejects(() => manager.restoreTo(recovery.archivePath, target), /must be empty/);

    const incomplete = new RecoverySetManager({
      rootDir: f.root,
      encryptionSecret: 'correct-recovery-secret-at-least-32-characters',
      stateBackupManager: f.stateBackupManager,
      sqliteBackupRunner: {
        runOnce: async () => ({
          startedAt: '', finishedAt: '', durationMs: 0, destDir: '', results: [
            { name: 'broken', ok: false, durationMs: 1, error: 'failed' },
          ], successCount: 0, failureCount: 1, prunedDirs: [],
        }),
      },
    });
    await assert.rejects(() => incomplete.create(), /SQLite backup incomplete: broken/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

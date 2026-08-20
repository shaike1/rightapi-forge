import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { SqliteBackupRunner } from './SqliteBackupRunner.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'itops-sqlite-bk-'));
}

test('SqliteBackupRunner copies every registered path into a dated folder', async () => {
  const root = tmpDir();
  const dbDir = tmpDir();
  const a = path.join(dbDir, 'a.db');
  const b = path.join(dbDir, 'b.db');
  const dbA = new Database(a);
  const dbB = new Database(b);
  try {
    dbA.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1), (2), (3);');
    dbB.exec("CREATE TABLE u(y TEXT); INSERT INTO u VALUES ('hi');");
  } finally {
    dbA.close(); dbB.close();
  }

  const fixedNow = new Date('2026-05-13T10:00:00Z');
  const runner = new SqliteBackupRunner({ destRoot: root, retentionDays: 14, now: () => fixedNow });
  runner.register({ name: 'a', sourcePath: a });
  runner.register({ name: 'b', sourcePath: b });

  const report = await runner.runOnce();
  try {
    assert.equal(report.successCount, 2);
    assert.equal(report.failureCount, 0);
    const destDir = path.join(root, '2026-05-13');
    assert.ok(fs.existsSync(path.join(destDir, 'a.db')));
    assert.ok(fs.existsSync(path.join(destDir, 'b.db')));

    // Re-open the backup and assert the row count survived.
    const dbACopy = new Database(path.join(destDir, 'a.db'), { readonly: true });
    try {
      const n = (dbACopy.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
      assert.equal(n, 3);
    } finally { dbACopy.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test('SqliteBackupRunner prunes dated dirs older than retentionDays', async () => {
  const root = tmpDir();
  const old1 = path.join(root, '2026-01-01'); fs.mkdirSync(old1);
  const old2 = path.join(root, '2026-02-01'); fs.mkdirSync(old2);
  const oldTime = new Date('2026-01-01T00:00:00Z').getTime() / 1000;
  fs.utimesSync(old1, oldTime, oldTime);
  fs.utimesSync(old2, oldTime, oldTime);

  const dbPath = path.join(tmpDir(), 'x.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t(x INTEGER);');
  db.close();

  const fixedNow = new Date('2026-05-13T10:00:00Z');
  const runner = new SqliteBackupRunner({ destRoot: root, retentionDays: 14, now: () => fixedNow });
  runner.register({ name: 'x', sourcePath: dbPath });
  const report = await runner.runOnce();
  try {
    assert.equal(report.prunedDirs.length, 2);
    assert.ok(!fs.existsSync(old1));
    assert.ok(!fs.existsSync(old2));
    assert.ok(fs.existsSync(path.join(root, '2026-05-13', 'x.db')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('SqliteBackupRunner reports per-target failures without aborting', async () => {
  const root = tmpDir();
  const okPath = path.join(tmpDir(), 'ok.db');
  const ok = new Database(okPath);
  ok.exec('CREATE TABLE t(x);');
  ok.close();
  // Fake target with an injected db whose backup throws.
  const bad = { backup: async () => { throw new Error('disk full'); } };

  const runner = new SqliteBackupRunner({ destRoot: root });
  runner.register({ name: 'ok',  sourcePath: okPath });
  runner.register({ name: 'bad', sourcePath: 'never', db: bad });
  const report = await runner.runOnce();
  try {
    assert.equal(report.successCount, 1);
    assert.equal(report.failureCount, 1);
    assert.equal(report.results.find(r => r.name === 'bad')?.error, 'disk full');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(okPath), { recursive: true, force: true });
  }
});

test('SqliteBackupRunner listSnapshots returns dated folders newest-first', async () => {
  const root = tmpDir();
  for (const date of ['2026-05-01', '2026-05-02', '2026-05-03']) {
    const dir = path.join(root, date);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.db'), Buffer.alloc(100));
    fs.writeFileSync(path.join(dir, 'b.db'), Buffer.alloc(50));
  }
  const runner = new SqliteBackupRunner({ destRoot: root });
  const snaps = runner.listSnapshots();
  assert.equal(snaps.length, 3);
  assert.equal(snaps[0].date, '2026-05-03');
  assert.equal(snaps[0].files, 2);
  assert.equal(snaps[0].bytes, 150);
  fs.rmSync(root, { recursive: true, force: true });
});

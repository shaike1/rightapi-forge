import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { SqliteVacuumRunner } from './SqliteVacuumRunner.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'itops-vacuum-'));
}

test('SqliteVacuumRunner vacuums every registered path and returns a report', async () => {
  const dir = tmpDir();
  const aPath = path.join(dir, 'a.db');
  const bPath = path.join(dir, 'b.db');
  const a = new Database(aPath);
  const b = new Database(bPath);
  try {
    a.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1), (2);");
    b.exec("CREATE TABLE u(y); INSERT INTO u VALUES ('a');");
    a.exec("DELETE FROM t");
  } finally {
    a.close(); b.close();
  }

  const runner = new SqliteVacuumRunner();
  runner.register({ name: 'a', sourcePath: aPath });
  runner.register({ name: 'b', sourcePath: bPath });

  const report = await runner.runOnce();
  assert.equal(report.successCount, 2);
  assert.equal(report.failureCount, 0);
  assert.ok(report.results.find(r => r.name === 'a' && r.ok));
  assert.ok(report.results.find(r => r.name === 'b' && r.ok));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('SqliteVacuumRunner collects per-DB failures', async () => {
  const bad = { pragma: () => null, exec: () => { throw new Error('locked'); } };
  const runner = new SqliteVacuumRunner();
  runner.register({ name: 'bad', sourcePath: '/nonexistent.db', db: bad });

  const report = await runner.runOnce();
  assert.equal(report.successCount, 0);
  assert.equal(report.failureCount, 1);
  assert.equal(report.results[0].error, 'locked');
});

test('SqliteVacuumRunner reports source-not-found cleanly', async () => {
  const runner = new SqliteVacuumRunner();
  runner.register({ name: 'missing', sourcePath: '/tmp/itops-vacuum-not-there.db' });
  const report = await runner.runOnce();
  assert.equal(report.failureCount, 1);
  assert.match(report.results[0].error ?? '', /does not exist/);
});

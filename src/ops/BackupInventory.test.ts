import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildBackupInventory, planBackupCoverage } from './BackupInventory.js';

test('buildBackupInventory classifies coverage and excludes transient backup files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-backup-inventory-'));
  try {
    fs.mkdirSync(path.join(root, 'audit'));
    fs.mkdirSync(path.join(root, 'backups'));
    fs.writeFileSync(path.join(root, 'tasks.db'), 'db');
    fs.writeFileSync(path.join(root, 'legacy.db'), 'db');
    fs.writeFileSync(path.join(root, 'tasks.db-wal'), 'wal');
    fs.writeFileSync(path.join(root, 'config.json'), '{}');
    fs.writeFileSync(path.join(root, 'audit', 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(root, 'orphan.json'), '{}');
    fs.writeFileSync(path.join(root, 'backups', 'old.json'), '{}');

    const report = buildBackupInventory({
      dataRoot: root,
      stateTargets: [
        { key: 'config', filePath: path.join(root, 'config.json'), required: true },
        { key: 'legacy-db-copy', filePath: path.join(root, 'legacy.db'), required: true },
      ],
      sqliteTargets: [{ key: 'tasks', filePath: path.join(root, 'tasks.db'), required: true }],
      volumes: [{
        name: 'itops-data', service: 'itops-agents', mountPath: root,
        purpose: 'core state', requiredForCoreRestore: true,
      }],
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });

    assert.equal(report.generatedAt, '2026-08-16T00:00:00.000Z');
    assert.deepEqual(report.files.map(file => file.relativePath), [
      'audit/events.jsonl', 'config.json', 'legacy.db', 'orphan.json', 'tasks.db',
    ]);
    assert.equal(report.files.find(file => file.relativePath === 'tasks.db')?.coverage, 'sqlite-online');
    assert.equal(report.files.find(file => file.relativePath === 'config.json')?.coverage, 'state-bundle');
    assert.equal(report.files.find(file => file.relativePath === 'config.json')?.sensitive, true);
    assert.equal(report.files.find(file => file.relativePath === 'orphan.json')?.coverage, 'uncovered');
    assert.deepEqual(report.summary, {
      totalFiles: 5,
      totalBytes: 11,
      databases: 2,
      stateFiles: 3,
      sensitiveFiles: 1,
      coveredFiles: 3,
      uncoveredFiles: 2,
    });
    assert.equal(report.volumes[0].requiredForCoreRestore, true);

    const plan = planBackupCoverage(report);
    assert.deepEqual(plan.stateTargets.map(target => target.key), [
      'discovered:audit/events.jsonl',
      'discovered:orphan.json',
    ]);
    assert.equal(plan.sqliteTargets.length, 1);
    assert.match(plan.sqliteTargets[0].key, /^discovered-legacy-[a-f0-9]{10}$/);
    assert.equal(plan.sqliteTargets[0].filePath, path.join(root, 'legacy.db'));
    assert.equal(plan.sqliteTargets[0].required, true);

    const reconciled = buildBackupInventory({
      dataRoot: root,
      stateTargets: [
        { key: 'config', filePath: path.join(root, 'config.json'), required: true },
        ...plan.stateTargets,
      ],
      sqliteTargets: [
        { key: 'tasks', filePath: path.join(root, 'tasks.db'), required: true },
        ...plan.sqliteTargets,
      ],
      volumes: [],
    });
    assert.equal(reconciled.summary.uncoveredFiles, 0);
    assert.equal(reconciled.files.find(file => file.relativePath === 'legacy.db')?.coverage, 'sqlite-online');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

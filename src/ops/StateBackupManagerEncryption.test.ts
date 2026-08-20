import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateBackupManager } from './StateBackupManager.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-encrypted-backup-'));
  const statePath = path.join(root, 'state', 'credentials.json');
  const emptyPath = path.join(root, 'state', 'events.jsonl');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ token: 'TOP_SECRET_VALUE' }));
  fs.writeFileSync(emptyPath, '');
  return { root, statePath, emptyPath, backupDir };
}

test('encrypted backup hides plaintext and restores only after authentication', () => {
  const f = fixture();
  try {
    const manager = new StateBackupManager(f.backupDir, [
      { key: 'credentials', filePath: f.statePath, required: true },
      { key: 'events', filePath: f.emptyPath, required: false },
    ], { encryptionSecret: 'dedicated-backup-key-at-least-32-characters', requireEncryption: true });
    const backup = manager.create({ label: 'encrypted-test' });
    const raw = fs.readFileSync(backup.bundlePath, 'utf8');

    assert.equal(backup.encrypted, true);
    assert.equal(backup.encryptionAlgorithm, 'aes-256-gcm');
    assert.doesNotMatch(raw, /TOP_SECRET_VALUE|contentBase64/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(backup.bundlePath).mode & 0o777, 0o600);
    }
    assert.equal(manager.verify(backup.id).ok, true);

    fs.writeFileSync(f.statePath, '{}');
    fs.writeFileSync(f.emptyPath, 'changed');
    const restored = manager.restore(backup.id, { dryRun: false });
    assert.equal(restored.restored, true);
    assert.match(fs.readFileSync(f.statePath, 'utf8'), /TOP_SECRET_VALUE/);
    assert.equal(fs.readFileSync(f.emptyPath, 'utf8'), '');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('wrong keys and tampered encrypted bundles fail closed', () => {
  const f = fixture();
  try {
    const manager = new StateBackupManager(f.backupDir, [
      { key: 'credentials', filePath: f.statePath, required: true },
    ], { encryptionSecret: 'correct-key' });
    const backup = manager.create();
    const wrongKey = new StateBackupManager(f.backupDir, [], { encryptionSecret: 'wrong-key' });
    assert.throws(() => wrongKey.verify(backup.id), /different key/);

    const envelope = JSON.parse(fs.readFileSync(backup.bundlePath, 'utf8'));
    envelope.ciphertext = envelope.ciphertext.slice(0, -4) + 'AAAA';
    fs.writeFileSync(backup.bundlePath, JSON.stringify(envelope));
    assert.throws(() => manager.verify(backup.id), /failed authenticated decryption/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('legacy plaintext bundles remain readable and encryption can be required', () => {
  const f = fixture();
  try {
    const legacy = new StateBackupManager(f.backupDir, [
      { key: 'credentials', filePath: f.statePath, required: true },
    ]);
    const backup = legacy.create();
    const encryptedReader = new StateBackupManager(f.backupDir, [], {
      encryptionSecret: 'new-key-at-least-32-characters-long', requireEncryption: true,
    });
    assert.equal(encryptedReader.verify(backup.id).ok, true);
    assert.equal(encryptedReader.list()[0].encrypted, false);
    assert.throws(
      () => new StateBackupManager(f.backupDir, [], { requireEncryption: true }),
      /BACKUP_ENCRYPTION_KEY is required/,
    );
    assert.throws(
      () => new StateBackupManager(f.backupDir, [], { encryptionSecret: 'short', requireEncryption: true }),
      /at least 32 characters/,
    );
    assert.throws(() => encryptedReader.verify('../config'), /Invalid backup id/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('list ignores recovery status and other JSON files in the backup directory', () => {
  const f = fixture();
  try {
    const manager = new StateBackupManager(f.backupDir, [
      { key: 'credentials', filePath: f.statePath, required: true },
    ], { encryptionSecret: 'dedicated-backup-key-at-least-32-characters' });
    const backup = manager.create();
    fs.writeFileSync(path.join(f.backupDir, 'recovery-status.json'), '{"enabled":true}\n');
    fs.writeFileSync(path.join(f.backupDir, 'notes.json'), '{}\n');
    assert.deepEqual(manager.list().map(item => item.id), [backup.id]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

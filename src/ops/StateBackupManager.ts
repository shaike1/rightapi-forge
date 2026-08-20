import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface BackupTargetFile {
  key: string;
  filePath: string;
  required?: boolean;
}

export interface BackupBundle {
  version: number;
  id: string;
  createdAt: string;
  label?: string;
  actorId?: string;
  encryption?: {
    algorithm: 'aes-256-gcm';
    keyId: string;
  };
  files: Array<{
    key: string;
    filePath: string;
    exists: boolean;
    required: boolean;
    sha256?: string;
    bytes?: number;
    contentBase64?: string;
  }>;
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  label?: string;
  actorId?: string;
  bundlePath: string;
  fileCount: number;
  existingFileCount: number;
  encrypted: boolean;
  encryptionAlgorithm?: 'aes-256-gcm';
  keyId?: string;
}

interface EncryptedBackupEnvelope {
  format: 'itops-state-backup';
  version: 2;
  id: string;
  createdAt: string;
  algorithm: 'aes-256-gcm';
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface StateBackupManagerOptions {
  encryptionSecret?: string;
  requireEncryption?: boolean;
}

function sha256(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export class StateBackupManager {
  private backupDir: string;
  private targets: BackupTargetFile[];
  private encryptionKey?: Buffer;
  private keyId?: string;

  constructor(backupDir: string, targets: BackupTargetFile[], opts: StateBackupManagerOptions = {}) {
    this.backupDir = backupDir;
    this.targets = targets;
    if (opts.requireEncryption && !opts.encryptionSecret) {
      throw new Error('BACKUP_ENCRYPTION_KEY is required when backup encryption is enforced');
    }
    if (opts.requireEncryption && opts.encryptionSecret!.length < 32) {
      throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 32 characters');
    }
    if (opts.encryptionSecret) {
      this.encryptionKey = crypto.createHash('sha256').update(opts.encryptionSecret, 'utf8').digest();
      this.keyId = sha256(this.encryptionKey).slice(0, 12);
    }
  }

  create(params?: { label?: string; actorId?: string }): BackupSummary {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const id = `backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const bundle: BackupBundle = {
      version: 1,
      id,
      createdAt,
      label: params?.label,
      actorId: params?.actorId,
      encryption: this.encryptionKey && this.keyId
        ? { algorithm: 'aes-256-gcm', keyId: this.keyId }
        : undefined,
      files: this.targets.map(target => {
        const exists = fs.existsSync(target.filePath);
        if (!exists) {
          return {
            key: target.key,
            filePath: target.filePath,
            exists: false,
            required: !!target.required
          };
        }
        const content = fs.readFileSync(target.filePath);
        return {
          key: target.key,
          filePath: target.filePath,
          exists: true,
          required: !!target.required,
          sha256: sha256(content),
          bytes: content.length,
          contentBase64: content.toString('base64')
        };
      })
    };
    const bundlePath = this.bundlePath(id);
    const serialized = this.encryptionKey && this.keyId
      ? JSON.stringify(this.encryptBundle(bundle), null, 2)
      : JSON.stringify(bundle, null, 2);
    this.atomicWrite(bundlePath, serialized + '\n');
    return this.toSummary(bundle, bundlePath);
  }

  list(limit: number = 50): BackupSummary[] {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const effectiveLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
    const entries = fs.readdirSync(this.backupDir)
      .filter(name => /^backup-\d+-[a-z0-9]+\.json$/.test(name))
      .map(name => path.join(this.backupDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, effectiveLimit);
    return entries.map(bundlePath => {
      const bundle = this.readBundleByPath(bundlePath);
      return this.toSummary(bundle, bundlePath);
    });
  }

  verify(backupId: string): {
    ok: boolean;
    backup: BackupSummary;
    checks: Array<{ key: string; exists: boolean; required: boolean; hashMatches?: boolean; reason?: string }>;
  } {
    const bundle = this.readBundle(backupId);
    const checks = bundle.files.map(file => {
      if (!file.exists) {
        if (file.required) {
          return {
            key: file.key,
            exists: false,
            required: true,
            reason: 'Required file was missing at backup creation time'
          };
        }
        return { key: file.key, exists: false, required: false };
      }
      if (file.contentBase64 === undefined) {
        return {
          key: file.key,
          exists: true,
          required: file.required,
          hashMatches: false,
          reason: 'Missing backup content payload'
        };
      }
      const content = Buffer.from(file.contentBase64, 'base64');
      const hash = sha256(content);
      return {
        key: file.key,
        exists: true,
        required: file.required,
        hashMatches: hash === file.sha256,
        reason: hash === file.sha256 ? undefined : 'SHA256 mismatch in backup bundle'
      };
    });
    const ok = checks.every(c =>
      (c.exists ? c.hashMatches !== false : !c.required)
    );
    return {
      ok,
      backup: this.toSummary(bundle, this.bundlePath(bundle.id)),
      checks
    };
  }

  restore(backupId: string, params?: { dryRun?: boolean; actorId?: string }): {
    restored: boolean;
    dryRun: boolean;
    backup: BackupSummary;
    files: Array<{ key: string; filePath: string; action: 'skip' | 'restore'; reason?: string }>;
  } {
    const bundle = this.readBundle(backupId);
    const verify = this.verify(backupId);
    if (!verify.ok) {
      throw new Error('Backup verification failed. Restore aborted.');
    }

    const dryRun = !!params?.dryRun;
    const actions: Array<{ key: string; filePath: string; action: 'skip' | 'restore'; reason?: string }> = [];

    for (const file of bundle.files) {
      if (!file.exists || file.contentBase64 === undefined) {
        actions.push({
          key: file.key,
          filePath: file.filePath,
          action: 'skip',
          reason: file.required
            ? 'Required file missing in backup bundle'
            : 'Optional file missing in backup bundle'
        });
        continue;
      }
      actions.push({ key: file.key, filePath: file.filePath, action: 'restore' });
      if (dryRun) continue;

      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      if (fs.existsSync(file.filePath)) {
        const previous = fs.readFileSync(file.filePath);
        const backupPath = `${file.filePath}.restore-backup-${Date.now()}`;
        fs.writeFileSync(backupPath, previous);
      }
      fs.writeFileSync(file.filePath, Buffer.from(file.contentBase64, 'base64'));
    }

    return {
      restored: !dryRun,
      dryRun,
      backup: this.toSummary(bundle, this.bundlePath(bundle.id)),
      files: actions
    };
  }

  private bundlePath(backupId: string): string {
    if (!/^backup-[a-zA-Z0-9-]+$/.test(backupId)) {
      throw new Error('Invalid backup id');
    }
    return path.join(this.backupDir, `${backupId}.json`);
  }

  private readBundle(backupId: string): BackupBundle {
    return this.readBundleByPath(this.bundlePath(backupId));
  }

  private readBundleByPath(bundlePath: string): BackupBundle {
    if (!fs.existsSync(bundlePath)) {
      throw new Error(`Backup bundle not found: ${bundlePath}`);
    }
    const raw = fs.readFileSync(bundlePath, 'utf8');
    const parsedValue = JSON.parse(raw) as BackupBundle | EncryptedBackupEnvelope;
    const parsed = this.isEncryptedEnvelope(parsedValue)
      ? this.decryptEnvelope(parsedValue)
      : parsedValue as BackupBundle;
    if (!parsed?.id || !Array.isArray(parsed.files)) {
      throw new Error(`Invalid backup bundle format: ${bundlePath}`);
    }
    return parsed;
  }

  private toSummary(bundle: BackupBundle, bundlePath: string): BackupSummary {
    return {
      id: bundle.id,
      createdAt: bundle.createdAt,
      label: bundle.label,
      actorId: bundle.actorId,
      bundlePath,
      fileCount: bundle.files.length,
      existingFileCount: bundle.files.filter(f => f.exists).length,
      encrypted: !!bundle.encryption,
      encryptionAlgorithm: bundle.encryption?.algorithm,
      keyId: bundle.encryption?.keyId,
    };
  }

  private encryptBundle(bundle: BackupBundle): EncryptedBackupEnvelope {
    if (!this.encryptionKey || !this.keyId) throw new Error('Backup encryption key is not configured');
    const iv = crypto.randomBytes(12);
    const metadata = {
      format: 'itops-state-backup' as const,
      version: 2 as const,
      id: bundle.id,
      createdAt: bundle.createdAt,
      algorithm: 'aes-256-gcm' as const,
      keyId: this.keyId,
    };
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(metadata), 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(bundle), 'utf8'),
      cipher.final(),
    ]);
    return {
      ...metadata,
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decryptEnvelope(envelope: EncryptedBackupEnvelope): BackupBundle {
    if (!this.encryptionKey || !this.keyId) {
      throw new Error(`Backup ${envelope.id} is encrypted but BACKUP_ENCRYPTION_KEY is not configured`);
    }
    if (envelope.keyId !== this.keyId) {
      throw new Error(`Backup ${envelope.id} was encrypted with a different key`);
    }
    const metadata = {
      format: envelope.format,
      version: envelope.version,
      id: envelope.id,
      createdAt: envelope.createdAt,
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
    };
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from(JSON.stringify(metadata), 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as BackupBundle;
    } catch {
      throw new Error(`Backup ${envelope.id} failed authenticated decryption`);
    }
  }

  private isEncryptedEnvelope(value: BackupBundle | EncryptedBackupEnvelope): value is EncryptedBackupEnvelope {
    return (value as EncryptedBackupEnvelope)?.format === 'itops-state-backup'
      && (value as EncryptedBackupEnvelope)?.version === 2;
  }

  private atomicWrite(filePath: string, content: string): void {
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  /**
   * Get backup statistics for dashboard overview
   */
  getStatistics(): {
    totalBackups: number;
    totalSizeBytes: number;
    oldestBackup?: { id: string; createdAt: string };
    newestBackup?: { id: string; createdAt: string };
    backupsInLast24h: number;
    backupsInLast7d: number;
    backupsInLast30d: number;
  } {
    const backups = this.list(10000);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    let totalSizeBytes = 0;
    backups.forEach(b => {
      try {
        const stats = require('fs').statSync(b.bundlePath);
        totalSizeBytes += stats.size;
      } catch {
        // Ignore stat errors
      }
    });

    return {
      totalBackups: backups.length,
      totalSizeBytes,
      oldestBackup: backups.length > 0 ? {
        id: backups[backups.length - 1].id,
        createdAt: backups[backups.length - 1].createdAt
      } : undefined,
      newestBackup: backups.length > 0 ? {
        id: backups[0].id,
        createdAt: backups[0].createdAt
      } : undefined,
      backupsInLast24h: backups.filter(b => now - new Date(b.createdAt).getTime() <= dayMs).length,
      backupsInLast7d: backups.filter(b => now - new Date(b.createdAt).getTime() <= dayMs * 7).length,
      backupsInLast30d: backups.filter(b => now - new Date(b.createdAt).getTime() <= dayMs * 30).length
    };
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { BackupSummary } from '../ops/StateBackupManager.js';
import type { SqliteBackupReport } from '../ops/SqliteBackupRunner.js';

const execFileAsync = promisify(execFile);
const MAGIC = Buffer.from('ITOPS-RECOVERY-V1\n', 'ascii');
const AUTH_TAG_BYTES = 16;

interface StateBackupLike {
  create: (params?: { label?: string; actorId?: string }) => BackupSummary;
  verify: (backupId: string) => { ok: boolean };
}

interface SqliteBackupLike {
  runOnce: () => Promise<SqliteBackupReport>;
}

export interface RecoveryManifestEntry {
  path: string;
  source: string;
  bytes: number;
  sha256: string;
}

export interface RecoveryManifest {
  format: 'itops-recovery-set';
  version: 1;
  id: string;
  createdAt: string;
  stateBackupId: string;
  sqliteStartedAt: string;
  entries: RecoveryManifestEntry[];
}

export interface RecoverySetSummary {
  id: string;
  createdAt: string;
  archivePath: string;
  bytes: number;
  sha256: string;
  keyId: string;
  stateBackupId: string;
  sqliteCount: number;
}

export interface StoredRecoverySet {
  id: string;
  archivePath: string;
  createdAt: string;
  bytes: number;
}

interface RecoverySetManagerOptions {
  rootDir: string;
  encryptionSecret: string;
  stateBackupManager: StateBackupLike;
  sqliteBackupRunner: SqliteBackupLike;
  tarCommand?: string;
}

interface EnvelopeHeader {
  format: 'itops-recovery-envelope';
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  iv: string;
}

export class RecoverySetManager {
  private readonly archiveDir: string;
  private readonly key: Buffer;
  private readonly keyId: string;
  private readonly tarCommand: string;

  constructor(private readonly opts: RecoverySetManagerOptions) {
    if (opts.encryptionSecret.length < 32) {
      throw new Error('Recovery-set encryption secret must contain at least 32 characters');
    }
    this.archiveDir = path.join(opts.rootDir, 'recovery');
    this.key = crypto.createHash('sha256').update(opts.encryptionSecret, 'utf8').digest();
    this.keyId = crypto.createHash('sha256').update(this.key).digest('hex').slice(0, 12);
    this.tarCommand = opts.tarCommand || 'tar';
  }

  async create(params: { label?: string; actorId?: string } = {}): Promise<RecoverySetSummary> {
    fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    const id = `recovery-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-recovery-create-'));
    const plainArchive = path.join(workDir, `${id}.tar.gz`);
    const archivePath = path.join(this.archiveDir, `${id}.itops-recovery`);

    try {
      const state = this.opts.stateBackupManager.create(params);
      if (!state.encrypted) throw new Error('Recovery set requires an encrypted state backup');
      if (!this.opts.stateBackupManager.verify(state.id).ok) throw new Error('State backup verification failed');

      const sqlite = await this.opts.sqliteBackupRunner.runOnce();
      if (sqlite.failureCount > 0 || sqlite.successCount === 0) {
        const failures = sqlite.results.filter(result => !result.ok).map(result => result.name).join(', ');
        throw new Error(`SQLite backup incomplete: ${failures || 'no successful targets'}`);
      }

      const entries: RecoveryManifestEntry[] = [];
      this.stageFile(state.bundlePath, path.join(workDir, 'payload', 'state', path.basename(state.bundlePath)), 'state', entries);
      for (const result of sqlite.results) {
        if (!result.ok || !result.destPath) continue;
        this.stageFile(result.destPath, path.join(workDir, 'payload', 'sqlite', `${result.name}.db`), `sqlite:${result.name}`, entries);
      }

      const manifest: RecoveryManifest = {
        format: 'itops-recovery-set',
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        stateBackupId: state.id,
        sqliteStartedAt: sqlite.startedAt,
        entries,
      };
      fs.writeFileSync(path.join(workDir, 'payload', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await execFileAsync(this.tarCommand, ['-czf', plainArchive, '-C', path.join(workDir, 'payload'), '.']);
      await this.encryptFile(plainArchive, archivePath);
      fs.chmodSync(archivePath, 0o600);

      const verification = await this.verify(archivePath);
      if (!verification.ok) throw new Error(`Recovery-set verification failed: ${verification.error}`);
      return {
        id,
        createdAt: manifest.createdAt,
        archivePath,
        bytes: fs.statSync(archivePath).size,
        sha256: hashFile(archivePath),
        keyId: this.keyId,
        stateBackupId: state.id,
        sqliteCount: sqlite.successCount,
      };
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      throw error;
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  list(limit = 50): StoredRecoverySet[] {
    fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    return fs.readdirSync(this.archiveDir)
      .filter(name => /^recovery-\d+-[a-f0-9]{6}\.itops-recovery$/.test(name))
      .map(name => {
        const archivePath = path.join(this.archiveDir, name);
        const stat = fs.statSync(archivePath);
        return {
          id: name.replace(/\.itops-recovery$/, ''), archivePath,
          createdAt: stat.mtime.toISOString(), bytes: stat.size,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(Math.max(Math.floor(limit), 1), 500));
  }

  resolveArchivePath(id: string): string {
    if (!/^recovery-\d+-[a-f0-9]{6}$/.test(id)) throw new Error('Invalid recovery-set id');
    const archivePath = path.join(this.archiveDir, `${id}.itops-recovery`);
    if (!fs.existsSync(archivePath)) throw new Error('Recovery set not found');
    return archivePath;
  }

  prune(keepLatest: number, maxAgeDays: number): number {
    const keep = Math.max(1, Math.floor(keepLatest));
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const item of this.list(500).slice(keep)) {
      if (Date.parse(item.createdAt) >= cutoff) continue;
      fs.rmSync(item.archivePath, { force: true });
      deleted++;
    }
    return deleted;
  }

  async verify(archivePath: string): Promise<{ ok: boolean; manifest?: RecoveryManifest; error?: string }> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-recovery-verify-'));
    try {
      const plainArchive = path.join(workDir, 'payload.tar.gz');
      const extractDir = path.join(workDir, 'extract');
      fs.mkdirSync(extractDir);
      await this.decryptFile(archivePath, plainArchive);
      const { stdout } = await execFileAsync(this.tarCommand, ['-tzf', plainArchive]);
      const unsafe = stdout.split(/\r?\n/).filter(Boolean).find(entry => path.isAbsolute(entry) || entry.split('/').includes('..'));
      if (unsafe) throw new Error(`Unsafe archive entry: ${unsafe}`);
      await execFileAsync(this.tarCommand, ['-xzf', plainArchive, '-C', extractDir]);
      const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf8')) as RecoveryManifest;
      if (manifest.format !== 'itops-recovery-set' || manifest.version !== 1) throw new Error('Unsupported recovery manifest');
      for (const entry of manifest.entries) {
        const filePath = path.resolve(extractDir, entry.path);
        if (!filePath.startsWith(`${path.resolve(extractDir)}${path.sep}`)) throw new Error(`Unsafe manifest path: ${entry.path}`);
        if (!fs.existsSync(filePath)) throw new Error(`Missing recovery entry: ${entry.path}`);
        if (fs.statSync(filePath).size !== entry.bytes || hashFile(filePath) !== entry.sha256) {
          throw new Error(`Integrity check failed: ${entry.path}`);
        }
      }
      return { ok: true, manifest };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  async restoreTo(archivePath: string, targetDir: string): Promise<RecoveryManifest> {
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      throw new Error('Recovery target directory must be empty');
    }
    const verified = await this.verify(archivePath);
    if (!verified.ok || !verified.manifest) throw new Error(verified.error || 'Recovery-set verification failed');
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const plainArchive = path.join(targetDir, '.recovery.tar.gz');
    try {
      await this.decryptFile(archivePath, plainArchive);
      await execFileAsync(this.tarCommand, ['-xzf', plainArchive, '-C', targetDir]);
      return verified.manifest;
    } finally {
      fs.rmSync(plainArchive, { force: true });
    }
  }

  private stageFile(source: string, destination: string, sourceLabel: string, entries: RecoveryManifestEntry[]): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try { fs.linkSync(source, destination); } catch { fs.copyFileSync(source, destination); }
    const relative = path.relative(path.join(destination, '..', '..'), destination).split(path.sep).join('/');
    entries.push({ path: relative, source: sourceLabel, bytes: fs.statSync(destination).size, sha256: hashFile(destination) });
  }

  private async encryptFile(source: string, destination: string): Promise<void> {
    const iv = crypto.randomBytes(12);
    const header: EnvelopeHeader = {
      format: 'itops-recovery-envelope', version: 1, algorithm: 'aes-256-gcm', keyId: this.keyId, iv: iv.toString('base64'),
    };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(MAGIC.length + 4 + headerBytes.length);
    MAGIC.copy(prefix, 0);
    prefix.writeUInt32BE(headerBytes.length, MAGIC.length);
    headerBytes.copy(prefix, MAGIC.length + 4);
    fs.writeFileSync(destination, prefix, { mode: 0o600 });
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(headerBytes);
    await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(destination, { flags: 'a' }));
    fs.appendFileSync(destination, cipher.getAuthTag());
  }

  private async decryptFile(source: string, destination: string): Promise<void> {
    const fd = fs.openSync(source, 'r');
    try {
      const fixed = Buffer.alloc(MAGIC.length + 4);
      if (fs.readSync(fd, fixed, 0, fixed.length, 0) !== fixed.length || !fixed.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('Invalid recovery envelope');
      }
      const headerLength = fixed.readUInt32BE(MAGIC.length);
      if (headerLength < 1 || headerLength > 16 * 1024) throw new Error('Invalid recovery envelope header');
      const headerBytes = Buffer.alloc(headerLength);
      fs.readSync(fd, headerBytes, 0, headerLength, fixed.length);
      const header = JSON.parse(headerBytes.toString('utf8')) as EnvelopeHeader;
      if (header.format !== 'itops-recovery-envelope' || header.keyId !== this.keyId) throw new Error('Recovery archive uses a different key');
      const stat = fs.fstatSync(fd);
      const cipherStart = fixed.length + headerLength;
      const cipherEnd = stat.size - AUTH_TAG_BYTES - 1;
      if (cipherEnd < cipherStart) throw new Error('Truncated recovery envelope');
      const tag = Buffer.alloc(AUTH_TAG_BYTES);
      fs.readSync(fd, tag, 0, AUTH_TAG_BYTES, stat.size - AUTH_TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(header.iv, 'base64'));
      decipher.setAAD(headerBytes);
      decipher.setAuthTag(tag);
      await pipeline(fs.createReadStream(source, { start: cipherStart, end: cipherEnd }), decipher, fs.createWriteStream(destination, { mode: 0o600 }));
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw new Error(`Recovery archive authentication failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      fs.closeSync(fd);
    }
  }
}

function hashFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

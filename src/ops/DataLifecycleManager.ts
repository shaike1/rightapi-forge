import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export type LifecycleSourceKind = 'sqlite' | 'json';

export interface LifecycleSource {
  name: string;
  sourcePath: string;
  kind: LifecycleSourceKind;
  required?: boolean;
}

export interface LifecycleResource {
  name: string;
  retentionDays: number;
  preview: () => number | Promise<number>;
  prune: () => number | Promise<number>;
}

export interface LifecycleInventoryItem {
  name: string;
  sourcePath: string;
  kind: LifecycleSourceKind;
  exists: boolean;
  bytes: number;
  records: number;
  integrity: 'ok' | 'missing' | 'failed';
  error?: string;
}

export interface LifecycleCheckpointFile {
  name: string;
  kind: LifecycleSourceKind;
  sourcePath: string;
  archivePath: string;
  bytes: number;
  sha256: string;
  integrity: 'ok';
}

export interface LifecycleCheckpointManifest {
  id: string;
  createdAt: string;
  verifiedAt: string;
  files: LifecycleCheckpointFile[];
}

export interface LifecycleRunReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  candidates: Record<string, number>;
  deleted: Record<string, number>;
  totalCandidates: number;
  totalDeleted: number;
  checkpoint?: LifecycleCheckpointManifest;
  before: LifecycleInventoryItem[];
  after: LifecycleInventoryItem[];
}

export class DataLifecycleManager {
  private running?: Promise<LifecycleRunReport>;

  constructor(
    private readonly options: {
      archiveRoot: string;
      statePath: string;
      sources: LifecycleSource[];
      resources: LifecycleResource[];
      now?: () => Date;
    },
  ) {}

  inventory(): LifecycleInventoryItem[] {
    return this.options.sources.map(source => inspectSource(source));
  }

  policy(): Array<{ name: string; retentionDays: number }> {
    return this.options.resources.map(({ name, retentionDays }) => ({ name, retentionDays }));
  }

  lastRun(): LifecycleRunReport | null {
    try {
      return JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) as LifecycleRunReport;
    } catch {
      return null;
    }
  }

  run(input: { dryRun?: boolean } = {}): Promise<LifecycleRunReport> {
    if (this.running) return this.running;
    this.running = this.runInternal(input).finally(() => { this.running = undefined; });
    return this.running;
  }

  listCheckpoints(): LifecycleCheckpointManifest[] {
    if (!fs.existsSync(this.options.archiveRoot)) return [];
    const manifests: LifecycleCheckpointManifest[] = [];
    for (const entry of fs.readdirSync(this.options.archiveRoot)) {
      const manifestPath = path.join(this.options.archiveRoot, entry, 'manifest.json');
      try { manifests.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as LifecycleCheckpointManifest); } catch { /* incomplete checkpoint */ }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  verifyCheckpoint(id: string): { ok: boolean; errors: string[]; manifest?: LifecycleCheckpointManifest } {
    const safeId = normalizeCheckpointId(id);
    const manifestPath = path.join(this.options.archiveRoot, safeId, 'manifest.json');
    const errors: string[] = [];
    let manifest: LifecycleCheckpointManifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as LifecycleCheckpointManifest; }
    catch (error) { return { ok: false, errors: [`manifest unreadable: ${message(error)}`] }; }
    for (const file of manifest.files) {
      if (!fs.existsSync(file.archivePath)) { errors.push(`${file.name}: archive missing`); continue; }
      if (sha256(file.archivePath) !== file.sha256) errors.push(`${file.name}: checksum mismatch`);
      const verified = inspectSource({ name: file.name, sourcePath: file.archivePath, kind: file.kind, required: true });
      if (verified.integrity !== 'ok') errors.push(`${file.name}: ${verified.error || verified.integrity}`);
    }
    return { ok: errors.length === 0, errors, manifest };
  }

  restoreCheckpointTo(id: string, targetDir: string): { restored: string[] } {
    const verified = this.verifyCheckpoint(id);
    if (!verified.ok || !verified.manifest) throw new Error(`checkpoint verification failed: ${verified.errors.join('; ')}`);
    fs.mkdirSync(targetDir, { recursive: true });
    if (fs.readdirSync(targetDir).length > 0) throw new Error('restore target must be empty');
    const restored: string[] = [];
    for (const file of verified.manifest.files) {
      const dest = path.join(targetDir, path.basename(file.archivePath));
      fs.copyFileSync(file.archivePath, dest);
      restored.push(dest);
    }
    return { restored };
  }

  private async runInternal(input: { dryRun?: boolean }): Promise<LifecycleRunReport> {
    const dryRun = input.dryRun !== false;
    const startedAt = this.now();
    const before = this.inventory();
    const requiredFailure = before.find(item => item.integrity !== 'ok' && this.options.sources.find(s => s.name === item.name)?.required !== false);
    if (requiredFailure) throw new Error(`required lifecycle source is not healthy: ${requiredFailure.name} (${requiredFailure.error || requiredFailure.integrity})`);

    const candidates: Record<string, number> = {};
    for (const resource of this.options.resources) candidates[resource.name] = await resource.preview();
    const totalCandidates = Object.values(candidates).reduce((sum, count) => sum + count, 0);
    const deleted: Record<string, number> = {};
    let checkpoint: LifecycleCheckpointManifest | undefined;

    if (!dryRun && totalCandidates > 0) {
      checkpoint = await this.createCheckpoint();
      for (const resource of this.options.resources) deleted[resource.name] = await resource.prune();
    } else {
      for (const resource of this.options.resources) deleted[resource.name] = 0;
    }

    const after = this.inventory();
    const postFailure = after.find(item => item.exists && item.integrity === 'failed');
    if (postFailure) throw new Error(`post-retention integrity check failed: ${postFailure.name}`);
    const finishedAt = this.now();
    const report: LifecycleRunReport = {
      dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      candidates,
      deleted,
      totalCandidates,
      totalDeleted: Object.values(deleted).reduce((sum, count) => sum + count, 0),
      checkpoint,
      before,
      after,
    };
    writeJsonAtomic(this.options.statePath, report);
    return report;
  }

  private async createCheckpoint(): Promise<LifecycleCheckpointManifest> {
    const createdAt = this.now();
    const id = `${createdAt.toISOString().replace(/[^0-9TZ]/g, '')}-${randomBytes(3).toString('hex')}`;
    const checkpointDir = path.join(this.options.archiveRoot, id);
    fs.mkdirSync(checkpointDir, { recursive: true });
    const files: LifecycleCheckpointFile[] = [];
    try {
      for (const source of this.options.sources) {
        if (!fs.existsSync(source.sourcePath)) {
          if (source.required === false) continue;
          throw new Error(`${source.name}: source missing`);
        }
        const extension = source.kind === 'sqlite' ? '.db' : '.json';
        const archivePath = path.join(checkpointDir, `${safeName(source.name)}${extension}`);
        if (source.kind === 'sqlite') {
          const db = new Database(source.sourcePath, { readonly: true, fileMustExist: true });
          try { await db.backup(archivePath); } finally { db.close(); }
        } else {
          fs.copyFileSync(source.sourcePath, archivePath);
        }
        const inspected = inspectSource({ ...source, sourcePath: archivePath, required: true });
        if (inspected.integrity !== 'ok') throw new Error(`${source.name}: archived copy failed verification`);
        files.push({
          name: source.name,
          kind: source.kind,
          sourcePath: source.sourcePath,
          archivePath,
          bytes: inspected.bytes,
          sha256: sha256(archivePath),
          integrity: 'ok',
        });
      }
      const manifest: LifecycleCheckpointManifest = {
        id,
        createdAt: createdAt.toISOString(),
        verifiedAt: this.now().toISOString(),
        files,
      };
      writeJsonAtomic(path.join(checkpointDir, 'manifest.json'), manifest);
      const verified = this.verifyCheckpoint(id);
      if (!verified.ok) throw new Error(verified.errors.join('; '));
      return manifest;
    } catch (error) {
      fs.rmSync(checkpointDir, { recursive: true, force: true });
      throw error;
    }
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
}

function inspectSource(source: LifecycleSource): LifecycleInventoryItem {
  if (!fs.existsSync(source.sourcePath)) return { ...source, exists: false, bytes: 0, records: 0, integrity: 'missing' };
  try {
    const bytes = fs.statSync(source.sourcePath).size;
    if (source.kind === 'json') {
      const value = JSON.parse(fs.readFileSync(source.sourcePath, 'utf8'));
      const records = Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
      return { ...source, exists: true, bytes, records, integrity: 'ok' };
    }
    const db = new Database(source.sourcePath, { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error(String(integrity));
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ").all() as Array<{ name: string }>;
      let records = 0;
      for (const { name } of tables) records += Number((db.prepare(`SELECT COUNT(*) AS n FROM \"${name.replace(/\"/g, '\"\"')}\"`).get() as { n: number }).n || 0);
      return { ...source, exists: true, bytes, records, integrity: 'ok' };
    } finally { db.close(); }
  } catch (error) {
    return { ...source, exists: true, bytes: safeSize(source.sourcePath), records: 0, integrity: 'failed', error: message(error) };
  }
}

function normalizeCheckpointId(id: string): string {
  if (!/^[A-Za-z0-9TZ-]+$/.test(id)) throw new Error('invalid checkpoint id');
  return id;
}
function safeName(name: string): string { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }
function safeSize(filePath: string): number { try { return fs.statSync(filePath).size; } catch { return 0; } }
function sha256(filePath: string): string { return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, filePath);
}

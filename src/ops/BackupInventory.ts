import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type BackupCoverage = 'state-bundle' | 'sqlite-online' | 'uncovered';
export type PersistentFileKind = 'database' | 'secret-config' | 'state';

export interface BackupInventoryTarget {
  key: string;
  filePath: string;
  required?: boolean;
}

export interface BackupInventoryVolume {
  name: string;
  service: string;
  mountPath: string;
  purpose: string;
  requiredForCoreRestore: boolean;
}

export interface BackupInventoryFile {
  relativePath: string;
  filePath: string;
  bytes: number;
  kind: PersistentFileKind;
  sensitive: boolean;
  coverage: BackupCoverage;
  targetKey?: string;
  required: boolean;
}

export interface BackupInventoryReport {
  generatedAt: string;
  dataRoot: string;
  files: BackupInventoryFile[];
  volumes: BackupInventoryVolume[];
  summary: {
    totalFiles: number;
    totalBytes: number;
    databases: number;
    stateFiles: number;
    sensitiveFiles: number;
    coveredFiles: number;
    uncoveredFiles: number;
  };
}

export interface BackupCoveragePlan {
  stateTargets: BackupInventoryTarget[];
  sqliteTargets: BackupInventoryTarget[];
}

const SENSITIVE_NAME = /(auth|credential|secret|token|api-key|vault|config)/i;
const EXCLUDED_DIRECTORY = new Set(['backups', 'logs', 'node_modules', 'tmp']);

function isPersistentCandidate(name: string): boolean {
  return /\.(db|json|jsonl)$/i.test(name);
}

function shouldIgnoreFile(name: string): boolean {
  return /-(wal|shm)$/.test(name) || /\.bootstrap$/.test(name) || /\.restore-backup-\d+$/.test(name);
}

function walkPersistentFiles(root: string, current: string, output: string[]): void {
  if (!fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      const relative = path.relative(root, fullPath);
      const topLevel = relative.split(path.sep)[0];
      if (!EXCLUDED_DIRECTORY.has(topLevel)) walkPersistentFiles(root, fullPath, output);
      continue;
    }
    if (!entry.isFile() || shouldIgnoreFile(entry.name) || !isPersistentCandidate(entry.name)) continue;
    output.push(fullPath);
  }
}

function classifyFile(filePath: string): { kind: PersistentFileKind; sensitive: boolean } {
  const name = path.basename(filePath);
  const sensitive = SENSITIVE_NAME.test(name);
  if (/\.db$/i.test(name)) return { kind: 'database', sensitive };
  if (sensitive) return { kind: 'secret-config', sensitive: true };
  return { kind: 'state', sensitive: false };
}

export function buildBackupInventory(opts: {
  dataRoot: string;
  stateTargets: BackupInventoryTarget[];
  sqliteTargets: BackupInventoryTarget[];
  volumes: BackupInventoryVolume[];
  now?: () => Date;
}): BackupInventoryReport {
  const dataRoot = path.resolve(opts.dataRoot);
  const stateTargets = new Map(opts.stateTargets.map(target => [path.resolve(target.filePath), target]));
  const sqliteTargets = new Map(opts.sqliteTargets.map(target => [path.resolve(target.filePath), target]));
  const discovered: string[] = [];
  walkPersistentFiles(dataRoot, dataRoot, discovered);

  const files = discovered.sort().map(filePath => {
    const resolved = path.resolve(filePath);
    const stateTarget = stateTargets.get(resolved);
    const sqliteTarget = sqliteTargets.get(resolved);
    const classification = classifyFile(resolved);
    const target = sqliteTarget || stateTarget;
    return {
      relativePath: path.relative(dataRoot, resolved).split(path.sep).join('/'),
      filePath: resolved,
      bytes: fs.statSync(resolved).size,
      ...classification,
      coverage: sqliteTarget ? 'sqlite-online' as const : stateTarget ? 'state-bundle' as const : 'uncovered' as const,
      targetKey: target?.key,
      required: !!target?.required,
    };
  });

  return {
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    dataRoot,
    files,
    volumes: opts.volumes.map(volume => ({ ...volume })),
    summary: {
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      databases: files.filter(file => file.kind === 'database').length,
      stateFiles: files.filter(file => file.kind !== 'database').length,
      sensitiveFiles: files.filter(file => file.sensitive).length,
      coveredFiles: files.filter(file => file.coverage !== 'uncovered').length,
      uncoveredFiles: files.filter(file => file.coverage === 'uncovered').length,
    },
  };
}

export function planBackupCoverage(report: BackupInventoryReport): BackupCoveragePlan {
  const stateTargets: BackupInventoryTarget[] = [];
  const sqliteTargets: BackupInventoryTarget[] = [];
  for (const file of report.files) {
    if (file.kind === 'database') {
      if (file.coverage !== 'sqlite-online') {
        const base = path.basename(file.relativePath, '.db').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48) || 'database';
        const suffix = crypto.createHash('sha256').update(file.relativePath).digest('hex').slice(0, 10);
        sqliteTargets.push({
          key: `discovered-${base}-${suffix}`,
          filePath: file.filePath,
          required: true,
        });
      }
      continue;
    }
    if (file.coverage === 'uncovered') {
      stateTargets.push({
        key: `discovered:${file.relativePath}`,
        filePath: file.filePath,
        required: false,
      });
    }
  }
  return { stateTargets, sqliteTargets };
}

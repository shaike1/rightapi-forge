import fs from 'fs';
import path from 'path';

export interface SlaSnapshotPolicy {
  defaultWindowHours: number;
  captureIntervalMs: number;
  retentionHours: number;
  maxRecords: number;
}

interface SlaSnapshotPolicyFile {
  version: number;
  revision?: number;
  updatedAt?: string;
  policy: SlaSnapshotPolicy;
}

const DEFAULT_POLICY: SlaSnapshotPolicy = {
  defaultWindowHours: 24,
  captureIntervalMs: 300_000,
  retentionHours: 24 * 14,
  maxRecords: 2000
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export class SlaSnapshotPolicyStore {
  private filePath: string;
  private policy: SlaSnapshotPolicy;
  private revision: number;
  private updatedAt: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.policy = { ...DEFAULT_POLICY };
    this.revision = 1;
    this.updatedAt = new Date().toISOString();
    this.load();
  }

  get(): SlaSnapshotPolicy {
    return { ...this.policy };
  }

  update(patch: Partial<SlaSnapshotPolicy>): SlaSnapshotPolicy {
    this.updateWithOptions(patch);
    return this.get();
  }

  updateWithOptions(patch: Partial<SlaSnapshotPolicy>, options?: { expectedRevision?: number }): {
    policy: SlaSnapshotPolicy;
    revision: number;
    updatedAt: string;
  } {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new Error(`Revision mismatch: expected ${options.expectedRevision}, current ${this.revision}`);
    }
    this.policy = {
      defaultWindowHours: clampInt(
        patch.defaultWindowHours,
        this.policy.defaultWindowHours,
        1,
        168
      ),
      captureIntervalMs: clampInt(
        patch.captureIntervalMs,
        this.policy.captureIntervalMs,
        10_000,
        24 * 60 * 60 * 1000
      ),
      retentionHours: clampInt(
        patch.retentionHours,
        this.policy.retentionHours,
        1,
        24 * 365
      ),
      maxRecords: clampInt(
        patch.maxRecords,
        this.policy.maxRecords,
        10,
        100_000
      )
    };
    this.revision += 1;
    this.updatedAt = new Date().toISOString();
    this.save();
    return this.getRecord();
  }

  getRecord(): { policy: SlaSnapshotPolicy; revision: number; updatedAt: string } {
    return {
      policy: this.get(),
      revision: this.revision,
      updatedAt: this.updatedAt
    };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SlaSnapshotPolicyFile;
      const p: Partial<SlaSnapshotPolicy> = parsed?.policy || {};
      this.policy = {
        defaultWindowHours: clampInt(p.defaultWindowHours, DEFAULT_POLICY.defaultWindowHours, 1, 168),
        captureIntervalMs: clampInt(p.captureIntervalMs, DEFAULT_POLICY.captureIntervalMs, 10_000, 24 * 60 * 60 * 1000),
        retentionHours: clampInt(p.retentionHours, DEFAULT_POLICY.retentionHours, 1, 24 * 365),
        maxRecords: clampInt(p.maxRecords, DEFAULT_POLICY.maxRecords, 10, 100_000)
      };
      this.revision = Number.isFinite(parsed.revision as number) ? Math.max(1, Number(parsed.revision)) : 1;
      this.updatedAt = parsed.updatedAt || new Date().toISOString();
    } catch {
      this.policy = { ...DEFAULT_POLICY };
      this.revision = 1;
      this.updatedAt = new Date().toISOString();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: SlaSnapshotPolicyFile = {
      version: 1,
      revision: this.revision,
      updatedAt: this.updatedAt,
      policy: this.policy
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

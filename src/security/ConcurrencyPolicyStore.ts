import fs from 'fs';
import path from 'path';
import type { RiskTier } from './ToolingPolicy.js';

export interface ConcurrencyPolicy {
  byRisk: Record<RiskTier, number>;
  byCommand: Record<string, number>;
}

interface ConcurrencyPolicyFile {
  version: number;
  revision?: number;
  updatedAt?: string;
  policy: ConcurrencyPolicy;
}

const DEFAULT_POLICY: ConcurrencyPolicy = {
  byRisk: {
    safe: 4,
    standard: 2,
    risky: 1,
    destructive: 1
  },
  byCommand: {}
};

function sanitizeLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 20);
}

export class ConcurrencyPolicyStore {
  private filePath: string;
  private policy: ConcurrencyPolicy;
  private revision: number;
  private updatedAt: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.policy = { ...DEFAULT_POLICY, byRisk: { ...DEFAULT_POLICY.byRisk }, byCommand: {} };
    this.revision = 1;
    this.updatedAt = new Date().toISOString();
    this.load();
  }

  get(): ConcurrencyPolicy {
    return {
      byRisk: { ...this.policy.byRisk },
      byCommand: { ...this.policy.byCommand }
    };
  }

  update(patch: Partial<ConcurrencyPolicy>): ConcurrencyPolicy {
    this.updateWithOptions(patch);
    return this.get();
  }

  updateWithOptions(patch: Partial<ConcurrencyPolicy>, options?: { expectedRevision?: number }): {
    policy: ConcurrencyPolicy;
    revision: number;
    updatedAt: string;
  } {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new Error(`Revision mismatch: expected ${options.expectedRevision}, current ${this.revision}`);
    }
    if (patch.byRisk) {
      this.policy.byRisk.safe = sanitizeLimit(patch.byRisk.safe, this.policy.byRisk.safe);
      this.policy.byRisk.standard = sanitizeLimit(patch.byRisk.standard, this.policy.byRisk.standard);
      this.policy.byRisk.risky = sanitizeLimit(patch.byRisk.risky, this.policy.byRisk.risky);
      this.policy.byRisk.destructive = sanitizeLimit(patch.byRisk.destructive, this.policy.byRisk.destructive);
    }
    if (patch.byCommand && typeof patch.byCommand === 'object') {
      const next: Record<string, number> = {};
      Object.entries(patch.byCommand).forEach(([command, value]) => {
        if (!command || typeof command !== 'string') return;
        next[command] = sanitizeLimit(value, this.policy.byCommand[command] || 1);
      });
      this.policy.byCommand = next;
    }
    this.revision += 1;
    this.updatedAt = new Date().toISOString();
    this.save();
    return this.getRecord();
  }

  getRecord(): { policy: ConcurrencyPolicy; revision: number; updatedAt: string } {
    return {
      policy: this.get(),
      revision: this.revision,
      updatedAt: this.updatedAt
    };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ConcurrencyPolicyFile;
      const byRisk = parsed?.policy?.byRisk;
      const byCommand = parsed?.policy?.byCommand;
      if (byRisk) {
        const legacyPrivileged = (byRisk as Record<string, unknown>).privileged;
        this.policy.byRisk = {
          safe: sanitizeLimit(byRisk.safe, DEFAULT_POLICY.byRisk.safe),
          standard: sanitizeLimit(byRisk.standard ?? legacyPrivileged, DEFAULT_POLICY.byRisk.standard),
          risky: sanitizeLimit(byRisk.risky ?? legacyPrivileged, DEFAULT_POLICY.byRisk.risky),
          destructive: sanitizeLimit(byRisk.destructive, DEFAULT_POLICY.byRisk.destructive)
        };
      }
      if (byCommand && typeof byCommand === 'object') {
        const cleaned: Record<string, number> = {};
        Object.entries(byCommand).forEach(([command, value]) => {
          if (!command) return;
          cleaned[command] = sanitizeLimit(value, 1);
        });
        this.policy.byCommand = cleaned;
      }
      this.revision = Number.isFinite(parsed.revision as number) ? Math.max(1, Number(parsed.revision)) : 1;
      this.updatedAt = parsed.updatedAt || new Date().toISOString();
    } catch {
      this.policy = { ...DEFAULT_POLICY, byRisk: { ...DEFAULT_POLICY.byRisk }, byCommand: {} };
      this.revision = 1;
      this.updatedAt = new Date().toISOString();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: ConcurrencyPolicyFile = {
      version: 1,
      revision: this.revision,
      updatedAt: this.updatedAt,
      policy: this.policy
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

import fs from 'fs';
import path from 'path';
import type { OrchestratorReliabilityPolicy } from './OrchestratorService.js';

interface PolicyFile {
  version: number;
  revision?: number;
  updatedAt?: string;
  policy: OrchestratorReliabilityPolicy;
}

const DEFAULT_POLICY: OrchestratorReliabilityPolicy = {
  autoRecoverEnabled: true,
  stuckThresholdMinutes: 90,
  retryLimit: 2,
  retryCooldownMinutes: 15
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function sanitizePolicy(input?: Partial<OrchestratorReliabilityPolicy>): OrchestratorReliabilityPolicy {
  const policy = input || {};
  return {
    autoRecoverEnabled: policy.autoRecoverEnabled === undefined
      ? DEFAULT_POLICY.autoRecoverEnabled
      : !!policy.autoRecoverEnabled,
    stuckThresholdMinutes: clampInt(policy.stuckThresholdMinutes, DEFAULT_POLICY.stuckThresholdMinutes, 1, 24 * 60),
    retryLimit: clampInt(policy.retryLimit, DEFAULT_POLICY.retryLimit, 0, 10),
    retryCooldownMinutes: clampInt(policy.retryCooldownMinutes, DEFAULT_POLICY.retryCooldownMinutes, 1, 24 * 60)
  };
}

export class OrchestratorReliabilityPolicyStore {
  private filePath: string;
  private policy: OrchestratorReliabilityPolicy;
  private revision: number;
  private updatedAt: string;

  constructor(filePath: string, defaults?: Partial<OrchestratorReliabilityPolicy>) {
    this.filePath = filePath;
    this.policy = sanitizePolicy({ ...DEFAULT_POLICY, ...(defaults || {}) });
    this.revision = 1;
    this.updatedAt = new Date().toISOString();
    this.load();
  }

  get(): OrchestratorReliabilityPolicy {
    return { ...this.policy };
  }

  updateWithOptions(
    patch: Partial<OrchestratorReliabilityPolicy>,
    options?: { expectedRevision?: number }
  ): { policy: OrchestratorReliabilityPolicy; revision: number; updatedAt: string } {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new Error(`Revision mismatch: expected ${options.expectedRevision}, current ${this.revision}`);
    }
    this.policy = sanitizePolicy({
      ...this.policy,
      ...patch
    });
    this.revision += 1;
    this.updatedAt = new Date().toISOString();
    this.save();
    return this.getRecord();
  }

  getRecord(): { policy: OrchestratorReliabilityPolicy; revision: number; updatedAt: string } {
    return {
      policy: this.get(),
      revision: this.revision,
      updatedAt: this.updatedAt
    };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PolicyFile;
      this.policy = sanitizePolicy(parsed.policy);
      this.revision = Number.isFinite(parsed.revision as number) ? Math.max(1, Number(parsed.revision)) : 1;
      this.updatedAt = parsed.updatedAt || new Date().toISOString();
    } catch {
      this.policy = sanitizePolicy();
      this.revision = 1;
      this.updatedAt = new Date().toISOString();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PolicyFile = {
      version: 1,
      revision: this.revision,
      updatedAt: this.updatedAt,
      policy: this.policy
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

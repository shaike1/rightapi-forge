import fs from 'fs';
import path from 'path';
import type { DelegationRiskLevel, DelegationState } from '../types/index.js';

export interface DelegationPolicy {
  requireApprovalByTransition: Partial<Record<DelegationState, DelegationRiskLevel[]>>;
  stalledHoursByState: Partial<Record<DelegationState, number>>;
  overdueAction: 'escalate' | 'reject';
}

interface PolicyFile {
  version: number;
  revision?: number;
  updatedAt?: string;
  policy: DelegationPolicy;
}

const DEFAULT_POLICY: DelegationPolicy = {
  requireApprovalByTransition: {
    approved: ['high'],
    dispatched: ['medium', 'high']
  },
  stalledHoursByState: {
    approved: 6,
    dispatched: 6,
    accepted: 12
  },
  overdueAction: 'escalate'
};

function sanitizePolicy(input?: Partial<DelegationPolicy>): DelegationPolicy {
  const policy: DelegationPolicy = {
    requireApprovalByTransition: { ...DEFAULT_POLICY.requireApprovalByTransition },
    stalledHoursByState: { ...DEFAULT_POLICY.stalledHoursByState },
    overdueAction: DEFAULT_POLICY.overdueAction
  };
  if (!input) return policy;

  if (input.requireApprovalByTransition) {
    for (const [state, risks] of Object.entries(input.requireApprovalByTransition)) {
      if (!Array.isArray(risks)) continue;
      const validRisks = risks.filter(r => ['low', 'medium', 'high'].includes(r)) as DelegationRiskLevel[];
      policy.requireApprovalByTransition[state as DelegationState] = validRisks;
    }
  }
  if (input.stalledHoursByState) {
    for (const [state, hours] of Object.entries(input.stalledHoursByState)) {
      const numeric = Number(hours);
      if (Number.isFinite(numeric) && numeric > 0 && numeric <= 24 * 30) {
        policy.stalledHoursByState[state as DelegationState] = numeric;
      }
    }
  }
  if (input.overdueAction === 'escalate' || input.overdueAction === 'reject') {
    policy.overdueAction = input.overdueAction;
  }
  return policy;
}

export class DelegationPolicyStore {
  private filePath: string;
  private policy: DelegationPolicy;
  private revision: number;
  private updatedAt: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.policy = sanitizePolicy();
    this.revision = 1;
    this.updatedAt = new Date().toISOString();
    this.load();
  }

  get(): DelegationPolicy {
    return {
      requireApprovalByTransition: { ...this.policy.requireApprovalByTransition },
      stalledHoursByState: { ...this.policy.stalledHoursByState },
      overdueAction: this.policy.overdueAction
    };
  }

  update(partial: Partial<DelegationPolicy>): DelegationPolicy {
    this.updateWithOptions(partial);
    return this.get();
  }

  updateWithOptions(partial: Partial<DelegationPolicy>, options?: { expectedRevision?: number }): {
    policy: DelegationPolicy;
    revision: number;
    updatedAt: string;
  } {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new Error(`Revision mismatch: expected ${options.expectedRevision}, current ${this.revision}`);
    }
    this.policy = sanitizePolicy({
      ...this.policy,
      ...partial,
      requireApprovalByTransition: {
        ...this.policy.requireApprovalByTransition,
        ...(partial.requireApprovalByTransition || {})
      },
      stalledHoursByState: {
        ...this.policy.stalledHoursByState,
        ...(partial.stalledHoursByState || {})
      }
    });
    this.revision += 1;
    this.updatedAt = new Date().toISOString();
    this.save();
    return this.getRecord();
  }

  getRecord(): {
    policy: DelegationPolicy;
    revision: number;
    updatedAt: string;
  } {
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

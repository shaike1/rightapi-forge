import fs from 'fs';
import path from 'path';

export type AllowlistRisk = 'standard' | 'risky' | 'destructive';

export interface PrivilegedTargetAllowlistPolicy {
  enabled: boolean;
  targets: string[];
  enforceForRisks: AllowlistRisk[];
}

interface PolicyFile {
  version: number;
  revision?: number;
  updatedAt?: string;
  policy: PrivilegedTargetAllowlistPolicy;
}

const DEFAULT_POLICY: PrivilegedTargetAllowlistPolicy = {
  enabled: false,
  targets: [],
  enforceForRisks: ['standard', 'risky', 'destructive']
};

function normalizeTarget(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeTargets(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTarget(String(value));
    if (!normalized || normalized.length > 200) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 500) break;
  }
  return out;
}

function normalizeRisks(values: unknown, fallback: AllowlistRisk[]): AllowlistRisk[] {
  if (!Array.isArray(values)) return [...fallback];
  const allowed: AllowlistRisk[] = [];
  values.forEach(value => {
    if (value === 'privileged') {
      if (!allowed.includes('standard')) allowed.push('standard');
      if (!allowed.includes('risky')) allowed.push('risky');
    } else if (value === 'standard' || value === 'risky' || value === 'destructive') {
      if (!allowed.includes(value)) allowed.push(value);
    }
  });
  return allowed.length > 0 ? allowed : [...fallback];
}

function sanitizePolicy(input?: Partial<PrivilegedTargetAllowlistPolicy>): PrivilegedTargetAllowlistPolicy {
  const fallback = { ...DEFAULT_POLICY };
  if (!input) return fallback;
  const enabled = input.enabled === undefined ? fallback.enabled : !!input.enabled;
  const targets = input.targets === undefined
    ? fallback.targets
    : normalizeTargets(input.targets);
  const enforceForRisks = normalizeRisks(input.enforceForRisks, fallback.enforceForRisks);
  return {
    enabled,
    targets,
    enforceForRisks
  };
}

export class PrivilegedTargetAllowlistPolicyStore {
  private filePath: string;
  private policy: PrivilegedTargetAllowlistPolicy;
  private revision: number;
  private updatedAt: string;

  constructor(filePath: string, seedTargets?: string[]) {
    this.filePath = filePath;
    this.policy = sanitizePolicy();
    this.revision = 1;
    this.updatedAt = new Date().toISOString();
    this.load();
    if (this.policy.targets.length === 0 && Array.isArray(seedTargets) && seedTargets.length > 0) {
      this.policy.targets = normalizeTargets(seedTargets);
      this.policy.enabled = true;
      this.revision += 1;
      this.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  get(): PrivilegedTargetAllowlistPolicy {
    return {
      enabled: this.policy.enabled,
      targets: [...this.policy.targets],
      enforceForRisks: [...this.policy.enforceForRisks]
    };
  }

  updateWithOptions(
    partial: Partial<PrivilegedTargetAllowlistPolicy>,
    options?: { expectedRevision?: number }
  ): { policy: PrivilegedTargetAllowlistPolicy; revision: number; updatedAt: string } {
    if (options?.expectedRevision !== undefined && options.expectedRevision !== this.revision) {
      throw new Error(`Revision mismatch: expected ${options.expectedRevision}, current ${this.revision}`);
    }
    this.policy = sanitizePolicy({
      ...this.policy,
      ...partial,
      targets: partial.targets === undefined ? this.policy.targets : partial.targets,
      enforceForRisks: partial.enforceForRisks === undefined ? this.policy.enforceForRisks : partial.enforceForRisks
    });
    this.revision += 1;
    this.updatedAt = new Date().toISOString();
    this.save();
    return this.getRecord();
  }

  getRecord(): { policy: PrivilegedTargetAllowlistPolicy; revision: number; updatedAt: string } {
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

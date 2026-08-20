import fs from 'fs';
import path from 'path';

export type PolicyType =
  | 'delegation'
  | 'concurrency'
  | 'sla_snapshot'
  | 'target_allowlist'
  | 'orchestrator_reliability';

export interface PolicyChangeAuditRecord {
  id: string;
  timestamp: string;
  policyType: PolicyType;
  actorId: string;
  action: 'update' | 'import';
  expectedRevision?: number;
  previousRevision: number;
  nextRevision: number;
  changedKeys: string[];
  before: unknown;
  after: unknown;
}

interface PolicyChangeAuditFile {
  version: number;
  records: PolicyChangeAuditRecord[];
}

export class PolicyChangeAuditStore {
  private filePath: string;
  private maxRecords: number;
  private records: PolicyChangeAuditRecord[] = [];

  constructor(filePath: string, maxRecords: number = 5000) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.load();
  }

  append(record: PolicyChangeAuditRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.save();
  }

  list(params?: { limit?: number; policyType?: PolicyType }): PolicyChangeAuditRecord[] {
    const limit = Math.min(Math.max(Math.floor(params?.limit || 100), 1), 1000);
    return this.records
      .filter(r => !params?.policyType || r.policyType === params.policyType)
      .slice(-limit)
      .reverse();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PolicyChangeAuditFile;
      this.records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PolicyChangeAuditFile = {
      version: 1,
      records: this.records
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

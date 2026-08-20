import fs from 'fs';
import path from 'path';

export type ExecutionAuditStatus = 'allowed' | 'blocked' | 'error';

export interface ExecutionAuditRecord {
  id: string;
  timestamp: string;
  taskId?: string;
  command: string;
  skillId: string;
  agentId: string;
  agentRole: string;
  status: ExecutionAuditStatus;
  reason?: string;
  risk?: string;
  sandbox?: string;
  runner?: string;
  approvalTokenId?: string;
  approvalRequired: boolean;
  credentialIds: string[];
  credentialScopes: string[];
  credentialCatalogEntryIds?: string[];
  credentialEnvironment?: string;
  credentialSystem?: string;
  credentialDecision?: 'allow' | 'deny' | 'not_checked' | 'error';
  durationMs?: number;
}

interface AuditFile {
  version: number;
  records: ExecutionAuditRecord[];
}

export class ExecutionAuditStore {
  private filePath: string;
  private maxRecords: number;
  private records: ExecutionAuditRecord[] = [];

  constructor(filePath: string, maxRecords: number = 2000) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.load();
  }

  append(record: ExecutionAuditRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.save();
  }

  list(limit: number = 100): ExecutionAuditRecord[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 500);
    return [...this.records].slice(-effectiveLimit).reverse();
  }

  listByTask(taskId: string, limit: number = 200): ExecutionAuditRecord[] {
    const effectiveLimit = Math.min(Math.max(limit, 1), 1000);
    return this.records
      .filter(r => r.taskId === taskId)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, effectiveLimit);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as AuditFile;
      this.records = Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: AuditFile = { version: 1, records: this.records };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

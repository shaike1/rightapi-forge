import fs from 'fs';
import path from 'path';

export interface SlaSnapshotRecord {
  id: string;
  timestamp: string;
  windowHours: number;
  summary: {
    delegationCreated: number;
    delegationCompleted: number;
    delegationRejected: number;
    stalledEscalations: number;
    overdueEscalations: number;
  };
  topAgents: Array<{
    agentId: string;
    name: string;
    role: string;
    completedInWindow: number;
    failedInWindow: number;
    meanDurationMinutes: number | null;
  }>;
}

interface SnapshotFile {
  version: number;
  snapshots: SlaSnapshotRecord[];
}

export class SlaSnapshotStore {
  private filePath: string;
  private maxRecords: number;
  private snapshots: SlaSnapshotRecord[] = [];

  constructor(filePath: string, maxRecords: number = 2000) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.load();
  }

  append(record: SlaSnapshotRecord): SlaSnapshotRecord {
    this.snapshots.push(record);
    if (this.snapshots.length > this.maxRecords) {
      this.snapshots.splice(0, this.snapshots.length - this.maxRecords);
    }
    this.save();
    return record;
  }

  prune(params?: { retentionHours?: number; maxRecords?: number }): void {
    const retentionHours = params?.retentionHours;
    const maxRecords = params?.maxRecords;
    if (typeof retentionHours === 'number' && Number.isFinite(retentionHours) && retentionHours > 0) {
      const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);
      this.snapshots = this.snapshots.filter(s => Date.parse(s.timestamp) >= cutoff);
    }
    const effectiveMax = typeof maxRecords === 'number' && Number.isFinite(maxRecords) && maxRecords > 0
      ? Math.floor(maxRecords)
      : this.maxRecords;
    if (this.snapshots.length > effectiveMax) {
      this.snapshots.splice(0, this.snapshots.length - effectiveMax);
    }
    this.save();
  }

  list(limit: number = 200): SlaSnapshotRecord[] {
    const effectiveLimit = Math.min(Math.max(Math.floor(limit), 1), 2000);
    return [...this.snapshots].slice(-effectiveLimit).reverse();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SnapshotFile;
      this.snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
    } catch {
      this.snapshots = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: SnapshotFile = {
      version: 1,
      snapshots: this.snapshots
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

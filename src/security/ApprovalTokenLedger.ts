import fs from 'fs';
import path from 'path';

export interface ApprovalTokenUseRecord {
  tokenId: string;
  usedAt: string;
  command?: string;
  agentId?: string;
}

export interface ApprovalTokenRevocationRecord {
  tokenId: string;
  revokedAt: string;
  revokedBy: string;
  reason?: string;
}

interface LedgerFile {
  version: number;
  used: ApprovalTokenUseRecord[];
  revoked: ApprovalTokenRevocationRecord[];
}

export class ApprovalTokenLedger {
  private filePath: string;
  private used: ApprovalTokenUseRecord[] = [];
  private revoked: ApprovalTokenRevocationRecord[] = [];
  private usedIndex: Set<string> = new Set();
  private revokedIndex: Map<string, ApprovalTokenRevocationRecord> = new Map();
  private maxRecords: number;

  constructor(filePath: string, maxRecords: number = 5000) {
    this.filePath = filePath;
    this.maxRecords = maxRecords;
    this.load();
  }

  consume(params: { tokenId: string; command?: string; agentId?: string }): { ok: boolean; reason?: string } {
    const status = this.getStatus(params.tokenId);
    if (status.revoked) return { ok: false, reason: 'Approval token revoked' };
    if (status.used) return { ok: false, reason: 'Approval token already used (one-time token)' };

    const record: ApprovalTokenUseRecord = {
      tokenId: params.tokenId,
      usedAt: new Date().toISOString(),
      command: params.command,
      agentId: params.agentId
    };
    this.used.push(record);
    this.usedIndex.add(params.tokenId);
    this.trim();
    this.save();
    return { ok: true };
  }

  revoke(params: { tokenId: string; revokedBy: string; reason?: string }): ApprovalTokenRevocationRecord {
    const existing = this.revokedIndex.get(params.tokenId);
    if (existing) return existing;
    const record: ApprovalTokenRevocationRecord = {
      tokenId: params.tokenId,
      revokedAt: new Date().toISOString(),
      revokedBy: params.revokedBy,
      reason: params.reason
    };
    this.revoked.push(record);
    this.revokedIndex.set(params.tokenId, record);
    this.trim();
    this.save();
    return record;
  }

  getStatus(tokenId: string): { tokenId: string; used: boolean; revoked: boolean; revocation?: ApprovalTokenRevocationRecord } {
    const revocation = this.revokedIndex.get(tokenId);
    return {
      tokenId,
      used: this.usedIndex.has(tokenId),
      revoked: !!revocation,
      revocation
    };
  }

  list(limit: number = 100): { used: ApprovalTokenUseRecord[]; revoked: ApprovalTokenRevocationRecord[] } {
    const capped = Math.min(Math.max(limit, 1), 1000);
    return {
      used: [...this.used].slice(-capped).reverse(),
      revoked: [...this.revoked].slice(-capped).reverse()
    };
  }

  private trim(): void {
    if (this.used.length > this.maxRecords) {
      this.used = this.used.slice(this.used.length - this.maxRecords);
      this.usedIndex = new Set(this.used.map(r => r.tokenId));
    }
    if (this.revoked.length > this.maxRecords) {
      this.revoked = this.revoked.slice(this.revoked.length - this.maxRecords);
      this.revokedIndex = new Map(this.revoked.map(r => [r.tokenId, r]));
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as LedgerFile;
      this.used = Array.isArray(parsed.used) ? parsed.used : [];
      this.revoked = Array.isArray(parsed.revoked) ? parsed.revoked : [];
      this.usedIndex = new Set(this.used.map(r => r.tokenId));
      this.revokedIndex = new Map(this.revoked.map(r => [r.tokenId, r]));
    } catch {
      this.used = [];
      this.revoked = [];
      this.usedIndex = new Set();
      this.revokedIndex = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: LedgerFile = {
      version: 1,
      used: this.used,
      revoked: this.revoked
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}


import fs from 'fs';
import path from 'path';

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  username: string;
  role: string;
  resource: string;
  method: string;
  ip: string;
  success: boolean;
  detail?: string;
}

export class AuditLog {
  private filePath: string;
  private entries: AuditEntry[] = [];
  private maxEntries: number;

  constructor(filePath: string, maxEntries = 10000) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.load();
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const full: AuditEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.save();
  }

  query(params: {
    username?: string;
    action?: string;
    resource?: string;
    success?: boolean;
    since?: string;
    limit?: number;
  }): AuditEntry[] {
    let result = this.entries;
    if (params.username) result = result.filter(e => e.username === params.username);
    if (params.action) result = result.filter(e => e.action === params.action);
    if (params.resource) result = result.filter(e => e.resource.includes(params.resource));
    if (params.success !== undefined) result = result.filter(e => e.success === params.success);
    if (params.since) {
      const since = new Date(params.since).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() >= since);
    }
    const limit = params.limit || 100;
    return result.slice(-limit).reverse();
  }

  getStats(): { total: number; last24h: number; failedLast24h: number; topUsers: Array<{ username: string; count: number }> } {
    const now = Date.now();
    const day = 86400000;
    const last24h = this.entries.filter(e => now - new Date(e.timestamp).getTime() < day);
    const userCounts = new Map<string, number>();
    for (const e of this.entries) {
      userCounts.set(e.username, (userCounts.get(e.username) || 0) + 1);
    }
    const topUsers = Array.from(userCounts.entries())
      .map(([username, count]) => ({ username, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total: this.entries.length,
      last24h: last24h.length,
      failedLast24h: last24h.filter(e => !e.success).length,
      topUsers
    };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.entries = Array.isArray(data.entries) ? data.entries : [];
    } catch { this.entries = []; }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8');
  }
}

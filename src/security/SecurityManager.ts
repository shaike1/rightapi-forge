import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type AuditAction = 'create' | 'read' | 'update' | 'delete' | 'execute' | 'approve' | 'reject' | 'login' | 'logout';
export type AuditResource = 'workflow' | 'pipeline' | 'alert' | 'task' | 'agent' | 'tenant' | 'user' | 'secret' | 'config';

export interface AuditLog {
  id: string;
  timestamp: Date;
  userId: string;
  username: string;
  action: AuditAction;
  resource: AuditResource;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  errorMessage?: string;
}

export interface ComplianceReport {
  id: string;
  generatedAt: Date;
  period: { from: Date; to: Date };
  framework: 'SOC2' | 'ISO27001' | 'GDPR' | 'HIPAA' | 'custom';
  findings: ComplianceFinding[];
  summary: {
    totalEvents: number;
    criticalFindings: number;
    warningFindings: number;
    passedChecks: number;
    failedChecks: number;
  };
}

export interface ComplianceFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  title: string;
  description: string;
  recommendation?: string;
  evidence?: string[];
  status: 'open' | 'resolved' | 'accepted-risk';
}

export interface Secret {
  id: string;
  name: string;
  type: 'api-key' | 'password' | 'token' | 'certificate';
  createdAt: Date;
  lastRotated?: Date;
  rotationPolicy?: { intervalDays: number; enabled: boolean };
  expiresAt?: Date;
  owner: string;
  tags?: string[];
}

export class AuditLogger extends EventEmitter {
  private logs: AuditLog[] = [];
  private dataPath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataPath: string = '/data/itops-agents/security') {
    super();
    this.dataPath = dataPath;
    this.ensureDir();
    this.load();
    // Flush to disk every 60s
    this.flushTimer = setInterval(() => this.flush(), 60_000);
    console.log('[AuditLogger] Ready');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
  }

  log(entry: Omit<AuditLog, 'id' | 'timestamp'>): void {
    const log: AuditLog = {
      ...entry,
      id: uuidv4(),
      timestamp: new Date()
    };
    this.logs.push(log);
    this.emit('audit-log', log);
    
    if (!log.success) {
      console.warn('[AuditLogger] Failed action:', log.action, log.resource, log.errorMessage);
    }
  }

  query(filter?: {
    userId?: string;
    action?: AuditAction;
    resource?: AuditResource;
    from?: Date;
    to?: Date;
    success?: boolean;
    limit?: number;
  }): AuditLog[] {
    let results = [...this.logs];
    
    if (filter?.userId) results = results.filter(l => l.userId === filter.userId);
    if (filter?.action) results = results.filter(l => l.action === filter.action);
    if (filter?.resource) results = results.filter(l => l.resource === filter.resource);
    if (filter?.from) results = results.filter(l => new Date(l.timestamp) >= filter.from!);
    if (filter?.to) results = results.filter(l => new Date(l.timestamp) <= filter.to!);
    if (filter?.success !== undefined) results = results.filter(l => l.success === filter.success);
    
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    if (filter?.limit) results = results.slice(0, filter.limit);
    return results;
  }

  getStats(period?: { from: Date; to: Date }) {
    const logs = period ? this.query({ from: period.from, to: period.to }) : this.logs;
    
    const byAction: Record<string, number> = {};
    const byResource: Record<string, number> = {};
    const byUser: Record<string, number> = {};
    
    logs.forEach(log => {
      byAction[log.action] = (byAction[log.action] || 0) + 1;
      byResource[log.resource] = (byResource[log.resource] || 0) + 1;
      byUser[log.userId] = (byUser[log.userId] || 0) + 1;
    });

    return {
      total: logs.length,
      success: logs.filter(l => l.success).length,
      failure: logs.filter(l => !l.success).length,
      byAction,
      byResource,
      byUser,
      uniqueUsers: Object.keys(byUser).length,
      oldestLog: logs.length ? logs[logs.length - 1].timestamp : null,
      newestLog: logs.length ? logs[0].timestamp : null
    };
  }

  private flush(): void {
    try {
      const file = path.join(this.dataPath, 'audit-logs.json');
      fs.writeFileSync(file, JSON.stringify(this.logs, null, 2), 'utf8');
    } catch (e) {
      console.error('[AuditLogger] Flush failed:', e);
    }
  }

  private load(): void {
    try {
      const file = path.join(this.dataPath, 'audit-logs.json');
      if (fs.existsSync(file)) {
        this.logs = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log('[AuditLogger] Loaded ' + this.logs.length + ' audit logs');
      }
    } catch (e) {
      console.error('[AuditLogger] Load failed:', e);
    }
  }
}

export class ComplianceEngine {
  private reports: Map<string, ComplianceReport> = new Map();

  constructor(private auditLogger: AuditLogger) {}

  generateReport(
    framework: ComplianceReport['framework'],
    period: { from: Date; to: Date }
  ): ComplianceReport {
    const logs = this.auditLogger.query({ from: period.from, to: period.to });
    const findings: ComplianceFinding[] = [];

    // Check 1: Failed login attempts
    const failedLogins = logs.filter(l => l.action === 'login' && !l.success);
    if (failedLogins.length > 10) {
      findings.push({
        id: uuidv4(),
        severity: 'high',
        category: 'Access Control',
        title: 'Excessive Failed Login Attempts',
        description: failedLogins.length + ' failed login attempts detected in reporting period',
        recommendation: 'Review account lockout policies and implement rate limiting',
        evidence: failedLogins.slice(0, 5).map(l => l.userId + ' at ' + l.timestamp),
        status: 'open'
      });
    }

    // Check 2: Unaudited actions
    const criticalActions = logs.filter(l => ['delete', 'execute'].includes(l.action));
    if (criticalActions.length === 0 && logs.length > 0) {
      findings.push({
        id: uuidv4(),
        severity: 'info',
        category: 'Audit Trail',
        title: 'No Critical Actions in Period',
        description: 'No delete or execute actions recorded',
        status: 'open'
      });
    }

    // Check 3: Secrets without rotation
    findings.push({
      id: uuidv4(),
      severity: 'medium',
      category: 'Secret Management',
      title: 'Secret Rotation Policy',
      description: 'Review all secrets for rotation compliance',
      recommendation: 'Enable automatic rotation for all API keys and tokens',
      status: 'open'
    });

    // Check 4: Audit log retention
    const stats = this.auditLogger.getStats(period);
    if (stats.total < 10) {
      findings.push({
        id: uuidv4(),
        severity: 'low',
        category: 'Audit Trail',
        title: 'Low Audit Activity',
        description: 'Only ' + stats.total + ' audit events in period',
        recommendation: 'Verify audit logging is enabled for all critical actions',
        status: 'open'
      });
    }

    const report: ComplianceReport = {
      id: uuidv4(),
      generatedAt: new Date(),
      period,
      framework,
      findings,
      summary: {
        totalEvents: stats.total,
        criticalFindings: findings.filter(f => f.severity === 'critical').length,
        warningFindings: findings.filter(f => f.severity === 'high' || f.severity === 'medium').length,
        passedChecks: 0, // Would be calculated based on checks
        failedChecks: findings.filter(f => f.status === 'open').length
      }
    };

    this.reports.set(report.id, report);
    return report;
  }

  getReport(id: string): ComplianceReport | undefined {
    return this.reports.get(id);
  }

  getAllReports(): ComplianceReport[] {
    return Array.from(this.reports.values())
      .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
  }
}

export class SecretManager {
  private secrets: Map<string, Secret> = new Map();
  private dataPath: string;

  constructor(dataPath: string = '/data/itops-agents/security') {
    this.dataPath = dataPath;
    this.ensureDir();
    this.load();
    console.log('[SecretManager] Ready');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
  }

  addSecret(data: Omit<Secret, 'id' | 'createdAt'>): Secret {
    const secret: Secret = {
      ...data,
      id: uuidv4(),
      createdAt: new Date()
    };
    this.secrets.set(secret.id, secret);
    this.save();
    return secret;
  }

  rotateSecret(id: string): Secret | null {
    const secret = this.secrets.get(id);
    if (!secret) return null;
    secret.lastRotated = new Date();
    this.save();
    return secret;
  }

  deleteSecret(id: string): boolean {
    const ok = this.secrets.delete(id);
    if (ok) this.save();
    return ok;
  }

  getSecrets(filter?: { type?: Secret['type']; owner?: string }): Secret[] {
    let list = Array.from(this.secrets.values());
    if (filter?.type) list = list.filter(s => s.type === filter.type);
    if (filter?.owner) list = list.filter(s => s.owner === filter.owner);
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  getExpiringSecrets(withinDays: number): Secret[] {
    const cutoff = Date.now() + withinDays * 86_400_000;
    return Array.from(this.secrets.values())
      .filter(s => s.expiresAt && new Date(s.expiresAt).getTime() <= cutoff);
  }

  private save(): void {
    try {
      const file = path.join(this.dataPath, 'secrets.json');
      // In production, encrypt this!
      fs.writeFileSync(file, JSON.stringify(Array.from(this.secrets.entries()), null, 2), 'utf8');
    } catch (e) {
      console.error('[SecretManager] Save failed:', e);
    }
  }

  private load(): void {
    try {
      const file = path.join(this.dataPath, 'secrets.json');
      if (fs.existsSync(file)) {
        this.secrets = new Map(JSON.parse(fs.readFileSync(file, 'utf8')));
        console.log('[SecretManager] Loaded ' + this.secrets.size + ' secrets');
      }
    } catch (e) {
      console.error('[SecretManager] Load failed:', e);
    }
  }
}

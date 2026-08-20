import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const router = Router();
const DATA_DIR = process.env.DATA_DIR || '/data/itops-agents';
const AUDIT_FILE = path.join(DATA_DIR, 'audit-log.jsonl');

export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorType: 'agent' | 'user' | 'system';
  action: string;
  resource: string;
  resourceId?: string;
  outcome: 'success' | 'failure' | 'pending';
  severity: 'info' | 'warning' | 'critical';
  details?: Record<string, unknown>;
  ip?: string;
}

function readAuditLog(): AuditEntry[] {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  return fs.readFileSync(AUDIT_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean) as AuditEntry[];
}

export function appendAuditEntry(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
  const full: AuditEntry = {
    ...entry,
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n');
  return full;
}

// GET /api/audit-log
router.get('/', (req: Request, res: Response) => {
  const entries = readAuditLog();
  const { actor, action, severity, outcome, limit = '200', from, to } = req.query as Record<string, string>;
  let filtered = entries;
  if (actor) filtered = filtered.filter(e => e.actor === actor);
  if (action) filtered = filtered.filter(e => e.action.includes(action));
  if (severity) filtered = filtered.filter(e => e.severity === severity);
  if (outcome) filtered = filtered.filter(e => e.outcome === outcome);
  if (from) filtered = filtered.filter(e => e.timestamp >= from);
  if (to) filtered = filtered.filter(e => e.timestamp <= to);
  const total = filtered.length;
  filtered = filtered.slice(-parseInt(limit));
  res.json({ total, entries: filtered.reverse() });
});

// POST /api/audit-log (manual entry)
router.post('/', (req: Request, res: Response) => {
  const entry = appendAuditEntry({ ...req.body });
  res.status(201).json(entry);
});

// GET /api/audit-log/stats
router.get('/stats', (_req: Request, res: Response) => {
  const entries = readAuditLog();
  const now = Date.now();
  const last24h = entries.filter(e => now - new Date(e.timestamp).getTime() < 86400000);
  const byActor = last24h.reduce<Record<string, number>>((acc, e) => { acc[e.actor] = (acc[e.actor] || 0) + 1; return acc; }, {});
  const bySeverity = last24h.reduce<Record<string, number>>((acc, e) => { acc[e.severity] = (acc[e.severity] || 0) + 1; return acc; }, {});
  const byOutcome = last24h.reduce<Record<string, number>>((acc, e) => { acc[e.outcome] = (acc[e.outcome] || 0) + 1; return acc; }, {});
  res.json({ total: entries.length, last24h: last24h.length, byActor, bySeverity, byOutcome });
});

// GET /api/audit-log/export/csv
router.get('/export/csv', (_req: Request, res: Response) => {
  const entries = readAuditLog();
  const header = 'id,timestamp,actor,actorType,action,resource,resourceId,outcome,severity\n';
  const rows = entries.map(e =>
    [e.id, e.timestamp, e.actor, e.actorType, e.action, e.resource, e.resourceId || '', e.outcome, e.severity]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(header + rows);
});

// Seed some initial entries
function seedIfEmpty() {
  if (fs.existsSync(AUDIT_FILE)) return;
  const seeds = [
    { actor: 'Director', actorType: 'agent' as const, action: 'task.assign', resource: 'Task', resourceId: 'task-001', outcome: 'success' as const, severity: 'info' as const, details: { to: 'Alice' } },
    { actor: 'Alice', actorType: 'agent' as const, action: 'task.complete', resource: 'Task', resourceId: 'task-001', outcome: 'success' as const, severity: 'info' as const },
    { actor: 'system', actorType: 'system' as const, action: 'agent.restart', resource: 'Agent', resourceId: 'Bob', outcome: 'success' as const, severity: 'warning' as const },
    { actor: 'Bob', actorType: 'agent' as const, action: 'security.scan', resource: 'Server', resourceId: 'server-01', outcome: 'success' as const, severity: 'info' as const },
    { actor: 'Eve', actorType: 'agent' as const, action: 'backup.run', resource: 'Storage', outcome: 'failure' as const, severity: 'critical' as const, details: { error: 'Disk full' } },
  ];
  seeds.forEach(s => appendAuditEntry(s));
}
seedIfEmpty();

export default router;

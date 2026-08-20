import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type AutonomyClassification =
  | 'in_progress'
  | 'verified_autonomous'
  | 'assisted'
  | 'false_resolution'
  | 'failed'
  | 'human_handoff';

export type AutonomyPhaseKind =
  | 'dispatch'
  | 'agent_execution'
  | 'tool_execution'
  | 'resolution_claimed'
  | 'verification'
  | 'fallback_remediator'
  | 'fallback_workflow'
  | 'escalation'
  | 'terminal';

export interface AutonomyPhase {
  kind: AutonomyPhaseKind;
  at: string;
  status: 'started' | 'success' | 'failed' | 'pending';
  details?: Record<string, unknown>;
}

export interface AutonomyAttempt {
  id: string;
  incidentId: string;
  taskId: string | null;
  source: 'agent_handler' | 'auto_resolver';
  correlationId: string | null;
  agentId: string;
  agentName: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  classification: AutonomyClassification;
  outcome: string | null;
  verification: 'pending' | 'passed' | 'failed' | 'not_applicable';
  phases: AutonomyPhase[];
  updatedAt: string;
}

interface AttemptFilter {
  since?: string;
  until?: string;
  incidentId?: string;
  classification?: AutonomyClassification;
  agentId?: string;
  limit?: number;
}

interface RawAttempt {
  id: string;
  incident_id: string;
  task_id: string | null;
  source: AutonomyAttempt['source'];
  correlation_id: string | null;
  agent_id: string;
  agent_name: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  classification: AutonomyClassification;
  outcome: string | null;
  verification: AutonomyAttempt['verification'];
  phases: string;
  updated_at: string;
}

export class AutonomyAttemptStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autonomy_attempts (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL,
        task_id TEXT,
        source TEXT NOT NULL DEFAULT 'agent_handler',
        correlation_id TEXT,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        classification TEXT NOT NULL DEFAULT 'in_progress',
        outcome TEXT,
        verification TEXT NOT NULL DEFAULT 'pending',
        phases TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_autonomy_attempt_incident ON autonomy_attempts(incident_id, started_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_autonomy_attempt_correlation ON autonomy_attempts(correlation_id) WHERE correlation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_autonomy_attempt_started ON autonomy_attempts(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_autonomy_attempt_classification ON autonomy_attempts(classification, started_at DESC);
    `);
  }

  start(input: { incidentId: string; taskId?: string; source?: AutonomyAttempt['source']; correlationId?: string; agentId: string; agentName: string; at?: string }): AutonomyAttempt {
    const at = input.at || new Date().toISOString();
    const row: AutonomyAttempt = {
      id: `attempt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      incidentId: input.incidentId,
      taskId: input.taskId || null,
      source: input.source || 'agent_handler',
      correlationId: input.correlationId || null,
      agentId: input.agentId,
      agentName: input.agentName,
      startedAt: at,
      completedAt: null,
      durationMs: null,
      classification: 'in_progress',
      outcome: null,
      verification: 'pending',
      phases: [{ kind: 'dispatch', at, status: 'success', details: { taskId: input.taskId || null } }],
      updatedAt: at,
    };
    this.write(row);
    return row;
  }

  get(id: string): AutonomyAttempt | null {
    const row = this.db.prepare('SELECT * FROM autonomy_attempts WHERE id = ?').get(id) as RawAttempt | undefined;
    return row ? hydrate(row) : null;
  }

  getByCorrelationId(correlationId: string): AutonomyAttempt | null {
    const row = this.db.prepare('SELECT * FROM autonomy_attempts WHERE correlation_id = ?').get(correlationId) as RawAttempt | undefined;
    return row ? hydrate(row) : null;
  }

  latestForIncident(incidentId: string, onlyInProgress = false): AutonomyAttempt | null {
    const sql = `SELECT * FROM autonomy_attempts WHERE incident_id = ?${onlyInProgress ? " AND classification = 'in_progress'" : ''} ORDER BY started_at DESC LIMIT 1`;
    const row = this.db.prepare(sql).get(incidentId) as RawAttempt | undefined;
    return row ? hydrate(row) : null;
  }

  list(filter: AttemptFilter = {}): AutonomyAttempt[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.since) { where.push('started_at >= ?'); values.push(filter.since); }
    if (filter.until) { where.push('started_at <= ?'); values.push(filter.until); }
    if (filter.incidentId) { where.push('incident_id = ?'); values.push(filter.incidentId); }
    if (filter.classification) { where.push('classification = ?'); values.push(filter.classification); }
    if (filter.agentId) { where.push('agent_id = ?'); values.push(filter.agentId); }
    const limit = Math.min(Math.max(Math.floor(filter.limit || 5000), 1), 20_000);
    const rows = this.db.prepare(`SELECT * FROM autonomy_attempts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ${limit}`).all(...values) as RawAttempt[];
    return rows.map(hydrate);
  }

  /** Small bounded routing signal derived only from attributable terminal
   *  outcomes. New agents remain neutral until at least three samples. */
  reliabilityForAgent(agentId: string, limit = 200): { bonus: number; samples: number; successRate: number | null } {
    const rows = this.list({ agentId, limit: Math.min(Math.max(limit, 1), 2_000) })
      .filter(row => row.classification !== 'in_progress');
    const successes = rows.filter(row => row.classification === 'verified_autonomous' || row.classification === 'assisted').length;
    const failures = rows.filter(row => row.classification === 'false_resolution' || row.classification === 'failed').length;
    const samples = successes + failures;
    if (samples < 3) return { bonus: 0, samples, successRate: samples ? successes / samples : null };
    const successRate = successes / samples;
    return { bonus: Math.round((successRate - 0.5) * 20), samples, successRate };
  }

  addPhase(id: string, phase: Omit<AutonomyPhase, 'at'> & { at?: string }): AutonomyAttempt | null {
    const attempt = this.get(id);
    if (!attempt || attempt.classification !== 'in_progress') return attempt;
    const at = phase.at || new Date().toISOString();
    attempt.phases.push({ ...phase, at });
    attempt.updatedAt = at;
    this.write(attempt);
    return attempt;
  }

  conclude(id: string, classification: Exclude<AutonomyClassification, 'in_progress'>, outcome: string, opts: { verification?: AutonomyAttempt['verification']; at?: string; details?: Record<string, unknown> } = {}): AutonomyAttempt | null {
    const attempt = this.get(id);
    if (!attempt) return null;
    if (attempt.classification !== 'in_progress') return attempt;
    const at = opts.at || new Date().toISOString();
    attempt.classification = classification;
    attempt.outcome = outcome;
    attempt.verification = opts.verification || (classification === 'verified_autonomous' ? 'passed' : 'not_applicable');
    attempt.completedAt = at;
    attempt.durationMs = Math.max(0, Date.parse(at) - Date.parse(attempt.startedAt));
    attempt.updatedAt = at;
    attempt.phases.push({ kind: 'terminal', at, status: classification === 'false_resolution' || classification === 'failed' ? 'failed' : 'success', details: { classification, outcome, ...opts.details } });
    this.write(attempt);
    return attempt;
  }

  expireInProgress(olderThan: string): number {
    const attempts = this.list({ classification: 'in_progress', limit: 20_000 });
    let expired = 0;
    for (const attempt of attempts) {
      if (attempt.startedAt >= olderThan) continue;
      if (this.conclude(attempt.id, 'failed', 'attempt_expired', { details: { olderThan } })) expired++;
    }
    return expired;
  }

  close(): void { this.db.close(); }

  private write(row: AutonomyAttempt): void {
    this.db.prepare(`
      INSERT INTO autonomy_attempts
        (id, incident_id, task_id, source, correlation_id, agent_id, agent_name, started_at, completed_at, duration_ms, classification, outcome, verification, phases, updated_at)
      VALUES
        (@id, @incident_id, @task_id, @source, @correlation_id, @agent_id, @agent_name, @started_at, @completed_at, @duration_ms, @classification, @outcome, @verification, @phases, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        completed_at=excluded.completed_at, duration_ms=excluded.duration_ms, classification=excluded.classification,
        outcome=excluded.outcome, verification=excluded.verification, phases=excluded.phases, updated_at=excluded.updated_at
    `).run({
      id: row.id, incident_id: row.incidentId, task_id: row.taskId, source: row.source,
      correlation_id: row.correlationId, agent_id: row.agentId, agent_name: row.agentName,
      started_at: row.startedAt, completed_at: row.completedAt, duration_ms: row.durationMs,
      classification: row.classification, outcome: row.outcome, verification: row.verification,
      phases: JSON.stringify(row.phases), updated_at: row.updatedAt,
    });
  }
}

function hydrate(row: RawAttempt): AutonomyAttempt {
  let phases: AutonomyPhase[] = [];
  try { phases = JSON.parse(row.phases); } catch { phases = []; }
  return {
    id: row.id, incidentId: row.incident_id, taskId: row.task_id, source: row.source,
    correlationId: row.correlation_id, agentId: row.agent_id, agentName: row.agent_name,
    startedAt: row.started_at, completedAt: row.completed_at, durationMs: row.duration_ms,
    classification: row.classification, outcome: row.outcome, verification: row.verification,
    phases, updatedAt: row.updated_at,
  };
}

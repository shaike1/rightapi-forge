// AiDecisionStore — persistent log of every autonomous AI decision the
// platform makes. Backed by a single SQLite table so the AI Insights
// dashboard can produce aggregate stats with one query per metric.
//
// Why a single table:
//   • The five autonomy features (triage, resolve, predict, runbook-gen
//     and any future hooks) all produce the same shape: a typed
//     decision row with confidence, reasoning, applied/suggested flag,
//     optional reference to an incident, and outcome tracking.
//   • Joining across multiple typed tables to answer "what did the AI
//     do today" was rejected as needless complexity — discriminating
//     by `kind` is enough and the row count is small (one per incident
//     × number of features, capped at ~10/day per host in practice).
//
// Outcome tracking:
//   • A decision can be marked `outcome` later: 'success'|'failed'|
//     'reopened'|'overridden'. Used for accuracy stats — e.g. an auto-
//     resolved incident reopened within 24h flips outcome → 'reopened'.
//   • `reviewedAt` records when an operator confirmed/overrode the
//     decision so the dashboard can surface the latency from suggestion
//     to human action.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import { addTenantColumnSqlite } from '../persistence/index.js';

export type AiDecisionKind =
  | 'triage'
  | 'resolve'
  | 'predict'
  | 'runbook-generate';

export type AiDecisionOutcome =
  | 'pending'
  | 'success'
  | 'failed'
  | 'reopened'
  | 'overridden';

export interface AiDecision {
  id: string;
  kind: AiDecisionKind;
  /** Optional incident this decision relates to. Required for triage /
   *  resolve / predict (when a predicted incident has materialised) and
   *  omitted for things like a runbook generated from a prompt with no
   *  triggering incident. */
  incidentId: string | null;
  /** Confidence score in [0,1]. Producers pick the scale meaning. */
  confidence: number;
  /** Human-readable explanation displayed in the UI timeline + the
   *  AI Insights cards. */
  reasoning: string;
  /** True if the platform acted on the decision (auto-applied);
   *  false if it was suggested only. */
  autoApplied: boolean;
  outcome: AiDecisionOutcome;
  /** Free-form structured payload — each kind documents its own shape.
   *  Stored as JSON. */
  payload: Record<string, unknown>;
  createdAt: string;
  /** When the outcome moved off `pending` (or when an operator reviewed
   *  the suggestion). */
  reviewedAt: string | null;
  /** Username of the operator that reviewed/overrode the decision. */
  reviewedBy: string | null;
}

export interface AiDecisionFilter {
  kind?: AiDecisionKind;
  incidentId?: string;
  outcome?: AiDecisionOutcome;
  autoApplied?: boolean;
  /** ISO timestamp. */
  since?: string;
  limit?: number;
}

export interface AiDecisionStats {
  total: number;
  byKind: Record<AiDecisionKind, number>;
  byOutcome: Record<AiDecisionOutcome, number>;
  autoApplied: number;
  suggested: number;
  /** Mean confidence across all decisions. NaN-safe (returns 0 on empty). */
  meanConfidence: number;
  /** Per-kind mean confidence — convenient for the dashboard cards. */
  meanConfidenceByKind: Partial<Record<AiDecisionKind, number>>;
  /** Per-kind success rate computed as success/(success+failed+reopened).
   *  Decisions still pending are excluded from the denominator. */
  successRateByKind: Partial<Record<AiDecisionKind, number>>;
}

export class AiDecisionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    applyStandardPragmas(this.db);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_decisions (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        incident_id  TEXT,
        confidence   REAL NOT NULL DEFAULT 0,
        reasoning    TEXT NOT NULL DEFAULT '',
        auto_applied INTEGER NOT NULL DEFAULT 0,
        outcome      TEXT NOT NULL DEFAULT 'pending',
        payload      TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        reviewed_at  TEXT,
        reviewed_by  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ai_dec_kind        ON ai_decisions(kind);
      CREATE INDEX IF NOT EXISTS idx_ai_dec_incident    ON ai_decisions(incident_id);
      CREATE INDEX IF NOT EXISTS idx_ai_dec_outcome     ON ai_decisions(outcome);
      CREATE INDEX IF NOT EXISTS idx_ai_dec_created     ON ai_decisions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_dec_kind_created ON ai_decisions(kind, created_at DESC);
    `);
    addTenantColumnSqlite(this.db, 'ai_decisions');
  }

  insert(input: Omit<AiDecision, 'createdAt' | 'reviewedAt' | 'reviewedBy' | 'outcome'> & { outcome?: AiDecisionOutcome; createdAt?: string }): AiDecision {
    const row: AiDecision = {
      id: input.id,
      kind: input.kind,
      incidentId: input.incidentId ?? null,
      confidence: clamp01(input.confidence),
      reasoning: input.reasoning,
      autoApplied: !!input.autoApplied,
      outcome: input.outcome ?? 'pending',
      payload: input.payload ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
      reviewedAt: null,
      reviewedBy: null,
    };
    this.db.prepare(`
      INSERT INTO ai_decisions
        (id, kind, incident_id, confidence, reasoning, auto_applied, outcome, payload, created_at, reviewed_at, reviewed_by)
      VALUES
        (@id, @kind, @incident_id, @confidence, @reasoning, @auto_applied, @outcome, @payload, @created_at, NULL, NULL)
    `).run({
      id: row.id,
      kind: row.kind,
      incident_id: row.incidentId,
      confidence: row.confidence,
      reasoning: row.reasoning,
      auto_applied: row.autoApplied ? 1 : 0,
      outcome: row.outcome,
      payload: JSON.stringify(row.payload),
      created_at: row.createdAt,
    });
    return row;
  }

  get(id: string): AiDecision | null {
    const r = this.db.prepare('SELECT * FROM ai_decisions WHERE id = ?').get(id) as RawRow | undefined;
    return r ? hydrate(r) : null;
  }

  list(filter: AiDecisionFilter = {}): AiDecision[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.kind)        { where.push('kind = ?');        params.push(filter.kind); }
    if (filter.incidentId)  { where.push('incident_id = ?'); params.push(filter.incidentId); }
    if (filter.outcome)     { where.push('outcome = ?');     params.push(filter.outcome); }
    if (filter.autoApplied !== undefined) {
      where.push('auto_applied = ?');
      params.push(filter.autoApplied ? 1 : 0);
    }
    if (filter.since) {
      where.push('created_at >= ?');
      params.push(filter.since);
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 5000);
    const sql = `SELECT * FROM ai_decisions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as RawRow[]).map(hydrate);
  }

  /** Update the outcome (and reviewer info) for an existing decision.
   *  Idempotent — re-running with the same values is a no-op. */
  recordOutcome(id: string, outcome: AiDecisionOutcome, reviewedBy?: string): AiDecision | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db.prepare(`UPDATE ai_decisions SET outcome = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?`).run(
      outcome,
      new Date().toISOString(),
      reviewedBy ?? null,
      id,
    );
    return this.get(id);
  }

  /** Compute the aggregate stats used by the AI Insights dashboard. The
   *  `since` filter accepts the same ISO string the list endpoint takes;
   *  unset means all-time. */
  stats(since?: string): AiDecisionStats {
    const rows = this.list({ since, limit: 5000 });
    const byKind:    Record<AiDecisionKind, number> = { triage: 0, resolve: 0, predict: 0, 'runbook-generate': 0 };
    const byOutcome: Record<AiDecisionOutcome, number> = { pending: 0, success: 0, failed: 0, reopened: 0, overridden: 0 };
    let autoApplied = 0;
    let suggested = 0;
    let confidenceSum = 0;
    const confidenceByKind: Record<AiDecisionKind, { sum: number; n: number }> = {
      triage:            { sum: 0, n: 0 },
      resolve:           { sum: 0, n: 0 },
      predict:           { sum: 0, n: 0 },
      'runbook-generate':{ sum: 0, n: 0 },
    };
    const outcomeByKind: Record<AiDecisionKind, Record<AiDecisionOutcome, number>> = {
      triage:            { pending: 0, success: 0, failed: 0, reopened: 0, overridden: 0 },
      resolve:           { pending: 0, success: 0, failed: 0, reopened: 0, overridden: 0 },
      predict:           { pending: 0, success: 0, failed: 0, reopened: 0, overridden: 0 },
      'runbook-generate':{ pending: 0, success: 0, failed: 0, reopened: 0, overridden: 0 },
    };

    for (const r of rows) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      if (r.autoApplied) autoApplied++; else suggested++;
      confidenceSum += r.confidence;
      confidenceByKind[r.kind].sum += r.confidence;
      confidenceByKind[r.kind].n += 1;
      outcomeByKind[r.kind][r.outcome] = (outcomeByKind[r.kind][r.outcome] ?? 0) + 1;
    }

    const meanConfidenceByKind: Partial<Record<AiDecisionKind, number>> = {};
    const successRateByKind:   Partial<Record<AiDecisionKind, number>> = {};
    for (const kind of Object.keys(confidenceByKind) as AiDecisionKind[]) {
      const c = confidenceByKind[kind];
      if (c.n > 0) meanConfidenceByKind[kind] = c.sum / c.n;
      const o = outcomeByKind[kind];
      const concluded = o.success + o.failed + o.reopened;
      if (concluded > 0) successRateByKind[kind] = o.success / concluded;
    }

    return {
      total: rows.length,
      byKind,
      byOutcome,
      autoApplied,
      suggested,
      meanConfidence: rows.length > 0 ? confidenceSum / rows.length : 0,
      meanConfidenceByKind,
      successRateByKind,
    };
  }

  /** Delete decisions older than the given ISO timestamp. Returns rows removed. */
  prune(olderThan: string, dryRun = false): number {
    if (dryRun) return (this.db.prepare('SELECT COUNT(*) AS n FROM ai_decisions WHERE created_at < ?').get(olderThan) as { n: number }).n;
    const info = this.db.prepare('DELETE FROM ai_decisions WHERE created_at < ?').run(olderThan);
    return info.changes;
  }

  close(): void { this.db.close(); }
}

interface RawRow {
  id: string;
  kind: AiDecisionKind;
  incident_id: string | null;
  confidence: number;
  reasoning: string;
  auto_applied: number;
  outcome: AiDecisionOutcome;
  payload: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

function hydrate(r: RawRow): AiDecision {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(r.payload || '{}'); } catch { payload = { _raw: r.payload }; }
  return {
    id: r.id,
    kind: r.kind,
    incidentId: r.incident_id,
    confidence: r.confidence,
    reasoning: r.reasoning,
    autoApplied: r.auto_applied === 1,
    outcome: r.outcome,
    payload,
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

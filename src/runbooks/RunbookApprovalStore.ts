// RunbookApprovalStore — per-run/per-step approval records.
//
// Distinct from the generic ApprovalTokenService — that one mints opaque
// service-to-service JWTs scoped to (command, agentId). Here each row is
// tied to a specific RunbookRun + step, with the requester / decider /
// reason audit trail the editor work needs. The two systems coexist
// (ApprovalTokenService still gates skill-execution and workflow approval
// gates) but they speak different languages.
//
// Schema is intentionally lean: status moves pending → approved | rejected
// | timeout. A row is never deleted; we keep the full history so /api/audit
// can replay who decided what.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

export interface RunbookApproval {
  id: string;
  runId: string;
  stepId: string;
  stepDescription: string;
  /** Why approval was needed — either 'requires_approval flag' or the
   *  destructive-pattern that triggered the hardcoded guard. Surfaced in
   *  the operator UI so the approver knows *what* they're greenlighting. */
  reason: string;
  requestedBy: string;
  requestedAt: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
}

interface Row {
  id: string;
  run_id: string;
  step_id: string;
  step_description: string;
  reason: string;
  requested_by: string;
  requested_at: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
}

export class RunbookApprovalStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    logger.info('[RunbookApprovalStore] opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runbook_approvals (
        id                TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL,
        step_id           TEXT NOT NULL,
        step_description  TEXT NOT NULL,
        reason            TEXT NOT NULL,
        requested_by      TEXT NOT NULL,
        requested_at      TEXT NOT NULL,
        status            TEXT NOT NULL,
        decided_by        TEXT,
        decided_at        TEXT,
        decision_reason   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_run    ON runbook_approvals(run_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON runbook_approvals(status);
    `);
    addTenantColumnSqlite(this.db, 'runbook_approvals');
  }

  create(params: { runId: string; stepId: string; stepDescription: string; reason: string; requestedBy: string }): RunbookApproval {
    const id = 'apr-' + crypto.randomBytes(6).toString('hex');
    const requestedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runbook_approvals (id, run_id, step_id, step_description, reason, requested_by, requested_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, params.runId, params.stepId, params.stepDescription, params.reason, params.requestedBy, requestedAt);
    return {
      id,
      runId: params.runId,
      stepId: params.stepId,
      stepDescription: params.stepDescription,
      reason: params.reason,
      requestedBy: params.requestedBy,
      requestedAt,
      status: 'pending',
    };
  }

  decide(id: string, decision: { status: 'approved' | 'rejected' | 'timeout'; decidedBy: string; reason?: string }): RunbookApproval | null {
    const existing = this.get(id);
    if (!existing || existing.status !== 'pending') return null;
    const decidedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE runbook_approvals
      SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(decision.status, decision.decidedBy, decidedAt, decision.reason ?? null, id);
    return this.get(id);
  }

  get(id: string): RunbookApproval | null {
    const row = this.db.prepare('SELECT * FROM runbook_approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? this.rowToApproval(row) : null;
  }

  /** Find the active (pending) approval for a given run+step. The engine
   *  uses this on `approve` / `reject` requests that arrive identified by
   *  (runId, stepId) rather than approval id. */
  findPendingForStep(runId: string, stepId: string): RunbookApproval | null {
    const row = this.db.prepare(
      "SELECT * FROM runbook_approvals WHERE run_id = ? AND step_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1"
    ).get(runId, stepId) as Row | undefined;
    return row ? this.rowToApproval(row) : null;
  }

  listPending(): RunbookApproval[] {
    const rows = this.db.prepare(
      "SELECT * FROM runbook_approvals WHERE status = 'pending' ORDER BY requested_at DESC"
    ).all() as Row[];
    return rows.map(r => this.rowToApproval(r));
  }

  listForRun(runId: string): RunbookApproval[] {
    const rows = this.db.prepare(
      'SELECT * FROM runbook_approvals WHERE run_id = ? ORDER BY requested_at DESC'
    ).all(runId) as Row[];
    return rows.map(r => this.rowToApproval(r));
  }

  private rowToApproval(row: Row): RunbookApproval {
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      stepDescription: row.step_description,
      reason: row.reason,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      status: row.status as ApprovalStatus,
      decidedBy: row.decided_by ?? undefined,
      decidedAt: row.decided_at ?? undefined,
      decisionReason: row.decision_reason ?? undefined,
    };
  }

  close(): void { this.db.close(); }
}

// RunbookRunStore — SQLite-backed persistence for runbook executions.
//
// Replaces the JSON-file ring buffer (last 500 runs only) that the engine
// used to keep at /data/itops-agents/runbook-runs.json. The audit trail
// requirements for the editor work need a queryable, paginated, full
// history — better-sqlite3 gives us that with the same ops surface
// (single file, hot-backed up by the existing state-backup job).
//
// On first boot the legacy JSON file is imported once into the SQLite
// table and then ignored. Operators never see the JSON path again.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import type { RunbookRun, RunbookStatus, RunbookRunContext } from './RunbookTypes.js';
import { logger } from '../utils/logger.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

interface Row {
  id: string;
  template_id: string;
  template_name: string;
  triggered_by: string;
  status: string;
  current_step_index: number;
  step_results: string;
  context: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export class RunbookRunStore {
  private readonly db: Database.Database;

  constructor(dbPath: string, opts: { legacyJsonPath?: string } = {}) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    if (opts.legacyJsonPath) this.importLegacy(opts.legacyJsonPath);
    logger.info('[RunbookRunStore] opened', { dbPath });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runbook_runs (
        id                   TEXT PRIMARY KEY,
        template_id          TEXT NOT NULL,
        template_name        TEXT NOT NULL,
        triggered_by         TEXT NOT NULL,
        status               TEXT NOT NULL,
        current_step_index   INTEGER NOT NULL DEFAULT 0,
        step_results         TEXT NOT NULL,
        context              TEXT,
        started_at           TEXT NOT NULL,
        completed_at         TEXT,
        error                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_template_id ON runbook_runs(template_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status      ON runbook_runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at  ON runbook_runs(started_at DESC);
    `);
    addTenantColumnSqlite(this.db, 'runbook_runs');
  }

  /** One-shot migration from the legacy JSON ring buffer. Idempotent —
   *  re-running this on the same JSON file is harmless because rows are
   *  upserted by id. After a successful import we rename the JSON to
   *  `.imported` so the next boot doesn't re-load anything. */
  private importLegacy(jsonPath: string): void {
    if (!existsSync(jsonPath)) return;
    try {
      const raw = readFileSync(jsonPath, 'utf8');
      const runs = JSON.parse(raw) as RunbookRun[];
      if (!Array.isArray(runs) || runs.length === 0) return;
      let imported = 0;
      for (const run of runs) {
        try {
          this.upsert(run);
          imported++;
        } catch (e) {
          logger.warn('[RunbookRunStore] skip malformed legacy run', {
            id: run?.id, err: e instanceof Error ? e.message : String(e),
          });
        }
      }
      logger.info('[RunbookRunStore] imported legacy JSON runs', { jsonPath, imported });
      try { renameSync(jsonPath, jsonPath + '.imported'); } catch { /* best-effort */ }
    } catch (e) {
      logger.warn('[RunbookRunStore] legacy import failed', {
        jsonPath, err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  upsert(run: RunbookRun): void {
    this.db.prepare(`
      INSERT INTO runbook_runs
        (id, template_id, template_name, triggered_by, status, current_step_index, step_results, context, started_at, completed_at, error)
      VALUES (@id, @template_id, @template_name, @triggered_by, @status, @current_step_index, @step_results, @context, @started_at, @completed_at, @error)
      ON CONFLICT(id) DO UPDATE SET
        template_name=excluded.template_name,
        triggered_by=excluded.triggered_by,
        status=excluded.status,
        current_step_index=excluded.current_step_index,
        step_results=excluded.step_results,
        context=excluded.context,
        completed_at=excluded.completed_at,
        error=excluded.error
    `).run({
      id: run.id,
      template_id: run.templateId,
      template_name: run.templateName,
      triggered_by: run.triggeredBy,
      status: run.status,
      current_step_index: run.currentStepIndex,
      step_results: JSON.stringify(run.stepResults),
      context: run.context ? JSON.stringify(run.context) : null,
      started_at: run.startedAt,
      completed_at: run.completedAt ?? null,
      error: run.error ?? null,
    });
  }

  get(id: string): RunbookRun | null {
    const row = this.db.prepare('SELECT * FROM runbook_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.rowToRun(row) : null;
  }

  /** Active = running or waiting_approval. Used by the engine on boot to
   *  resurrect in-flight approvals into the watcher map. */
  listActive(): RunbookRun[] {
    const rows = this.db.prepare(
      "SELECT * FROM runbook_runs WHERE status IN ('running','waiting_approval') ORDER BY started_at DESC"
    ).all() as Row[];
    return rows.map(r => this.rowToRun(r));
  }

  /** General-purpose list with filter + pagination. Returns most-recent
   *  first to mirror what the dashboard expects. */
  list(filter: { templateId?: string; status?: RunbookStatus; limit?: number; offset?: number } = {}): RunbookRun[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.templateId) { where.push('template_id = @template_id'); params.template_id = filter.templateId; }
    if (filter.status)     { where.push('status = @status'); params.status = filter.status; }
    const limit  = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const q = `SELECT * FROM runbook_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const rows = this.db.prepare(q).all(params) as Row[];
    return rows.map(r => this.rowToRun(r));
  }

  /** Count for paginated views. */
  count(filter: { templateId?: string; status?: RunbookStatus } = {}): number {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.templateId) { where.push('template_id = @template_id'); params.template_id = filter.templateId; }
    if (filter.status)     { where.push('status = @status'); params.status = filter.status; }
    const q = `SELECT COUNT(*) AS n FROM runbook_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const r = this.db.prepare(q).get(params) as { n: number };
    return r.n;
  }

  private rowToRun(row: Row): RunbookRun {
    const ctx: RunbookRunContext | undefined = row.context ? this.safeJSON(row.context) : undefined;
    return {
      id: row.id,
      templateId: row.template_id,
      templateName: row.template_name,
      triggeredBy: row.triggered_by,
      status: row.status as RunbookStatus,
      currentStepIndex: row.current_step_index,
      stepResults: this.safeJSON(row.step_results) ?? [],
      context: ctx,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    };
  }

  private safeJSON<T = unknown>(s: string): T | undefined {
    try { return JSON.parse(s) as T; } catch { return undefined; }
  }

  close(): void { this.db.close(); }
}

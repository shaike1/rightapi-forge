import Database from 'better-sqlite3';
import path from 'path';
import type { Plan, PlanNode } from './GoalPlanner.js';
import { addTenantColumnSqlite } from '../persistence/tenantMigration.js';

export class PlanStore {
  private db: Database.Database;

  constructor(dbPath = '/data/itops-agents/plans.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        progress INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS plan_nodes (
        id TEXT NOT NULL,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        task TEXT NOT NULL,
        description TEXT NOT NULL,
        assigned_agent TEXT,
        required_skills TEXT NOT NULL DEFAULT '[]',
        deps TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        error TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (id, plan_id)
      );
      -- ORDER BY created_at DESC on list() — index keeps it cheap as the
      -- table grows. Composite PK on (id, plan_id) already covers the
      -- plan_id lookup in hydrate(), so no extra index needed there.
      CREATE INDEX IF NOT EXISTS idx_plans_created ON plans(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_plan_nodes_plan ON plan_nodes(plan_id);
    `);
    addTenantColumnSqlite(this.db, 'plans');
    addTenantColumnSqlite(this.db, 'plan_nodes');
  }

  save(plan: Plan): void {
    const upsertPlan = this.db.prepare(`
      INSERT INTO plans (id, goal, status, progress, created_by, created_at, updated_at, completed_at)
      VALUES (@id, @goal, @status, @progress, @createdBy, @createdAt, @updatedAt, @completedAt)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, progress=excluded.progress,
        updated_at=excluded.updated_at, completed_at=excluded.completed_at
    `);

    const upsertNode = this.db.prepare(`
      INSERT INTO plan_nodes
        (id, plan_id, task, description, assigned_agent, required_skills, deps, status, result, error, retries, started_at, completed_at)
      VALUES
        (@id, @planId, @task, @description, @assignedAgent, @requiredSkills, @deps, @status, @result, @error, @retries, @startedAt, @completedAt)
      ON CONFLICT(id, plan_id) DO UPDATE SET
        status=excluded.status, result=excluded.result, error=excluded.error,
        retries=excluded.retries, started_at=excluded.started_at, completed_at=excluded.completed_at,
        assigned_agent=excluded.assigned_agent
    `);

    const tx = this.db.transaction(() => {
      upsertPlan.run({
        id: plan.id,
        goal: plan.goal,
        status: plan.status,
        progress: plan.progress,
        createdBy: plan.createdBy ?? null,
        createdAt: plan.createdAt.toISOString(),
        updatedAt: plan.updatedAt.toISOString(),
        completedAt: plan.completedAt?.toISOString() ?? null,
      });

      for (const node of plan.nodes) {
        upsertNode.run({
          id: node.id,
          planId: plan.id,
          task: node.task,
          description: node.description,
          assignedAgent: node.assignedAgent ?? null,
          requiredSkills: JSON.stringify(node.requiredSkills),
          deps: JSON.stringify(node.deps),
          status: node.status,
          result: node.result ?? null,
          error: node.error ?? null,
          retries: node.retries,
          startedAt: node.startedAt?.toISOString() ?? null,
          completedAt: node.completedAt?.toISOString() ?? null,
        });
      }
    });

    tx();
  }

  get(planId: string): Plan | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as any;
    if (!row) return null;
    return this.hydrate(row);
  }

  list(limit = 50): Plan[] {
    const rows = this.db
      .prepare('SELECT * FROM plans ORDER BY created_at DESC LIMIT ?')
      .all(limit) as any[];
    return rows.map((r) => this.hydrate(r));
  }

  delete(planId: string): void {
    this.db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
  }

  private hydrate(row: any): Plan {
    const nodeRows = this.db
      .prepare('SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY rowid')
      .all(row.id) as any[];

    const nodes: PlanNode[] = nodeRows.map((n) => ({
      id: n.id,
      task: n.task,
      description: n.description,
      assignedAgent: n.assigned_agent ?? undefined,
      requiredSkills: JSON.parse(n.required_skills),
      deps: JSON.parse(n.deps),
      status: n.status,
      result: n.result ?? undefined,
      error: n.error ?? undefined,
      retries: n.retries,
      startedAt: n.started_at ? new Date(n.started_at) : undefined,
      completedAt: n.completed_at ? new Date(n.completed_at) : undefined,
    }));

    return {
      id: row.id,
      goal: row.goal,
      nodes,
      status: row.status,
      progress: row.progress,
      createdBy: row.created_by ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }
}

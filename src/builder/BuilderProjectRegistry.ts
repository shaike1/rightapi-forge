import crypto from 'node:crypto';
import { dirname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import { type AppSpec, parseAppSpec } from './AppSpec.js';

export type BuilderProjectStatus = 'draft' | 'ready' | 'archived';

export interface BuilderRevision {
  projectId: string;
  tenantId: string;
  revision: number;
  spec: AppSpec;
  message: string;
  actor: string;
  checksum: string;
  createdAt: string;
}

export interface BuilderProject {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: BuilderProjectStatus;
  currentRevision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: BuilderRevision;
}

export interface BuilderEditState {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
}

interface ProjectRow {
  id: string; tenant_id: string; name: string; slug: string; status: BuilderProjectStatus;
  current_revision: number; created_by: string; created_at: string; updated_at: string;
}

interface RevisionRow {
  project_id: string; tenant_id: string; revision: number; spec_json: string;
  message: string; actor: string; checksum: string; created_at: string;
}

export class BuilderProjectRegistry {
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
      CREATE TABLE IF NOT EXISTS builder_projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        current_revision INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_builder_projects_tenant_updated
        ON builder_projects(tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS builder_revisions (
        project_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        spec_version TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        message TEXT NOT NULL,
        actor TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, revision),
        FOREIGN KEY (project_id) REFERENCES builder_projects(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_builder_revisions_project
        ON builder_revisions(tenant_id, project_id, revision DESC);
      CREATE TABLE IF NOT EXISTS builder_edit_state (
        project_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        undo_json TEXT NOT NULL DEFAULT '[]',
        redo_json TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (project_id) REFERENCES builder_projects(id) ON DELETE RESTRICT
      );
    `);
  }

  create(input: { tenantId: string; actor: string; message: string; spec: unknown }): BuilderProject {
    const spec = parseAppSpec(input.spec);
    const now = new Date().toISOString();
    const id = `app-${crypto.randomBytes(8).toString('hex')}`;
    const stored = JSON.stringify(spec);
    const checksum = sha256(stored);
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO builder_projects
        (id, tenant_id, name, slug, status, current_revision, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?)`)
        .run(id, input.tenantId, spec.metadata.name, spec.metadata.slug, input.actor, now, now);
      this.db.prepare(`INSERT INTO builder_revisions
        (project_id, tenant_id, revision, spec_version, spec_json, message, actor, checksum, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.tenantId, spec.schemaVersion, stored, input.message.trim(), input.actor, checksum, now);
      this.saveEditState(id, input.tenantId, [], []);
    })();
    return this.get(id, input.tenantId)!;
  }

  revise(input: { projectId: string; tenantId: string; actor: string; message: string; spec: unknown; expectedRevision?: number }): BuilderProject | null {
    const spec = parseAppSpec(input.spec);
    const existing = this.projectRow(input.projectId, input.tenantId);
    if (!existing) return null;
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing.current_revision) {
      throw new Error(`revision conflict: expected ${input.expectedRevision}, current ${existing.current_revision}`);
    }
    const revision = existing.current_revision + 1;
    const now = new Date().toISOString();
    const stored = JSON.stringify(spec);
    const checksum = sha256(stored);
    const editState = this.editStacks(input.projectId, input.tenantId, existing.current_revision);
    this.db.transaction(() => {
      const updated = this.db.prepare(`UPDATE builder_projects
        SET name = ?, slug = ?, current_revision = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND current_revision = ?`)
        .run(spec.metadata.name, spec.metadata.slug, revision, now, input.projectId, input.tenantId, existing.current_revision);
      if (updated.changes !== 1) throw new Error('revision conflict: project changed while refining');
      this.db.prepare(`INSERT INTO builder_revisions
        (project_id, tenant_id, revision, spec_version, spec_json, message, actor, checksum, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.projectId, input.tenantId, revision, spec.schemaVersion, stored, input.message.trim(), input.actor, checksum, now);
      this.saveEditState(input.projectId, input.tenantId, [...editState.undo, existing.current_revision], []);
    })();
    return this.get(input.projectId, input.tenantId);
  }

  undo(input: { projectId: string; tenantId: string; actor: string; expectedRevision?: number }): BuilderProject | null {
    return this.moveHistory({ ...input, direction: 'undo' });
  }

  redo(input: { projectId: string; tenantId: string; actor: string; expectedRevision?: number }): BuilderProject | null {
    return this.moveHistory({ ...input, direction: 'redo' });
  }

  editState(projectId: string, tenantId: string): BuilderEditState | null {
    const project = this.projectRow(projectId, tenantId);
    if (!project) return null;
    const state = this.editStacks(projectId, tenantId, project.current_revision);
    return { canUndo: state.undo.length > 0, canRedo: state.redo.length > 0, undoDepth: state.undo.length, redoDepth: state.redo.length };
  }

  setStatus(id: string, tenantId: string, status: BuilderProjectStatus): BuilderProject | null {
    const result = this.db.prepare('UPDATE builder_projects SET status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(status, new Date().toISOString(), id, tenantId);
    return result.changes === 1 ? this.get(id, tenantId) : null;
  }

  get(id: string, tenantId: string): BuilderProject | null {
    const project = this.projectRow(id, tenantId);
    if (!project) return null;
    const revision = this.revisionRow(id, tenantId, project.current_revision);
    if (!revision) throw new Error(`builder project ${id} has no current revision`);
    return hydrateProject(project, revision);
  }

  list(tenantId: string, opts: { includeArchived?: boolean; limit?: number } = {}): BuilderProject[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`SELECT * FROM builder_projects
      WHERE tenant_id = ? ${opts.includeArchived ? '' : "AND status != 'archived'"}
      ORDER BY updated_at DESC LIMIT ?`).all(tenantId, limit) as ProjectRow[];
    return rows.map(project => {
      const revision = this.revisionRow(project.id, tenantId, project.current_revision);
      if (!revision) throw new Error(`builder project ${project.id} has no current revision`);
      return hydrateProject(project, revision);
    });
  }

  revisions(projectId: string, tenantId: string): BuilderRevision[] {
    return (this.db.prepare(`SELECT * FROM builder_revisions
      WHERE project_id = ? AND tenant_id = ? ORDER BY revision DESC`)
      .all(projectId, tenantId) as RevisionRow[]).map(hydrateRevision);
  }

  close(): void { this.db.close(); }

  private projectRow(id: string, tenantId: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM builder_projects WHERE id = ? AND tenant_id = ?').get(id, tenantId) as ProjectRow | undefined;
  }

  private revisionRow(projectId: string, tenantId: string, revision: number): RevisionRow | undefined {
    return this.db.prepare(`SELECT * FROM builder_revisions
      WHERE project_id = ? AND tenant_id = ? AND revision = ?`).get(projectId, tenantId, revision) as RevisionRow | undefined;
  }

  private moveHistory(input: { projectId: string; tenantId: string; actor: string; expectedRevision?: number; direction: 'undo' | 'redo' }): BuilderProject | null {
    const existing = this.projectRow(input.projectId, input.tenantId);
    if (!existing) return null;
    if (input.expectedRevision !== undefined && input.expectedRevision !== existing.current_revision) {
      throw new Error(`revision conflict: expected ${input.expectedRevision}, current ${existing.current_revision}`);
    }
    const state = this.editStacks(input.projectId, input.tenantId, existing.current_revision);
    const source = input.direction === 'undo' ? state.undo : state.redo;
    if (source.length === 0) throw new Error(`nothing to ${input.direction}`);
    const targetRevision = source[source.length - 1];
    const target = this.revisionRow(input.projectId, input.tenantId, targetRevision);
    if (!target) throw new Error(`${input.direction} target revision is unavailable`);
    const spec = parseAppSpec(JSON.parse(target.spec_json));
    const revision = existing.current_revision + 1;
    const now = new Date().toISOString();
    const stored = JSON.stringify(spec);
    const checksum = sha256(stored);
    const undo = input.direction === 'undo'
      ? state.undo.slice(0, -1)
      : [...state.undo, existing.current_revision];
    const redo = input.direction === 'undo'
      ? [...state.redo, existing.current_revision]
      : state.redo.slice(0, -1);
    this.db.transaction(() => {
      const updated = this.db.prepare(`UPDATE builder_projects
        SET name = ?, slug = ?, current_revision = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND current_revision = ?`)
        .run(spec.metadata.name, spec.metadata.slug, revision, now, input.projectId, input.tenantId, existing.current_revision);
      if (updated.changes !== 1) throw new Error('revision conflict: project changed while editing history');
      this.db.prepare(`INSERT INTO builder_revisions
        (project_id, tenant_id, revision, spec_version, spec_json, message, actor, checksum, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.projectId, input.tenantId, revision, spec.schemaVersion, stored,
          `${input.direction} to revision ${targetRevision}`, input.actor, checksum, now);
      this.saveEditState(input.projectId, input.tenantId, undo, redo);
    })();
    return this.get(input.projectId, input.tenantId);
  }

  private editStacks(projectId: string, tenantId: string, currentRevision: number): { undo: number[]; redo: number[] } {
    const row = this.db.prepare(`SELECT undo_json, redo_json FROM builder_edit_state
      WHERE project_id = ? AND tenant_id = ?`).get(projectId, tenantId) as { undo_json: string; redo_json: string } | undefined;
    if (row) return { undo: JSON.parse(row.undo_json) as number[], redo: JSON.parse(row.redo_json) as number[] };
    const undo = (this.db.prepare(`SELECT revision FROM builder_revisions
      WHERE project_id = ? AND tenant_id = ? AND revision < ? ORDER BY revision ASC`)
      .all(projectId, tenantId, currentRevision) as Array<{ revision: number }>).map(item => item.revision);
    this.saveEditState(projectId, tenantId, undo, []);
    return { undo, redo: [] };
  }

  private saveEditState(projectId: string, tenantId: string, undo: number[], redo: number[]): void {
    this.db.prepare(`INSERT INTO builder_edit_state (project_id, tenant_id, undo_json, redo_json)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET
      tenant_id=excluded.tenant_id, undo_json=excluded.undo_json, redo_json=excluded.redo_json`)
      .run(projectId, tenantId, JSON.stringify(undo), JSON.stringify(redo));
  }
}

function hydrateProject(row: ProjectRow, revision: RevisionRow): BuilderProject {
  return {
    id: row.id, tenantId: row.tenant_id, name: row.name, slug: row.slug,
    status: row.status, currentRevision: row.current_revision, createdBy: row.created_by,
    createdAt: row.created_at, updatedAt: row.updated_at, revision: hydrateRevision(revision),
  };
}

function hydrateRevision(row: RevisionRow): BuilderRevision {
  const raw = row.spec_json;
  if (sha256(raw) !== row.checksum) throw new Error(`builder revision checksum mismatch: ${row.project_id}@${row.revision}`);
  return {
    projectId: row.project_id, tenantId: row.tenant_id, revision: row.revision,
    spec: parseAppSpec(JSON.parse(raw)), message: row.message, actor: row.actor,
    checksum: row.checksum, createdAt: row.created_at,
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

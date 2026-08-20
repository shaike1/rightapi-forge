import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import type { BuilderProjectRegistry, BuilderProjectStatus } from './BuilderProjectRegistry.js';
import type { ToolReleaseManager } from './ToolReleaseManager.js';

export interface CatalogTool {
  id: string; name: string; slug: string; description: string; owner: string; revision: number;
  lifecycle: BuilderProjectStatus; releaseStatus: string; health: 'healthy' | 'not_deployed' | 'degraded';
  deploymentId?: string; deployedRevision?: number; launches: number; lastLaunchedAt?: string; updatedAt: string;
}

export class ToolCatalog {
  private db: Database.Database;
  constructor(private projects: BuilderProjectRegistry, private releases: ToolReleaseManager, dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath); applyStandardPragmas(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS builder_catalog_usage (
      tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, launches INTEGER NOT NULL DEFAULT 0,
      last_launched_at TEXT, PRIMARY KEY (tenant_id, project_id)
    );`);
  }

  list(tenantId: string, options: { query?: string; lifecycle?: BuilderProjectStatus } = {}): CatalogTool[] {
    const query = options.query?.trim().toLowerCase() ?? '';
    return this.projects.list(tenantId, { includeArchived: true, limit: 500 })
      .filter(project => !options.lifecycle || project.status === options.lifecycle)
      .filter(project => !query || `${project.name} ${project.slug} ${project.revision.spec.metadata.description}`.toLowerCase().includes(query))
      .map(project => {
        const deployments = this.releases.listDeployments(project.id, tenantId);
        const active = deployments.find(item => item.status === 'healthy');
        const latestRelease = this.releases.listReleases(project.id, tenantId)[0];
        const usage = this.db.prepare('SELECT launches,last_launched_at FROM builder_catalog_usage WHERE tenant_id=? AND project_id=?')
          .get(tenantId, project.id) as { launches: number; last_launched_at?: string } | undefined;
        const failedLatest = deployments[0] && ['failed', 'rolled_back'].includes(deployments[0].status);
        return {
          id: project.id, name: project.name, slug: project.slug, description: project.revision.spec.metadata.description,
          owner: project.createdBy, revision: project.currentRevision, lifecycle: project.status,
          releaseStatus: latestRelease?.status ?? 'unreleased', health: active ? 'healthy' : failedLatest ? 'degraded' : 'not_deployed',
          ...(active ? { deploymentId: active.id, deployedRevision: active.revision } : {}),
          launches: usage?.launches ?? 0, ...(usage?.last_launched_at ? { lastLaunchedAt: usage.last_launched_at } : {}), updatedAt: project.updatedAt,
        } satisfies CatalogTool;
      });
  }

  recordLaunch(projectId: string, tenantId: string): CatalogTool | null {
    const project = this.projects.get(projectId, tenantId);
    if (!project || project.status === 'archived') return null;
    const active = this.releases.listDeployments(projectId, tenantId).find(item => item.status === 'healthy');
    if (!active) throw new Error('tool has no healthy deployment');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO builder_catalog_usage (tenant_id,project_id,launches,last_launched_at) VALUES (?,?,1,?)
      ON CONFLICT(tenant_id,project_id) DO UPDATE SET launches=launches+1,last_launched_at=excluded.last_launched_at`)
      .run(tenantId, projectId, now);
    return this.list(tenantId).find(item => item.id === projectId) ?? null;
  }

  close(): void { this.db.close(); }
}

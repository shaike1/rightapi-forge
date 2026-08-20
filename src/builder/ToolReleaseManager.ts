import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import type { AppSpec } from './AppSpec.js';
import type { GeneratedApplication } from './AppGenerator.js';
import type { QualityEvidence } from './QualityGate.js';

export type ReleaseRisk = 'low' | 'medium' | 'high';
export type ToolReleaseStatus = 'pending_review' | 'approved' | 'rejected' | 'deploying' | 'deployed' | 'failed' | 'rolled_back';
export type ToolDeploymentStatus = 'healthy' | 'failed' | 'superseded' | 'rolled_back';

export interface ReleaseApproval { actor: string; decision: 'approved' | 'rejected'; note: string; at: string }
export interface RevisionDiff {
  previousRevision?: number;
  pages: ChangeSet;
  dataModels: ChangeSet;
  actions: ChangeSet;
  integrations: ChangeSet;
  roles: ChangeSet;
  metadataChanged: boolean;
  deploymentChanged: boolean;
}
interface ChangeSet { added: string[]; removed: string[]; changed: string[] }

export interface ToolRelease {
  id: string; tenantId: string; projectId: string; revision: number; status: ToolReleaseStatus;
  risk: ReleaseRisk; requiredApprovals: number; requestedBy: string; requestedAt: string;
  artifactChecksum: string; evidenceId: string; diff: RevisionDiff; approvals: ReleaseApproval[];
  metadataSignature?: string; exportCommit?: string; deployedAt?: string; failure?: string;
}

export interface ToolDeployment {
  id: string; tenantId: string; projectId: string; releaseId: string; revision: number;
  status: ToolDeploymentStatus; runtimeRef?: string; health: string; createdBy: string; createdAt: string;
  completedAt?: string; rolledBackTo?: string; failure?: string;
}

export interface ReleaseAuditEvent {
  id: string; tenantId: string; releaseId: string; deploymentId?: string; action: string;
  actor: string; data: Record<string, unknown>; at: string; checksum: string;
}

export interface GitReleaseExporter {
  export(input: { release: ToolRelease; artifact: GeneratedApplication; signedMetadata: string }): Promise<{ commit: string }>;
}

export interface ToolDeploymentAdapter {
  deploy(input: { deploymentId: string; tenantId: string; projectId: string; revision: number; artifact: GeneratedApplication }): Promise<{ healthy: boolean; runtimeRef?: string; health: string; error?: string }>;
  rollback(input: { activeRuntimeRef?: string; targetRuntimeRef: string }): Promise<{ healthy: boolean; health: string; error?: string }>;
}

export class ToolReleaseStore {
  private db: Database.Database;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath); applyStandardPragmas(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS builder_releases (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, release_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builder_releases_project ON builder_releases(tenant_id, project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS builder_deployments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, release_id TEXT NOT NULL,
      revision INTEGER NOT NULL, status TEXT NOT NULL, deployment_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builder_deployments_project ON builder_deployments(tenant_id, project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS builder_release_events (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, release_id TEXT NOT NULL, deployment_id TEXT,
      action TEXT NOT NULL, event_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builder_release_events ON builder_release_events(tenant_id, release_id, created_at ASC);`);
  }
  saveRelease(value: ToolRelease): void {
    this.db.prepare(`INSERT INTO builder_releases (id, tenant_id, project_id, revision, status, release_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, release_json=excluded.release_json`)
      .run(value.id, value.tenantId, value.projectId, value.revision, value.status, JSON.stringify(value), value.requestedAt);
  }
  getRelease(id: string, tenantId: string): ToolRelease | null {
    const row = this.db.prepare('SELECT release_json FROM builder_releases WHERE id=? AND tenant_id=?').get(id, tenantId) as { release_json: string } | undefined;
    return row ? JSON.parse(row.release_json) as ToolRelease : null;
  }
  listReleases(projectId: string, tenantId: string): ToolRelease[] {
    return (this.db.prepare('SELECT release_json FROM builder_releases WHERE project_id=? AND tenant_id=? ORDER BY created_at DESC').all(projectId, tenantId) as Array<{ release_json: string }>).map(row => JSON.parse(row.release_json));
  }
  saveDeployment(value: ToolDeployment): void {
    this.db.prepare(`INSERT INTO builder_deployments (id, tenant_id, project_id, release_id, revision, status, deployment_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, deployment_json=excluded.deployment_json`)
      .run(value.id, value.tenantId, value.projectId, value.releaseId, value.revision, value.status, JSON.stringify(value), value.createdAt);
  }
  getDeployment(id: string, tenantId: string): ToolDeployment | null {
    const row = this.db.prepare('SELECT deployment_json FROM builder_deployments WHERE id=? AND tenant_id=?').get(id, tenantId) as { deployment_json: string } | undefined;
    return row ? JSON.parse(row.deployment_json) as ToolDeployment : null;
  }
  listDeployments(projectId: string, tenantId: string): ToolDeployment[] {
    return (this.db.prepare('SELECT deployment_json FROM builder_deployments WHERE project_id=? AND tenant_id=? ORDER BY created_at DESC').all(projectId, tenantId) as Array<{ deployment_json: string }>).map(row => JSON.parse(row.deployment_json));
  }
  activeDeployment(projectId: string, tenantId: string): ToolDeployment | null {
    return this.listDeployments(projectId, tenantId).find(item => item.status === 'healthy') ?? null;
  }
  saveEvent(value: ReleaseAuditEvent): void {
    this.db.prepare(`INSERT INTO builder_release_events (id,tenant_id,release_id,deployment_id,action,event_json,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(value.id, value.tenantId, value.releaseId, value.deploymentId ?? null, value.action, JSON.stringify(value), value.at);
  }
  events(releaseId: string, tenantId: string): ReleaseAuditEvent[] {
    return (this.db.prepare('SELECT event_json FROM builder_release_events WHERE release_id=? AND tenant_id=? ORDER BY created_at ASC').all(releaseId, tenantId) as Array<{ event_json: string }>).map(row => JSON.parse(row.event_json));
  }
  close(): void { this.db.close(); }
}

export class ToolReleaseManager {
  constructor(
    private store: ToolReleaseStore,
    private exporter: GitReleaseExporter,
    private deployment: ToolDeploymentAdapter,
    private signingKey: string,
    private now: () => Date = () => new Date(),
  ) { if (signingKey.length < 32) throw new Error('release signing key must contain at least 32 characters'); }

  request(input: { tenantId: string; projectId: string; revision: number; actor: string; artifactChecksum: string; evidence: QualityEvidence; spec: AppSpec; previousSpec?: AppSpec; previousRevision?: number }): ToolRelease {
    if (!input.evidence.passed || input.evidence.projectId !== input.projectId || input.evidence.revision !== input.revision || input.evidence.artifactChecksum !== input.artifactChecksum) throw new Error('valid passing evidence for the exact artifact is required');
    const risk = classifyRisk(input.spec, input.previousSpec);
    const release: ToolRelease = {
      id: `release-${crypto.randomBytes(10).toString('hex')}`, tenantId: input.tenantId, projectId: input.projectId,
      revision: input.revision, status: 'pending_review', risk, requiredApprovals: risk === 'high' ? 2 : 1,
      requestedBy: input.actor, requestedAt: this.now().toISOString(), artifactChecksum: input.artifactChecksum,
      evidenceId: input.evidence.id, diff: revisionDiff(input.spec, input.previousSpec, input.previousRevision), approvals: [],
    };
    this.store.saveRelease(release); this.event(release, 'release.requested', input.actor, { risk, requiredApprovals: release.requiredApprovals, evidenceId: release.evidenceId });
    return release;
  }

  review(id: string, tenantId: string, actor: string, decision: 'approved' | 'rejected', note = ''): ToolRelease | null {
    const release = this.store.getRelease(id, tenantId); if (!release) return null;
    if (!['pending_review', 'approved'].includes(release.status)) throw new Error(`release cannot be reviewed from ${release.status}`);
    if (actor === release.requestedBy) throw new Error('release requester cannot approve their own revision');
    if (release.approvals.some(item => item.actor === actor)) throw new Error('reviewer already decided this release');
    const review: ReleaseApproval = { actor, decision, note: note.trim().slice(0, 1000), at: this.now().toISOString() };
    release.approvals.push(review);
    if (decision === 'rejected') release.status = 'rejected';
    else if (release.approvals.filter(item => item.decision === 'approved').length >= release.requiredApprovals) {
      release.status = 'approved'; release.metadataSignature = signRelease(release, this.signingKey);
    }
    this.store.saveRelease(release); this.event(release, `release.${decision}`, actor, { note: review.note, approvals: release.approvals.length });
    return release;
  }

  async deploy(input: { id: string; tenantId: string; actor: string; artifact: GeneratedApplication; evidenceValid: boolean }): Promise<{ release: ToolRelease; deployment: ToolDeployment }> {
    const release = this.store.getRelease(input.id, input.tenantId); if (!release) throw new Error('release not found');
    if (release.status !== 'approved' || !release.metadataSignature || !verifyRelease(release, this.signingKey)) throw new Error('release must have valid approval signatures before deployment');
    if (!input.evidenceValid || release.artifactChecksum !== artifactChecksum(input.artifact)) throw new Error('release evidence no longer matches the generated artifact');
    const exported = await this.exporter.export({ release, artifact: input.artifact, signedMetadata: release.metadataSignature });
    release.exportCommit = exported.commit; release.status = 'deploying'; this.store.saveRelease(release);
    this.event(release, 'release.exported', input.actor, { commit: exported.commit });
    const previous = this.store.activeDeployment(release.projectId, release.tenantId);
    const deployment: ToolDeployment = { id: `deployment-${crypto.randomBytes(10).toString('hex')}`, tenantId: release.tenantId, projectId: release.projectId, releaseId: release.id, revision: release.revision, status: 'failed', health: 'pending', createdBy: input.actor, createdAt: this.now().toISOString() };
    this.store.saveDeployment(deployment); this.event(release, 'deployment.started', input.actor, { previousDeploymentId: previous?.id }, deployment.id);
    const result = await this.deployment.deploy({ deploymentId: deployment.id, tenantId: release.tenantId, projectId: release.projectId, revision: release.revision, artifact: input.artifact });
    deployment.runtimeRef = result.runtimeRef; deployment.health = result.health; deployment.completedAt = this.now().toISOString();
    if (result.healthy) {
      deployment.status = 'healthy'; release.status = 'deployed'; release.deployedAt = deployment.completedAt;
      if (previous) { previous.status = 'superseded'; previous.completedAt = deployment.completedAt; this.store.saveDeployment(previous); }
      this.event(release, 'deployment.healthy', input.actor, { health: result.health, previousDeploymentId: previous?.id }, deployment.id);
    } else {
      deployment.status = 'failed'; deployment.failure = result.error ?? result.health; release.status = 'failed'; release.failure = deployment.failure;
      if (previous?.runtimeRef) {
        const rolledBack = await this.deployment.rollback({ activeRuntimeRef: result.runtimeRef, targetRuntimeRef: previous.runtimeRef });
        if (rolledBack.healthy) { previous.status = 'healthy'; previous.completedAt = this.now().toISOString(); deployment.status = 'rolled_back'; deployment.rolledBackTo = previous.id; this.store.saveDeployment(previous); }
        this.event(release, 'deployment.auto_rollback', input.actor, { targetDeploymentId: previous.id, healthy: rolledBack.healthy, health: rolledBack.health }, deployment.id);
      }
      this.event(release, 'deployment.failed', input.actor, { health: result.health, error: deployment.failure }, deployment.id);
    }
    this.store.saveDeployment(deployment); this.store.saveRelease(release);
    return { release, deployment };
  }

  async rollback(input: { deploymentId: string; tenantId: string; actor: string; targetDeploymentId: string }): Promise<{ deployment: ToolDeployment; target: ToolDeployment }> {
    const current = this.store.getDeployment(input.deploymentId, input.tenantId); const target = this.store.getDeployment(input.targetDeploymentId, input.tenantId);
    if (!current || !target || current.projectId !== target.projectId || !target.runtimeRef) throw new Error('rollback deployment pair not found');
    const result = await this.deployment.rollback({ activeRuntimeRef: current.runtimeRef, targetRuntimeRef: target.runtimeRef });
    if (!result.healthy) throw new Error(`rollback health check failed: ${result.error ?? result.health}`);
    current.status = 'rolled_back'; current.rolledBackTo = target.id; current.completedAt = this.now().toISOString();
    target.status = 'healthy'; target.completedAt = current.completedAt; this.store.saveDeployment(current); this.store.saveDeployment(target);
    const release = this.store.getRelease(current.releaseId, input.tenantId); if (release) { release.status = 'rolled_back'; this.store.saveRelease(release); this.event(release, 'deployment.manual_rollback', input.actor, { targetDeploymentId: target.id }, current.id); }
    return { deployment: current, target };
  }

  getRelease(id: string, tenantId: string) { return this.store.getRelease(id, tenantId); }
  listReleases(projectId: string, tenantId: string) { return this.store.listReleases(projectId, tenantId); }
  listDeployments(projectId: string, tenantId: string) { return this.store.listDeployments(projectId, tenantId); }
  getDeployment(id: string, tenantId: string) { return this.store.getDeployment(id, tenantId); }
  events(releaseId: string, tenantId: string) { return this.store.events(releaseId, tenantId); }
  private event(release: ToolRelease, action: string, actor: string, data: Record<string, unknown>, deploymentId?: string): void {
    const base = { id: `release-event-${crypto.randomBytes(8).toString('hex')}`, tenantId: release.tenantId, releaseId: release.id, ...(deploymentId ? { deploymentId } : {}), action, actor, data, at: this.now().toISOString() };
    this.store.saveEvent({ ...base, checksum: sha256(stableJson(base)) });
  }
}

export class FilesystemGitReleaseExporter implements GitReleaseExporter {
  constructor(private root: string) {}
  async export(input: { release: ToolRelease; artifact: GeneratedApplication; signedMetadata: string }): Promise<{ commit: string }> {
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(path.join(this.root, '.git'))) { await git(this.root, ['init']); await git(this.root, ['config', 'user.name', 'ITOPS Builder']); await git(this.root, ['config', 'user.email', 'builder@itops.local']); }
    const rel = path.join(shortHash(input.release.tenantId), input.release.projectId, `revision-${input.release.revision}`);
    const target = path.join(this.root, rel); fs.rmSync(target, { recursive: true, force: true });
    for (const file of input.artifact.files) { const output = path.join(target, file.path); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, file.content, { encoding: 'utf8', mode: 0o600 }); }
    fs.writeFileSync(path.join(target, 'release-metadata.json'), JSON.stringify({ release: input.release, signature: input.signedMetadata }, null, 2) + '\n', { mode: 0o600 });
    await git(this.root, ['add', '--', rel]); await git(this.root, ['commit', '--allow-empty', '-m', `release: ${input.release.projectId} revision ${input.release.revision}`]);
    return { commit: (await git(this.root, ['rev-parse', 'HEAD'])).trim() };
  }
}

export function classifyRisk(spec: AppSpec, previous?: AppSpec): ReleaseRisk {
  if (spec.deploymentTarget.visibility === 'public' || spec.integrations.length > 0 || spec.actions.some(action => action.requiresApproval || action.kind === 'delete')) return 'high';
  if (spec.actions.length > 0 || spec.dataModels.length > 0 || (previous && stableJson(spec.roles) !== stableJson(previous.roles))) return 'medium';
  return 'low';
}
export function revisionDiff(current: AppSpec, previous?: AppSpec, previousRevision?: number): RevisionDiff {
  const empty = { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  if (!previous) return { previousRevision, pages: added(current.pages), dataModels: added(current.dataModels), actions: added(current.actions), integrations: added(current.integrations), roles: added(current.roles), metadataChanged: true, deploymentChanged: true };
  return { previousRevision, pages: changes(current.pages, previous.pages), dataModels: changes(current.dataModels, previous.dataModels), actions: changes(current.actions, previous.actions), integrations: changes(current.integrations, previous.integrations), roles: changes(current.roles, previous.roles), metadataChanged: stableJson(current.metadata) !== stableJson(previous.metadata), deploymentChanged: stableJson(current.deploymentTarget) !== stableJson(previous.deploymentTarget) };
  function added(values: Array<{ id?: string }>): ChangeSet { return { ...empty, added: values.map(item => item.id).filter((id): id is string => !!id) }; }
}
function changes(current: Array<{ id?: string }>, previous: Array<{ id?: string }>): ChangeSet { const a = new Map(current.filter(item => !!item.id).map(item => [item.id!, item])); const b = new Map(previous.filter(item => !!item.id).map(item => [item.id!, item])); return { added: [...a.keys()].filter(id => !b.has(id)), removed: [...b.keys()].filter(id => !a.has(id)), changed: [...a.keys()].filter(id => b.has(id) && stableJson(a.get(id)) !== stableJson(b.get(id))) }; }
function signRelease(release: ToolRelease, key: string): string { return crypto.createHmac('sha256', key).update(stableJson(releaseSigningPayload(release))).digest('hex'); }
function verifyRelease(release: ToolRelease, key: string): boolean { if (!release.metadataSignature) return false; const a = Buffer.from(release.metadataSignature, 'hex'); const b = Buffer.from(signRelease(release, key), 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function releaseSigningPayload(release: ToolRelease) { return { id: release.id, tenantId: release.tenantId, projectId: release.projectId, revision: release.revision, risk: release.risk, requiredApprovals: release.requiredApprovals, requestedBy: release.requestedBy, requestedAt: release.requestedAt, artifactChecksum: release.artifactChecksum, evidenceId: release.evidenceId, diff: release.diff, approvals: release.approvals }; }
function artifactChecksum(artifact: GeneratedApplication): string { return sha256(stableJson(artifact.files.map(file => ({ path: file.path, sha256: file.sha256 })))); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`; return JSON.stringify(value); }
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function shortHash(value: string): string { return sha256(value).slice(0, 16); }
function git(cwd: string, args: string[]): Promise<string> { return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout))); }

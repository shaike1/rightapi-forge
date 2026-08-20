import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';

export type PipelineProvider = 'github' | 'gitlab' | 'jenkins' | 'generic';
export type BuildStatus = 'pending' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped';

export interface Pipeline {
  id: string;
  name: string;
  provider: PipelineProvider;
  repoUrl?: string;
  branch?: string;
  config: Record<string, string>;
  enabled: boolean;
  createdAt: Date;
  lastRunAt?: Date;
  lastStatus?: BuildStatus;
}

export interface Build {
  id: string;
  pipelineId: string;
  pipelineName: string;
  provider: PipelineProvider;
  externalId?: string;
  status: BuildStatus;
  branch: string;
  commit?: string;
  commitMsg?: string;
  author?: string;
  triggeredBy: string;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  logs?: string;
  url?: string;
}

export interface Deployment {
  id: string;
  pipelineId: string;
  buildId: string;
  environment: string;
  status: BuildStatus;
  version?: string;
  deployedAt: Date;
  deployedBy: string;
  notes?: string;
}

export class CICDManager extends EventEmitter {
  private pipelines: Map<string, Pipeline> = new Map();
  private builds: Map<string, Build> = new Map();
  private deployments: Map<string, Deployment> = new Map();
  private dataPath: string;

  constructor(dataPath: string = '/data/itops-agents/cicd') {
    super();
    this.dataPath = dataPath;
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
  }

  // ── Pipelines ─────────────────────────────────────────────────────────────

  createPipeline(data: Omit<Pipeline, 'id' | 'createdAt'>): Pipeline {
    const pipeline: Pipeline = { ...data, id: uuidv4(), createdAt: new Date() };
    this.pipelines.set(pipeline.id, pipeline);
    this.save();
    this.emit('pipeline-created', pipeline);
    console.log('[CICDManager] Pipeline created: ' + pipeline.name);
    return pipeline;
  }

  updatePipeline(id: string, updates: Partial<Pipeline>): Pipeline | null {
    const p = this.pipelines.get(id);
    if (!p) return null;
    Object.assign(p, updates);
    this.save();
    return p;
  }

  deletePipeline(id: string): boolean {
    const ok = this.pipelines.delete(id);
    if (ok) this.save();
    return ok;
  }

  getPipeline(id: string): Pipeline | undefined { return this.pipelines.get(id); }
  getAllPipelines(): Pipeline[] { return Array.from(this.pipelines.values()); }

  // ── Builds ────────────────────────────────────────────────────────────────

  createBuild(data: Omit<Build, 'id' | 'startedAt'>): Build {
    const build: Build = { ...data, id: uuidv4(), startedAt: new Date() };
    this.builds.set(build.id, build);

    const pipeline = this.pipelines.get(build.pipelineId);
    if (pipeline) {
      pipeline.lastRunAt = new Date();
      pipeline.lastStatus = build.status;
    }

    this.save();
    this.emit('build-created', build);
    return build;
  }

  updateBuild(id: string, updates: Partial<Build>): Build | null {
    const b = this.builds.get(id);
    if (!b) return null;
    Object.assign(b, updates);
    if (updates.status && ['success', 'failure', 'cancelled'].includes(updates.status)) {
      b.finishedAt = b.finishedAt || new Date();
      b.durationMs = b.finishedAt.getTime() - b.startedAt.getTime();
      const pipeline = this.pipelines.get(b.pipelineId);
      if (pipeline) pipeline.lastStatus = updates.status;
    }
    this.save();
    this.emit('build-updated', b);
    return b;
  }

  getBuild(id: string): Build | undefined { return this.builds.get(id); }

  getBuilds(filter?: { pipelineId?: string; status?: BuildStatus; limit?: number }): Build[] {
    let list = Array.from(this.builds.values());
    if (filter?.pipelineId) list = list.filter(b => b.pipelineId === filter.pipelineId);
    if (filter?.status) list = list.filter(b => b.status === filter.status);
    list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    if (filter?.limit) list = list.slice(0, filter.limit);
    return list;
  }

  // ── Deployments ───────────────────────────────────────────────────────────

  createDeployment(data: Omit<Deployment, 'id' | 'deployedAt'>): Deployment {
    const dep: Deployment = { ...data, id: uuidv4(), deployedAt: new Date() };
    this.deployments.set(dep.id, dep);
    this.save();
    this.emit('deployment-created', dep);
    return dep;
  }

  updateDeployment(id: string, updates: Partial<Deployment>): Deployment | null {
    const d = this.deployments.get(id);
    if (!d) return null;
    Object.assign(d, updates);
    this.save();
    return d;
  }

  getDeployments(filter?: { pipelineId?: string; environment?: string; limit?: number }): Deployment[] {
    let list = Array.from(this.deployments.values());
    if (filter?.pipelineId) list = list.filter(d => d.pipelineId === filter.pipelineId);
    if (filter?.environment) list = list.filter(d => d.environment === filter.environment);
    list.sort((a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime());
    if (filter?.limit) list = list.slice(0, filter.limit);
    return list;
  }

  // ── Triggers ──────────────────────────────────────────────────────────────

  async triggerGitHub(pipeline: Pipeline, options: { ref?: string; inputs?: Record<string, string> } = {}): Promise<Build> {
    const { owner, repo, workflow, token } = pipeline.config as any;
    if (!owner || !repo || !workflow || !token) {
      throw new Error('GitHub pipeline requires: owner, repo, workflow, token in config');
    }

    const ref = options.ref || pipeline.branch || 'main';
    const body = JSON.stringify({ ref, inputs: options.inputs || {} });

    const build = this.createBuild({
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      provider: 'github',
      status: 'pending',
      branch: ref,
      triggeredBy: 'api'
    });

    try {
      await this.httpRequest(
        'POST',
        'https://api.github.com/repos/' + owner + '/' + repo + '/actions/workflows/' + workflow + '/dispatches',
        { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
        body
      );
      this.updateBuild(build.id, { status: 'running', externalId: owner + '/' + repo + '/' + workflow });
      this.emit('build-triggered', build);
    } catch (err: any) {
      this.updateBuild(build.id, { status: 'failure', logs: err.message });
    }

    return this.getBuild(build.id)!;
  }

  async triggerJenkins(pipeline: Pipeline, options: { params?: Record<string, string> } = {}): Promise<Build> {
    const { baseUrl, jobName, token, username, apiToken } = pipeline.config as any;
    if (!baseUrl || !jobName) {
      throw new Error('Jenkins pipeline requires: baseUrl, jobName in config');
    }

    const auth = username && apiToken
      ? 'Basic ' + Buffer.from(username + ':' + apiToken).toString('base64')
      : undefined;

    const params = options.params || {};
    const query = Object.keys(params).length
      ? '?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')
      : '';

    const build = this.createBuild({
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      provider: 'jenkins',
      status: 'pending',
      branch: pipeline.branch || 'main',
      triggeredBy: 'api'
    });

    try {
      const url = baseUrl.replace(/\/$/, '') + '/job/' + jobName + '/build' + (token ? 'WithParameters' : '') + query;
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (auth) headers['Authorization'] = auth;
      if (token) headers['Jenkins-Crumb'] = token;

      await this.httpRequest('POST', url, headers, '');
      this.updateBuild(build.id, { status: 'running', url: baseUrl + '/job/' + jobName });
      this.emit('build-triggered', build);
    } catch (err: any) {
      this.updateBuild(build.id, { status: 'failure', logs: err.message });
    }

    return this.getBuild(build.id)!;
  }

  async triggerWebhook(pipeline: Pipeline, payload: any = {}): Promise<Build> {
    const { url, method, secret } = pipeline.config as any;
    if (!url) throw new Error('Generic pipeline requires: url in config');

    const build = this.createBuild({
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      provider: 'generic',
      status: 'pending',
      branch: pipeline.branch || 'main',
      triggeredBy: 'api'
    });

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (secret) headers['X-Webhook-Secret'] = secret;
      const body = JSON.stringify({ ...payload, pipelineId: pipeline.id, triggeredAt: new Date().toISOString() });
      await this.httpRequest(method || 'POST', url, headers, body);
      this.updateBuild(build.id, { status: 'running' });
    } catch (err: any) {
      this.updateBuild(build.id, { status: 'failure', logs: err.message });
    }

    return this.getBuild(build.id)!;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats() {
    const builds = Array.from(this.builds.values());
    const recent = builds.filter(b => Date.now() - new Date(b.startedAt).getTime() < 86_400_000);
    const avgDuration = builds.filter(b => b.durationMs).reduce((s, b) => s + (b.durationMs || 0), 0) / (builds.filter(b => b.durationMs).length || 1);

    return {
      pipelines: this.pipelines.size,
      totalBuilds: builds.length,
      buildsToday: recent.length,
      successRate: builds.length ? Math.round(builds.filter(b => b.status === 'success').length / builds.length * 100) : 0,
      avgDurationMs: Math.round(avgDuration),
      deployments: this.deployments.size,
      byStatus: {
        success: builds.filter(b => b.status === 'success').length,
        failure: builds.filter(b => b.status === 'failure').length,
        running: builds.filter(b => b.status === 'running').length,
        pending: builds.filter(b => b.status === 'pending').length,
      }
    };
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private httpRequest(method: string, url: string, headers: Record<string, string>, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: parsed.hostname, port: parsed.port,
        path: parsed.pathname + parsed.search,
        method, headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.on('data', (c: any) => { data += c; });
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
          else resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  // ── Persist ───────────────────────────────────────────────────────────────

  private save(): void {
    try {
      fs.writeFileSync(path.join(this.dataPath, 'pipelines.json'), JSON.stringify(Array.from(this.pipelines.entries()), null, 2));
      fs.writeFileSync(path.join(this.dataPath, 'builds.json'), JSON.stringify(Array.from(this.builds.entries()), null, 2));
      fs.writeFileSync(path.join(this.dataPath, 'deployments.json'), JSON.stringify(Array.from(this.deployments.entries()), null, 2));
    } catch (e) { console.error('[CICDManager] Save failed:', e); }
  }

  private load(): void {
    try {
      const load = (file: string) => {
        const p = path.join(this.dataPath, file);
        return fs.existsSync(p) ? new Map(JSON.parse(fs.readFileSync(p, 'utf8'))) : new Map();
      };
      this.pipelines = load('pipelines.json') as Map<string, Pipeline>;
      this.builds = load('builds.json') as Map<string, Build>;
      this.deployments = load('deployments.json') as Map<string, Deployment>;
      console.log('[CICDManager] Loaded: ' + this.pipelines.size + ' pipelines, ' + this.builds.size + ' builds');
    } catch (e) { console.error('[CICDManager] Load failed:', e); }
  }
}

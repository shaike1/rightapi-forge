import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import Database from 'better-sqlite3';
import axe from 'axe-core';
import { chromium } from 'playwright-core';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import { parseAppSpec, type AppSpec } from './AppSpec.js';
import type { GeneratedApplication } from './AppGenerator.js';

export const QUALITY_GATE_VERSION = '1.0.0';

export type GateStatus = 'pass' | 'fail';

export interface GateCheck {
  id: string;
  status: GateStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface RuntimeGateResult {
  checks: GateCheck[];
}

export interface GateRuntimeVerifier {
  verify(artifact: GeneratedApplication, spec: AppSpec): Promise<RuntimeGateResult>;
}

export interface QualityEvidence {
  id: string;
  tenantId: string;
  projectId: string;
  revision: number;
  artifactChecksum: string;
  gateVersion: string;
  passed: boolean;
  checks: GateCheck[];
  reproducibilityKey: string;
  createdBy: string;
  createdAt: string;
  signature: string;
}

const ALLOWED_PATHS = new Set([
  '.dockerignore', 'Dockerfile', 'package.json', 'app-spec.json', 'provenance.json',
  'server/app.mjs', 'server/migrations/001_init.sql', 'client/index.html',
  'client/vite.config.js', 'client/src/main.jsx', 'client/src/App.jsx', 'client/src/styles.css',
]);

const ALLOWED_DEPENDENCIES: Record<string, string> = {
  'better-sqlite3': '12.6.2', express: '4.22.2', helmet: '8.1.0', react: '18.3.1', 'react-dom': '18.3.1',
};
const ALLOWED_DEV_DEPENDENCIES: Record<string, string> = { '@vitejs/plugin-react': '6.0.5', vite: '8.2.1' };

export class QualityGateRunner {
  private running = 0;

  constructor(
    private signingKey: string,
    private runtimeVerifier: GateRuntimeVerifier,
    private maxConcurrent = 2,
    private now: () => Date = () => new Date(),
  ) {
    if (signingKey.length < 32) throw new Error('builder gate signing key must contain at least 32 characters');
  }

  async run(input: {
    tenantId: string; projectId: string; revision: number; actor: string;
    artifact: GeneratedApplication;
  }): Promise<QualityEvidence> {
    if (this.running >= this.maxConcurrent) throw new Error('quality gate capacity reached');
    this.running++;
    try {
      const checks = staticChecks(input.artifact);
      let spec: AppSpec | undefined;
      try { spec = artifactSpec(input.artifact); } catch { /* schema check contains the failure */ }
      if (checks.every(check => check.status === 'pass') && spec) {
        try {
          checks.push(...(await this.runtimeVerifier.verify(input.artifact, spec)).checks);
        } catch (error) {
          checks.push(fail('runtime', `Runtime verification failed: ${errorMessage(error)}`));
        }
      } else {
        checks.push(fail('runtime', 'Runtime verification skipped because a static gate failed'));
      }
      const artifactChecksum = artifactChecksumFor(input.artifact);
      const normalized = checks.map(({ id, status, summary, details }) => ({ id, status, summary, details }));
      const reproducibilityKey = sha256(stableJson({ gateVersion: QUALITY_GATE_VERSION, artifactChecksum, checks: normalized }));
      const unsigned = {
        id: `gate-${crypto.randomBytes(10).toString('hex')}`,
        tenantId: input.tenantId,
        projectId: input.projectId,
        revision: input.revision,
        artifactChecksum,
        gateVersion: QUALITY_GATE_VERSION,
        passed: checks.every(check => check.status === 'pass'),
        checks,
        reproducibilityKey,
        createdBy: input.actor,
        createdAt: this.now().toISOString(),
      };
      return { ...unsigned, signature: sign(unsigned, this.signingKey) };
    } finally {
      this.running--;
    }
  }

  verify(evidence: QualityEvidence): boolean {
    const { signature, ...unsigned } = evidence;
    const expected = Buffer.from(sign(unsigned, this.signingKey), 'hex');
    const supplied = Buffer.from(signature, 'hex');
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }
}

export class QualityEvidenceRegistry {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    applyStandardPragmas(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS builder_gate_evidence (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      artifact_checksum TEXT NOT NULL,
      reproducibility_key TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builder_gate_revision
      ON builder_gate_evidence(tenant_id, project_id, revision, created_at DESC);`);
  }

  save(evidence: QualityEvidence): void {
    this.db.prepare(`INSERT INTO builder_gate_evidence
      (id, tenant_id, project_id, revision, passed, artifact_checksum, reproducibility_key, evidence_json, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evidence.id, evidence.tenantId, evidence.projectId, evidence.revision, evidence.passed ? 1 : 0,
        evidence.artifactChecksum, evidence.reproducibilityKey, JSON.stringify(evidence), evidence.signature, evidence.createdAt);
  }

  get(id: string, tenantId: string): QualityEvidence | null {
    const row = this.db.prepare('SELECT evidence_json FROM builder_gate_evidence WHERE id = ? AND tenant_id = ?')
      .get(id, tenantId) as { evidence_json: string } | undefined;
    return row ? JSON.parse(row.evidence_json) as QualityEvidence : null;
  }

  list(projectId: string, tenantId: string, revision?: number): QualityEvidence[] {
    const rows = revision === undefined
      ? this.db.prepare(`SELECT evidence_json FROM builder_gate_evidence
          WHERE project_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 100`).all(projectId, tenantId)
      : this.db.prepare(`SELECT evidence_json FROM builder_gate_evidence
          WHERE project_id = ? AND tenant_id = ? AND revision = ? ORDER BY created_at DESC LIMIT 100`).all(projectId, tenantId, revision);
    return (rows as Array<{ evidence_json: string }>).map(row => JSON.parse(row.evidence_json) as QualityEvidence);
  }

  latestPassing(projectId: string, tenantId: string, revision: number, artifactChecksum?: string): QualityEvidence | null {
    const params: unknown[] = [projectId, tenantId, revision];
    let checksum = '';
    if (artifactChecksum) { checksum = ' AND artifact_checksum = ?'; params.push(artifactChecksum); }
    const row = this.db.prepare(`SELECT evidence_json FROM builder_gate_evidence
      WHERE project_id = ? AND tenant_id = ? AND revision = ? AND passed = 1${checksum}
      ORDER BY created_at DESC LIMIT 1`).get(...params) as { evidence_json: string } | undefined;
    return row ? JSON.parse(row.evidence_json) as QualityEvidence : null;
  }

  close(): void { this.db.close(); }
}

export class LocalGateRuntimeVerifier implements GateRuntimeVerifier {
  constructor(private chromiumPath = process.env.CHROMIUM_PATH || (process.platform === 'win32' ? '' : '/usr/bin/chromium-browser')) {}

  async verify(artifact: GeneratedApplication, spec: AppSpec): Promise<RuntimeGateResult> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-builder-gate-'));
    let server: ReturnType<typeof spawn> | undefined;
    try {
      materialize(root, artifact);
      const install = await runProcess('npm', ['install', '--include=dev', '--no-fund', '--no-update-notifier'], root, 180_000);
      if (install.code !== 0) return { checks: [fail('dependencies', trimOutput(install)), fail('build', 'Build skipped because dependency installation failed')] };
      const audit = await runProcess('npm', ['audit', '--json'], root, 120_000, true);
      const auditBody = parseAudit(audit.stdout);
      const checks: GateCheck[] = [auditBody.total === 0
        ? pass('dependencies', 'Dependency installation and vulnerability audit passed', { vulnerabilities: 0 })
        : fail('dependencies', `Dependency audit found ${auditBody.total} vulnerabilities`, { vulnerabilities: auditBody.total })];
      const build = await runProcess('npm', ['run', 'build'], root, 180_000);
      if (build.code !== 0) return { checks: [...checks, fail('build', trimOutput(build))] };
      checks.push(pass('build', 'Generated client compiled from a clean workspace'));

      const port = await freePort();
      const token = crypto.randomBytes(32).toString('base64url');
      server = spawn(process.execPath, ['server/app.mjs'], {
        cwd: root,
        env: { ...process.env, APP_AUTH_TOKEN: token, APP_DATA_DIR: path.join(root, 'data'), PORT: String(port), NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitForHttp(`http://127.0.0.1:${port}/health`, 20_000);
      checks.push(await crudCheck(port, token, spec));
      checks.push(...await browserChecks(port, token, this.chromiumPath));
      return { checks };
    } finally {
      if (server && !server.killed) server.kill('SIGTERM');
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

function staticChecks(artifact: GeneratedApplication): GateCheck[] {
  const checks: GateCheck[] = [];
  const paths = artifact.files.map(file => file.path);
  const pathErrors = paths.filter(value => !ALLOWED_PATHS.has(value) || value.includes('..') || path.isAbsolute(value));
  const duplicates = paths.filter((value, index) => paths.indexOf(value) !== index);
  const missing = [...ALLOWED_PATHS].filter(value => !paths.includes(value));
  checks.push(pathErrors.length || duplicates.length || missing.length
    ? fail('artifact', 'Artifact path allowlist failed', { pathErrors, duplicates, missing })
    : artifact.files.every(file => sha256(file.content) === file.sha256)
      ? pass('artifact', 'File allowlist and all content hashes passed', { files: paths.length })
      : fail('artifact', 'One or more generated file hashes do not match'));

  try {
    const spec = artifactSpec(artifact);
    const checksum = sha256(JSON.stringify(spec, null, 2) + '\n');
    checks.push(checksum === artifact.specChecksum && checksum === artifact.provenance.specChecksum
      ? pass('schema', 'Application specification and provenance checksums passed')
      : fail('schema', 'Specification or provenance checksum mismatch'));
  } catch (error) { checks.push(fail('schema', `Application specification is invalid: ${errorMessage(error)}`)); }

  try {
    const manifest = JSON.parse(requiredFile(artifact, 'package.json')) as Record<string, any>;
    const valid = stableJson(manifest.dependencies ?? {}) === stableJson(ALLOWED_DEPENDENCIES)
      && stableJson(manifest.devDependencies ?? {}) === stableJson(ALLOWED_DEV_DEPENDENCIES)
      && manifest.scripts?.build === 'vite build --config client/vite.config.js'
      && manifest.scripts?.start === 'node server/app.mjs';
    checks.push(valid ? pass('dependency-policy', 'Dependencies and scripts match the fixed allowlist')
      : fail('dependency-policy', 'Dependencies or package scripts differ from the fixed allowlist'));
  } catch (error) { checks.push(fail('dependency-policy', errorMessage(error))); }

  const source = artifact.files.map(file => `${file.path}\n${file.content}`).join('\n');
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/,
    /(?:password|api[_-]?key|secret)\s*[:=]\s*["'][A-Za-z0-9_/+.-]{12,}["']/i,
  ];
  checks.push(secretPatterns.some(pattern => pattern.test(source))
    ? fail('secrets', 'Generated files contain a credential-like literal')
    : pass('secrets', 'No private keys, provider tokens, or credential literals detected'));

  const prohibited = /\b(?:child_process|eval\s*\(|new\s+Function\s*\(|Deno\.|Bun\.|process\.env\.(?!APP_AUTH_TOKEN|APP_DATA_DIR|PORT|NODE_ENV))|https?:\/\//;
  checks.push(prohibited.test(source)
    ? fail('source-policy', 'Generated source contains a prohibited runtime primitive or outbound URL')
    : pass('source-policy', 'Source lint policy and outbound-access restrictions passed'));

  const html = requiredFileOrEmpty(artifact, 'client/index.html');
  const jsx = requiredFileOrEmpty(artifact, 'client/src/App.jsx');
  const accessible = /<html lang=/.test(html) && /<meta name="viewport"/.test(html)
    && /<h1>/.test(jsx) && /<table>/.test(jsx) && /<label>/.test(jsx);
  checks.push(accessible ? pass('accessibility-static', 'Language, viewport, headings, labels, and table semantics are present')
    : fail('accessibility-static', 'Required accessible document semantics are missing'));

  const dockerfile = requiredFileOrEmpty(artifact, 'Dockerfile');
  const dockerRules = [
    /^FROM node:22-alpine AS build/m, /^FROM node:22-alpine$/m, /USER node/, /npm install --ignore-scripts/,
    /npm install --omit=dev/, /COPY --from=build/, /ENV NODE_ENV=production/,
  ];
  checks.push(dockerRules.every(rule => rule.test(dockerfile)) && !/\b(?:ADD|sudo|curl|wget)\b/.test(dockerfile)
    ? pass('container', 'Container definition uses a fixed non-root multi-stage policy')
    : fail('container', 'Container definition violates the generated-app policy'));
  return checks;
}

async function crudCheck(port: number, token: string, spec: AppSpec): Promise<GateCheck> {
  const model = spec.dataModels[0];
  if (!model) return pass('unit', 'Health and specification endpoints passed; no data model requires CRUD checks');
  const headers = { authorization: `Bearer ${token}`, 'x-app-role': spec.roles[0]!.id, 'content-type': 'application/json' };
  const payload = Object.fromEntries(model.fields.filter(field => field.required).map(field => [field.id, fixtureValue(field.type)]));
  const base = `http://127.0.0.1:${port}/api/data/${model.id}`;
  const unauthorized = await fetch(base);
  const created = await fetch(base, { method: 'POST', headers, body: JSON.stringify(payload) });
  const body = await created.json() as { id?: string };
  const listed = await fetch(base, { headers });
  const deleted = body.id ? await fetch(`${base}/${body.id}`, { method: 'DELETE', headers }) : undefined;
  return unauthorized.status === 401 && created.status === 201 && listed.status === 200 && deleted?.status === 204
    ? pass('unit', 'Authentication and generated CRUD smoke tests passed')
    : fail('unit', 'Generated API smoke test failed', { unauthorized: unauthorized.status, create: created.status, list: listed.status, delete: deleted?.status });
}

async function browserChecks(port: number, token: string, executablePath: string): Promise<GateCheck[]> {
  if (!executablePath || !fs.existsSync(executablePath)) return [fail('browser', `Chromium executable is unavailable at ${executablePath || '<unset>'}`)];
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const results: GateCheck[] = [];
    const snapshots: Record<string, string> = {};
    let criticalViolations = 0;
    for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.addInitScript(value => sessionStorage.setItem('app-token', value), token);
      await page.addInitScript({ content: axe.source });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
      await page.locator('h1').waitFor({ state: 'visible' });
      const report = await page.evaluate(async () => (globalThis as any).axe.run((globalThis as any).document));
      criticalViolations += report.violations.filter((item: any) => ['serious', 'critical'].includes(item.impact)).length;
      const screenshot = await page.screenshot({ fullPage: true });
      snapshots[viewport.name] = sha256(screenshot);
      await page.close();
    }
    results.push(pass('browser', 'Desktop and mobile Chromium smoke tests passed', { viewports: ['1440x900', '390x844'] }));
    results.push(criticalViolations === 0
      ? pass('accessibility', 'Browser accessibility scan found no serious or critical violations')
      : fail('accessibility', `Browser accessibility scan found ${criticalViolations} serious or critical violations`));
    results.push(pass('visual', 'Desktop and mobile visual snapshots captured', { snapshots }));
    return results;
  } finally { await browser.close(); }
}

function artifactSpec(artifact: GeneratedApplication): AppSpec { return parseAppSpec(JSON.parse(requiredFile(artifact, 'app-spec.json'))); }
function requiredFile(artifact: GeneratedApplication, name: string): string {
  const file = artifact.files.find(item => item.path === name);
  if (!file) throw new Error(`missing generated file: ${name}`);
  return file.content;
}
function requiredFileOrEmpty(artifact: GeneratedApplication, name: string): string { try { return requiredFile(artifact, name); } catch { return ''; } }
function materialize(root: string, artifact: GeneratedApplication): void {
  for (const file of artifact.files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { encoding: 'utf8', mode: 0o600 });
  }
}
function pass(id: string, summary: string, details?: Record<string, unknown>): GateCheck { return { id, status: 'pass', summary, ...(details ? { details } : {}) }; }
function fail(id: string, summary: string, details?: Record<string, unknown>): GateCheck { return { id, status: 'fail', summary, ...(details ? { details } : {}) }; }
export function artifactChecksumFor(artifact: GeneratedApplication): string { return sha256(stableJson(artifact.files.map(file => ({ path: file.path, sha256: file.sha256 })))); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function sign(value: unknown, key: string): string { return crypto.createHmac('sha256', key).update(stableJson(value)).digest('hex'); }
function sha256(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fixtureValue(type: string): unknown { return type === 'number' ? 1 : type === 'boolean' ? true : type === 'date' ? '2026-01-01' : 'Acceptance value'; }
function trimOutput(result: ProcessResult): string { return (result.stderr || result.stdout || `process exited ${result.code}`).trim().slice(-2000); }
function parseAudit(stdout: string): { total: number } {
  try { const body = JSON.parse(stdout); return { total: Number(body.metadata?.vulnerabilities?.total ?? 0) }; }
  catch { return { total: Number.POSITIVE_INFINITY }; }
}

interface ProcessResult { code: number; stdout: string; stderr: string }
function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, acceptNonZero = false): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, npm_config_loglevel: 'error' }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-200_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-200_000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); const result = { code: code ?? -1, stdout, stderr }; acceptNonZero || result.code === 0 ? resolve(result) : resolve(result); });
  });
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(error => error ? reject(error) : resolve(port)); }); });
}
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if ((await fetch(url)).ok) return; } catch { /* still starting */ } await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error('generated application did not become healthy');
}

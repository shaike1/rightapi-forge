import crypto from 'node:crypto';
import { type AppSpec, parseAppSpec } from './AppSpec.js';

export const GENERATOR_VERSION = '1.0.0';

export interface GeneratedFile {
  path: string;
  content: string;
  sha256: string;
}

export interface GeneratedApplication {
  generatorVersion: string;
  specChecksum: string;
  files: GeneratedFile[];
  provenance: {
    projectId: string;
    revision: number;
    generatedAt: string;
    generatorVersion: string;
    specChecksum: string;
  };
}

const ALLOWED_PATHS = new Set([
  '.dockerignore', 'Dockerfile', 'package.json', 'app-spec.json', 'provenance.json',
  'server/app.mjs', 'server/migrations/001_init.sql',
  'client/index.html', 'client/vite.config.js', 'client/src/main.jsx',
  'client/src/App.jsx', 'client/src/styles.css',
]);

export class AppGenerator {
  generate(input: { projectId: string; revision: number; spec: unknown; generatedAt?: string }): GeneratedApplication {
    const spec = parseAppSpec(input.spec);
    const specJson = JSON.stringify(spec, null, 2) + '\n';
    const specChecksum = sha256(specJson);
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const provenance = {
      projectId: input.projectId,
      revision: input.revision,
      generatedAt,
      generatorVersion: GENERATOR_VERSION,
      specChecksum,
    };
    const rawFiles: Array<[string, string]> = [
      ['.dockerignore', 'node_modules\npublic\ndata\n.env\n*.log\n'],
      ['package.json', packageManifest(spec)],
      ['app-spec.json', specJson],
      ['provenance.json', JSON.stringify(provenance, null, 2) + '\n'],
      ['server/migrations/001_init.sql', migrationSql(spec)],
      ['server/app.mjs', serverSource()],
      ['client/index.html', clientHtml(spec)],
      ['client/vite.config.js', viteConfig()],
      ['client/src/main.jsx', clientMain()],
      ['client/src/App.jsx', clientApp()],
      ['client/src/styles.css', clientStyles()],
      ['Dockerfile', dockerfile()],
    ];
    const files = rawFiles.map(([path, content]) => {
      if (!ALLOWED_PATHS.has(path) || path.includes('..') || path.startsWith('/')) {
        throw new Error(`generator attempted disallowed path: ${path}`);
      }
      return { path, content, sha256: sha256(content) };
    }).sort((a, b) => a.path.localeCompare(b.path));
    return { generatorVersion: GENERATOR_VERSION, specChecksum, files, provenance };
  }
}

function packageManifest(spec: AppSpec): string {
  return JSON.stringify({
    name: spec.metadata.slug,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    scripts: { build: 'vite build --config client/vite.config.js', start: 'node server/app.mjs' },
    dependencies: { 'better-sqlite3': '12.6.2', express: '4.22.2', helmet: '8.1.0', react: '18.3.1', 'react-dom': '18.3.1' },
    devDependencies: { '@vitejs/plugin-react': '6.0.5', vite: '8.2.1' },
  }, null, 2) + '\n';
}

function migrationSql(spec: AppSpec): string {
  const statements = spec.dataModels.map(model => {
    const columns = model.fields.map(field => `  ${quoteId(field.id)} ${sqliteType(field.type)}${field.required ? ' NOT NULL' : ''}${field.unique ? ' UNIQUE' : ''}`);
    return `CREATE TABLE IF NOT EXISTS ${quoteId(tableName(model.id))} (\n  id TEXT PRIMARY KEY,\n${columns.join(',\n')}${columns.length ? ',\n' : ''}  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);`;
  });
  return ['PRAGMA foreign_keys = ON;', ...statements, ''].join('\n\n');
}

function serverSource(): string {
  return `import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import helmet from 'helmet';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'app-spec.json'), 'utf8'));
const token = process.env.APP_AUTH_TOKEN;
if (!token || token.length < 32) throw new Error('APP_AUTH_TOKEN must contain at least 32 characters');
const dataDir = process.env.APP_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(root, 'server/migrations/001_init.sql'), 'utf8'));
const models = new Map(spec.dataModels.map(model => [model.id, model]));
const roles = new Map(spec.roles.map(role => [role.id, role]));
const app = express();
app.use(helmet());
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.json({ status: 'healthy', schemaVersion: spec.schemaVersion }));
app.use('/api', (req, res, next) => {
  const supplied = (req.header('authorization') || '').replace(/^Bearer\\s+/i, '');
  const role = req.header('x-app-role') || 'admin';
  const suppliedBuffer = Buffer.from(supplied); const tokenBuffer = Buffer.from(token);
  const validToken = suppliedBuffer.length === tokenBuffer.length && crypto.timingSafeEqual(suppliedBuffer, tokenBuffer);
  if (!validToken) return res.status(401).json({ error: 'Unauthorized' });
  if (!roles.has(role)) return res.status(403).json({ error: 'Unknown role' });
  req.appRole = roles.get(role);
  next();
});

app.get('/api/spec', (_req, res) => res.json(spec));
app.get('/api/data/:model', (req, res) => {
  const model = modelFor(req.params.model, res); if (!model) return;
  if (!can(req, model.id + '.read')) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(\`SELECT * FROM \${qid(tableName(model.id))} ORDER BY created_at DESC LIMIT 500\`).all();
  res.json({ items: rows });
});
app.post('/api/data/:model', (req, res) => {
  const model = modelFor(req.params.model, res); if (!model) return;
  if (!can(req, model.id + '.write')) return res.status(403).json({ error: 'Forbidden' });
  const values = payload(model, req.body, false);
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const fields = ['id', ...Object.keys(values), 'created_at', 'updated_at'];
  db.prepare(\`INSERT INTO \${qid(tableName(model.id))} (\${fields.map(qid).join(',')}) VALUES (\${fields.map(() => '?').join(',')})\`)
    .run(id, ...Object.values(values), now, now);
  res.status(201).json(db.prepare(\`SELECT * FROM \${qid(tableName(model.id))} WHERE id = ?\`).get(id));
});
app.patch('/api/data/:model/:id', (req, res) => {
  const model = modelFor(req.params.model, res); if (!model) return;
  if (!can(req, model.id + '.write')) return res.status(403).json({ error: 'Forbidden' });
  const values = payload(model, req.body, true); const keys = Object.keys(values);
  if (!keys.length) return res.status(400).json({ error: 'No editable fields supplied' });
  const result = db.prepare(\`UPDATE \${qid(tableName(model.id))} SET \${keys.map(key => qid(key) + ' = ?').join(',')}, updated_at = ? WHERE id = ?\`)
    .run(...Object.values(values), new Date().toISOString(), req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json(db.prepare(\`SELECT * FROM \${qid(tableName(model.id))} WHERE id = ?\`).get(req.params.id));
});
app.delete('/api/data/:model/:id', (req, res) => {
  const model = modelFor(req.params.model, res); if (!model) return;
  if (!can(req, model.id + '.write')) return res.status(403).json({ error: 'Forbidden' });
  const result = db.prepare(\`DELETE FROM \${qid(tableName(model.id))} WHERE id = ?\`).run(req.params.id);
  res.status(result.changes ? 204 : 404).end();
});

app.use((error, _req, res, _next) => {
  res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' });
});

const publicDir = path.join(root, 'public');
app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.listen(Number(process.env.PORT || 3000), '0.0.0.0');

function modelFor(id, res) { const model = models.get(id); if (!model) res.status(404).json({ error: 'Unknown model' }); return model; }
function can(req, permission) { return req.appRole.permissions.includes('*') || req.appRole.permissions.includes(permission); }
function tableName(id) { return 'model_' + id.replaceAll('-', '_'); }
function qid(value) { return '"' + value.replaceAll('"', '""') + '"'; }
function payload(model, input, partial) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('JSON object required');
  const out = {}; const allowed = new Set(model.fields.map(field => field.id));
  for (const [key, value] of Object.entries(input)) { if (allowed.has(key)) out[key] = value; }
  if (!partial) for (const field of model.fields) if (field.required && (out[field.id] === undefined || out[field.id] === null || out[field.id] === '')) throw new Error(field.id + ' is required');
  return out;
}
`;
}

function clientHtml(spec: AppSpec): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(spec.metadata.name)}</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`;
}

function viteConfig(): string {
  return `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ root: 'client', base: './', plugins: [react()], build: { outDir: '../public', emptyOutDir: true } });\n`;
}

function clientMain(): string {
  return `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './styles.css';\ncreateRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);\n`;
}

function clientApp(): string {
  return `import { useEffect, useState } from 'react';

const previewMode = window.location.pathname.includes('/proxy/');
const apiBase = previewMode ? new URL('./api', window.location.href).pathname.replace(/\\/$/, '') : '/api';
const savedToken = previewMode ? 'preview-proxy' : (sessionStorage.getItem('app-token') || '');
export default function App() {
  const [token, setToken] = useState(savedToken); const [spec, setSpec] = useState(null);
  const [active, setActive] = useState(''); const [rows, setRows] = useState([]); const [error, setError] = useState('');
  const headers = { authorization: 'Bearer ' + token, 'x-app-role': 'admin', 'content-type': 'application/json' };
  useEffect(() => { if (!token) return; fetch(apiBase + '/spec', { headers: previewMode ? {} : headers }).then(async r => { if (!r.ok) throw new Error('Authentication failed'); return r.json(); }).then(s => { setSpec(s); setActive(s.pages[0]?.id || ''); if (!previewMode) sessionStorage.setItem('app-token', token); }).catch(e => setError(e.message)); }, [token]);
  const page = spec?.pages.find(item => item.id === active); const model = page?.components.find(item => item.modelId)?.modelId;
  useEffect(() => { if (!model || !token) { setRows([]); return; } fetch(apiBase + '/data/' + model, { headers: previewMode ? {} : headers }).then(r => r.json()).then(body => setRows(body.items || [])).catch(e => setError(e.message)); }, [model, token]);
  if (!token || !spec) return <main className="login"><form onSubmit={e => { e.preventDefault(); setToken(new FormData(e.currentTarget).get('token')); }}><h1>{spec?.metadata.name || 'Sign in'}</h1><label>Access token<input name="token" type="password" autoComplete="current-password" required /></label><button>Continue</button>{error && <p className="error">{error}</p>}</form></main>;
  return <div className="shell"><aside><strong>{spec.metadata.name}</strong><nav>{spec.pages.map(item => <button className={item.id === active ? 'active' : ''} onClick={() => setActive(item.id)} key={item.id}>{item.name}</button>)}</nav>{!previewMode && <button className="signout" onClick={() => { sessionStorage.clear(); location.reload(); }}>Sign out</button>}</aside><main><header><h1>{page?.name}</h1><p>{spec.metadata.description}</p></header>{model ? <DataTable model={spec.dataModels.find(item => item.id === model)} rows={rows} /> : <section className="empty">This page is ready for components.</section>}</main></div>;
}
function DataTable({ model, rows }) { return <section><div className="section-title"><h2>{model?.name}</h2><span>{rows.length} records</span></div><div className="table-wrap"><table><thead><tr>{model?.fields.map(field => <th key={field.id}>{field.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{model?.fields.map(field => <td key={field.id}>{String(row[field.id] ?? '')}</td>)}</tr>)}</tbody></table>{!rows.length && <div className="empty">No records yet.</div>}</div></section>; }
`;
}

function clientStyles(): string {
  return `:root{font-family:Inter,system-ui,sans-serif;color:#17212b;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}.shell{min-height:100vh;display:grid;grid-template-columns:240px 1fr}aside{background:#18232d;color:#fff;padding:24px 16px;display:flex;flex-direction:column;gap:24px}nav{display:grid;gap:4px}nav button,.signout{border:0;background:transparent;color:#cbd5df;text-align:left;padding:10px 12px;border-radius:6px;cursor:pointer}nav button.active{background:#2f6fed;color:#fff}.signout{margin-top:auto}main{padding:32px;min-width:0}header{border-bottom:1px solid #d9e0e6;margin-bottom:24px}h1{font-size:28px;margin:0 0 8px}header p{color:#607080}.section-title{display:flex;align-items:center;justify-content:space-between}.table-wrap{background:#fff;border:1px solid #d9e0e6;border-radius:6px;overflow:auto}table{border-collapse:collapse;width:100%}th,td{padding:12px;text-align:left;border-bottom:1px solid #e7ebef;white-space:nowrap}.empty{padding:32px;color:#607080}.login{min-height:100vh;display:grid;place-items:center}.login form{width:min(380px,calc(100vw - 32px));background:#fff;border:1px solid #d9e0e6;border-radius:6px;padding:24px}.login label{display:grid;gap:8px}.login input{padding:10px;border:1px solid #b9c4ce;border-radius:4px}.login button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:4px;background:#2f6fed;color:#fff}.error{color:#b42318}@media(max-width:720px){.shell{grid-template-columns:1fr}aside{position:sticky;top:0;padding:12px}nav{display:flex;overflow:auto}.signout{display:none}main{padding:20px}}\n`;
}

function dockerfile(): string {
  return `FROM node:22-alpine AS build\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --ignore-scripts\nCOPY client ./client\nRUN npm run build\n\nFROM node:22-alpine\nWORKDIR /app\nENV NODE_ENV=production\nCOPY package.json ./\nRUN npm install --omit=dev\nCOPY app-spec.json provenance.json ./\nCOPY server ./server\nCOPY --from=build /app/public ./public\nRUN mkdir -p /app/data && chown -R node:node /app\nUSER node\nEXPOSE 3000\nCMD ["npm","start"]\n`;
}

function tableName(id: string): string { return `model_${id.replaceAll('-', '_')}`; }
function quoteId(id: string): string { return `"${id.replaceAll('"', '""')}"`; }
function sqliteType(type: string): string { return ['number', 'boolean'].includes(type) ? 'REAL' : 'TEXT'; }
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { transform } from 'esbuild';
import { AppGenerator } from './AppGenerator.js';
import { draftAppSpecFromMessage, parseAppSpec } from './AppSpec.js';

function crudSpec() {
  const base = draftAppSpecFromMessage('Inventory control');
  return parseAppSpec({
    ...base,
    pages: [{ id: 'inventory', name: 'Inventory', path: '/', layout: 'list', components: [{ id: 'assets-table', type: 'table', modelId: 'asset' }] }],
    dataModels: [{
      id: 'asset', name: 'Asset', description: 'Tracked asset',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true, unique: true },
        { id: 'cost', label: 'Cost', type: 'number', required: false, unique: false },
      ],
    }],
    actions: [
      { id: 'create-asset', name: 'Create asset', kind: 'create', modelId: 'asset', requiresApproval: false },
      { id: 'delete-asset', name: 'Delete asset', kind: 'delete', modelId: 'asset', requiresApproval: true },
    ],
  });
}

test('generator is deterministic, allowlisted, and records provenance', () => {
  const generator = new AppGenerator();
  const input = { projectId: 'app-test', revision: 3, spec: crudSpec(), generatedAt: '2026-08-20T00:00:00.000Z' };
  const first = generator.generate(input);
  const second = generator.generate(input);
  assert.deepEqual(first, second);
  assert.match(first.specChecksum, /^[a-f0-9]{64}$/);
  assert.equal(first.provenance.projectId, 'app-test');
  assert.equal(first.provenance.revision, 3);
  assert.ok(first.files.every(file => !file.path.startsWith('/') && !file.path.includes('..')));
  assert.ok(first.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('generated migration creates typed CRUD tables and generated sources parse', async () => {
  const artifact = new AppGenerator().generate({
    projectId: 'app-test', revision: 1, spec: crudSpec(), generatedAt: '2026-08-20T00:00:00.000Z',
  });
  const file = (name: string) => artifact.files.find(item => item.path === name)?.content ?? '';
  const db = new Database(':memory:');
  db.exec(file('server/migrations/001_init.sql'));
  const columns = db.prepare('PRAGMA table_info("model_asset")').all() as Array<{ name: string; type: string; notnull: number }>;
  assert.deepEqual(columns.map(column => column.name), ['id', 'name', 'cost', 'created_at', 'updated_at']);
  assert.equal(columns.find(column => column.name === 'name')?.notnull, 1);
  db.close();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-generated-app-'));
  try {
    const serverPath = path.join(root, 'app.mjs');
    fs.writeFileSync(serverPath, file('server/app.mjs'));
    const syntax = spawnSync(process.execPath, ['--check', serverPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    await transform(file('client/src/App.jsx'), { loader: 'jsx', format: 'esm' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('generated dependency and Docker surfaces stay constrained', () => {
  const artifact = new AppGenerator().generate({
    projectId: 'app-test', revision: 1, spec: crudSpec(), generatedAt: '2026-08-20T00:00:00.000Z',
  });
  const files = new Map(artifact.files.map(file => [file.path, file.content]));
  const manifest = JSON.parse(files.get('package.json')!);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['better-sqlite3', 'express', 'helmet', 'react', 'react-dom']);
  assert.doesNotMatch(files.get('server/app.mjs')!, /child_process|execFile\(|\bspawn\(|https?:\/\//);
  assert.match(files.get('Dockerfile')!, /USER node/);
  assert.doesNotMatch([...files.values()].join('\n'), /APP_AUTH_TOKEN\s*=/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AppGenerator, draftAppSpecFromMessage, parseAppSpec } from '../dist/builder/index.js';

const base = draftAppSpecFromMessage('Inventory control');
const spec = parseAppSpec({
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-generated-acceptance-'));
let server;
try {
  const artifact = new AppGenerator().generate({
    projectId: 'acceptance-project', revision: 1, spec, generatedAt: '2026-08-20T00:00:00.000Z',
  });
  for (const file of artifact.files) {
    const target = path.resolve(root, file.path);
    if (!target.startsWith(root + path.sep)) throw new Error(`unsafe generated path: ${file.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { mode: 0o600 });
  }

  runNpm(['install', '--no-audit', '--no-fund'], root);
  runNpm(['audit', '--audit-level=high'], root);
  runNpm(['run', 'build'], root);

  const port = 32_000 + Math.floor(Math.random() * 1_000);
  const token = 'acceptance-token-that-is-at-least-32-characters';
  server = spawn(process.execPath, ['server/app.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), APP_AUTH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverErrors = [];
  server.stderr.on('data', chunk => serverErrors.push(String(chunk)));
  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin, serverErrors);
  const headers = { authorization: `Bearer ${token}`, 'x-app-role': 'admin', 'content-type': 'application/json' };
  const unauthorized = await fetch(`${origin}/api/data/asset`);
  if (unauthorized.status !== 401) throw new Error(`expected unauthenticated 401, got ${unauthorized.status}`);
  const createdResponse = await fetch(`${origin}/api/data/asset`, {
    method: 'POST', headers, body: JSON.stringify({ name: 'Router', cost: 1200, ignored: 'dropped' }),
  });
  if (createdResponse.status !== 201) throw new Error(`create failed: ${createdResponse.status} ${await createdResponse.text()}`);
  const created = await createdResponse.json();
  if (!created.id || created.name !== 'Router' || created.ignored !== undefined) throw new Error('created record did not match constrained model');
  const list = await (await fetch(`${origin}/api/data/asset`, { headers })).json();
  if (list.items?.length !== 1) throw new Error('generated list endpoint did not return the created record');
  const patched = await fetch(`${origin}/api/data/asset/${created.id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ cost: 1250 }),
  });
  if (!patched.ok || (await patched.json()).cost !== 1250) throw new Error('generated update endpoint failed');
  const removed = await fetch(`${origin}/api/data/asset/${created.id}`, { method: 'DELETE', headers });
  if (removed.status !== 204) throw new Error(`generated delete endpoint failed: ${removed.status}`);

  console.log(JSON.stringify({
    ok: true, files: artifact.files.length, specChecksum: artifact.specChecksum,
    build: 'passed', audit: 'passed', auth: 'passed', crud: 'passed',
  }));
} finally {
  if (server && !server.killed) server.kill();
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp cleanup is best effort */ }
}

function runNpm(args, cwd) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd, encoding: 'utf8', timeout: 180_000 })
    : spawnSync('npm', args, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed: ${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}

async function waitForHealth(origin, errors) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`generated server did not become healthy: ${errors.join('')}`);
}

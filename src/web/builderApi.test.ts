import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express, { type RequestHandler } from 'express';
import { draftAppSpecFromMessage } from '../builder/AppSpec.js';
import { BuilderProjectRegistry } from '../builder/BuilderProjectRegistry.js';
import { AppGenerator } from '../builder/AppGenerator.js';
import { PreviewRuntime, type PreviewBackend, type PreviewRequest } from '../builder/PreviewRuntime.js';
import { QualityEvidenceRegistry, QualityGateRunner, type GateRuntimeVerifier } from '../builder/QualityGate.js';
import { ToolReleaseManager, ToolReleaseStore } from '../builder/ToolReleaseManager.js';
import { ManagedIntegrationRegistry } from '../builder/ManagedIntegrationRegistry.js';
import { ToolCatalog } from '../builder/ToolCatalog.js';
import { ManagedIntegrationBroker } from '../builder/ManagedIntegrationBroker.js';
import { AppSpecEditor } from '../builder/AppSpecEditor.js';
import { ToolLaunchRuntime } from '../builder/ToolLaunchRuntime.js';
import { PluginConfigEncryption } from '../plugins/PluginConfigEncryption.js';
import { createBuilderRouter } from './builderApi.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-builder-api-'));
  const dbPath = path.join(root, 'builder.db');
  const registry = new BuilderProjectRegistry(dbPath);
  const gateEvidence = new QualityEvidenceRegistry(dbPath);
  const runtimeVerifier: GateRuntimeVerifier = { verify: async () => ({ checks: [{ id: 'runtime', status: 'pass', summary: 'fixture runtime passed' }] }) };
  const gateRunner = new QualityGateRunner('test-signing-key-that-is-at-least-32-bytes', runtimeVerifier);
  const releaseStore = new ToolReleaseStore(dbPath);
  const releases = new ToolReleaseManager(releaseStore,
    { export: async ({ release }) => ({ commit: `commit-${release.revision}` }) },
    { deploy: async ({ deploymentId }) => ({ healthy: true, runtimeRef: `runtime-${deploymentId}`, health: 'healthy' }), rollback: async () => ({ healthy: true, health: 'healthy' }) },
    'test-release-key-that-is-at-least-32-bytes');
  const connections = new ManagedIntegrationRegistry(dbPath, new PluginConfigEncryption('test-encryption-key'));
  const integrationBroker = new ManagedIntegrationBroker(connections, dbPath, 'test-broker-key-that-is-at-least-32-bytes',
    async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    async () => [{ address: '93.184.216.34', family: 4 }]);
  const catalog = new ToolCatalog(registry, releases, dbPath);
  const launches = new ToolLaunchRuntime({ request: async (_runtime, request) => ({ status: 200, headers: { 'content-type': request.path === '/' ? 'text/html' : 'application/json' }, body: Buffer.from(request.path === '/' ? '<html>tool</html>' : JSON.stringify({ path: request.path })) }) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { username: req.header('x-user') || 'tester', role: 'admin', source: 'jwt' };
    req.tenant = { tenantId: req.header('x-tenant') || 'system' };
    next();
  });
  const requirePermission = (_permission: string): RequestHandler => (_req, _res, next) => next();
  const previewBackend: PreviewBackend = {
    initialize: async () => undefined,
    start: async () => undefined,
    request: async (_sessionId: string, roleId: string, request: PreviewRequest) => ({
      status: 200,
      headers: { 'content-type': request.path === '/' ? 'text/html' : 'application/json' },
      body: Buffer.from(request.path === '/' ? '<html>preview</html>' : JSON.stringify({ roleId, path: request.path })),
    }),
    logs: async sessionId => `logs:${sessionId}`,
    stop: async () => undefined,
  };
  const previews = new PreviewRuntime(previewBackend);
  app.use('/api/builder', createBuilderRouter({ registry, generator: new AppGenerator(), previews, gateRunner, gateEvidence, releases, connections, integrationBroker, specEditor: new AppSpecEditor(), launches, catalog, authenticate: (_req, _res, next) => next(), requirePermission }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}/api/builder`,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await previews.dispose();
      catalog.close();
      integrationBroker.close();
      connections.close();
      releaseStore.close();
      gateEvidence.close();
      registry.close();
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }
    },
  };
}

const jsonHeaders = (tenant: string, user = 'alice') => ({
  'content-type': 'application/json',
  'x-tenant': tenant,
  'x-user': user,
});

test('builder conversation API creates, refines, and isolates typed projects', async () => {
  const f = await fixture();
  try {
    const initialSpec = draftAppSpecFromMessage('Customer request console');
    const createdResponse = await fetch(`${f.base}/conversations`, {
      method: 'POST', headers: jsonHeaders('acme'),
      body: JSON.stringify({ message: 'Build a customer request console', proposedSpec: initialSpec }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as any;
    assert.equal(created.specificationOnly, true);
    assert.equal(created.project.currentRevision, 1);

    const hidden = await fetch(`${f.base}/projects/${created.project.id}`, { headers: jsonHeaders('beta') });
    assert.equal(hidden.status, 404);

    const refinedSpec = {
      ...initialSpec,
      metadata: { ...initialSpec.metadata, description: 'Track and triage customer requests.' },
    };
    const refinedResponse = await fetch(`${f.base}/projects/${created.project.id}/messages`, {
      method: 'POST', headers: jsonHeaders('acme', 'bob'),
      body: JSON.stringify({ message: 'Add triage context', proposedSpec: refinedSpec, expectedRevision: 1 }),
    });
    assert.equal(refinedResponse.status, 200);
    assert.equal(((await refinedResponse.json()) as any).project.currentRevision, 2);

    const revisions = await fetch(`${f.base}/projects/${created.project.id}/revisions`, { headers: jsonHeaders('acme') });
    const revisionBody = await revisions.json() as any;
    assert.deepEqual(revisionBody.revisions.map((item: any) => item.revision), [2, 1]);

    const generated = await fetch(`${f.base}/projects/${created.project.id}/generate`, {
      method: 'POST', headers: jsonHeaders('acme'),
    });
    const generatedBody = await generated.json() as any;
    assert.equal(generated.status, 200);
    assert.equal(generatedBody.executed, false);
    assert.ok(generatedBody.artifact.files.some((file: any) => file.path === 'Dockerfile'));

    const conflict = await fetch(`${f.base}/projects/${created.project.id}/messages`, {
      method: 'POST', headers: jsonHeaders('acme'),
      body: JSON.stringify({ message: 'Stale change', proposedSpec: refinedSpec, expectedRevision: 1 }),
    });
    assert.equal(conflict.status, 409);
  } finally { await f.close(); }
});

test('builder API returns structured validation issues without persisting invalid specs', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/conversations`, {
      method: 'POST', headers: jsonHeaders('acme'),
      body: JSON.stringify({ message: 'Build invalid', proposedSpec: { schemaVersion: '1' } }),
    });
    assert.equal(response.status, 422);
    const body = await response.json() as any;
    assert.equal(body.error, 'invalid application specification');
    assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
    const projects = await fetch(`${f.base}/projects`, { headers: jsonHeaders('acme') });
    assert.equal(((await projects.json()) as any).projects.length, 0);
  } finally { await f.close(); }
});

test('preview API exchanges expiring access tokens and proxies without exposing app credentials', async () => {
  const f = await fixture();
  try {
    const createdProject = await fetch(`${f.base}/conversations`, {
      method: 'POST', headers: jsonHeaders('acme'),
      body: JSON.stringify({ message: 'Preview customer console' }),
    });
    const project = ((await createdProject.json()) as any).project;
    const blocked = await fetch(`${f.base}/projects/${project.id}/previews`, {
      method: 'POST', headers: jsonHeaders('acme'), body: JSON.stringify({ ttlMinutes: 5 }),
    });
    assert.equal(blocked.status, 409);
    const gated = await fetch(`${f.base}/projects/${project.id}/gates`, { method: 'POST', headers: jsonHeaders('acme') });
    assert.equal(gated.status, 201);
    assert.equal(((await gated.json()) as any).evidence.passed, true);
    const previewResponse = await fetch(`${f.base}/projects/${project.id}/previews`, {
      method: 'POST', headers: jsonHeaders('acme'), body: JSON.stringify({ ttlMinutes: 5 }),
    });
    assert.equal(previewResponse.status, 201);
    const preview = await previewResponse.json() as any;
    assert.equal(preview.session.status, 'ready');
    assert.equal(Object.hasOwn(preview.session, 'appToken'), false);

    const exchange = await fetch(`http://127.0.0.1:${new URL(f.base).port}${preview.accessUrl}`, { redirect: 'manual' });
    assert.equal(exchange.status, 303);
    const cookie = exchange.headers.get('set-cookie');
    assert.match(cookie ?? '', /HttpOnly/i);
    assert.doesNotMatch(cookie ?? '', /acceptance-token|APP_AUTH_TOKEN/);

    const proxied = await fetch(`http://127.0.0.1:${new URL(f.base).port}${exchange.headers.get('location')}`, {
      headers: { cookie: cookie!.split(';')[0] },
    });
    assert.equal(proxied.status, 200);
    assert.match(await proxied.text(), /preview/);

    const denied = await fetch(`http://127.0.0.1:${new URL(f.base).port}${exchange.headers.get('location')}`);
    assert.equal(denied.status, 403);
    const stopped = await fetch(`${f.base}/previews/${preview.session.id}`, { method: 'DELETE', headers: jsonHeaders('acme') });
    assert.equal(((await stopped.json()) as any).session.status, 'stopped');
  } finally { await f.close(); }
});

test('quality gate API stores signed tenant-scoped evidence for the current revision', async () => {
  const f = await fixture();
  try {
    const created = await fetch(`${f.base}/conversations`, {
      method: 'POST', headers: jsonHeaders('acme'), body: JSON.stringify({ message: 'Gate customer console' }),
    });
    const project = ((await created.json()) as any).project;
    const response = await fetch(`${f.base}/projects/${project.id}/gates`, { method: 'POST', headers: jsonHeaders('acme', 'reviewer') });
    assert.equal(response.status, 201);
    const evidence = ((await response.json()) as any).evidence;
    assert.equal(evidence.passed, true);
    assert.equal(evidence.createdBy, 'reviewer');
    assert.match(evidence.signature, /^[a-f0-9]{64}$/);
    assert.match(evidence.reproducibilityKey, /^[a-f0-9]{64}$/);

    const read = await fetch(`${f.base}/gates/${evidence.id}`, { headers: jsonHeaders('acme') });
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as any).signatureValid, true);
    const hidden = await fetch(`${f.base}/gates/${evidence.id}`, { headers: jsonHeaders('beta') });
    assert.equal(hidden.status, 404);
  } finally { await f.close(); }
});

test('release API enforces independent approval and records deployment evidence', async () => {
  const f = await fixture();
  try {
    const created = await fetch(`${f.base}/conversations`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ message: 'Release customer console' }) });
    const project = ((await created.json()) as any).project;
    await fetch(`${f.base}/projects/${project.id}/gates`, { method: 'POST', headers: jsonHeaders('acme', 'builder') });
    const requested = await fetch(`${f.base}/projects/${project.id}/releases`, { method: 'POST', headers: jsonHeaders('acme', 'builder') });
    assert.equal(requested.status, 201); const release = ((await requested.json()) as any).release;
    const selfReview = await fetch(`${f.base}/releases/${release.id}/review`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(selfReview.status, 409);
    const review = await fetch(`${f.base}/releases/${release.id}/review`, { method: 'POST', headers: jsonHeaders('acme', 'reviewer'), body: JSON.stringify({ decision: 'approved', note: 'verified' }) });
    assert.equal(((await review.json()) as any).release.status, 'approved');
    const deployed = await fetch(`${f.base}/releases/${release.id}/deploy`, { method: 'POST', headers: jsonHeaders('acme', 'deployer') });
    assert.equal(deployed.status, 201); assert.equal(((await deployed.json()) as any).deployment.status, 'healthy');
    const read = await fetch(`${f.base}/releases/${release.id}`, { headers: jsonHeaders('acme') });
    const body = await read.json() as any; assert.equal(body.release.status, 'deployed'); assert.ok(body.events.some((event: any) => event.action === 'deployment.healthy'));
  } finally { await f.close(); }
});

test('iterative editor supports chat, visual edits, comparison, undo, and redo', async () => {
  const f = await fixture();
  try {
    const created = await fetch(`${f.base}/conversations`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ message: 'Editable service console' }) });
    const project = ((await created.json()) as any).project;
    const chat = await fetch(`${f.base}/projects/${project.id}/messages`, {
      method: 'POST', headers: jsonHeaders('acme', 'builder'),
      body: JSON.stringify({ message: 'Add a page called Requests', expectedRevision: 1 }),
    });
    assert.equal(chat.status, 200);
    assert.equal(((await chat.json()) as any).project.revision.spec.pages.length, 2);

    const visual = await fetch(`${f.base}/projects/${project.id}/visual-edits`, {
      method: 'POST', headers: jsonHeaders('acme', 'builder'),
      body: JSON.stringify({ expectedRevision: 2, edit: { target: 'page', id: 'requests', property: 'layout', value: 'list' } }),
    });
    assert.equal(visual.status, 200);
    assert.equal(((await visual.json()) as any).project.currentRevision, 3);

    const compared = await fetch(`${f.base}/projects/${project.id}/revisions/compare?from=1&to=3`, { headers: jsonHeaders('acme') });
    assert.deepEqual(((await compared.json()) as any).diff.pages.added, ['requests']);
    const undo = await fetch(`${f.base}/projects/${project.id}/undo`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ expectedRevision: 3 }) });
    const undone = await undo.json() as any;
    assert.equal(undone.project.revision.spec.pages[1].layout, 'custom');
    assert.equal(undone.editState.canRedo, true);
    const redo = await fetch(`${f.base}/projects/${project.id}/redo`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ expectedRevision: 4 }) });
    assert.equal(((await redo.json()) as any).project.revision.spec.pages[1].layout, 'list');
  } finally { await f.close(); }
});

test('managed connections and catalog are tenant scoped and never return credentials', async () => {
  const f = await fixture();
  try {
    const connection = await fetch(`${f.base}/connections`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ name: 'GitHub Production', provider: 'github', capabilities: ['issues.read'], credentials: { token: 'never-return-this' } }) });
    assert.equal(connection.status, 201);
    const connectionBody = await connection.json() as any;
    assert.equal(JSON.stringify(connectionBody).includes('never-return-this'), false);
    assert.match(connectionBody.connection.ref, /^managed\//);
    assert.equal(((await (await fetch(`${f.base}/connections`, { headers: jsonHeaders('other') })).json()) as any).connections.length, 0);

    const created = await fetch(`${f.base}/conversations`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ message: 'Catalog console' }) });
    const project = ((await created.json()) as any).project;
    const catalog = await fetch(`${f.base}/catalog?q=catalog`, { headers: jsonHeaders('acme') });
    const tool = ((await catalog.json()) as any).tools[0];
    assert.equal(tool.id, project.id); assert.equal(tool.health, 'not_deployed'); assert.equal(tool.launches, 0);
    const archived = await fetch(`${f.base}/catalog/${project.id}/lifecycle`, { method: 'PATCH', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ status: 'archived' }) });
    assert.equal(((await archived.json()) as any).project.status, 'archived');
  } finally { await f.close(); }
});

test('integration broker grants only capabilities declared by the tool revision', async () => {
  const f = await fixture();
  try {
    const connectionResponse = await fetch(`${f.base}/connections`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ name: 'Issue API', provider: 'http', capabilities: ['GET /issues'], credentials: { baseUrl: 'https://api.example.com', 'header:authorization': 'Bearer secret' } }) });
    const connection = ((await connectionResponse.json()) as any).connection;
    const base = draftAppSpecFromMessage('Integrated console');
    const spec = { ...base, integrations: [{ id: 'issues', name: 'Issues', provider: 'http', connectionRef: connection.ref, capabilities: ['GET /issues'] }] };
    const created = await fetch(`${f.base}/conversations`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ message: 'Integrated console', proposedSpec: spec }) });
    const project = ((await created.json()) as any).project;
    const denied = await fetch(`${f.base}/projects/${project.id}/integration-grants`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ integrationId: 'issues', capability: 'POST /issues' }) });
    assert.equal(denied.status, 403);
    const granted = await fetch(`${f.base}/projects/${project.id}/integration-grants`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ integrationId: 'issues', capability: 'GET /issues' }) });
    assert.equal(granted.status, 201); const grant = ((await granted.json()) as any).grant;
    const invoked = await fetch(`${f.base}/projects/${project.id}/integrations/invoke`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ grant }) });
    assert.deepEqual(((await invoked.json()) as any).body, { ok: true });
    const calls = await fetch(`${f.base}/projects/${project.id}/integration-calls`, { headers: jsonHeaders('acme') });
    assert.equal(((await calls.json()) as any).calls.length, 1);
  } finally { await f.close(); }
});

test('catalog launch exchanges a one-time link for a scoped runtime proxy cookie', async () => {
  const f = await fixture();
  try {
    const created = await fetch(`${f.base}/conversations`, { method: 'POST', headers: jsonHeaders('acme', 'builder'), body: JSON.stringify({ message: 'Launchable console' }) });
    const project = ((await created.json()) as any).project;
    await fetch(`${f.base}/projects/${project.id}/gates`, { method: 'POST', headers: jsonHeaders('acme', 'builder') });
    const requested = await fetch(`${f.base}/projects/${project.id}/releases`, { method: 'POST', headers: jsonHeaders('acme', 'builder') });
    const release = ((await requested.json()) as any).release;
    await fetch(`${f.base}/releases/${release.id}/review`, { method: 'POST', headers: jsonHeaders('acme', 'reviewer'), body: JSON.stringify({ decision: 'approved' }) });
    await fetch(`${f.base}/releases/${release.id}/deploy`, { method: 'POST', headers: jsonHeaders('acme', 'deployer') });
    const launched = await fetch(`${f.base}/catalog/${project.id}/launch`, { method: 'POST', headers: jsonHeaders('acme', 'alice') });
    assert.equal(launched.status, 200); const accessUrl = ((await launched.json()) as any).accessUrl;
    const origin = new URL(f.base).origin;
    const exchange = await fetch(`${origin}${accessUrl}`, { redirect: 'manual' });
    assert.equal(exchange.status, 303); const cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? '';
    assert.match(cookie, /^itops_launch_/);
    const proxied = await fetch(`${origin}${exchange.headers.get('location')}`, { headers: { cookie } });
    assert.equal(proxied.status, 200); assert.match(await proxied.text(), /tool/);
    assert.equal((await fetch(`${origin}${accessUrl}`, { redirect: 'manual' })).status, 403);
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { AppGenerator } from './AppGenerator.js';
import { draftAppSpecFromMessage } from './AppSpec.js';
import { PreviewRuntime, type PreviewBackend, type PreviewRequest, type PreviewResponse } from './PreviewRuntime.js';

class FakeBackend implements PreviewBackend {
  starts: Array<{ sessionId: string; tenantId: string; appToken: string }> = [];
  stops: string[] = [];
  initialized?: Set<string>;
  failStart = false;
  onStart?: () => void;

  async initialize(active: Set<string>) { this.initialized = active; }
  async start(input: { sessionId: string; tenantId: string; appToken: string }) {
    this.starts.push(input);
    this.onStart?.();
    if (this.failStart) throw new Error('build failed');
  }
  async request(sessionId: string, roleId: string, request: PreviewRequest): Promise<PreviewResponse> {
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(`${sessionId}:${roleId}:${request.path}`) };
  }
  async logs(sessionId: string, tail: number) { return `${sessionId}:${tail}`; }
  async stop(sessionId: string) { this.stops.push(sessionId); }
}

const artifact = new AppGenerator().generate({
  projectId: 'project', revision: 1, spec: draftAppSpecFromMessage('Preview app'), generatedAt: '2026-08-20T00:00:00.000Z',
});

test('preview sessions isolate tenants, tokens, and runtime credentials', async () => {
  const backend = new FakeBackend();
  const runtime = new PreviewRuntime(backend);
  try {
    await runtime.initialize();
    assert.equal(backend.initialized?.size, 0);
    const acme = await runtime.create({ tenantId: 'acme', projectId: 'p1', revision: 1, roleId: 'admin', actor: 'alice', artifact });
    const beta = await runtime.create({ tenantId: 'beta', projectId: 'p2', revision: 1, roleId: 'operator', actor: 'bob', artifact });
    assert.equal(runtime.list('acme').length, 1);
    assert.equal(runtime.get(beta.session.id, 'acme'), null);
    assert.equal(runtime.authorize(acme.session.id, beta.accessToken), null);
    assert.equal(runtime.authorize(acme.session.id, acme.accessToken)?.tenantId, 'acme');
    assert.equal(Object.hasOwn(acme.session, 'tokenHash'), false);
    assert.equal(Object.hasOwn(acme.session, 'appToken'), false);
    assert.notEqual(backend.starts[0].appToken, acme.accessToken);
    const response = await runtime.request(acme.session.id, acme.accessToken, { method: 'GET', path: '/health' });
    assert.match(response.body.toString(), /:admin:\/health$/);
  } finally { await runtime.dispose(); }
  assert.equal(backend.stops.length, 2);
});

test('preview capacity, path validation, expiry, and teardown fail closed', async () => {
  let now = Date.parse('2026-08-20T00:00:00.000Z');
  const backend = new FakeBackend();
  const runtime = new PreviewRuntime(backend, { maxPerTenant: 1, maxGlobal: 2, defaultTtlMinutes: 1 }, () => now);
  const first = await runtime.create({ tenantId: 'acme', projectId: 'p1', revision: 1, roleId: 'admin', actor: 'alice', artifact });
  await assert.rejects(() => runtime.create({ tenantId: 'acme', projectId: 'p2', revision: 1, roleId: 'admin', actor: 'alice', artifact }), /tenant preview capacity/);
  await assert.rejects(() => runtime.request(first.session.id, first.accessToken, { method: 'GET', path: 'http://private.example' }), /invalid preview path/);
  now += 61_000;
  await runtime.sweepExpired();
  assert.equal(runtime.get(first.session.id, 'acme')?.status, 'expired');
  assert.equal(runtime.authorize(first.session.id, first.accessToken), null);
  assert.deepEqual(backend.stops, [first.session.id]);
  await runtime.dispose();
});

test('failed preview starts are recorded and cleaned up', async () => {
  const backend = new FakeBackend(); backend.failStart = true;
  const runtime = new PreviewRuntime(backend);
  await assert.rejects(() => runtime.create({ tenantId: 'acme', projectId: 'p1', revision: 1, roleId: 'admin', actor: 'alice', artifact }), /preview start failed/);
  assert.equal(runtime.list('acme')[0].status, 'failed');
  assert.equal(runtime.list('acme')[0].error, 'build failed');
  assert.equal(backend.stops.length, 1);
  await runtime.dispose();
});

test('preview TTL starts when a slow build becomes ready', async () => {
  let now = Date.parse('2026-08-20T00:00:00.000Z');
  const backend = new FakeBackend();
  backend.onStart = () => { now += 90_000; };
  const runtime = new PreviewRuntime(backend, { defaultTtlMinutes: 1 }, () => now);
  try {
    const created = await runtime.create({ tenantId: 'acme', projectId: 'p1', revision: 1, roleId: 'admin', actor: 'alice', artifact });
    assert.equal(Date.parse(created.session.expiresAt), now + 60_000);
    assert.ok(runtime.authorize(created.session.id, created.accessToken));
  } finally { await runtime.dispose(); }
});

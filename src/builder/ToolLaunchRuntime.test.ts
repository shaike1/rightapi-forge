import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolLaunchRuntime, type ToolRuntimeGateway } from './ToolLaunchRuntime.js';

test('launch runtime exchanges a single-use token for an expiring proxy cookie', async () => {
  let now = new Date('2026-08-20T00:00:00.000Z'); let runtime = '';
  const gateway: ToolRuntimeGateway = { request: async (runtimeRef, request) => { runtime = runtimeRef; return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(request.path) }; } };
  const launches = new ToolLaunchRuntime(gateway, 10, () => now);
  const created = launches.create({ tenantId: 'acme', projectId: 'app-1', deploymentId: 'dep-1', runtimeRef: 'runtime-1', actor: 'alice' });
  const exchanged = launches.exchange(created.session.id, created.accessToken); assert.ok(exchanged);
  assert.equal(launches.exchange(created.session.id, created.accessToken), null);
  const response = await launches.request(created.session.id, exchanged.cookie, { method: 'GET', path: '/api/spec', headers: {} });
  assert.equal(response.body.toString(), '/api/spec'); assert.equal(runtime, 'runtime-1');
  now = new Date('2026-08-20T00:11:00.000Z'); assert.equal(launches.authorize(created.session.id, exchanged.cookie), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRbacMiddleware } from './rbacMiddleware.js';

test('fine-grained permission middleware rejects an unauthenticated request before fallback resolution', async () => {
  let resolved = false; let status = 0; let body: any; let next = false;
  const rbac = { resolve: async () => { resolved = true; return { userId: 'anonymous', tenantId: 'system', effectiveRole: 'super_admin', permissions: new Set(['builder.deploy']), fromFallback: true }; } } as any;
  const middleware = createRbacMiddleware(rbac).requirePermission('builder.deploy');
  await middleware({ auth: undefined } as any, { status(value: number) { status = value; return this; }, json(value: any) { body = value; } } as any, () => { next = true; });
  assert.equal(status, 401); assert.equal(body.error, 'Authentication required'); assert.equal(resolved, false); assert.equal(next, false);
});

test('fine-grained permission middleware resolves an authenticated principal', async () => {
  let next = false;
  const rbac = { resolve: async (userId: string) => ({ userId, tenantId: 'system', effectiveRole: 'tenant_admin', permissions: new Set(['builder.deploy']), fromFallback: false }) } as any;
  const middleware = createRbacMiddleware(rbac).requirePermission('builder.deploy');
  const req = { auth: { username: 'alice', role: 'admin', source: 'jwt' } } as any;
  await middleware(req, { status() { return this; }, json() {} } as any, () => { next = true; });
  assert.equal(next, true); assert.equal(req.rbac.userId, 'alice');
});

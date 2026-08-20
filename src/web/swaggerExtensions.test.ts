import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendSwaggerSpec } from './swaggerExtensions.js';

test('extendSwaggerSpec adds the hardening-era paths and schemas', () => {
  const base: any = { paths: {}, components: { schemas: {} }, tags: [] };
  const out = extendSwaggerSpec(base);
  // A representative path from each new tag group must be present.
  assert.ok(out.paths['/incidents'], 'incidents path missing');
  assert.ok(out.paths['/auth/login'], 'auth path missing');
  assert.ok(out.paths['/assets'], 'assets path missing');
  assert.ok(out.paths['/changes'], 'changes path missing');
  assert.ok(out.paths['/knowledge/articles'], 'knowledge path missing');
  assert.ok(out.paths['/runbooks/library'], 'runbooks path missing');
  assert.ok(out.paths['/sla/policies'], 'sla path missing');
  assert.ok(out.paths['/reports/schedules'], 'reports path missing');
  assert.ok(out.paths['/problems'], 'problems path missing');
  assert.ok(out.paths['/plugins'], 'plugins path missing');
  assert.ok(out.paths['/health'], 'health path missing');
  assert.ok(out.paths['/metrics'], 'metrics path missing');
  assert.ok(out.paths['/portal/incidents'], 'portal path missing');
  assert.ok(out.paths['/system/db/status'], 'system db status path missing');
  // Schemas
  assert.ok(out.components.schemas['Incident'], 'Incident schema missing');
  assert.ok(out.components.schemas['Asset'], 'Asset schema missing');
  assert.ok(out.components.schemas['HealthReport'], 'HealthReport schema missing');
});

test('extendSwaggerSpec does not clobber existing schemas', () => {
  const base: any = {
    paths: { '/incidents': { get: { tags: ['MyCustom'] } } },
    components: { schemas: { Incident: { type: 'object', properties: { mine: { type: 'string' } } } } },
    tags: [{ name: 'MyCustom' }],
  };
  const out = extendSwaggerSpec(base);
  // Existing schema with same name wins (extension's Incident must NOT
  // clobber the curated one).
  assert.ok((out.components.schemas['Incident'] as any).properties.mine);
  // Extension path is added because it was missing from base.
  assert.ok(out.paths['/auth/login']);
  // Existing path is preserved (extension's /incidents must NOT override).
  assert.deepEqual((out.paths['/incidents'] as any).get.tags, ['MyCustom']);
});

test('extendSwaggerSpec is idempotent', () => {
  const base: any = { paths: {}, components: { schemas: {} }, tags: [] };
  const a = extendSwaggerSpec(base);
  const b = extendSwaggerSpec(a);
  assert.equal(Object.keys(a.paths).length, Object.keys(b.paths).length);
});

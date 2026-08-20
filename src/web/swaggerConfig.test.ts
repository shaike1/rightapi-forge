import test from 'node:test';
import assert from 'node:assert/strict';
import { swaggerSpec } from './swaggerConfig.js';

const expectedPaths = [
  '/agents/{id}/reflections',
  '/agents/{id}/performance',
  '/agents/{id}/usage',
  '/agents/{id}/usage/history',
  '/agents/{id}/usage/budget',
  '/agents/{id}/usage/reset',
  '/skills/circuit-breakers',
  '/skills/circuit-breakers/{skillId}/reset',
];

test('Swagger spec exposes every new endpoint', () => {
  const spec = swaggerSpec as any;
  assert.ok(spec.paths, 'paths object missing');
  for (const p of expectedPaths) {
    assert.ok(spec.paths[p], `path "${p}" not registered in Swagger`);
  }
});

test('Swagger spec exposes the new schemas', () => {
  const spec = swaggerSpec as any;
  const schemas = spec.components?.schemas ?? {};
  for (const name of ['Reflection', 'PerformanceStats', 'UsageReport', 'UsageBudget', 'UsageGate', 'DailyUsageRecord', 'CircuitBreakerSnapshot']) {
    assert.ok(schemas[name], `schema "${name}" not registered`);
  }
});

test('Swagger spec exposes the new tags', () => {
  const spec = swaggerSpec as any;
  const tagNames = (spec.tags ?? []).map((t: any) => t.name);
  for (const t of ['Reflections', 'Usage', 'Guardrails']) {
    assert.ok(tagNames.includes(t), `tag "${t}" missing`);
  }
});

test('Reflections endpoints declare the right query parameters', () => {
  const spec = swaggerSpec as any;
  const refl = spec.paths['/agents/{id}/reflections'].get;
  const paramNames = (refl.parameters ?? []).map((p: any) => p.name);
  assert.ok(paramNames.includes('id'));
  assert.ok(paramNames.includes('limit'));
  assert.ok(paramNames.includes('minRating'));
  assert.ok(paramNames.includes('maxRating'));
});

test('Usage budget endpoint declares a JSON requestBody pointing at UsageBudget', () => {
  const spec = swaggerSpec as any;
  const post = spec.paths['/agents/{id}/usage/budget'].post;
  assert.ok(post.requestBody);
  assert.equal(post.requestBody.required, true);
  const schema = post.requestBody.content['application/json'].schema;
  assert.equal(schema.$ref, '#/components/schemas/UsageBudget');
});

test('Circuit breaker endpoints declare the right shapes', () => {
  const spec = swaggerSpec as any;
  const list = spec.paths['/skills/circuit-breakers'].get;
  assert.equal(list.tags[0], 'Guardrails');
  const reset = spec.paths['/skills/circuit-breakers/{skillId}/reset'].post;
  assert.equal(reset.parameters[0].name, 'skillId');
  assert.equal(reset.parameters[0].required, true);
});

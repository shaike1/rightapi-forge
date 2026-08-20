import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const monitoringPagePath = path.join(
  process.cwd(),
  'client',
  'src',
  'pages',
  'MonitoringPage.tsx'
);

function readMonitoringPage(): string {
  return readFileSync(monitoringPagePath, 'utf8');
}

test('monitoring page uses the live server and agent metric endpoints', () => {
  const source = readMonitoringPage();

  assert.match(source, /api\.get<ServerMetricsResponse>\('\/api\/servers\/metrics'\)/);
  assert.match(source, /api\.get<AgentMetricsResponse>\('\/api\/agents\/metrics'\)/);
  assert.doesNotMatch(source, /\/api\/monitoring\/metrics/);
});

test('monitoring page preserves action-first handling for incomplete data', () => {
  const source = readMonitoringPage();

  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /if \(!server\.reachable\)/);
  assert.match(source, /one or more resource metrics are missing/);
  assert.match(source, /Recommended action/);
  assert.match(source, /Healthy fleet/);
  assert.match(source, /clampPercentage/);
});

test('monitoring page connects durable alert ownership and incident actions', () => {
  const source = readMonitoringPage();

  assert.match(source, /\/api\/alerts\?source=monitoring&status=active/);
  assert.match(source, /\/api\/alerts\/\$\{alert\.id\}\/acknowledge/);
  assert.match(source, /\/api\/alerts\/\$\{alert\.id\}\/assign/);
  assert.match(source, /\/api\/alerts\/\$\{alert\.id\}\/incident/);
  assert.match(source, /Acknowledge/);
  assert.match(source, /Assign to me/);
  assert.match(source, /Create incident/);
});

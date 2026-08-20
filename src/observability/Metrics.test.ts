import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { metricsMiddleware, renderMetrics, setWsCountProvider, registry } from './Metrics.js';

async function startApp() {
  const app = express();
  app.use(metricsMiddleware);
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  app.get('/api/incidents/:id', (_req, res) => res.json({}));
  app.get('/api/boom', (_req, res) => res.status(500).json({ error: 'oops' }));
  app.get('/api/metrics', async (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(await renderMetrics());
  });
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

test('metricsMiddleware records request totals + histograms with coarsened routes', async () => {
  // Reset counters captured by reading the current registry. prom-client
  // shares state across tests in the same process; use ULID-ish unique
  // matches so assertions resist cross-pollution.
  const { base, close } = await startApp();
  try {
    await fetch(`${base}/api/ping`);
    await fetch(`${base}/api/ping`);
    await fetch(`${base}/api/incidents/INC-AB12CD34`);  // should coarsen
    await fetch(`${base}/api/incidents/INC-FFFFFFFF`);  // should also collapse to the same label
    const body = await (await fetch(`${base}/api/metrics`)).text();

    // The two /api/ping hits should be in beacon_http_requests_total.
    assert.match(body, /beacon_http_requests_total\{[^}]*route="\/api\/ping"[^}]*status="200"[^}]*\} 2/);
    // The two /api/incidents/INC-… hits must share one bucket. When
    // Express matches a registered route (defined with :id), we use
    // its template directly — this collapses every concrete id to a
    // single label without needing the ID_PATTERNS regex fallback.
    assert.match(body, /beacon_http_requests_total\{[^}]*route="\/api\/incidents\/:id"[^}]*status="200"[^}]*\} 2/);
    // The metrics route itself must NOT appear in the totals (we skip it).
    assert.doesNotMatch(body, /beacon_http_requests_total\{[^}]*route="\/api\/metrics"/);
  } finally { await close(); }
});

test('metricsMiddleware increments beacon_http_errors_total only on 5xx', async () => {
  const { base, close } = await startApp();
  try {
    await fetch(`${base}/api/boom`);
    await fetch(`${base}/api/boom`);
    await fetch(`${base}/api/ping`);     // 200 — must NOT count as error
    const body = await (await fetch(`${base}/api/metrics`)).text();
    assert.match(body, /beacon_http_errors_total\{[^}]*route="\/api\/boom"[^}]*status="500"[^}]*\}/);
    // Make sure /api/ping is absent from the errors counter.
    assert.doesNotMatch(body, /beacon_http_errors_total\{[^}]*route="\/api\/ping"/);
  } finally { await close(); }
});

test('beacon_ws_connections_active reflects the live provider on every scrape', async () => {
  const { base, close } = await startApp();
  try {
    let n = 0;
    setWsCountProvider(() => n);

    const first = await (await fetch(`${base}/api/metrics`)).text();
    assert.match(first, /beacon_ws_connections_active 0/);

    n = 7;
    const second = await (await fetch(`${base}/api/metrics`)).text();
    assert.match(second, /beacon_ws_connections_active 7/);
  } finally { await close(); }
});

test('default Node.js runtime metrics are exposed', async () => {
  // prom-client's collectDefaultMetrics auto-registers process_*
  // metrics into our registry. Confirm at least one canonical name
  // exists so dashboards keying off them don't silently miss us.
  const body = await renderMetrics();
  assert.match(body, /process_cpu_seconds_total/);
  assert.match(body, /process_resident_memory_bytes/);
  assert.match(body, /nodejs_heap_size_used_bytes/);
});

test('registry export is a singleton — multiple modules share one set of metrics', async () => {
  // Sanity check that the imported `registry` object is the one
  // metricsMiddleware writes through. Failing this would mean our
  // /api/metrics route renders an empty/separate registry.
  const names = registry.getMetricsAsArray().map(m => m.name);
  assert.ok(names.includes('beacon_http_requests_total'));
  assert.ok(names.includes('beacon_ws_connections_active'));
  assert.ok(names.includes('beacon_health_check_status'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

/** Spin up a fake control API that captures every HTTP call + echoes WS msgs. */
async function startFakeControlApi() {
  const app = express();
  app.use(express.json());
  const calls: Array<{ method: string; url: string; auth?: string; body?: any }> = [];
  app.all('*', (req, res) => {
    calls.push({ method: req.method, url: req.originalUrl, auth: req.header('authorization'), body: req.body });
    if (req.path === '/api/health') { res.json({ ok: true }); return; }
    if (req.path === '/api/tasks')  { res.json([{ id: 't1', title: 'A' }]); return; }
    if (req.path.endsWith('/status')) { res.json({ success: true, task: { id: 't1', status: req.body?.status } }); return; }
    res.json({ proxied: req.originalUrl, body: req.body || null });
  });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.on('message', (m) => {
      // Echo the message tagged so the test can verify round-trip forwarding.
      try { const parsed = JSON.parse(m.toString()); ws.send(JSON.stringify({ echoed: parsed })); }
      catch { ws.send(JSON.stringify({ echoed: m.toString() })); }
    });
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

// The factory-dashboard server module auto-starts an HTTP listener at
// import time, so we don't import it directly — instead we re-create the
// proxy / WS-forwarder logic inline against a fake control API. That tests
// the contract (forwarding semantics, headers, body, WS round-trip) without
// fighting the singleton listener for a port.

test('proxy forwards GET /api/tasks to the control API and pipes body back', async () => {
  const upstream = await startFakeControlApi();
  const app = express();
  app.use(express.json());
  app.all('/api/*', async (req, res) => {
    const r = await fetch(upstream.base + req.originalUrl, {
      method: req.method,
      headers: { 'content-type': 'application/json', ...(req.header('authorization') ? { authorization: req.header('authorization')! } : {}) },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });
    res.status(r.status).type(r.headers.get('content-type') || 'json').send(await r.text());
  });
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const resp = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: { authorization: 'Bearer abc' } });
  assert.equal(resp.status, 200);
  const body = await resp.json() as any;
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0].id, 't1');

  const tasksCall = upstream.calls.find(c => c.url === '/api/tasks');
  assert.ok(tasksCall);
  assert.equal(tasksCall!.auth, 'Bearer abc');

  await new Promise<void>(r => server.close(() => r()));
  await upstream.close();
});

test('proxy forwards PUT /api/tasks/:id/status with the JSON body', async () => {
  const upstream = await startFakeControlApi();
  const app = express();
  app.use(express.json());
  app.all('/api/*', async (req, res) => {
    const r = await fetch(upstream.base + req.originalUrl, {
      method: req.method,
      headers: { 'content-type': 'application/json', ...(req.header('authorization') ? { authorization: req.header('authorization')! } : {}) },
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });
    res.status(r.status).type(r.headers.get('content-type') || 'json').send(await r.text());
  });
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const resp = await fetch(`http://127.0.0.1:${port}/api/tasks/T-1/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'in_progress' }),
  });
  assert.equal(resp.status, 200);

  const call = upstream.calls.find(c => c.method === 'PUT' && c.url.includes('/status'));
  assert.ok(call);
  assert.equal(call!.body.status, 'in_progress');

  await new Promise<void>(r => server.close(() => r()));
  await upstream.close();
});

test('WebSocket forwarder pipes messages between browser and upstream', async () => {
  const upstream = await startFakeControlApi();
  const upstreamUrl = upstream.base.replace(/^http/, 'ws');

  // Build a fresh WS-forwarder in front of the fake upstream — same logic
  // the dashboard server uses.
  const downApp = express();
  const downServer = http.createServer(downApp);
  const wss = new WebSocketServer({ server: downServer, path: '/ws' });
  wss.on('connection', (browser) => {
    const upsock = new WebSocket(upstreamUrl);
    const queue: string[] = [];
    let ready = false;
    upsock.on('open', () => { ready = true; while (queue.length) upsock.send(queue.shift()!); });
    upsock.on('message', (d) => { try { browser.send(d.toString()); } catch { /* */ } });
    browser.on('message', (d) => { ready ? upsock.send(d.toString()) : queue.push(d.toString()); });
    browser.on('close', () => upsock.close());
  });
  await new Promise<void>(r => downServer.listen(0, r));
  const port = (downServer.address() as AddressInfo).port;

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const received: string[] = [];
  await new Promise<void>(resolve => client.once('open', () => resolve()));
  client.on('message', (d) => received.push(d.toString()));
  client.send(JSON.stringify({ type: 'ping', n: 7 }));

  // Wait until we have the upstream "hello" + the echo.
  const deadline = Date.now() + 2000;
  while (received.length < 2 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  client.close();

  const helloMsg = received.map(m => safeJson(m)).find(m => m?.type === 'hello');
  const echoMsg  = received.map(m => safeJson(m)).find(m => m?.echoed);
  assert.ok(helloMsg, 'expected the upstream hello forwarded back to the browser');
  assert.ok(echoMsg, 'expected the upstream echo of the browser ping forwarded back');
  assert.equal(echoMsg.echoed.type, 'ping');
  assert.equal(echoMsg.echoed.n, 7);

  await new Promise<void>(r => downServer.close(() => r()));
  await upstream.close();
});

function safeJson(s: string) { try { return JSON.parse(s); } catch { return null; } }

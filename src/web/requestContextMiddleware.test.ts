import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { requestContextMiddleware } from './requestContextMiddleware.js';
import { getCurrentRequestId, setCurrentUserId } from '../observability/RequestContext.js';

function startServer(handler: (req: any, res: any) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.use(requestContextMiddleware());
  app.get('/x', (req, res) => handler(req, res));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function get(port: number, headers: Record<string, string> = {}): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: '/x', method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('middleware sets X-Request-Id header on every response', async () => {
  const srv = await startServer((req, res) => {
    res.json({ id: getCurrentRequestId() });
  });
  try {
    const r = await get(srv.port);
    assert.equal(r.status, 200);
    assert.ok(r.headers['x-request-id']);
    const id = String(r.headers['x-request-id']);
    const parsed = JSON.parse(r.body);
    assert.equal(parsed.id, id, 'handler must observe the same request id that was returned');
  } finally {
    await srv.close();
  }
});

test('middleware reuses a well-formed inbound X-Request-Id', async () => {
  const srv = await startServer((req, res) => res.json({ id: getCurrentRequestId() }));
  try {
    const incoming = 'req-12345678abcd';
    const r = await get(srv.port, { 'x-request-id': incoming });
    assert.equal(r.headers['x-request-id'], incoming);
    const parsed = JSON.parse(r.body);
    assert.equal(parsed.id, incoming);
  } finally {
    await srv.close();
  }
});

test('middleware rejects malformed inbound ids and mints a fresh one', async () => {
  const srv = await startServer((req, res) => res.json({ id: getCurrentRequestId() }));
  try {
    const r = await get(srv.port, { 'x-request-id': '$$$<script>' });
    const id = String(r.headers['x-request-id']);
    assert.notEqual(id, '$$$<script>');
    assert.ok(id.length >= 16);
  } finally {
    await srv.close();
  }
});

test('setCurrentUserId inside the handler is visible after await', async () => {
  let observed: string | undefined;
  const srv = await startServer((req, res) => {
    setCurrentUserId('alice');
    setTimeout(() => {
      observed = getCurrentRequestId();
      res.json({ ok: true });
    }, 5);
  });
  try {
    await get(srv.port);
    assert.ok(observed, 'request id must survive an async hop');
  } finally {
    await srv.close();
  }
});

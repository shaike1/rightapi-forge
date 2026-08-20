import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createPublicDemoRouter } from './publicDemoApi.js';

async function fixture() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-demo-api-'));
  const notifications: Array<{ subject: string; body: string; recipients: string[] }> = [];
  const app = express();
  app.use(express.json());
  app.use('/api/public', createPublicDemoRouter({
    dataRoot,
    notify: async (subject, body, recipients) => { notifications.push({ subject, body, recipients }); },
  }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/public/demo-requests`,
    dataRoot,
    notifications,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('demo request endpoint validates, persists, and notifies', async () => {
  const f = await fixture();
  try {
    const invalid = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bad' }) });
    assert.equal(invalid.status, 400);

    const response = await fetch(f.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Ada Operator', email: 'ADA@EXAMPLE.COM', company: 'Example Ops', teamSize: '11-50',
        useCase: 'We need governed incident remediation across several production services.',
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { accepted: boolean; requestId: string };
    assert.equal(body.accepted, true);
    assert.match(body.requestId, /^demo_/);
    const records = fs.readFileSync(path.join(f.dataRoot, 'public-demo-requests.jsonl'), 'utf8').trim().split('\n');
    assert.equal(records.length, 1);
    assert.equal(JSON.parse(records[0]).email, 'ada@example.com');
    assert.equal(f.notifications.length, 1);
    assert.deepEqual(f.notifications[0].recipients, ['info@right-api.com']);
  } finally {
    await f.close();
  }
});

test('demo request honeypot accepts without storing bot submissions', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ website: 'https://spam.invalid' }),
    });
    assert.equal(response.status, 202);
    assert.equal(fs.existsSync(path.join(f.dataRoot, 'public-demo-requests.jsonl')), false);
  } finally {
    await f.close();
  }
});

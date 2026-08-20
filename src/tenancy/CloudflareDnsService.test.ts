import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareDnsService, cloudflareDnsConfigFromEnv } from './CloudflareDnsService.js';

interface MockCall {
  url: string;
  method: string;
  body?: any;
}

function mockFetch(responses: Array<{ status?: number; body: any }>) {
  const calls: MockCall[] = [];
  let i = 0;
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body: bodyStr ? JSON.parse(bodyStr) : undefined });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fn, calls };
}

function svc(fn: typeof fetch) {
  return new CloudflareDnsService({
    apiToken: 'tok',
    zoneId: 'zid',
    tunnelCname: 'tunnel-abc.cfargotunnel.com',
    zoneName: 'example.com',
    subdomainSuffix: '-itops',
    fetchImpl: fn,
  });
}

test('hostnameFor combines slug + suffix + zone', () => {
  const s = svc(mockFetch([{ body: {} }]).fn);
  assert.equal(s.hostnameFor('acme'), 'acme-itops.example.com');
});

test('createRecord posts a proxied CNAME and returns the record id', async () => {
  const { fn, calls } = mockFetch([
    { body: { success: true, result: { id: 'rec123', name: 'acme-itops.example.com', type: 'CNAME', content: 'tunnel-abc.cfargotunnel.com' } } },
  ]);
  const r = await svc(fn).createRecord('acme');
  assert.equal(r.ok, true);
  assert.equal(r.recordId, 'rec123');
  assert.equal(r.hostname, 'acme-itops.example.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, /\/zones\/zid\/dns_records$/);
  assert.equal(calls[0].body.type, 'CNAME');
  assert.equal(calls[0].body.proxied, true);
  assert.equal(calls[0].body.content, 'tunnel-abc.cfargotunnel.com');
  assert.equal(calls[0].body.name, 'acme-itops.example.com');
});

test('createRecord treats existing-with-correct-target as success', async () => {
  const { fn } = mockFetch([
    { body: { success: false, errors: [{ code: 81053, message: 'already exists' }] } },
    { body: { success: true, result: [{ id: 'rec999', name: 'acme-itops.example.com', type: 'CNAME', content: 'tunnel-abc.cfargotunnel.com' }] } },
  ]);
  const r = await svc(fn).createRecord('acme');
  assert.equal(r.ok, true);
  assert.equal(r.alreadyExisted, true);
  assert.equal(r.recordId, 'rec999');
});

test('createRecord surfaces conflict when existing record points elsewhere', async () => {
  const { fn } = mockFetch([
    { body: { success: false, errors: [{ code: 81053, message: 'already exists' }] } },
    { body: { success: true, result: [{ id: 'rec000', name: 'acme-itops.example.com', type: 'CNAME', content: 'wrong-tunnel.cfargotunnel.com' }] } },
  ]);
  const r = await svc(fn).createRecord('acme');
  assert.equal(r.ok, false);
  assert.match(r.error!, /wrong-tunnel/);
});

test('createRecord swallows network errors and returns ok=false', async () => {
  const fn: typeof fetch = async () => { throw new Error('boom'); };
  const r = await svc(fn).createRecord('acme');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'boom');
});

test('deleteRecord finds + deletes the record', async () => {
  const { fn, calls } = mockFetch([
    { body: { success: true, result: [{ id: 'rec123', name: 'acme-itops.example.com', type: 'CNAME', content: 'tunnel-abc.cfargotunnel.com' }] } },
    { body: { success: true, result: { id: 'rec123' } } },
  ]);
  const r = await svc(fn).deleteRecord('acme');
  assert.equal(r.ok, true);
  assert.equal(r.hostname, 'acme-itops.example.com');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'DELETE');
  assert.match(calls[1].url, /\/dns_records\/rec123$/);
});

test('deleteRecord returns ok+notFound when nothing exists', async () => {
  const { fn, calls } = mockFetch([
    { body: { success: true, result: [] } },
  ]);
  const r = await svc(fn).deleteRecord('ghost');
  assert.equal(r.ok, true);
  assert.equal(r.notFound, true);
  assert.equal(calls.length, 1);
});

test('cloudflareDnsConfigFromEnv returns undefined when token or zone missing', () => {
  const prev = { ...process.env };
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ZONE_ID;
  assert.equal(cloudflareDnsConfigFromEnv(), undefined);
  process.env.CLOUDFLARE_API_TOKEN = 'x';
  assert.equal(cloudflareDnsConfigFromEnv(), undefined);
  Object.assign(process.env, prev);
});

test('cloudflareDnsConfigFromEnv derives tunnel cname from CLOUDFLARE_TUNNEL_ID', () => {
  const prev = { ...process.env };
  process.env.CLOUDFLARE_API_TOKEN = 'tok';
  process.env.CLOUDFLARE_ZONE_ID = 'zid';
  process.env.CLOUDFLARE_TUNNEL_ID = 'abc-123';
  delete process.env.CLOUDFLARE_TUNNEL_CNAME;
  const cfg = cloudflareDnsConfigFromEnv();
  assert.ok(cfg);
  assert.equal(cfg!.tunnelCname, 'abc-123.cfargotunnel.com');
  assert.equal(cfg!.zoneName, 'example.com');
  assert.equal(cfg!.subdomainSuffix, '-itops');
  Object.assign(process.env, prev);
});

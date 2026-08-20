import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PluginConfigEncryption } from '../plugins/PluginConfigEncryption.js';
import { ManagedIntegrationBroker } from './ManagedIntegrationBroker.js';
import { ManagedIntegrationRegistry } from './ManagedIntegrationRegistry.js';

test('broker injects secrets server-side for an exact signed capability and records the call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-broker-')); const db = path.join(root, 'builder.db');
  const registry = new ManagedIntegrationRegistry(db, new PluginConfigEncryption('broker-encryption'));
  const connection = registry.create({ tenantId: 'acme', actor: 'admin', connection: {
    name: 'Issue API', provider: 'http', capabilities: ['GET /issues?state=open'],
    credentials: { baseUrl: 'https://api.example.com/v1', 'header:authorization': 'Bearer hidden' },
  } });
  const broker = new ManagedIntegrationBroker(registry, db, 'broker-signing-key-that-is-at-least-32-bytes',
    async (url, init) => {
      assert.equal(url, 'https://api.example.com/issues?state=open');
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer hidden');
      return new Response(JSON.stringify({ issues: 3 }), { status: 200, headers: { 'content-type': 'application/json', 'x-secret': 'blocked' } });
    }, async () => [{ address: '93.184.216.34', family: 4 }]);
  try {
    const issued = broker.issue({ tenantId: 'acme', projectId: 'app-1', connectionRef: connection.ref, capability: 'GET /issues?state=open', actor: 'alice' });
    assert.equal(issued.grant.includes('hidden'), false);
    const result = await broker.invoke({ grant: issued.grant, tenantId: 'acme', projectId: 'app-1', actor: 'alice' });
    assert.deepEqual(result.body, { issues: 3 }); assert.equal(result.headers['x-secret'], undefined);
    assert.equal(broker.calls('acme', 'app-1').length, 1);
    await assert.rejects(() => broker.invoke({ grant: `${issued.grant}x`, tenantId: 'acme', projectId: 'app-1', actor: 'alice' }), /invalid capability grant/);
  } finally { broker.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('broker rejects private targets before fetch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-broker-')); const db = path.join(root, 'builder.db');
  const registry = new ManagedIntegrationRegistry(db, new PluginConfigEncryption('broker-encryption'));
  const connection = registry.create({ tenantId: 'acme', actor: 'admin', connection: { name: 'Internal', provider: 'http', capabilities: ['GET /health'], credentials: { baseUrl: 'https://internal.example' } } });
  const broker = new ManagedIntegrationBroker(registry, db, 'broker-signing-key-that-is-at-least-32-bytes', async () => { throw new Error('fetch must not run'); }, async () => [{ address: '10.0.0.2', family: 4 }]);
  try {
    const grant = broker.issue({ tenantId: 'acme', projectId: 'app-1', connectionRef: connection.ref, capability: 'GET /health', actor: 'alice' }).grant;
    await assert.rejects(() => broker.invoke({ grant, tenantId: 'acme', projectId: 'app-1', actor: 'alice' }), /private or reserved/);
  } finally { broker.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

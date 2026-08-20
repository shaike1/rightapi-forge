import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PluginConfigEncryption } from '../plugins/PluginConfigEncryption.js';
import { ManagedIntegrationRegistry } from './ManagedIntegrationRegistry.js';

test('managed connections expose capabilities while credentials stay encrypted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-connections-'));
  const db = path.join(root, 'builder.db'); const registry = new ManagedIntegrationRegistry(db, new PluginConfigEncryption('test-key'));
  try {
    const created = registry.create({ tenantId: 'acme', actor: 'alice', connection: { name: 'Production GitHub', provider: 'github', capabilities: ['issues.read'], credentials: { token: 'super-secret-value' } } });
    assert.equal(JSON.stringify(created).includes('super-secret-value'), false);
    const stored = [db, `${db}-wal`].filter(fs.existsSync).map(file => fs.readFileSync(file));
    assert.equal(Buffer.concat(stored).includes(Buffer.from('super-secret-value')), false);
    assert.equal(registry.resolveCapability('acme', created.ref, 'issues.read')?.credentials.token, 'super-secret-value');
    assert.equal(registry.resolveCapability('acme', created.ref, 'issues.write'), null);
    assert.equal(registry.list('other').length, 0);
  } finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

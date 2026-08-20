import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ServerRegistry, LOCAL_SERVER_ID } from './ServerRegistry.js';

function fresh(): ServerRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-srvreg-'));
  return new ServerRegistry(path.join(dir, 'servers.db'));
}

test('ensureLocal creates an immutable-identity local row on first call', () => {
  const r = fresh();
  const a = r.ensureLocal();
  assert.equal(a.id, LOCAL_SERVER_ID);
  assert.equal(a.isLocal, true);
  assert.equal(a.host, null);
  // Idempotent — calling again returns the same row.
  const b = r.ensureLocal();
  assert.equal(b.id, a.id);
  assert.equal(b.createdAt, a.createdAt);
});

test('upsert creates a remote server with defaults filled in', () => {
  const r = fresh();
  const s = r.upsert({ name: 'production-1', host: '10.0.0.5', sshUser: 'ubuntu' });
  assert.equal(s.id, 'production-1');
  assert.equal(s.sshPort, 22);
  assert.equal(s.enabled, true);
  assert.equal(s.isLocal, false);
  assert.deepEqual(s.tags, []);
});

test('upsert slugifies the id from the name when none is supplied', () => {
  const r = fresh();
  const s = r.upsert({ name: 'Prod DB Cluster #1', host: 'db1', sshUser: 'admin' });
  assert.equal(s.id, 'prod-db-cluster-1');
});

test('update freezes the local row\'s host/ssh fields but allows renaming', () => {
  const r = fresh();
  r.ensureLocal();
  // Try to corrupt the local row by feeding it remote-shaped values.
  const updated = r.update(LOCAL_SERVER_ID, {
    name: 'vps1-renamed',
    host: '1.2.3.4',
    sshUser: 'root',
    tags: ['custom-tag'],
    enabled: false,
  });
  assert.ok(updated);
  // Name + tags + enabled are mutable; host/ssh are not.
  assert.equal(updated!.name, 'vps1-renamed');
  assert.deepEqual(updated!.tags, ['custom-tag']);
  assert.equal(updated!.enabled, false);
  assert.equal(updated!.host, null, 'host stays null (frozen)');
  assert.equal(updated!.sshUser, null, 'sshUser stays null (frozen)');
});

test('ensureLocal migrates the legacy "local" name to env default "vps1"', () => {
  const r = fresh();
  // Simulate an upgrade where the row was seeded under the old default.
  r.upsert({
    id: LOCAL_SERVER_ID, name: 'local', host: null, sshUser: null,
    tags: ['local', 'nsenter'], isLocal: true, enabled: true,
  });
  const migrated = r.ensureLocal();
  assert.equal(migrated.name, 'vps1');
});

test('ensureLocal does not stomp on an operator-customised name', () => {
  const r = fresh();
  r.ensureLocal();
  r.update(LOCAL_SERVER_ID, { name: 'my-edge-box' });
  const after = r.ensureLocal();
  assert.equal(after.name, 'my-edge-box', 'operator name preserved across boots');
});

test('delete refuses to remove the local row', () => {
  const r = fresh();
  r.ensureLocal();
  assert.equal(r.delete(LOCAL_SERVER_ID), false);
  assert.ok(r.get(LOCAL_SERVER_ID), 'local row still present');
});

test('delete removes a remote row and the registry reflects it', () => {
  const r = fresh();
  r.upsert({ name: 'temp', host: '1.1.1.1', sshUser: 'x' });
  assert.equal(r.delete('temp'), true);
  assert.equal(r.get('temp'), null);
});

test('list orders local first, then by name', () => {
  const r = fresh();
  r.ensureLocal();
  r.upsert({ name: 'zeta', host: 'z', sshUser: 'u' });
  r.upsert({ name: 'alpha', host: 'a', sshUser: 'u' });
  const list = r.list();
  assert.equal(list[0].id, LOCAL_SERVER_ID, 'local first');
  assert.equal(list[1].name, 'alpha');
  assert.equal(list[2].name, 'zeta');
});

test('enabledServers filters out disabled rows', () => {
  const r = fresh();
  r.ensureLocal();
  r.upsert({ name: 'on',  host: 'h', sshUser: 'u', enabled: true });
  r.upsert({ name: 'off', host: 'h', sshUser: 'u', enabled: false });
  const enabled = r.enabledServers().map(s => s.id);
  assert.ok(enabled.includes(LOCAL_SERVER_ID));
  assert.ok(enabled.includes('on'));
  assert.ok(!enabled.includes('off'));
});

test('recordCheck stamps lastSeen on ok and lastCheckStatus always', () => {
  const r = fresh();
  r.upsert({ name: 'x', host: 'h', sshUser: 'u' });
  r.recordCheck('x', 'ok');
  const after1 = r.get('x')!;
  assert.equal(after1.lastCheckStatus, 'ok');
  assert.ok(after1.lastSeen, 'lastSeen set on ok');
  r.recordCheck('x', 'error');
  const after2 = r.get('x')!;
  assert.equal(after2.lastCheckStatus, 'error');
  // lastSeen frozen on the prior success.
  assert.equal(after2.lastSeen, after1.lastSeen);
});

test('ensureSeed is a no-op when the id already exists', () => {
  const r = fresh();
  r.upsert({ id: 'openclaw', name: 'openclaw', host: '10.0.0.1', sshUser: 'shai' });
  // Operator has customised host; seed default shouldn't overwrite it.
  const result = r.ensureSeed({ id: 'openclaw', name: 'openclaw', host: '192.0.2.12', sshUser: 'operator' });
  assert.equal(result.created, false);
  assert.equal(result.server.host, '10.0.0.1', 'operator value preserved');
});

test('ensureSeed creates the row when absent', () => {
  const r = fresh();
  const result = r.ensureSeed({ id: 'fresh', name: 'fresh', host: 'h', sshUser: 'u' });
  assert.equal(result.created, true);
  assert.equal(result.server.id, 'fresh');
});

test('sshOptions round-trip through SQLite as JSON', () => {
  const r = fresh();
  r.upsert({
    name: 'oracle-host',
    host: '10.0.0.99',
    sshUser: 'opc',
    sshOptions: { HostKeyAlgorithms: 'rsa-sha2-512,rsa-sha2-256' },
  });
  const back = r.get('oracle-host')!;
  assert.deepEqual(back.sshOptions, { HostKeyAlgorithms: 'rsa-sha2-512,rsa-sha2-256' });
});

test('a second instance opening the same DB sees prior rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-srvreg-'));
  const dbPath = path.join(dir, 'servers.db');
  const a = new ServerRegistry(dbPath);
  a.ensureLocal();
  a.upsert({ name: 'persistent', host: 'p', sshUser: 'u' });
  // Open a second handle to the same file — simulates a process restart.
  const b = new ServerRegistry(dbPath);
  const persisted = b.get('persistent');
  assert.ok(persisted, 'row survives restart');
  assert.equal(persisted!.host, 'p');
});

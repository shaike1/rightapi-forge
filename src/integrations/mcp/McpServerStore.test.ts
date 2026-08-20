import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { McpServerStore } from './McpServerStore.js';
import type { McpServerDef } from './types.js';

function withTempPath(run: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-server-store-'));
  try {
    run(path.join(dir, 'mcp-clients.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('McpServerStore round-trips definitions through disk', () => {
  withTempPath(filePath => {
    const store = new McpServerStore(filePath);
    assert.deepEqual(store.list(), []);

    const def: McpServerDef = {
      id: 'openclaw',
      name: 'OpenClaw',
      transport: 'http',
      url: 'http://10.0.0.115:18789/mcp',
      authToken: 'secret',
      enabled: true,
      exposeToAgents: true,
    };
    store.upsert(def);

    const reloaded = new McpServerStore(filePath);
    const list = reloaded.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'openclaw');
    assert.equal(list[0].url, 'http://10.0.0.115:18789/mcp');
    assert.equal(list[0].authToken, 'secret');
  });
});

test('McpServerStore.delete removes entries and persists', () => {
  withTempPath(filePath => {
    const store = new McpServerStore(filePath);
    store.upsert({ id: 'a', name: 'A', transport: 'http', url: 'http://x' });
    store.upsert({ id: 'b', name: 'B', transport: 'http', url: 'http://y' });
    assert.equal(store.list().length, 2);

    assert.equal(store.delete('a'), true);
    assert.equal(store.delete('a'), false); // already gone
    assert.equal(store.list().length, 1);

    const reloaded = new McpServerStore(filePath);
    assert.deepEqual(reloaded.list().map(d => d.id), ['b']);
  });
});

test('McpServerStore tolerates missing or malformed file', () => {
  withTempPath(filePath => {
    // Missing file
    let store = new McpServerStore(filePath);
    assert.deepEqual(store.list(), []);

    // Malformed JSON
    fs.writeFileSync(filePath, '{ this is not json');
    store = new McpServerStore(filePath);
    assert.deepEqual(store.list(), []);

    // Wrong shape
    fs.writeFileSync(filePath, JSON.stringify({ servers: 'not-an-array' }));
    store = new McpServerStore(filePath);
    assert.deepEqual(store.list(), []);
  });
});

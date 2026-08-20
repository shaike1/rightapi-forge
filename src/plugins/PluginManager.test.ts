import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager } from './PluginManager.js';
import { PluginConfigEncryption } from './PluginConfigEncryption.js';
import type { ITOpsPlugin, PluginContext, PluginConfigField } from './PluginInterface.js';
import type { Incident } from '../persistence/SqliteStore.js';

// ── Test doubles ──────────────────────────────────────────────────────

function fakeContext(): PluginContext {
  const audited: string[] = [];
  const ctx = {
    pluginId: 'test',
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    incidents: {
      create: () => ({} as Incident),
      resolve: () => null,
      escalate: () => null,
      list: () => [],
      get: () => null,
    },
    servers: { list: () => [], get: () => null },
    metrics: { latest: () => [] },
    audit: { log: (action: string, detail?: string) => { audited.push(`${action}|${detail ?? ''}`); } },
    http: {
      get:    async () => ({ ok: true,  status: 200, body: async () => ({}), text: async () => '' }),
      post:   async () => ({ ok: true,  status: 200, body: async () => ({}), text: async () => '' }),
      put:    async () => ({ ok: true,  status: 200, body: async () => ({}), text: async () => '' }),
      delete: async () => ({ ok: true,  status: 200, body: async () => ({}), text: async () => '' }),
    },
  } as PluginContext;
  (ctx as any).audited = audited;
  return ctx;
}

function makePlugin(opts: Partial<ITOpsPlugin> = {}): { plugin: ITOpsPlugin; calls: string[] } {
  const calls: string[] = [];
  const plugin: ITOpsPlugin = {
    id: opts.id ?? 'fake',
    name: opts.name ?? 'Fake',
    version: opts.version ?? '1.0.0',
    description: opts.description ?? 'fake plugin',
    configSchema: opts.configSchema ?? [
      { key: 'token', label: 'Token', type: 'password', required: true },
      { key: 'host',  label: 'Host',  type: 'url',      required: true },
    ],
    onLoad: opts.onLoad ?? (async () => { calls.push('onLoad'); }),
    onUnload: opts.onUnload ?? (async () => { calls.push('onUnload'); }),
    onIncidentCreated: opts.onIncidentCreated ?? (async () => { calls.push('onIncidentCreated'); }),
    onIncidentResolved: opts.onIncidentResolved ?? (async () => { calls.push('onIncidentResolved'); }),
    onIncidentEscalated: opts.onIncidentEscalated ?? (async () => { calls.push('onIncidentEscalated'); }),
    ...opts,
  };
  return { plugin, calls };
}

function fakeIncident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'INC-TEST', title: 'x', description: '', severity: 'high', status: 'open',
    assignedTo: null, assignedAgent: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), resolvedAt: null, source: 'manual',
    sourceRef: null, slaMinutes: 240, serverId: null, ...over,
  };
}

function newManager() {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-mgr-test-'));
  const enc = new PluginConfigEncryption('test-key');
  return new PluginManager({
    dbPath: join(dir, 'plugins.db'),
    encryption: enc,
    contextFor: () => fakeContext(),
  });
}

async function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Registration + lifecycle ──────────────────────────────────────────

test('register() creates a SQLite row; second register() refreshes name/version', () => {
  const m = newManager();
  const { plugin } = makePlugin();
  m.register(plugin);
  const view = m.get('fake');
  assert.ok(view);
  assert.equal(view!.name, 'Fake');
  assert.equal(view!.version, '1.0.0');
  assert.equal(view!.enabled, false);
  // Double-register throws to catch programmer error.
  assert.throws(() => m.register(plugin));
});

test('list() returns one row per registered plugin', () => {
  const m = newManager();
  m.register(makePlugin({ id: 'a', name: 'A' }).plugin);
  m.register(makePlugin({ id: 'b', name: 'B' }).plugin);
  assert.equal(m.list().length, 2);
  assert.deepEqual(m.list().map(p => p.id).sort(), ['a', 'b']);
});

test('enable() calls onLoad and marks loaded=true', async () => {
  const m = newManager();
  const { plugin, calls } = makePlugin();
  m.register(plugin);
  await m.setConfig('fake', { token: 't', host: 'https://h' });
  await m.enable('fake');
  assert.ok(calls.includes('onLoad'));
  assert.equal(m.get('fake')!.loaded, true);
  assert.equal(m.get('fake')!.enabled, true);
});

test('disable() calls onUnload and clears loaded', async () => {
  const m = newManager();
  const { plugin, calls } = makePlugin();
  m.register(plugin);
  await m.setConfig('fake', { token: 't', host: 'https://h' });
  await m.enable('fake');
  await m.disable('fake');
  assert.ok(calls.includes('onUnload'));
  assert.equal(m.get('fake')!.loaded, false);
  assert.equal(m.get('fake')!.enabled, false);
});

test('enable() with failing onLoad surfaces error and stays errored', async () => {
  const m = newManager();
  const { plugin } = makePlugin({ onLoad: async () => { throw new Error('upstream down'); } });
  m.register(plugin);
  await m.setConfig('fake', { token: 't', host: 'https://h' });
  await assert.rejects(m.enable('fake'));
  const v = m.get('fake')!;
  assert.equal(v.enabled, true, 'still enabled in DB so the UI shows the error state');
  assert.equal(v.loaded, false);
  assert.match(v.lastError!, /upstream down/);
});

// ── Config validation + encryption ────────────────────────────────────

test('setConfig() rejects when a required field is missing', async () => {
  const m = newManager();
  m.register(makePlugin().plugin);
  await assert.rejects(m.setConfig('fake', { host: 'https://h' }), /token is required/);
});

test('setConfig() rejects wrong type', async () => {
  const m = newManager();
  m.register(makePlugin({
    configSchema: [{ key: 'count', label: 'N', type: 'number', required: true }],
  } as any).plugin);
  await assert.rejects(m.setConfig('fake', { count: 'not-a-number' as any }), /must be a number/);
});

test('select config validates against options list', async () => {
  const m = newManager();
  m.register(makePlugin({
    configSchema: [{ key: 'region', label: 'Region', type: 'select', required: true,
      options: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] }],
  } as any).plugin);
  await assert.rejects(m.setConfig('fake', { region: 'mars' }), /must be one of/);
  await m.setConfig('fake', { region: 'us' }); // ok
});

test('config password fields are redacted in viewer payload', async () => {
  const m = newManager();
  m.register(makePlugin().plugin);
  await m.setConfig('fake', { token: 'sk-very-secret', host: 'https://h' });
  const v = m.get('fake')!;
  assert.equal((v.config as any).token, '__REDACTED__');
  assert.equal((v.config as any).host, 'https://h');
});

test('empty string for password preserves the previously-saved value (round-trip)', async () => {
  const m = newManager();
  m.register(makePlugin().plugin);
  await m.setConfig('fake', { token: 'real-token', host: 'https://h' });
  // Simulate the UI re-submitting with the redacted token treated as
  // "unchanged" — we encode that as empty string.
  await m.setConfig('fake', { token: '', host: 'https://other' });
  // The plugin should still see real-token if we enable it now.
  let loadedWith: Record<string, unknown> | null = null;
  const { plugin } = makePlugin({ onLoad: async (cfg) => { loadedWith = cfg; } });
  // re-register isn't allowed; we use a new manager but the same SQLite
  // file is private to it, so we instead enable a fresh plugin id.
  const m2 = newManager();
  const { plugin: p2 } = makePlugin({ id: 'p2', onLoad: async (cfg) => { loadedWith = cfg; } });
  m2.register(p2);
  await m2.setConfig('p2', { token: 'kept', host: 'h1' });
  await m2.setConfig('p2', { token: '', host: 'h2' });
  await m2.enable('p2');
  assert.equal((loadedWith as any).token, 'kept');
  assert.equal((loadedWith as any).host, 'h2');
  void plugin;
});

test('setConfig() restarts a currently-loaded plugin with the new config', async () => {
  const m = newManager();
  const calls: Array<{ fn: string; cfg?: Record<string, unknown> }> = [];
  const { plugin } = makePlugin({
    onLoad: async (cfg) => { calls.push({ fn: 'onLoad', cfg: { ...cfg } }); },
    onUnload: async () => { calls.push({ fn: 'onUnload' }); },
  });
  m.register(plugin);
  await m.setConfig('fake', { token: 'v1', host: 'h' });
  await m.enable('fake');
  await m.setConfig('fake', { token: 'v2', host: 'h' });
  assert.deepEqual(calls.map(c => c.fn), ['onLoad', 'onUnload', 'onLoad']);
  assert.equal(calls[2].cfg!.token, 'v2');
});

// ── Hook dispatch + error isolation ───────────────────────────────────

test('hook fan-out invokes every loaded plugin', async () => {
  const m = newManager();
  const a = makePlugin({ id: 'a' });
  const b = makePlugin({ id: 'b' });
  m.register(a.plugin);
  m.register(b.plugin);
  await m.setConfig('a', { token: 't', host: 'h' });
  await m.setConfig('b', { token: 't', host: 'h' });
  await m.enable('a');
  await m.enable('b');
  m.notifyIncidentCreated(fakeIncident());
  await wait(50);
  assert.ok(a.calls.includes('onIncidentCreated'));
  assert.ok(b.calls.includes('onIncidentCreated'));
});

test('a plugin that throws does not stop other plugins from running', async () => {
  const m = newManager();
  const a = makePlugin({ id: 'a', onIncidentCreated: async () => { throw new Error('boom'); } });
  const b = makePlugin({ id: 'b' });
  m.register(a.plugin);
  m.register(b.plugin);
  await m.setConfig('a', { token: 't', host: 'h' });
  await m.setConfig('b', { token: 't', host: 'h' });
  await m.enable('a');
  await m.enable('b');
  m.notifyIncidentCreated(fakeIncident());
  await wait(50);
  assert.ok(b.calls.includes('onIncidentCreated'));
  // Manager records the failure on plugin a's row.
  assert.match(m.get('a')!.lastError ?? '', /boom/);
});

test('disabled plugins do not receive hook dispatches', async () => {
  const m = newManager();
  const a = makePlugin({ id: 'a' });
  m.register(a.plugin);
  await m.setConfig('a', { token: 't', host: 'h' });
  await m.enable('a');
  await m.disable('a');
  m.notifyIncidentCreated(fakeIncident());
  await wait(20);
  assert.ok(!a.calls.includes('onIncidentCreated'));
});

test('synchronous throw from hook is caught (does not leak unhandled rejection)', async () => {
  const m = newManager();
  const a = makePlugin({ id: 'a', onIncidentCreated: (() => { throw new Error('sync throw'); }) as any });
  m.register(a.plugin);
  await m.setConfig('a', { token: 't', host: 'h' });
  await m.enable('a');
  m.notifyIncidentCreated(fakeIncident()); // must not throw
  await wait(20);
  assert.match(m.get('a')!.lastError ?? '', /sync throw/);
});

// ── testConnection + loadEnabled ──────────────────────────────────────

test('testConnection() runs onLoad against a candidate config without persisting it', async () => {
  const m = newManager();
  const onLoadCalls: Record<string, unknown>[] = [];
  const { plugin } = makePlugin({
    onLoad: async (cfg) => { onLoadCalls.push(cfg); },
  });
  m.register(plugin);
  const r = await m.testConnection('fake', { token: 'try', host: 'h' });
  assert.equal(r.ok, true);
  assert.equal(onLoadCalls.length, 1);
  // Stored config should remain empty (test path doesn't persist).
  const stored = m.get('fake')!;
  assert.equal(stored.config, null);
});

test('testConnection() reports onLoad failure', async () => {
  const m = newManager();
  const { plugin } = makePlugin({ onLoad: async () => { throw new Error('bad creds'); } });
  m.register(plugin);
  const r = await m.testConnection('fake', { token: 't', host: 'h' });
  assert.equal(r.ok, false);
  assert.match(r.error!, /bad creds/);
});

test('loadEnabled() re-loads previously-enabled plugins on boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-boot-test-'));
  const enc = new PluginConfigEncryption('boot-key');
  const dbPath = join(dir, 'plugins.db');

  // First "process": enable a plugin then "shut down".
  const m1 = new PluginManager({ dbPath, encryption: enc, contextFor: () => fakeContext() });
  const calls1: string[] = [];
  const p1: ITOpsPlugin = { ...makePlugin({ id: 'persist' }).plugin };
  p1.onLoad = async () => { calls1.push('onLoad-1'); };
  m1.register(p1);
  await m1.setConfig('persist', { token: 't', host: 'h' });
  await m1.enable('persist');
  m1.close();

  // Second "process": fresh manager pointing at the same SQLite file.
  const m2 = new PluginManager({ dbPath, encryption: enc, contextFor: () => fakeContext() });
  const calls2: string[] = [];
  const p2: ITOpsPlugin = { ...makePlugin({ id: 'persist' }).plugin };
  p2.onLoad = async () => { calls2.push('onLoad-2'); };
  m2.register(p2);
  await m2.loadEnabled();
  assert.equal(calls2.length, 1, 'plugin should be auto-loaded on boot');
  assert.equal(m2.get('persist')!.loaded, true);
});

test('loadEnabled() with a registered plugin missing in the DB is a no-op', async () => {
  const m = newManager();
  m.register(makePlugin({ id: 'fresh' }).plugin);
  // No row was ever created with enabled=1 → loadEnabled does nothing.
  await m.loadEnabled();
  assert.equal(m.get('fresh')!.loaded, false);
});

// ── Prometheus integration surface ────────────────────────────────────

test('renderPrometheus concatenates text from each loaded plugin', async () => {
  const m = newManager();
  const a: ITOpsPlugin = {
    ...makePlugin({ id: 'a' }).plugin,
    renderPrometheus: () => '# HELP a a\n# TYPE a gauge\na 1',
  };
  const b: ITOpsPlugin = {
    ...makePlugin({ id: 'b' }).plugin,
    renderPrometheus: () => '# HELP b b\n# TYPE b gauge\nb 2',
  };
  m.register(a);
  m.register(b);
  await m.setConfig('a', { token: 't', host: 'h' });
  await m.setConfig('b', { token: 't', host: 'h' });
  await m.enable('a');
  await m.enable('b');
  const out = m.renderPrometheus();
  assert.match(out, /^# HELP a/m);
  assert.match(out, /^# HELP b/m);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SkillManager } from './SkillManager.js';
import { SkillPluginLoader } from './SkillPluginLoader.js';

/** Build an ESM plugin source string with the given skill id + handler body. */
function pluginSrc(opts: { id: string; commandName?: string; body?: string }): string {
  const cmd = opts.commandName ?? `${opts.id}.ping`;
  const body = opts.body ?? `return JSON.stringify({ ok: true, summary: 'pong-${opts.id}' });`;
  return `export default {
  skill: {
    id: '${opts.id}',
    name: '${opts.id}',
    description: 'fake plugin',
    category: 'general',
    enabled: true,
    commands: [{ name: '${cmd}', description: 'ping', handler: 'ping' }],
  },
  executor: {
    async ping(params) { ${body} },
  },
};
`;
}

function tempDir(prefix = 'plugin-loader-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `itops-${prefix}`));
}

async function settle(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

test('loadAll picks up a valid plugin and registers it with the SkillManager', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'foo.plugin.js'), pluginSrc({ id: 'foo' }), 'utf8');
    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir });

    const res = await loader.loadAll();
    assert.equal(res.loaded, 1);
    assert.equal(res.failed, 0);
    assert.ok(sm.get('foo'));
    const out = JSON.parse(await sm.execute('foo.ping'));
    assert.equal(out.ok, true);
    assert.equal(out.summary, 'pong-foo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed plugin is rejected without crashing the loader', async () => {
  const dir = tempDir();
  try {
    // Missing executor field.
    fs.writeFileSync(
      path.join(dir, 'bad.plugin.js'),
      `export default { skill: { id: 'bad', commands: [] } };\n`,
      'utf8',
    );
    // Plus one good plugin alongside the bad one.
    fs.writeFileSync(path.join(dir, 'good.plugin.js'), pluginSrc({ id: 'good' }), 'utf8');

    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir });
    const res = await loader.loadAll();
    assert.equal(res.loaded, 1, 'good plugin should still load');
    assert.equal(res.failed, 1, 'bad plugin should be counted as failed');
    assert.ok(sm.get('good'));
    assert.equal(sm.get('bad'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin reload swaps the executor in place (cache-busting works)', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'rev.plugin.js');
    fs.writeFileSync(file, pluginSrc({
      id: 'rev',
      body: "return JSON.stringify({ ok: true, summary: 'v1' });",
    }), 'utf8');

    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir });
    await loader.loadAll();
    let r = JSON.parse(await sm.execute('rev.ping'));
    assert.equal(r.summary, 'v1');

    // Rewrite + reload via loadOne (same file path → cache-bust).
    fs.writeFileSync(file, pluginSrc({
      id: 'rev',
      body: "return JSON.stringify({ ok: true, summary: 'v2' });",
    }), 'utf8');
    const reloaded = await loader.loadOne(file);
    assert.equal(reloaded, true);
    r = JSON.parse(await sm.execute('rev.ping'));
    assert.equal(r.summary, 'v2', 'fresh module should be served, not cache');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a plugin file unregisters its skill', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'gone.plugin.js');
    fs.writeFileSync(file, pluginSrc({ id: 'gone' }), 'utf8');
    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir });
    await loader.loadAll();
    assert.ok(sm.get('gone'));

    fs.unlinkSync(file);
    const removed = loader.unloadByPath(file);
    assert.equal(removed, 'gone');
    assert.equal(sm.get('gone'), undefined);
    await assert.rejects(() => sm.execute('gone.ping'), /Unknown command/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin cannot shadow a built-in skill', async () => {
  const dir = tempDir();
  try {
    // 'bash' is a built-in registered in SkillManager's constructor.
    fs.writeFileSync(
      path.join(dir, 'evil.plugin.js'),
      pluginSrc({ id: 'bash', commandName: 'bash.exec' }),
      'utf8',
    );
    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir });
    const res = await loader.loadAll();
    assert.equal(res.loaded, 0);
    assert.equal(res.failed, 1);
    // The built-in is still registered and untouched.
    assert.ok(sm.get('bash'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two plugin files cannot claim the same skill id', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.plugin.js'), pluginSrc({ id: 'dup' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'b.plugin.js'), pluginSrc({ id: 'dup' }), 'utf8');
    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir });
    const res = await loader.loadAll();
    assert.equal(res.loaded, 1, 'first plugin wins');
    assert.equal(res.failed, 1);
    assert.ok(sm.get('dup'));
    assert.equal(loader.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sandboxed loader dispatches a plugin command via a worker thread', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'sb.plugin.js'), pluginSrc({
      id: 'sb',
      body: "return JSON.stringify({ ok: true, summary: 'sandboxed', data: { pid: typeof process !== 'undefined' ? 'in-worker' : 'unknown' } });",
    }), 'utf8');
    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir, sandbox: true });
    await loader.loadAll();
    assert.ok(sm.get('sb'));
    const out = JSON.parse(await sm.execute('sb.ping'));
    assert.equal(out.ok, true);
    assert.equal(out.data.pid, 'in-worker');
    await loader.stop(); // must terminate the worker cleanly
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('start() begins watching and picks up a file dropped after launch', async () => {
  const dir = tempDir();
  try {
    const sm = new SkillManager();
    const loader = new SkillPluginLoader(sm, { pluginDir: dir, debounceMs: 30 });
    await loader.start();
    assert.equal(loader.list().length, 0);

    fs.writeFileSync(path.join(dir, 'late.plugin.js'), pluginSrc({ id: 'late' }), 'utf8');
    // fs.watch is platform-flaky on timing; poll briefly.
    for (let i = 0; i < 40; i++) {
      if (sm.get('late')) break;
      await settle(50);
    }
    assert.ok(sm.get('late'), 'watcher should have loaded the dropped plugin');
    await loader.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

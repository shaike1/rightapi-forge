import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SandboxedPluginRunner } from './SandboxedPluginRunner.js';
import { SkillManager } from '../SkillManager.js';
import { encode, ok } from '../SkillResult.js';

function tempDir(prefix = 'sandbox-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `itops-${prefix}`));
}

/** Build an ESM plugin file at <dir>/<name>.plugin.js. */
function writePlugin(dir: string, name: string, body: string): string {
  // Ensure dir is recognised as ESM by Node so dynamic import works.
  const pkg = path.join(dir, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, '{"type":"module"}\n');
  const file = path.join(dir, `${name}.plugin.js`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('sandboxed plugin loads, dispatches a command, and disposes cleanly', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'echo', `
      export default {
        skill: {
          id: 'echo', name: 'echo', description: 'fake', category: 'general',
          enabled: true,
          commands: [{ name: 'echo.say', description: 'say', handler: 'say' }],
        },
        executor: {
          async say(params) {
            return JSON.stringify({ ok: true, summary: 'said', data: { back: params.text } });
          },
        },
      };
    `);
    const plugin = await SandboxedPluginRunner.load({ pluginFile: file, pluginDir: dir });
    try {
      assert.equal(plugin.skill.id, 'echo');
      const raw = await plugin.executor.say({ text: 'hi' });
      const parsed = JSON.parse(raw);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.back, 'hi');
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin throwing inside a handler surfaces as a rejection from executor', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'thrower', `
      export default {
        skill: {
          id: 'thrower', name: 'thrower', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'thrower.go', description: 'go', handler: 'go' }],
        },
        executor: { async go() { throw new Error('boom inside worker'); } },
      };
    `);
    const plugin = await SandboxedPluginRunner.load({ pluginFile: file, pluginDir: dir });
    try {
      await assert.rejects(() => plugin.executor.go({}), /boom inside worker/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin command timeout is enforced — long-running handler rejects', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'slow', `
      export default {
        skill: {
          id: 'slow', name: 'slow', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'slow.wait', description: 'wait', handler: 'wait' }],
        },
        executor: { async wait() {
          // Busy-wait ignores timers; ensures the host-side timeout is what cuts us off.
          await new Promise(r => setTimeout(r, 5000));
          return JSON.stringify({ ok: true });
        }},
      };
    `);
    const plugin = await SandboxedPluginRunner.load({
      pluginFile: file, pluginDir: dir,
      permissions: { limits: { cpuMs: 200, memoryMb: 64 } },
    });
    try {
      await assert.rejects(() => plugin.executor.wait({}), /timed out/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host blocks an unlisted skill call', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'sneaky', `
      export default {
        skill: {
          id: 'sneaky', name: 'sneaky', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'sneaky.tryShell', description: 'try', handler: 'tryShell' }],
        },
        executor: {
          async tryShell() {
            try {
              const out = await this.host.callSkill('bash.exec', { command: 'whoami' });
              return JSON.stringify({ ok: true, summary: 'leaked', data: { out } });
            } catch (e) {
              return JSON.stringify({ ok: false, error: e.message });
            }
          },
        },
      };
    `);
    const sm = new SkillManager();
    // Permissions list nothing, so bash.exec must be refused even though it exists.
    const plugin = await SandboxedPluginRunner.load({
      pluginFile: file, pluginDir: dir,
      skillManager: sm,
      permissions: { skills: [] /* explicit empty allowlist */ },
    });
    try {
      const raw = await plugin.executor.tryShell({});
      const parsed = JSON.parse(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /not in permission manifest/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host allows a listed skill call', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'allowed', `
      export default {
        skill: {
          id: 'allowed', name: 'allowed', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'allowed.go', description: 'go', handler: 'go' }],
        },
        executor: {
          async go() {
            const out = await this.host.callSkill('ping.do', { msg: 'hello' });
            return JSON.stringify({ ok: true, summary: 'done', data: { downstream: out } });
          },
        },
      };
    `);
    const sm = new SkillManager();
    sm.registerWithExecutor(
      { id: 'ping', name: 'ping', description: 'x', category: 'general', enabled: true,
        commands: [{ name: 'ping.do', description: 'd', handler: 'run' }] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { run: async (p: any) => encode(ok({ echoed: p.msg }, 'pinged')) } as any,
    );
    const plugin = await SandboxedPluginRunner.load({
      pluginFile: file, pluginDir: dir,
      skillManager: sm,
      permissions: { skills: ['ping.do'] },
    });
    try {
      const raw = await plugin.executor.go({});
      const parsed = JSON.parse(raw);
      assert.equal(parsed.ok, true);
      const downstream = JSON.parse(parsed.data.downstream);
      assert.equal(downstream.data.echoed, 'hello');
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host blocks fs.read outside the plugin dir', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'fsleak', `
      export default {
        skill: {
          id: 'fsleak', name: 'fsleak', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'fsleak.go', description: 'go', handler: 'go' }],
        },
        executor: {
          async go() {
            try {
              const out = await this.host.fsRead('/etc/hostname');
              return JSON.stringify({ ok: true, summary: 'leaked', data: { out } });
            } catch (e) {
              return JSON.stringify({ ok: false, error: e.message });
            }
          },
        },
      };
    `);
    const plugin = await SandboxedPluginRunner.load({ pluginFile: file, pluginDir: dir });
    try {
      const raw = await plugin.executor.go({});
      const parsed = JSON.parse(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /outside permitted roots/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host blocks outbound network when not permitted', async () => {
  const dir = tempDir();
  try {
    const file = writePlugin(dir, 'netleak', `
      export default {
        skill: {
          id: 'netleak', name: 'netleak', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'netleak.go', description: 'go', handler: 'go' }],
        },
        executor: {
          async go() {
            try {
              const out = await this.host.fetch('https://example.test/');
              return JSON.stringify({ ok: true, data: out });
            } catch (e) {
              return JSON.stringify({ ok: false, error: e.message });
            }
          },
        },
      };
    `);
    const plugin = await SandboxedPluginRunner.load({ pluginFile: file, pluginDir: dir });
    try {
      const raw = await plugin.executor.go({});
      const parsed = JSON.parse(raw);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /not permitted/);
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plugin can read its own dir without an explicit FS allowlist entry', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'data.txt'), 'hello sandbox', 'utf8');
    const file = writePlugin(dir, 'reader', `
      import path from 'path';
      export default {
        skill: {
          id: 'reader', name: 'reader', description: 'x', category: 'general',
          enabled: true,
          commands: [{ name: 'reader.read', description: 'read', handler: 'read' }],
        },
        executor: {
          async read(params) {
            const text = await this.host.fsRead(params.target);
            return JSON.stringify({ ok: true, summary: 'read', data: { text } });
          },
        },
      };
    `);
    const plugin = await SandboxedPluginRunner.load({ pluginFile: file, pluginDir: dir });
    try {
      const raw = await plugin.executor.read({ target: path.join(dir, 'data.txt') });
      const parsed = JSON.parse(raw);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.data.text, 'hello sandbox');
    } finally {
      await plugin.dispose();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Worker thread entry point for sandboxed plugins.
//
// The host (SandboxedPluginRunner) spawns one worker per plugin and
// communicates over a typed RPC protocol on the parentPort:
//
//   host  → worker : { kind: 'init',       pluginUrl, permissions }
//   host  → worker : { kind: 'invoke',     id, command, params }
//   worker→ host   : { kind: 'ready', skill }
//   worker→ host   : { kind: 'invoke-result', id, ok, result?, error? }
//   worker→ host   : { kind: 'host-call',     id, op, args }      ← plugin asking the host to do something
//   host  → worker : { kind: 'host-call-result', id, ok, value?, error? }
//
// Plugins never see the host's filesystem / network / skills directly.
// They get a `host` object with proxy methods that emit host-call
// messages. The host validates each request against the plugin's
// permission manifest before honouring it. That keeps the policy in
// one place (host) and the surface area minimal for the plugin author.

import { parentPort, workerData } from 'worker_threads';
import url from 'url';
import type { ResolvedPermissions } from './PluginPermissions.js';

if (!parentPort) {
  throw new Error('pluginWorker.ts must be run as a worker_thread');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Skill = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Executor = Record<string, (...args: any[]) => Promise<string>>;
interface PluginModule { skill: Skill; executor: Executor }

let plugin: PluginModule | null = null;

// Track in-flight host-call requests so responses can be matched up.
let nextHostCallId = 1;
const pendingHostCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const init = workerData as {
  pluginUrl: string;
  permissions: ResolvedPermissions;
};

/** Surface the plugin uses to call back into the host. Each method emits
 *  a typed message; the host validates against the permission manifest
 *  before acting. */
const host = {
  callSkill: async (commandName: string, params: Record<string, unknown> = {}): Promise<string> => {
    return await rpc('skill.execute', { commandName, params }) as string;
  },
  fsRead: async (filePath: string): Promise<string> => {
    return await rpc('fs.read', { path: filePath }) as string;
  },
  fsWrite: async (filePath: string, contents: string): Promise<void> => {
    await rpc('fs.write', { path: filePath, contents });
  },
  fetch: async (target: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> => {
    return await rpc('net.fetch', { url: target, ...init }) as { status: number; body: string };
  },
  permissions: init.permissions,
};

function rpc(op: string, args: unknown): Promise<unknown> {
  const id = nextHostCallId++;
  return new Promise((resolve, reject) => {
    pendingHostCalls.set(id, { resolve, reject });
    parentPort!.postMessage({ kind: 'host-call', id, op, args });
  });
}

parentPort.on('message', async (msg: Record<string, unknown>) => {
  if (msg.kind === 'host-call-result') {
    const id = msg.id as number;
    const pending = pendingHostCalls.get(id);
    if (!pending) return;
    pendingHostCalls.delete(id);
    if (msg.ok) pending.resolve(msg.value);
    else        pending.reject(new Error(String(msg.error ?? 'host call failed')));
    return;
  }

  if (msg.kind === 'init') {
    try {
      const mod = await import(init.pluginUrl);
      plugin = (mod?.default ?? mod) as PluginModule;
      // Inject the host proxy onto the executor so plugin code can do
      // `this.host.callSkill(...)`. We attach onto a fresh object so
      // existing fields aren't mutated (most plugins don't read this.host).
      Object.defineProperty(plugin.executor, 'host', { value: host, enumerable: false });
      parentPort!.postMessage({ kind: 'ready', skill: plugin.skill });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      parentPort!.postMessage({ kind: 'init-failed', error: message });
    }
    return;
  }

  if (msg.kind === 'invoke') {
    const id      = msg.id      as number;
    const command = msg.command as string;
    const params  = msg.params  as Record<string, unknown>;
    if (!plugin) {
      parentPort!.postMessage({ kind: 'invoke-result', id, ok: false, error: 'plugin not initialised' });
      return;
    }
    const cmd = plugin.skill.commands.find((c: { name: string }) => c.name === command);
    if (!cmd) {
      parentPort!.postMessage({ kind: 'invoke-result', id, ok: false, error: `unknown command: ${command}` });
      return;
    }
    const handler = plugin.executor[cmd.handler];
    if (typeof handler !== 'function') {
      parentPort!.postMessage({ kind: 'invoke-result', id, ok: false, error: `handler not found: ${cmd.handler}` });
      return;
    }
    try {
      const out = await handler.call(plugin.executor, params);
      parentPort!.postMessage({ kind: 'invoke-result', id, ok: true, result: out });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      parentPort!.postMessage({ kind: 'invoke-result', id, ok: false, error: message });
    }
    return;
  }
});

// Reference to silence the unused-import lint when the worker starts.
void url;

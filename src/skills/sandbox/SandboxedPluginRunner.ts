// Host-side harness around a single sandboxed plugin worker.
//
// One instance per plugin. Manages the worker's lifecycle:
//   - Spawns the worker with resourceLimits (heap, stack).
//   - Waits for the worker's `ready` message before reporting load
//     success.
//   - Implements the host-side of the host-call protocol from
//     pluginWorker.ts: validates each request against the plugin's
//     ResolvedPermissions, calls the host service, and sends the result
//     back.
//   - Provides an `executor`-shaped object so the runner can be plugged
//     directly into SkillManager.registerWithExecutor() — the rest of
//     SkillManager doesn't know or care that the work happens in a
//     worker thread.
//
// Default-deny: if the manifest doesn't permit it, the host rejects.
// Defence in depth: even though the worker proxies through the host
// for FS/network/skill access, we don't trust the worker to do its
// own checks — the host validates every request anyway.

import fs from 'fs';
import path from 'path';
import url from 'url';
import { Worker } from 'worker_threads';
import { createLogger } from '../../observability/Logger.js';
import type { SkillManager } from '../SkillManager.js';
import type { PluginPermissions, ResolvedPermissions } from './PluginPermissions.js';
import { resolvePermissions } from './PluginPermissions.js';

const log = createLogger({ component: 'plugin-sandbox' });

// Resolve worker entrypoint relative to this file. After build it lives
// in dist/skills/sandbox/pluginWorker.js, alongside this module.
function resolveWorkerEntry(): string {
  const here = url.fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), 'pluginWorker.js');
}

export interface SandboxedPluginOptions {
  pluginFile: string;
  pluginDir: string;        // root the plugin must stay within for FS reads
  permissions?: PluginPermissions;
  /** Required for the skills permission. Without it, callSkill is
   *  rejected even if listed in the manifest. */
  skillManager?: SkillManager;
  /** Wall-clock invocation timeout. Falls back to permissions.limits.cpuMs. */
  invocationTimeoutMs?: number;
}

export interface LoadedSandboxedPlugin {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skill: any;
  /** Executor object the SkillManager uses for dispatch. Each command
   *  name forwards to the worker via the invoke RPC. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: Record<string, (...args: any[]) => Promise<string>>;
  /** Stop the worker and release its resources. */
  dispose(): Promise<void>;
  /** Snapshot of the resolved permission set, for diagnostics. */
  permissions: ResolvedPermissions;
}

interface PendingInvocation {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export class SandboxedPluginRunner {
  /** Spawn a worker for the given plugin and resolve once it's ready. */
  static async load(opts: SandboxedPluginOptions): Promise<LoadedSandboxedPlugin> {
    const permissions = resolvePermissions(opts.permissions);
    const workerEntry = resolveWorkerEntry();

    const worker = new Worker(workerEntry, {
      workerData: {
        pluginUrl: url.pathToFileURL(opts.pluginFile).href,
        permissions,
      },
      // Keep the heap modest. Stack stays at default — most plugins
      // don't recurse deeply, and a tiny stack misfires legitimate code.
      resourceLimits: {
        maxOldGenerationSizeMb: permissions.limits.memoryMb,
        maxYoungGenerationSizeMb: Math.max(8, Math.floor(permissions.limits.memoryMb / 8)),
      },
    });

    let nextInvocationId = 1;
    const pending = new Map<number, PendingInvocation>();
    let crashed = false;

    worker.on('error', (err) => {
      crashed = true;
      log.error('plugin worker errored', { plugin: opts.pluginFile, err: err.message });
      for (const p of pending.values()) {
        clearTimeout(p.timeout);
        p.reject(new Error(`plugin worker crashed: ${err.message}`));
      }
      pending.clear();
    });
    worker.on('exit', (code) => {
      if (code !== 0) {
        crashed = true;
        for (const p of pending.values()) {
          clearTimeout(p.timeout);
          p.reject(new Error(`plugin worker exited with code ${code}`));
        }
        pending.clear();
      }
    });

    // Wait for `ready` (or `init-failed`) before resolving.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ready = await new Promise<{ skill: any }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('plugin init timed out')), 10_000);
      worker.on('message', (msg: Record<string, unknown>) => {
        if (msg.kind === 'ready') {
          clearTimeout(timer);
          resolve({ skill: msg.skill });
        } else if (msg.kind === 'init-failed') {
          clearTimeout(timer);
          reject(new Error(String(msg.error ?? 'plugin init failed')));
        }
      });
      worker.postMessage({ kind: 'init' });
    });

    // Wire host-call handling now that the worker is alive.
    worker.on('message', async (msg: Record<string, unknown>) => {
      if (msg.kind === 'invoke-result') {
        const id = msg.id as number;
        const p = pending.get(id);
        if (!p) return;
        clearTimeout(p.timeout);
        pending.delete(id);
        if (msg.ok) p.resolve(String(msg.result ?? ''));
        else        p.reject(new Error(String(msg.error ?? 'invocation failed')));
        return;
      }
      if (msg.kind === 'host-call') {
        const id  = msg.id  as number;
        const op  = msg.op  as string;
        const args = msg.args as Record<string, unknown>;
        try {
          const value = await handleHostCall(op, args, opts, permissions);
          worker.postMessage({ kind: 'host-call-result', id, ok: true, value });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          worker.postMessage({ kind: 'host-call-result', id, ok: false, error: message });
        }
      }
    });

    // Build executor — one method per plugin command, each sends an
    // invoke RPC and waits.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executor: Record<string, (...args: any[]) => Promise<string>> = {};
    for (const cmd of (ready.skill?.commands ?? [])) {
      executor[cmd.handler] = async (params: Record<string, unknown> = {}) => {
        if (crashed) throw new Error('plugin worker is no longer alive');
        const id = nextInvocationId++;
        const timeoutMs = opts.invocationTimeoutMs ?? permissions.limits.cpuMs;
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`plugin command "${cmd.name}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timeout });
          worker.postMessage({ kind: 'invoke', id, command: cmd.name, params });
        });
      };
    }

    return {
      skill: ready.skill,
      executor,
      permissions,
      async dispose() {
        try { await worker.terminate(); }
        catch { /* worker may already be dead */ }
      },
    };
  }
}

async function handleHostCall(
  op: string,
  args: Record<string, unknown>,
  opts: SandboxedPluginOptions,
  permissions: ResolvedPermissions,
): Promise<unknown> {
  switch (op) {
    case 'skill.execute': {
      const command = String(args.commandName ?? '');
      const params  = (args.params as Record<string, unknown> | undefined) ?? {};
      if (!opts.skillManager) {
        throw new Error('host has no skill manager wired');
      }
      // Default-deny: the manifest must list either the dotted command or
      // the skill prefix (e.g. "monitor.*" matches "monitor.systemHealth").
      const allowed = permissions.skills.some(s =>
        s === command || (s.endsWith('.*') && command.startsWith(s.slice(0, -1))),
      );
      if (!allowed) throw new Error(`skill "${command}" not in permission manifest`);
      return opts.skillManager.execute(command, params);
    }
    case 'fs.read': {
      const target = String(args.path ?? '');
      assertPathAllowed(target, [opts.pluginDir, ...permissions.filesystem.read]);
      return fs.promises.readFile(target, 'utf8');
    }
    case 'fs.write': {
      const target = String(args.path ?? '');
      const contents = String(args.contents ?? '');
      // Writes must be in the explicit write allowlist OR the plugin's own
      // dir if that dir is also listed under write.
      assertPathAllowed(target, permissions.filesystem.write);
      await fs.promises.writeFile(target, contents, 'utf8');
      return null;
    }
    case 'net.fetch': {
      if (!permissions.network.outbound) throw new Error('network.outbound not permitted');
      const target = String(args.url ?? '');
      const u = new URL(target);
      const hosts = permissions.network.allowedHosts;
      if (hosts.length > 0 && !hosts.includes(u.hostname)) {
        throw new Error(`host "${u.hostname}" not in network.allowedHosts`);
      }
      const res = await fetch(target, {
        method:  (args.method  as string | undefined) ?? 'GET',
        headers: (args.headers as Record<string, string> | undefined),
        body:    (args.body    as string | undefined),
      });
      const body = await res.text();
      return { status: res.status, body };
    }
    default:
      throw new Error(`unknown host op "${op}"`);
  }
}

function assertPathAllowed(target: string, roots: string[]): void {
  const abs = path.resolve(target);
  const ok  = roots.some(root => {
    const rootAbs = path.resolve(root);
    const rel = path.relative(rootAbs, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) throw new Error(`path "${target}" outside permitted roots`);
}

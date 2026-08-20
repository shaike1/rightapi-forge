// RemoteExecutor — unified command-execution surface for monitored servers.
//
// SystemMonitors used to call execFile('nsenter', …) directly, which
// implicitly meant "run this on the host where the container lives".
// The executor abstracts that decision:
//
//   - For a server with isLocal=true, run via `nsenter --target 1 …`
//     (uses CAP_SYS_ADMIN + pid:host the compose file already grants).
//   - For a remote server, build an `ssh -o … user@host -- cmd` invocation
//     with the algorithm flags pinned per the task spec, plus any
//     per-server overrides from ServerRegistry.sshOptions.
//
// Two entry points:
//
//   execute(server, command, opts?)
//       Treats `command` as a shell string. Uses /bin/sh -lc on the
//       target so pipelines/redirects work. Required for things like
//       `cat /proc/meminfo | awk …`.
//
//   executeFile(server, file, args, opts?)
//       argv form, no shell. Preferred whenever the caller can avoid
//       a shell — keeps the caller's parameters from being parsed by
//       sh. Used for `docker inspect …`, `systemctl is-active …`.
//
// Both return { stdout, stderr, exitCode } and never throw on a non-zero
// exit. The promise rejects only when the command can't be spawned at
// all (binary missing) or the wall-clock timeout fires.

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import type { MonitoredServer } from './ServerRegistry.js';

const execFile = promisify(execFileCb);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /** Wall-clock cap in ms. Default 30s — matches the spec. */
  timeoutMs?: number;
  /** Hard cap on captured stdout/stderr; default 4MB. */
  maxBufferBytes?: number;
}

/** nsenter prefix into PID 1's namespaces — same set the rest of the
 *  codebase uses (compose grants pid:host + CAP_SYS_ADMIN). */
const NSENTER_ARGS = ['--target', '1', '-m', '-u', '-i', '-n', '-p'];

/** SSH `-o` flags every remote invocation gets. Per-server overrides in
 *  `MonitoredServer.sshOptions` are merged in on top, so a host whose
 *  algorithm set doesn't include ssh-ed25519 can override HostKeyAlgorithms. */
const DEFAULT_SSH_OPTIONS: Record<string, string> = {
  KexAlgorithms: 'curve25519-sha256',
  HostKeyAlgorithms: 'ssh-ed25519',
  ConnectTimeout: '10',
  StrictHostKeyChecking: 'accept-new',
  // BatchMode keeps ssh from prompting interactively when key auth
  // fails — we don't have a TTY and we don't want to hang for 30s.
  BatchMode: 'yes',
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BUFFER_BYTES = 4 * 1024 * 1024;

export interface RemoteExecutorDeps {
  /** Optional hook fired after every executed command. Used by server.ts
   *  to stamp `last_seen` / `last_check_status` on the registry. */
  onResult?: (server: MonitoredServer, ok: boolean) => void;
}

export class RemoteExecutor {
  constructor(private readonly deps: RemoteExecutorDeps = {}) {}

  /** Shell-string form. Wraps the command in `sh -lc` on the target so
   *  pipelines/redirects work. Caller does NOT need to escape — we pass
   *  it as a single argv element to ssh/nsenter, both of which forward
   *  it untouched to the remote sh. */
  async execute(server: MonitoredServer, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (server.isLocal) {
      return this.runArgv('nsenter', [...NSENTER_ARGS, 'sh', '-lc', command], opts, server);
    }
    const { sshArgs } = this.sshInvocation(server);
    sshArgs.push(server.sshUser ? `${server.sshUser}@${server.host}` : String(server.host));
    sshArgs.push('--', command);
    return this.runArgv('ssh', sshArgs, opts, server);
  }

  /** argv form — preferred when no shell expansion is needed. */
  async executeFile(
    server: MonitoredServer,
    file: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    if (server.isLocal) {
      return this.runArgv('nsenter', [...NSENTER_ARGS, file, ...args], opts, server);
    }
    const { sshArgs } = this.sshInvocation(server);
    sshArgs.push(server.sshUser ? `${server.sshUser}@${server.host}` : String(server.host));
    sshArgs.push('--', file, ...args);
    return this.runArgv('ssh', sshArgs, opts, server);
  }

  /** Lightweight connectivity test — used by POST /api/servers/:id/test
   *  and as the seed for `lastSeen` on first contact. Returns ok=true
   *  only when the remote shell echoed our token. */
  async testConnectivity(server: MonitoredServer): Promise<{ ok: boolean; detail: string; durationMs: number }> {
    const token = `beacon-probe-${Date.now()}`;
    const started = Date.now();
    try {
      const r = await this.execute(server, `echo ${token}`, { timeoutMs: 12_000 });
      const durationMs = Date.now() - started;
      const ok = r.exitCode === 0 && r.stdout.trim() === token;
      const detail = ok
        ? `echo round-trip ${durationMs}ms`
        : `unexpected output (exit=${r.exitCode}): stdout="${r.stdout.slice(0, 200).trim()}" stderr="${r.stderr.slice(0, 200).trim()}"`;
      return { ok, detail, durationMs };
    } catch (e: any) {
      return {
        ok: false,
        detail: `${e?.code ?? 'error'}: ${e?.message ?? String(e)}`,
        durationMs: Date.now() - started,
      };
    }
  }

  // ── Internal ───────────────────────────────────────────────────────

  private sshInvocation(server: MonitoredServer): { sshArgs: string[] } {
    const merged: Record<string, string> = { ...DEFAULT_SSH_OPTIONS, ...(server.sshOptions || {}) };
    const sshArgs: string[] = [];
    for (const [k, v] of Object.entries(merged)) {
      sshArgs.push('-o', `${k}=${v}`);
    }
    if (typeof server.sshPort === 'number' && server.sshPort !== 22) {
      sshArgs.push('-p', String(server.sshPort));
    }
    if (server.sshKeyPath) {
      sshArgs.push('-i', server.sshKeyPath);
    }
    // -n keeps stdin closed so a passphrase-protected key can't make the
    // process hang waiting for an interactive prompt that no one will type.
    sshArgs.push('-n');
    return { sshArgs };
  }

  private async runArgv(
    file: string,
    args: string[],
    opts: ExecOptions,
    server: MonitoredServer,
  ): Promise<ExecResult> {
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = opts.maxBufferBytes ?? DEFAULT_BUFFER_BYTES;
    try {
      const r = await execFile(file, args, { timeout, maxBuffer });
      // Node's execFile resolves only when exit=0; the catch branch is
      // where non-zero exits land.
      const res: ExecResult = {
        stdout: r.stdout?.toString() ?? '',
        stderr: r.stderr?.toString() ?? '',
        exitCode: 0,
      };
      this.deps.onResult?.(server, true);
      return res;
    } catch (e: any) {
      // Distinguish "exited non-zero" (we want the captured output) from
      // "couldn't spawn" / "timed out" (real failure, surface to caller).
      const hasExitCode = typeof e?.code === 'number';
      if (hasExitCode) {
        const res: ExecResult = {
          stdout: e.stdout?.toString() ?? '',
          stderr: e.stderr?.toString() ?? '',
          exitCode: e.code,
        };
        // Non-zero exit can still mean the host is reachable (e.g.
        // `systemctl is-active foo` returns 3 when inactive). Treat
        // any captured stdout as "we got bytes back" = host reachable.
        this.deps.onResult?.(server, res.stdout.length > 0 || res.stderr.length > 0);
        return res;
      }
      // ETIMEDOUT / ENOENT / signal-killed — bubble up after stamping.
      this.deps.onResult?.(server, false);
      logger.debug('[RemoteExecutor] exec failed', {
        serverId: server.id,
        file,
        argsLen: args.length,
        err: e?.message ?? String(e),
        code: e?.code ?? null,
      });
      throw e;
    }
  }
}

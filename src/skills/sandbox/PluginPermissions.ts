// Permission manifest for sandboxed plugins.
//
// A sandboxed plugin must declare what it needs up front. The runner
// rejects requests at runtime that fall outside the declared envelope
// — the host has the final word, not the plugin code. This is
// important because the manifest also feeds operator-facing prompts:
// when a plugin file is added, the loader logs the manifest so an
// admin can see what surface area the plugin demands before it goes
// live.
//
// What the sandbox actually enforces (out-of-scope items are a soft
// declaration only):
//   - filesystem.read / filesystem.write paths    — enforced by an FS
//                                                  proxy + the worker's
//                                                  resourceLimits and
//                                                  by validating any
//                                                  request the plugin
//                                                  sends back to the
//                                                  host.
//   - network.outbound      — enforced by the host: when false,
//                             fetch() requests from the plugin worker
//                             return an error.
//   - cpuMs / memoryMb      — enforced by Worker resourceLimits +
//                             a host-side wall-clock timeout.
//   - skills                — list of skill IDs the plugin may invoke
//                             via its `host.callSkill()` proxy. The
//                             runner refuses any other call.
//
// Default-deny is the rule: an unspecified field means "no access".

export interface PluginPermissions {
  /** Plugin must run in a worker thread, not in-process. Default true.
   *  Set false to opt out (e.g. trusted first-party plugins) — the
   *  loader respects this only when the plugin file lives outside the
   *  external plugin directory. */
  sandbox?: boolean;

  /** Filesystem access. Plugins by default only see their own plugin
   *  directory — both fields here grant additional paths. */
  filesystem?: {
    /** Absolute paths the plugin may read. Empty/undefined = none. */
    read?: string[];
    /** Absolute paths the plugin may write. Empty/undefined = none. */
    write?: string[];
  };

  /** Outbound network. Default false. When true, fetch() inside the
   *  plugin works; when false, the host blocks all outbound. */
  network?: {
    outbound?: boolean;
    /** Optional allowlist of hostnames the plugin may reach. Empty +
     *  outbound:true means "any host"; non-empty restricts. */
    allowedHosts?: string[];
  };

  /** Skills the plugin may invoke through host.callSkill(). The host
   *  enforces this — the plugin can't bypass it by encoding the skill
   *  name dynamically; the call is validated against this list. */
  skills?: string[];

  /** Resource limits passed to the Worker. */
  limits?: {
    /** Soft cap on heap (MB). Default 128. */
    memoryMb?: number;
    /** Wall-clock timeout per command invocation (ms). Default 10000. */
    cpuMs?: number;
  };
}

/** Fully-resolved permissions — every field defaulted, no undefined.
 *  The runner uses this internally; the manifest type above is what
 *  plugin authors hand-write. */
export interface ResolvedPermissions {
  sandbox: boolean;
  filesystem: { read: string[]; write: string[] };
  network: { outbound: boolean; allowedHosts: string[] };
  skills: string[];
  limits: { memoryMb: number; cpuMs: number };
}

export function resolvePermissions(p?: PluginPermissions): ResolvedPermissions {
  return {
    sandbox: p?.sandbox ?? true,
    filesystem: {
      read:  p?.filesystem?.read  ?? [],
      write: p?.filesystem?.write ?? [],
    },
    network: {
      outbound:     p?.network?.outbound     ?? false,
      allowedHosts: p?.network?.allowedHosts ?? [],
    },
    skills: p?.skills ?? [],
    limits: {
      memoryMb: clamp(p?.limits?.memoryMb ?? 128, 16, 4096),
      cpuMs:    clamp(p?.limits?.cpuMs    ?? 10_000, 100, 600_000),
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

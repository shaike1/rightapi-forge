// Auto-remediation for newly opened incidents.
//
// Wires into the `onCreated` hook on IncidentManager. When an incident
// matches one of a small allow-list of safe patterns, this module
// executes a pre-baked remediation recipe, records each action as a
// note in the incident timeline, and transitions the incident to
// `mitigating` so the next health-check pass can confirm the fix
// (we never auto-resolve — that's the operator's call after the fix
// holds).
//
// Execution scope:
//   - `mode: 'shell'` / `'argv'` run inside the agent container. Used
//     for everything that talks to the Docker socket (the socket is
//     bind-mounted, so prune-style commands work directly).
//   - `mode: 'host-shell'` runs on the **host**, via nsenter into PID 1's
//     namespaces. Required for commands that don't exist or are
//     meaningless inside the container (journalctl, find /var/log).
//     The compose file gives the container `pid: host` + CAP_SYS_ADMIN
//     so this works without privileged mode.
//
// Safety boundaries:
//   - One attempt per incident id (in-memory Set, reset on restart).
//     Restarted servers re-evaluate fresh because dedup on the
//     IncidentManager side suppresses duplicate creates anyway.
//   - Commands are pre-baked literals or argv arrays — no caller data
//     is interpolated into a shell string. Container names are matched
//     against a strict regex before any docker invocation.
//   - No volume deletion (`--volumes=false` is hard-coded), no config
//     edits, no commands outside the docker / log-cleanup scope.
//   - Each action carries its own timeout (default 120s). Image and
//     builder prune get 300s since they routinely exceed 2 minutes
//     when there are tens of GBs to reclaim.
//   - Before every action we re-fetch the incident; if an operator has
//     resolved/closed it in the meantime we abort the remaining steps.

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { Incident } from '../persistence/SqliteStore.js';
import { createLogger } from '../observability/Logger.js';
import { serviceFromIncident } from '../incidents/IncidentVerifier.js';
import { serviceCandidates } from '../monitoring/ServiceAliases.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const log = createLogger({ component: 'auto-remediator' });

/** Docker container names: alnum start, then alnum/_/-/. — same set
 *  Docker itself enforces. Anything else is rejected before we run. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** Default per-action timeout. Pruning + journal vacuum both occasionally
 *  take >30s on a busy host; 120s leaves slack without letting a runaway
 *  command stall the pipeline indefinitely. */
const DEFAULT_ACTION_TIMEOUT_MS = 120_000;

/** Used for image/builder prune which can legitimately take minutes
 *  when there are tens of GBs of layers to reclaim. */
const LONG_ACTION_TIMEOUT_MS = 300_000;

/** Statuses where the incident is already done — auto-remediation
 *  should bail out instead of stomping on operator decisions. */
const TERMINAL_STATUSES = new Set(['resolved', 'closed']);

export type RemediationKind =
  | 'disk-cleanup'
  | 'docker-housekeeping'
  | 'container-restart'
  | 'service-restart';

export interface RemediationActionResult {
  command: string;
  status: 'success' | 'failed' | 'skipped';
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
}

export interface RemediationOutcome {
  incidentId: string;
  kind: RemediationKind;
  actions: RemediationActionResult[];
  startedAt: string;
  finishedAt: string;
  abortedReason?: string;
}

export interface AutoRemediatorOptions {
  /** Master switch. Defaults to AUTO_REMEDIATION_ENABLED env (true if
   *  unset). Operators can flip this off without redeploying by
   *  setting AUTO_REMEDIATION_ENABLED=false. */
  enabled?: boolean;
  /** Optional WS broadcaster. Lets the UI react in real time when a
   *  remediation kicks off / completes. Omitted in tests. */
  broadcast?: (msg: unknown) => void;
  /** Only structured service incidents whose service is in this set may
   *  trigger a restart. Defaults to AUTO_REMEDIATION_SERVICE_ALLOWLIST. */
  serviceAllowlist?: string[];
  getServerRegistry?: () => Pick<ServerRegistry, 'get'> | undefined;
  getRemoteExecutor?: () => Pick<RemoteExecutor, 'executeFile'> | undefined;
}

type RemediationActionSpec =
  | { mode: 'shell'; command: string; timeoutMs?: number }              // pre-baked literal, container scope
  | { mode: 'argv'; file: string; args: string[]; timeoutMs?: number }  // execFile, no shell, container scope
  | { mode: 'host-shell'; command: string; timeoutMs?: number }         // wrapped in nsenter, host scope
  | { mode: 'remote-service-restart'; serverId: string; candidates: string[]; timeoutMs?: number };

interface RemediationPlan {
  kind: RemediationKind;
  actions: RemediationActionSpec[];
}

/** Argv prefix for nsenter into the host's namespaces. Requires `pid: host`
 *  and CAP_SYS_ADMIN on the container (set in docker-compose.yml). */
const NSENTER_ARGV = ['nsenter', '--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--'];

export class IncidentAutoRemediator {
  private readonly enabled: boolean;
  private readonly broadcast?: (msg: unknown) => void;
  private readonly serviceAllowlist: ReadonlySet<string>;
  private readonly getServerRegistry?: AutoRemediatorOptions['getServerRegistry'];
  private readonly getRemoteExecutor?: AutoRemediatorOptions['getRemoteExecutor'];
  /** Incident ids we've already attempted in this process. One try per
   *  incident — if it fails, an operator looks at the timeline. */
  private readonly attempted = new Set<string>();

  constructor(
    private readonly incidentManager: IncidentManager,
    opts: AutoRemediatorOptions = {}
  ) {
    const envFlag = (process.env.AUTO_REMEDIATION_ENABLED ?? 'true').toLowerCase();
    this.enabled = opts.enabled ?? (envFlag !== 'false' && envFlag !== '0');
    this.broadcast = opts.broadcast;
    const configuredServices = opts.serviceAllowlist ?? (process.env.AUTO_REMEDIATION_SERVICE_ALLOWLIST || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    this.serviceAllowlist = new Set(configuredServices.map(value => value.toLowerCase()));
    this.getServerRegistry = opts.getServerRegistry;
    this.getRemoteExecutor = opts.getRemoteExecutor;
  }

  /** Entry point — called from IncidentManager's onCreated hook.
   *  Synchronous shape (returns void), but kicks off the actual work
   *  on the next tick so it can't block the create response. */
  handle(incident: Incident): void {
    // Fire-and-forget — onCreated callers shouldn't pay for shell time.
    void this.remediate(incident).catch(err => {
      log.error('[AutoRemediator] execute() threw unexpectedly', {
        incidentId: incident.id,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    });
  }

  /** Execute a matching plan and return its evidence. Agent fallbacks use
   *  this awaited form so they can verify the result before resolving. */
  async remediate(incident: Incident): Promise<RemediationOutcome | null> {
    if (!this.enabled || this.attempted.has(incident.id)) return null;
    const plan = this.matchPlan(incident);
    if (!plan) return null;
    this.attempted.add(incident.id);
    return this.execute(incident, plan);
  }

  /** Map an incident to a remediation plan, or return null if nothing
   *  in the allow-list applies. Pure / testable. */
  matchPlan(incident: Incident): RemediationPlan | null {
    const title = (incident.title || '').toLowerCase();
    const desc = (incident.description || '').toLowerCase();
    const sourceRef = (incident.sourceRef || '').toLowerCase();

    // ── Remote systemd service restart ───────────────────────────────
    // Both target and service must come from persisted structured fields.
    // Free-text incidents and services outside the operator allowlist are
    // deliberately ineligible for this action.
    const service = serviceFromIncident(incident);
    const hasStructuredServiceRef = /(?:^|:)service:failed:[a-z0-9_.@-]+(?::|$)/i.test(sourceRef);
    if (service && hasStructuredServiceRef && incident.serverId && this.serviceAllowlist.has(service.toLowerCase())) {
      return {
        kind: 'service-restart',
        actions: [{
          mode: 'remote-service-restart',
          serverId: incident.serverId,
          candidates: serviceCandidates(service),
          timeoutMs: 30_000,
        }],
      };
    }

    // ── Container restart ────────────────────────────────────────────
    // Only fires when sourceRef carries a parseable container name —
    // we refuse to scrape names from free-text titles, since a
    // hallucinated/typo name could land us restarting the wrong thing.
    const containerName = this.extractContainerName(incident);
    if (
      containerName &&
      (/(crashed|unhealthy|restart\s*loop|exited)/i.test(`${title} ${desc}`))
    ) {
      return {
        kind: 'container-restart',
        actions: [
          { mode: 'argv', file: 'docker', args: ['restart', containerName] },
        ],
      };
    }

    // ── Disk cleanup (most common health-monitor incident) ──────────
    // Catches both the production alert-rule shape ("High Disk Usage on
    // <host>" with sourceRef="seed-disk-warning") and structured
    // health-monitor incidents ("disk:/data" / "Disk Critical: /data").
    //
    // Recipe layered safest-first:
    //   1. container prune — reclaims stopped containers (fast, harmless)
    //   2. image prune     — dangling images only (no -a → tagged stay)
    //   3. builder prune   — keep 2 GB of cache; the rest is rebuildable
    //   4. find /var/log   — host-side: rotate compressed log archives
    //                        older than 7 days
    //   5. journalctl      — host-side: cap journal to 3 days
    //
    // Steps 4–5 run via nsenter. None of these touch volumes or app data.
    if (this.isDiskAlert(incident, { title, sourceRef })) {
      return {
        kind: 'disk-cleanup',
        actions: [
          // Container scope (Docker socket access).
          { mode: 'argv', file: 'docker', args: ['container', 'prune', '-f'] },
          { mode: 'argv', file: 'docker', args: ['image', 'prune', '-f'], timeoutMs: LONG_ACTION_TIMEOUT_MS },
          { mode: 'argv', file: 'docker', args: ['builder', 'prune', '-f', '--keep-storage=2GB'], timeoutMs: LONG_ACTION_TIMEOUT_MS },
          // Host scope — these binaries / paths only make sense on the host.
          { mode: 'host-shell', command: "find /var/log -type f -name '*.gz' -mtime +7 -delete" },
          { mode: 'host-shell', command: 'journalctl --vacuum-time=3d' },
        ],
      };
    }

    // ── Docker housekeeping (more aggressive prune, still safe) ─────
    // Split into per-resource commands so a partial failure (e.g. an
    // image with a stuck layer ref) doesn't void the rest, and the
    // timeline shows precisely which bucket reclaimed how much. The
    // image step carries `-a` to clear tagged-but-unused layers too —
    // that's the difference vs. disk-cleanup. No `--volumes` flag
    // anywhere in the recipe; user data is never pruned.
    const isDockerHousekeeping =
      sourceRef.startsWith('docker:') ||
      /docker\s*(housekeeping|disk|image|prune|cleanup)/i.test(incident.title);
    if (isDockerHousekeeping) {
      return {
        kind: 'docker-housekeeping',
        actions: [
          { mode: 'argv', file: 'docker', args: ['container', 'prune', '-f'] },
          { mode: 'argv', file: 'docker', args: ['image', 'prune', '-a', '-f'], timeoutMs: LONG_ACTION_TIMEOUT_MS },
          { mode: 'argv', file: 'docker', args: ['network', 'prune', '-f'] },
          { mode: 'argv', file: 'docker', args: ['builder', 'prune', '-f', '--keep-storage=2GB'], timeoutMs: LONG_ACTION_TIMEOUT_MS },
        ],
      };
    }

    return null;
  }

  /** Decide whether an incident is a real disk-pressure alert.
   *
   *  Real alerts come in three shapes:
   *    1. health-monitor → title "Disk Critical: /data at 92%",
   *       sourceRef "disk:/data".
   *    2. AlertRulesEngine → title "High Disk Usage on server.example.internal",
   *       sourceRef = rule id (typically contains "disk", e.g.
   *       "seed-disk-warning" / "rule-disk-prod-1234").
   *    3. Future structured refs from external monitors, e.g.
   *       "health:disk:/" — handled via the `:disk:` substring check.
   *
   *  The earlier matcher used `title.includes('disk')` which over-
   *  matched titles like "Container disk1 crashed" or "Failed disk
   *  backup task" and triggered docker prune for unrelated incidents.
   *  This version requires a word-boundary disk-noun *paired with* a
   *  pressure qualifier in title-only matches, while still trusting
   *  structured sourceRefs verbatim. */
  private isDiskAlert(
    incident: Incident,
    cooked: { title: string; sourceRef: string },
  ): boolean {
    const { sourceRef } = cooked;

    // Structured sourceRefs we trust on their own.
    if (sourceRef.startsWith('disk:')) return true;
    if (sourceRef.startsWith('seed-disk')) return true; // seeded alert-rule id
    if (sourceRef.includes(':disk:')) return true;       // health:disk:/, etc.
    // AlertRulesEngine rule ids that contain disk as a whole token,
    // e.g. "rule-disk-prod-1234". Word boundaries avoid matching
    // "diskette" etc.
    if (/\bdisk\b/i.test(sourceRef)) return true;

    // Title/description path: require both a disk-noun and a pressure
    // qualifier. Word boundaries on the disk-noun reject "disk1",
    // "diskette", "Disney"; the qualifier set covers every reasonable
    // alert phrasing without matching unrelated container/task issues.
    const haystack = `${incident.title || ''} ${incident.description || ''}`;
    const hasDiskNoun = /\b(disk|filesystem|storage|partition|volume)\b/i.test(haystack);
    if (!hasDiskNoun) return false;
    const hasPressureQualifier =
      /\b(usage|critical|full|space|pressure|alert|warning|threshold|almost|nearing|exhausted|out\s+of)\b/i.test(haystack) ||
      /\b(high|low|critical)\s+(disk|filesystem|storage)\b/i.test(haystack) ||
      /\b\d{2,3}\s*%/.test(haystack); // "92%" / "100 %"
    return hasPressureQualifier;
  }

  /** Run the plan, log every step into the incident timeline, and
   *  push the incident into `mitigating` once we're done (or have
   *  bailed). Never throws — failures get recorded and we move on. */
  private async execute(incident: Incident, plan: RemediationPlan): Promise<RemediationOutcome> {
    const startedAt = new Date().toISOString();
    const results: RemediationActionResult[] = [];
    let abortedReason: string | undefined;

    log.info('[AutoRemediator] starting', {
      incidentId: incident.id,
      kind: plan.kind,
      actionCount: plan.actions.length,
    });

    this.note(
      incident.id,
      `Auto-remediation started — ${plan.kind} (${plan.actions.length} action${plan.actions.length === 1 ? '' : 's'})`
    );
    this.broadcast?.({
      type: 'incident_remediation_started',
      data: { incidentId: incident.id, kind: plan.kind },
    });

    for (const action of plan.actions) {
      // Race guard: re-fetch the incident before each action. If an
      // operator (or another remediator) has resolved/closed it while
      // we were running, abort the remaining steps so we don't reopen
      // status=mitigating on top of their decision.
      const live = this.incidentManager.get(incident.id);
      if (!live) {
        abortedReason = 'incident no longer exists';
        log.warn('[AutoRemediator] aborting — incident gone', { incidentId: incident.id });
        break;
      }
      if (TERMINAL_STATUSES.has(live.status)) {
        abortedReason = `incident already ${live.status}`;
        this.note(
          incident.id,
          `Auto-remediation aborted — incident is ${live.status}; remaining ${plan.actions.length - results.length} action(s) skipped.`
        );
        log.info('[AutoRemediator] aborting — terminal status', {
          incidentId: incident.id,
          status: live.status,
        });
        break;
      }

      const result = await this.runAction(action);
      results.push(result);

      const summary =
        result.status === 'success'
          ? `Auto-remediation step OK (${result.durationMs}ms): \`${result.command}\`` +
            (result.stdout ? ` — ${truncate(result.stdout.trim(), 240)}` : '')
          : `Auto-remediation step FAILED (${result.durationMs}ms): \`${result.command}\` — ${truncate(result.error ?? 'unknown error', 240)}`;

      this.note(incident.id, summary);
    }

    const finishedAt = new Date().toISOString();
    const ranActions = results.length;
    const okCount = results.filter(r => r.status === 'success').length;
    const allOk = ranActions > 0 && okCount === ranActions;

    if (abortedReason) {
      this.note(
        incident.id,
        `Auto-remediation finished early — ${abortedReason}. Completed ${okCount}/${ranActions} action(s) before abort; status not changed.`
      );
    } else {
      this.note(
        incident.id,
        allOk
          ? `Auto-remediation finished — all ${ranActions} action(s) succeeded. Status → mitigating; awaiting next health-check confirmation.`
          : `Auto-remediation finished — ${okCount}/${ranActions} succeeded. Status → mitigating; review timeline for failures.`
      );

      // Only flip to `mitigating` when we actually ran the plan. If we
      // aborted because the incident was already resolved, leave it
      // alone — the operator's status wins.
      try {
        this.incidentManager.update(incident.id, { status: 'mitigating' });
      } catch (e) {
        log.error('[AutoRemediator] failed to set status=mitigating', {
          incidentId: incident.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.broadcast?.({
      type: 'incident_remediation_completed',
      data: {
        incidentId: incident.id,
        kind: plan.kind,
        ok: allOk,
        actions: results,
        abortedReason,
      },
    });

    log.info('[AutoRemediator] finished', {
      incidentId: incident.id,
      kind: plan.kind,
      ok: allOk,
      abortedReason,
    });

    return {
      incidentId: incident.id,
      kind: plan.kind,
      actions: results,
      startedAt,
      finishedAt,
      abortedReason,
    };
  }

  private async runAction(action: RemediationActionSpec): Promise<RemediationActionResult> {
    const startedAt = Date.now();
    const timeoutMs = action.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const display = this.displayCommand(action);

    try {
      const { stdout, stderr } = await this.dispatch(action, timeoutMs);
      return {
        command: display,
        status: 'success',
        stdout: typeof stdout === 'string' ? stdout : stdout?.toString(),
        stderr: typeof stderr === 'string' ? stderr : stderr?.toString(),
        durationMs: Date.now() - startedAt,
      };
    } catch (err: any) {
      const stderr = (err?.stderr ?? '').toString();
      const stdout = (err?.stdout ?? '').toString();
      const message = err?.message ?? String(err);
      return {
        command: display,
        status: 'failed',
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        error: stderr || message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private dispatch(action: RemediationActionSpec, timeoutMs: number): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    const opts = { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 } as const;
    if (action.mode === 'shell') {
      return execAsync(action.command, opts);
    }
    if (action.mode === 'argv') {
      return execFileAsync(action.file, action.args, opts);
    }
    if (action.mode === 'remote-service-restart') {
      return this.restartRemoteService(action, timeoutMs);
    }
    // host-shell: wrap in nsenter into the host's namespaces, then run
    // the command via `sh -c` so shell features (find -delete, pipes)
    // still work. nsenter itself takes argv, so no shell injection
    // surface here even though the inner command is a literal string.
    return execFileAsync(
      NSENTER_ARGV[0],
      [...NSENTER_ARGV.slice(1), 'sh', '-c', action.command],
      opts,
    );
  }

  private displayCommand(action: RemediationActionSpec): string {
    if (action.mode === 'shell') return action.command;
    if (action.mode === 'argv') return `${action.file} ${action.args.join(' ')}`;
    if (action.mode === 'remote-service-restart') {
      return `[${action.serverId}] systemctl restart ${action.candidates.join('|')}`;
    }
    return `[host] ${action.command}`;
  }

  private async restartRemoteService(
    action: Extract<RemediationActionSpec, { mode: 'remote-service-restart' }>,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }> {
    const registry = this.getServerRegistry?.();
    const executor = this.getRemoteExecutor?.();
    if (!registry || !executor) throw new Error('remote service remediation dependencies are unavailable');
    const server = registry.get(action.serverId);
    if (!server) throw new Error(`remote service remediation server not found: ${action.serverId}`);

    const failures: string[] = [];
    for (const service of action.candidates) {
      const result = await executor.executeFile(server, 'systemctl', ['restart', service], { timeoutMs });
      if (result.exitCode === 0) {
        return { stdout: `restarted ${service} on ${server.name}${result.stdout ? `: ${result.stdout.trim()}` : ''}`, stderr: result.stderr };
      }
      failures.push(`${service}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
    }
    throw new Error(`service restart failed on ${server.name}: ${failures.join('; ')}`);
  }

  /** Pull a Docker container name out of the incident in a way we trust.
   *  Order of preference:
   *    1. sourceRef of the form `container:<name>` (structured, set by
   *       a future container-health monitor)
   *    2. sourceRef of the form `docker:container:<name>`
   *  Free-text title parsing is intentionally NOT done — too risky. */
  private extractContainerName(incident: Incident): string | null {
    const ref = (incident.sourceRef || '').trim();
    if (!ref) return null;

    let candidate: string | null = null;
    const m1 = ref.match(/^container:([^\s:]+)$/i);
    const m2 = ref.match(/^docker:container:([^\s:]+)$/i);
    if (m1) candidate = m1[1];
    else if (m2) candidate = m2[1];

    if (!candidate) return null;
    if (!CONTAINER_NAME_RE.test(candidate)) return null;
    return candidate;
  }

  private note(incidentId: string, message: string): void {
    try {
      this.incidentManager.addNote(incidentId, 'auto-remediator', message);
    } catch (e) {
      log.error('[AutoRemediator] failed to add timeline note', {
        incidentId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

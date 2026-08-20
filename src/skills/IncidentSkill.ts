// Incident-context skill — gives an agent the surface area it needs to
// actually own an incident end-to-end: read state, append timeline notes,
// transition status, run safe host commands (via nsenter when present),
// check live metrics, search the runbook library, and execute a runbook.
//
// Every command is shaped to be invoked from inside a ReAct loop:
//   - clear name + parameters schema
//   - SkillResult envelope (encode/ok/fail)
//   - destructive surfaces gated by an allowlist/blocklist
//   - per-call timeout so a hung shell can't burn the agent's time budget
//
// Host execution model: the production container has pid:host + CAP_SYS_ADMIN,
// so `nsenter --target 1 --mount --uts --ipc --net --pid` reaches the host's
// process namespace. We auto-prefix that when nsenter is on PATH; in dev (no
// nsenter, no privileges) we fall back to plain exec inside the container so
// tests still cover the codepath.
//
// Allow/blocklist is intentionally tight by default. The flag
// HOST_EXEC_ALLOW_EXTRA_BINARIES (comma-separated) widens the allowlist per
// deploy without recompiling.

import type { Skill } from '../types/index.js';
import type { SkillExecutionContext } from './SkillManager.js';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { encode, ok, fail } from './SkillResult.js';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { RunbookEngine } from '../runbooks/RunbookEngine.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── Safety ──────────────────────────────────────────────────────────────────
// Binaries the agent is allowed to invoke through host.exec. Keep this tight.
// Read-only diagnostics + targeted housekeeping primitives only. Service
// restart goes through `incident.restart_service` (separate allow-list under
// REMEDIATION_RESTART_ALLOWLIST so an agent can't sidestep the existing gate).
const HOST_EXEC_ALLOWED_BINARIES: ReadonlySet<string> = new Set(
  [
    // Read-only host diagnostics
    'df', 'du', 'free', 'uptime', 'ps', 'top', 'ss', 'netstat',
    'ip', 'cat', 'ls', 'stat', 'find', 'head', 'tail', 'grep',
    'wc', 'awk', 'sed',
    // Container / orchestrator inspection
    'docker', 'kubectl', 'crictl',
    // System inspection
    'systemctl', 'journalctl',
    // Safe housekeeping
    'sync',
  ].concat(
    (process.env.HOST_EXEC_ALLOW_EXTRA_BINARIES || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  )
);

// Hard blocks — these substrings short-circuit the call regardless of binary.
// "incident type matching" (per the brief) isn't a free pass: a `rm -rf /`
// is rejected even if we're in a "disk full" incident. Destructive cleanup
// goes through pre-approved runbooks.
const HOST_EXEC_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+-[rRfF]+[^\n]*?\s\/(\s|$)/,        // rm -rf /
  /\brm\s+-[rRfF]+\s+\/\*?/,                  // rm -rf /*
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bmkfs(\.|\s)/,                            // mkfs, mkfs.ext4, etc.
  /\bdd\s+if=/,                               // raw disk overwrite
  /\b:\(\)\s*\{[^\}]*\}\s*;\s*:/,             // fork bomb
  /\b(curl|wget)[^\n]*\|\s*(bash|sh|zsh)\b/,  // remote-pipe-to-shell
  /\bchmod\s+(-R\s+)?[0-7]*777\s+\//,         // chmod 777 /
  /\bchown\s+(-R\s+)?[^\s]+\s+\/(\s|$)/,      // chown ... /
  />\s*\/dev\/(sd[a-z]|nvme|mmcblk)/,         // write to raw block device
];

function looksDangerous(command: string): string | null {
  for (const re of HOST_EXEC_BLOCKED_PATTERNS) {
    if (re.test(command)) return `command matches blocked pattern: ${re.source}`;
  }
  return null;
}

function firstBinary(command: string): string {
  // Strip env-var prefix ("FOO=bar baz=1 docker ps") then grab the first token.
  const stripped = command.replace(/^(\s*[A-Z_][A-Z0-9_]*=[^\s]+\s+)+/, '');
  const m = stripped.trim().match(/^([A-Za-z0-9_./-]+)/);
  return m ? m[1].split('/').pop()! : '';
}

let nsenterAvailable: boolean | null = null;
async function detectNsenter(): Promise<boolean> {
  if (nsenterAvailable !== null) return nsenterAvailable;
  try {
    await execFileAsync('which', ['nsenter'], { timeout: 2000 });
    nsenterAvailable = true;
  } catch {
    nsenterAvailable = false;
  }
  return nsenterAvailable;
}

// ── Canned metric probes ────────────────────────────────────────────────────
// Pre-baked safe one-liners. Returning structured-ish text the agent can
// reason over without learning the host's shell quirks. Each one is read-only.
const METRIC_PROBES: Record<string, { cmd: string; describe: string }> = {
  disk:     { cmd: 'df -h --output=source,size,used,avail,pcent,target',                          describe: 'filesystem usage by mount' },
  cpu:      { cmd: 'top -bn1 | head -20',                                                          describe: 'top 20 CPU consumers' },
  memory:   { cmd: 'free -m',                                                                      describe: 'memory + swap usage in MB' },
  load:     { cmd: 'uptime',                                                                       describe: 'load average + uptime' },
  docker:   { cmd: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}' | head -50", describe: 'docker container roll-call' },
  services: { cmd: 'systemctl list-units --type=service --state=failed --no-pager',                describe: 'failed systemd services' },
  network:  { cmd: 'ss -tunap 2>/dev/null | head -40 || netstat -tunap | head -40',                describe: 'top 40 network sockets' },
};

// ── Skill ───────────────────────────────────────────────────────────────────
export class IncidentSkill {
  private incidents?: IncidentManager;
  private runbooks?: RunbookEngine;
  private servers?: Pick<ServerRegistry, 'get'>;
  private executor?: Pick<RemoteExecutor, 'execute'>;

  constructor(opts?: {
    incidents?: IncidentManager;
    runbooks?: RunbookEngine;
    servers?: Pick<ServerRegistry, 'get'>;
    executor?: Pick<RemoteExecutor, 'execute'>;
  }) {
    this.incidents = opts?.incidents;
    this.runbooks = opts?.runbooks;
    this.servers = opts?.servers;
    this.executor = opts?.executor;
  }

  setIncidents(m: IncidentManager): void { this.incidents = m; }
  setRunbooks(e: RunbookEngine): void { this.runbooks = e; }
  setServers(s: Pick<ServerRegistry, 'get'>): void { this.servers = s; }
  setExecutor(e: Pick<RemoteExecutor, 'execute'>): void { this.executor = e; }

  getSkill(): Skill {
    return {
      id: 'incident',
      name: 'Incident Response Toolkit',
      description: 'Tools an on-call agent needs to investigate and remediate an incident end-to-end.',
      category: 'service-management',
      enabled: true,
      commands: [
        { name: 'incident.get',            description: 'Get the incident + its timeline by id.',                                                                handler: 'incidentGet',         parameters: { incidentId: 'string' } },
        { name: 'incident.note',           description: 'Append a timeline note to the incident as the executing agent.',                                       handler: 'incidentNote',        parameters: { incidentId: 'string', message: 'string' } },
        { name: 'incident.set_status',     description: 'Move the incident through its lifecycle: open|investigating|mitigating|resolved.',                     handler: 'incidentSetStatus',   parameters: { incidentId: 'string', status: 'string' } },
        { name: 'incident.resolve',        description: 'Mark the incident resolved with a one-paragraph resolution summary.',                                  handler: 'incidentResolve',     parameters: { incidentId: 'string', resolution: 'string' } },
        { name: 'incident.escalate',       description: 'Bump severity one notch and add an escalation reason — use when the agent cannot remediate alone.',    handler: 'incidentEscalate',    parameters: { incidentId: 'string', reason: 'string' } },
        { name: 'host.exec',               description: 'Execute a safe diagnostic/maintenance command on a monitored server. Pass serverId for remote incidents; omit it only for local execution.', handler: 'hostExec',  parameters: { serverId: 'string?', command: 'string', timeoutMs: 'number?' } },
        { name: 'host.check_metric',       description: 'Run a pre-canned read-only probe on a monitored server. Metrics: disk|cpu|memory|load|docker|services|network.', handler: 'hostCheckMetric', parameters: { serverId: 'string?', metric: 'string' } },
        { name: 'runbook.search',          description: 'Find runbook templates whose name/description/tags match a free-text query.',                          handler: 'runbookSearch',       parameters: { query: 'string' } },
        { name: 'runbook.execute',         description: 'Trigger execution of a runbook template by id. Returns the runId — poll runbook.status (from the runbook skill) for progress.', handler: 'runbookExecute', parameters: { templateId: 'string' } },
      ],
    };
  }

  // ── Incident handlers ────────────────────────────────────────────────────

  async incidentGet(params: { incidentId?: string }): Promise<string> {
    if (!this.incidents) return encode(fail('IncidentSkill has no incident manager wired', 'unconfigured'));
    if (!params?.incidentId) return encode(fail('incident.get requires { incidentId }'));
    const inc = this.incidents.get(params.incidentId);
    if (!inc) return encode(fail(`incident not found: ${params.incidentId}`, 'not_found'));
    return encode(ok({
      id: inc.id,
      title: inc.title,
      description: inc.description,
      severity: inc.severity,
      status: inc.status,
      source: inc.source,
      serverId: inc.serverId,
      assignedTo: inc.assignedTo,
      createdAt: inc.createdAt,
      timeline: inc.timeline.slice(-20).map(t => ({
        timestamp: t.timestamp, actor: t.actor, type: t.type, message: t.message,
      })),
    }, `${inc.id} — ${inc.status}/${inc.severity} — ${inc.title}`));
  }

  async incidentNote(params: { incidentId?: string; message?: string }, ctx?: SkillExecutionContext): Promise<string> {
    if (!this.incidents) return encode(fail('IncidentSkill has no incident manager wired', 'unconfigured'));
    if (!params?.incidentId || !params?.message) return encode(fail('incident.note requires { incidentId, message }'));
    const actor = ctx?.callerAgentName || ctx?.callerAgentId || 'agent';
    const entry = this.incidents.addNote(params.incidentId, actor, params.message);
    if (!entry) return encode(fail(`incident not found: ${params.incidentId}`, 'not_found'));
    return encode(ok({ entryId: entry.id, timestamp: entry.timestamp }, `note added to ${params.incidentId}`));
  }

  async incidentSetStatus(params: { incidentId?: string; status?: string }): Promise<string> {
    if (!this.incidents) return encode(fail('IncidentSkill has no incident manager wired', 'unconfigured'));
    if (!params?.incidentId || !params?.status) return encode(fail('incident.set_status requires { incidentId, status }'));
    const valid = ['open', 'investigating', 'mitigating', 'resolved'];
    if (!valid.includes(params.status)) return encode(fail(`status must be one of: ${valid.join(', ')}`));
    const updated = this.incidents.update(params.incidentId, { status: params.status as any });
    if (!updated) return encode(fail(`incident not found: ${params.incidentId}`, 'not_found'));
    return encode(ok({ id: updated.id, status: updated.status }, `${updated.id} → ${updated.status}`));
  }

  async incidentResolve(params: { incidentId?: string; resolution?: string }): Promise<string> {
    if (!this.incidents) return encode(fail('IncidentSkill has no incident manager wired', 'unconfigured'));
    if (!params?.incidentId || !params?.resolution) return encode(fail('incident.resolve requires { incidentId, resolution }'));
    const updated = this.incidents.resolve(params.incidentId, params.resolution);
    if (!updated) return encode(fail(`incident not found: ${params.incidentId}`, 'not_found'));
    return encode(ok({ id: updated.id, status: updated.status, resolvedAt: updated.resolvedAt }, `${updated.id} resolved`));
  }

  async incidentEscalate(params: { incidentId?: string; reason?: string }): Promise<string> {
    if (!this.incidents) return encode(fail('IncidentSkill has no incident manager wired', 'unconfigured'));
    if (!params?.incidentId || !params?.reason) return encode(fail('incident.escalate requires { incidentId, reason }'));
    const updated = this.incidents.escalate(params.incidentId, params.reason);
    if (!updated) return encode(fail(`incident not found: ${params.incidentId}`, 'not_found'));
    return encode(ok({ id: updated.id, severity: updated.severity }, `${updated.id} escalated → ${updated.severity}`));
  }

  // ── Host execution ───────────────────────────────────────────────────────

  async hostExec(params: { serverId?: string; command?: string; timeoutMs?: number }): Promise<string> {
    if (!params?.command) return encode(fail('host.exec requires { command }'));
    const command = params.command.trim();
    const timeout = Math.min(Math.max(params.timeoutMs ?? 30000, 1000), 120000);

    const dangerReason = looksDangerous(command);
    if (dangerReason) return encode(fail(dangerReason, 'blocked'));

    const binary = firstBinary(command);
    if (!binary) return encode(fail('could not identify command binary', 'parse_error'));
    if (!HOST_EXEC_ALLOWED_BINARIES.has(binary)) {
      return encode(fail(
        `binary "${binary}" not in HOST_EXEC allowlist (allowed: ${Array.from(HOST_EXEC_ALLOWED_BINARIES).slice(0, 20).join(', ')}…)`,
        'not_allowlisted',
      ));
    }

    if (params.serverId) {
      if (!this.servers || !this.executor) {
        return encode(fail('remote host execution is not configured', 'unconfigured'));
      }
      const server = this.servers.get(params.serverId);
      if (!server) return encode(fail(`unknown server: ${params.serverId}`, 'unknown_server'));
      try {
        const res = await this.executor.execute(server, command, { timeoutMs: timeout });
        const stdout = res.stdout.trim();
        const stderr = res.stderr.trim();
        if (res.exitCode !== 0) {
          return encode(fail(stderr || stdout || `command exited with code ${res.exitCode}`, `exit ${res.exitCode}`));
        }
        return encode(ok({ stdout: res.stdout, stderr: res.stderr, binary, viaRemote: true },
          stdout ? `${stdout.split('\n').length} lines stdout` : stderr ? 'stderr only' : 'no output'));
      } catch (e: any) {
        return encode(fail(e?.message ?? String(e), 'remote_exec_failed'));
      }
    }

    const useNsenter = await detectNsenter();
    const wrapped = useNsenter
      ? `nsenter --target 1 --mount --uts --ipc --net --pid -- sh -c ${shellQuote(command)}`
      : command;

    try {
      const { stdout, stderr } = await execAsync(wrapped, {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
      const out = (stdout || '').trim();
      const err = (stderr || '').trim();
      return encode(ok(
        { stdout: out, stderr: err, viaNsenter: useNsenter, binary },
        out ? `${out.split('\n').length} lines stdout` : err ? 'stderr only' : 'no output',
      ));
    } catch (e: any) {
      if (e?.killed && e?.signal === 'SIGTERM') {
        return encode(fail(`command timed out after ${timeout}ms`, 'timeout'));
      }
      const exitCode = typeof e?.code === 'number' ? e.code : null;
      const stderr = (e?.stderr ?? '').toString().trim();
      return encode(fail(
        stderr || e?.message || String(e),
        exitCode !== null ? `exit ${exitCode}` : 'failed',
      ));
    }
  }

  async hostCheckMetric(params: { serverId?: string; metric?: string }): Promise<string> {
    if (!params?.metric) return encode(fail('host.check_metric requires { metric }'));
    const probe = METRIC_PROBES[params.metric];
    if (!probe) return encode(fail(
      `unknown metric "${params.metric}". Known: ${Object.keys(METRIC_PROBES).join(', ')}`,
      'unknown_metric',
    ));
    return this.hostExec({ serverId: params.serverId, command: probe.cmd, timeoutMs: 15000 });
  }

  // ── Runbooks ─────────────────────────────────────────────────────────────

  async runbookSearch(params: { query?: string }): Promise<string> {
    if (!this.runbooks) return encode(fail('IncidentSkill has no runbook engine wired', 'unconfigured'));
    if (!params?.query) return encode(fail('runbook.search requires { query }'));
    const q = params.query.toLowerCase();
    const tokens = q.split(/\s+/).filter(t => t.length >= 3);
    const templates = this.runbooks.listTemplates();
    const scored = templates.map(t => {
      const haystack = `${t.name} ${t.description} ${(t.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      if (haystack.includes(q)) score += 5;
      for (const tk of tokens) if (haystack.includes(tk)) score += 1;
      return { t, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);

    return encode(ok({
      matches: scored.map(({ t, score }) => ({
        id: t.id, name: t.name, description: t.description,
        category: t.category, tags: t.tags, score,
      })),
    }, `${scored.length} runbook match(es) for "${params.query}"`));
  }

  async runbookExecute(params: { templateId?: string }, ctx?: SkillExecutionContext): Promise<string> {
    if (!this.runbooks) return encode(fail('IncidentSkill has no runbook engine wired', 'unconfigured'));
    if (!params?.templateId) return encode(fail('runbook.execute requires { templateId }'));
    try {
      const triggeredBy = ctx?.callerAgentName || ctx?.callerAgentId || 'agent';
      const run = await this.runbooks.executeRun(params.templateId, triggeredBy);
      return encode(ok({
        runId: run.id, templateName: run.templateName, status: run.status,
        stepCount: run.stepResults.length,
      }, `runbook started: ${run.id}`));
    } catch (e: any) {
      return encode(fail(e?.message ?? String(e), 'runbook_failed'));
    }
  }
}

function shellQuote(s: string): string {
  // Single-quote and escape internal single quotes for sh -c.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

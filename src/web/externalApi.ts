// External API for chat-bot / phone-friendly remote control.
//
// Mounted at /api/external. Auth is a single shared bearer token in
// EXTERNAL_API_TOKEN — when that env var is unset, the router is not
// mounted at all (see server.ts wiring), so the endpoints simply 404.
//
// The point of this surface is to be addressable from an external AI
// agent (OpenClaw / a Telegram bot / etc.). Every response includes a
// natural-language `summary` so the LLM relaying the data to the user
// doesn't have to interpret raw JSON.
//
// Read endpoints are unrestricted. Action endpoints are rate-limited
// per action key (one call per ACTION_RATE_LIMIT_MS) and recorded in
// the in-memory audit buffer exposed at /audit. Actions are operator
// commands, not alerts — they do NOT create incidents.

import { Router, type Request, type Response, type NextFunction } from 'express';
import * as os from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { OrganizationManager } from '../agents/Organization.js';
import type { TaskManager } from '../tasks/TaskManager.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const ACTION_RATE_LIMIT_MS = 60_000;

// nsenter into PID 1's namespaces — same prefix IncidentAutoRemediator
// uses for host-scope commands. Requires `pid: host` + CAP_SYS_ADMIN
// on the container, which docker-compose.yml configures.
const NSENTER_ARGV = ['--target', '1', '--mount', '--uts', '--ipc', '--net', '--pid', '--'];

// Containers an external chat bot may restart. Override with
// EXTERNAL_API_RESTART_ALLOWLIST (comma-separated). Anything not on
// the list is rejected so a hallucinating LLM can't restart sshd or
// the host's database container by name.
function loadRestartAllowlist(): Set<string> {
  const raw = process.env.EXTERNAL_API_RESTART_ALLOWLIST
    || 'itops-agents,itops-factory-dashboard,itops-irc-server,itops-agentirc';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

export interface ExternalApiDeps {
  incidentManager: IncidentManager;
  organization: OrganizationManager;
  taskManager: TaskManager;
  /** Optional. When wired, /status returns a per-server breakdown
   *  alongside the local snapshot. Older deployments without
   *  multi-server support keep working unchanged. */
  serverRegistry?: ServerRegistry;
  remoteExecutor?: RemoteExecutor;
  /** Optional. When wired, /status includes a `trends` field that
   *  summarises predictive issues (disk filling up, statistical
   *  anomalies). The chat-bot uses this to surface "things on track to
   *  break in the next 48h" without an extra round-trip. */
  trendAnalyzer?: {
    isEnabled(): boolean;
    getLastReport(): {
      trends: Array<{
        serverId: string;
        serverName: string;
        metricType: string;
        dimension: string | null;
        currentValue: number;
        ratePerHour: number;
        predictedCriticalAt: string | null;
        hoursUntilCritical: number | null;
        isAnomaly: boolean;
        anomalyZScore: number | null;
      }>;
      finishedAt: string;
    } | null;
  };
}

interface AuditEntry {
  at: string;
  action: string;
  ip: string;
  result: 'ok' | 'rate-limited' | 'error';
  detail?: string;
}

const auditBuffer: AuditEntry[] = [];
const lastActionAt = new Map<string, number>();

function record(entry: AuditEntry): void {
  auditBuffer.push(entry);
  if (auditBuffer.length > 200) auditBuffer.splice(0, auditBuffer.length - 200);
}

function checkRate(action: string): boolean {
  const now = Date.now();
  const prev = lastActionAt.get(action) ?? 0;
  if (now - prev < ACTION_RATE_LIMIT_MS) return false;
  lastActionAt.set(action, now);
  return true;
}

/** Run a shell command on the host via nsenter. Same mechanism the
 *  IncidentAutoRemediator uses for host-scope steps. */
async function hostShell(cmd: string, timeoutMs = 15000): Promise<string> {
  const { stdout } = await execFileAsync(
    'nsenter',
    [...NSENTER_ARGV, 'sh', '-c', cmd],
    { timeout: timeoutMs },
  );
  return stdout.trim();
}

async function dockerExec(args: string[], timeoutMs = 15000): Promise<string> {
  // execFile so user-derived data (container names) never reach a shell.
  // The container has /var/run/docker.sock mounted from the host.
  const { stdout } = await execFileAsync('docker', args, { timeout: timeoutMs });
  return stdout.trim();
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

export function createExternalApiRouter(deps: ExternalApiDeps): Router {
  const router = Router();
  const expectedToken = (process.env.EXTERNAL_API_TOKEN || '').trim();

  // Bearer-token auth. Mounting code is responsible for not wiring this
  // router when the token is empty, but we double-check here so a future
  // refactor can't accidentally expose an open endpoint.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!expectedToken) {
      res.status(503).json({ error: 'External API not configured (EXTERNAL_API_TOKEN unset)' });
      return;
    }
    const header = req.header('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1].trim() !== expectedToken) {
      record({
        at: new Date().toISOString(),
        action: req.method + ' ' + req.path,
        ip: req.ip || 'unknown',
        result: 'error',
        detail: 'auth-failed',
      });
      res.status(401).json({ error: 'Invalid or missing bearer token' });
      return;
    }
    next();
  });

  // ── Status ────────────────────────────────────────────────────────────
  router.get('/status', async (_req, res) => {
    try {
      const mem = process.memoryUsage();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memPct = pct(totalMem - freeMem, totalMem);

      const cpus = os.cpus();
      const load1 = os.loadavg()[0];
      const cpuPct = cpus.length > 0
        ? Math.min(100, Math.round((load1 / cpus.length) * 100))
        : null;

      let diskPct: number | null = null;
      let diskDetail = '';
      try {
        const diskRaw = await hostShell(
          "df -P / 2>/dev/null | tail -1 | awk '{print $5\" \"$3\" \"$2}'");
        const parts = diskRaw.replace(/%/g, '').trim().split(/\s+/);
        if (parts.length >= 1) diskPct = Number(parts[0]);
        diskDetail = diskRaw;
      } catch (e: any) {
        diskDetail = `disk probe failed: ${e.message}`;
      }

      let containerCount: { running: number; stopped: number } | null = null;
      try {
        const out = await dockerExec(['ps', '-a', '--format', '{{.State}}']);
        const lines = out.split('\n').filter(Boolean);
        containerCount = {
          running: lines.filter(l => l === 'running').length,
          stopped: lines.length - lines.filter(l => l === 'running').length,
        };
      } catch (_) { /* docker socket unavailable */ }

      const activeIncidents = deps.incidentManager.list({})
        .filter(i => ['open', 'investigating', 'mitigating'].includes(i.status));
      const agents = deps.organization.getAllAgents();

      // Per-server breakdown — local always present; remote rows queried
      // through the executor in parallel. Skips entirely if multi-server
      // isn't wired (older deployments) so the response stays small.
      const servers = deps.serverRegistry?.enabledServers() ?? [];
      const perServerByServer = new Map<string, typeof activeIncidents>();
      for (const inc of activeIncidents) {
        if (!inc.serverId) continue;
        const arr = perServerByServer.get(inc.serverId) ?? [];
        arr.push(inc);
        perServerByServer.set(inc.serverId, arr);
      }
      const perServer = await Promise.all(servers.map(async s => {
        const incidentsOnServer = perServerByServer.get(s.id) ?? [];
        return {
          id: s.id,
          name: s.name,
          host: s.host,
          isLocal: s.isLocal,
          enabled: s.enabled,
          lastSeen: s.lastSeen,
          lastCheckStatus: s.lastCheckStatus,
          incidents: {
            active: incidentsOnServer.length,
            critical: incidentsOnServer.filter(i => i.severity === 'critical').length,
            high: incidentsOnServer.filter(i => i.severity === 'high').length,
          },
          tags: s.tags,
        };
      }));

      // Trend / anomaly summary — only when the analyzer is wired AND
      // has produced a report (cold-boot the first tick hasn't run yet).
      // We pull just the actionable rows: anything with a prediction in
      // the next 48h, plus anything flagged as an anomaly. Everything
      // else is "trend OK, ignore".
      const trendReport = deps.trendAnalyzer?.getLastReport() ?? null;
      const predicted = (trendReport?.trends ?? []).filter(t => t.predictedCriticalAt != null);
      const anomalies = (trendReport?.trends ?? []).filter(t => t.isAnomaly);

      const summaryParts: string[] = [];
      if (diskPct != null) summaryParts.push(`disk ${diskPct}%`);
      summaryParts.push(`memory ${memPct}%`);
      if (cpuPct != null) summaryParts.push(`cpu load ${cpuPct}%`);
      if (containerCount) summaryParts.push(`${containerCount.running} containers running`);
      summaryParts.push(`${activeIncidents.length} active incidents`);
      summaryParts.push(`${agents.length} agents`);
      if (perServer.length > 1) {
        const healthy = perServer.filter(s => s.lastCheckStatus === 'ok').length;
        summaryParts.push(`${healthy}/${perServer.length} servers reachable`);
      }
      if (predicted.length > 0) {
        summaryParts.push(`${predicted.length} predicted issue${predicted.length === 1 ? '' : 's'} in next 48h`);
      }
      if (anomalies.length > 0) {
        summaryParts.push(`${anomalies.length} metric anomal${anomalies.length === 1 ? 'y' : 'ies'}`);
      }

      res.json({
        summary: 'System status: ' + summaryParts.join(', ') + '.',
        host: os.hostname(),
        disk: { usedPct: diskPct, raw: diskDetail },
        memory: {
          usedPct: memPct,
          totalMb: Math.round(totalMem / 1024 / 1024),
          freeMb: Math.round(freeMem / 1024 / 1024),
          processHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
        },
        cpu: {
          loadPct: cpuPct,
          cores: cpus.length,
          loadAvg: os.loadavg().map(n => Math.round(n * 100) / 100),
        },
        containers: containerCount,
        incidents: {
          active: activeIncidents.length,
          critical: activeIncidents.filter(i => i.severity === 'critical').length,
          high: activeIncidents.filter(i => i.severity === 'high').length,
        },
        agents: { total: agents.length },
        servers: perServer,
        // Forward-looking signal. Predicted = metrics on track to cross a
        // critical threshold within 48h. Anomalies = current value > 2.5σ
        // from the 7-day rolling mean. `enabled: false` here means the
        // analyzer hasn't been wired yet — trends will be empty.
        trends: {
          enabled: deps.trendAnalyzer?.isEnabled() ?? false,
          finishedAt: trendReport?.finishedAt ?? null,
          predicted: predicted.map(t => ({
            serverId: t.serverId,
            serverName: t.serverName,
            metric: t.metricType,
            dimension: t.dimension,
            currentValue: t.currentValue,
            ratePerHour: t.ratePerHour,
            predictedCriticalAt: t.predictedCriticalAt,
            hoursUntilCritical: t.hoursUntilCritical,
          })),
          anomalies: anomalies.map(t => ({
            serverId: t.serverId,
            serverName: t.serverName,
            metric: t.metricType,
            dimension: t.dimension,
            currentValue: t.currentValue,
            zScore: t.anomalyZScore,
          })),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message, summary: 'Failed to gather system status.' });
    }
  });

  // ── Incidents ─────────────────────────────────────────────────────────
  router.get('/incidents', (_req, res) => {
    const ACTIVE = ['open', 'investigating', 'mitigating'];
    const incidents = deps.incidentManager.list({})
      .filter(i => ACTIVE.includes(i.status))
      .map(i => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        status: i.status,
        assignedAgent: i.assignedTo,
        createdAt: i.createdAt,
        ageMinutes: Math.round((Date.now() - new Date(i.createdAt).getTime()) / 60000),
      }));

    const summary = incidents.length === 0
      ? 'No active incidents.'
      : `${incidents.length} active incident${incidents.length === 1 ? '' : 's'}: `
        + incidents.slice(0, 5).map(i => `${i.id} (${i.severity}) ${i.title}`).join('; ')
        + (incidents.length > 5 ? `, plus ${incidents.length - 5} more.` : '.');

    res.json({ summary, incidents, total: incidents.length });
  });

  router.get('/incidents/:id', (req, res) => {
    const inc = deps.incidentManager.get(req.params.id);
    if (!inc) {
      res.status(404).json({ error: 'Incident not found', summary: `No incident with id ${req.params.id}.` });
      return;
    }
    const ageMin = Math.round((Date.now() - new Date(inc.createdAt).getTime()) / 60000);
    const summary = `Incident ${inc.id} — ${inc.severity}, status ${inc.status}, ${ageMin}m old. ${inc.title}`;
    res.json({ summary, incident: inc });
  });

  // ── Agents ────────────────────────────────────────────────────────────
  router.get('/agents', (_req, res) => {
    const agents = deps.organization.getAllAgents().map(a => {
      const tasks = deps.taskManager.getTasksByAgent(a.config.id)
        .filter(t => t.status === 'in_progress');
      const current = tasks[0];
      return {
        id: a.config.id,
        name: a.config.name,
        role: a.config.role,
        status: current ? 'busy' : 'idle',
        currentTask: current ? { id: current.id, title: current.title, status: current.status } : null,
      };
    });
    const busy = agents.filter(a => a.status === 'busy').length;
    const summary = `${agents.length} agents — ${busy} busy, ${agents.length - busy} idle.`;
    res.json({ summary, agents });
  });

  // ── Disk ──────────────────────────────────────────────────────────────
  router.get('/disk', async (_req, res) => {
    try {
      // Per-mount usage. Filter pseudo filesystems so the output is meaningful.
      const dfRaw = await hostShell(
        "df -hPl -x tmpfs -x devtmpfs -x squashfs -x overlay -x fuse.gvfsd-fuse 2>/dev/null");
      const mounts = dfRaw.split('\n').slice(1).filter(Boolean).map(line => {
        const cols = line.trim().split(/\s+/);
        // Filesystem  Size  Used  Avail  Use%  Mounted-on
        return {
          filesystem: cols[0],
          total: cols[1],
          used: cols[2],
          available: cols[3],
          usedPct: Number((cols[4] || '0').replace('%', '')),
          mountpoint: cols[5],
        };
      });

      // Top consumers in noisy paths.
      let topConsumers: Array<{ size: string; path: string }> = [];
      try {
        const topRaw = await hostShell(
          "find /var/log /tmp /var/cache -maxdepth 4 -type f -size +50M -printf '%s\\t%p\\n' 2>/dev/null | sort -rn | head -10",
          60_000);
        topConsumers = topRaw.split('\n').filter(Boolean).map(l => {
          const [bytesStr, ...rest] = l.split('\t');
          const bytes = Number(bytesStr) || 0;
          return {
            size: bytes >= 1024 * 1024 * 1024
              ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`
              : `${Math.round(bytes / 1024 / 1024)}MB`,
            path: rest.join('\t').trim(),
          };
        });
      } catch (_) { /* find may be slow / restricted */ }

      const root = mounts.find(m => m.mountpoint === '/');
      const summary = root
        ? `Root filesystem ${root.usedPct}% used (${root.used} of ${root.total}, ${root.available} free).`
        : `Disk usage: ${mounts.length} mount(s) reported.`;

      res.json({
        summary,
        mounts,
        topConsumers,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message, summary: 'Failed to read disk usage.' });
    }
  });

  // ── Docker overview ───────────────────────────────────────────────────
  router.get('/docker', async (_req, res) => {
    try {
      const stateOut = await dockerExec(['ps', '-a', '--format', '{{.State}}']);
      const states = stateOut.split('\n').filter(Boolean);
      const running = states.filter(s => s === 'running').length;
      const stopped = states.length - running;

      const imagesOut = await dockerExec(['images', '-q']);
      const imageCount = imagesOut.split('\n').filter(Boolean).length;

      const danglingOut = await dockerExec(['images', '-q', '--filter', 'dangling=true']);
      const danglingCount = danglingOut.split('\n').filter(Boolean).length;

      const dfRaw = await dockerExec(['system', 'df',
        '--format', '{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}']);
      const dfRows = dfRaw.split('\n').filter(Boolean).map(line => {
        const [type, total, active, size, reclaimable] = line.split('\t');
        return { type, total: Number(total) || 0, active: Number(active) || 0, size, reclaimable };
      });

      const reclaimableBytes = dfRows.reduce((sum, r) => sum + parseSize(r.reclaimable.split(' ')[0]), 0);
      const reclaimableGb = (reclaimableBytes / 1024 / 1024 / 1024).toFixed(2);

      const summary = `Docker: ${running} running, ${stopped} stopped containers, ${imageCount} images `
        + `(${danglingCount} dangling). ${reclaimableGb} GB reclaimable.`;

      res.json({
        summary,
        containers: { running, stopped, total: states.length },
        images: { total: imageCount, dangling: danglingCount },
        diskUsage: dfRows,
        reclaimableGb: Number(reclaimableGb),
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message, summary: 'Failed to query docker. Is the daemon reachable?' });
    }
  });

  // ── Actions ───────────────────────────────────────────────────────────
  router.post('/actions/disk-cleanup', async (req, res) => {
    if (!checkRate('disk-cleanup')) {
      record({ at: new Date().toISOString(), action: 'disk-cleanup', ip: req.ip || 'unknown', result: 'rate-limited' });
      res.status(429).json({ error: 'Rate limited', summary: 'Disk cleanup was run within the last minute. Try again shortly.' });
      return;
    }
    try {
      // Mirrors the IncidentAutoRemediator disk-cleanup recipe: docker
      // prune via the local socket, then nsenter into the host for log
      // cleanup that the container can't do (journalctl + /var/log).
      const dockerOut = await dockerExec(['system', 'prune', '-f'], 120_000);
      const hostCmd = "find /var/log -type f -name '*.gz' -mtime +7 -delete 2>/dev/null; "
        + "JOUT=$(journalctl --vacuum-time=7d 2>&1 | tail -3); "
        + "TOUT=$(find /tmp -type f -mtime +7 -delete 2>/dev/null && echo tmp_cleaned || echo tmp_partial); "
        + "echo \"tmp=$TOUT journal=[$JOUT]\"";
      const hostOut = await hostShell(hostCmd, 120_000);

      const detail = `docker: ${dockerOut.replace(/\n/g, ' ')} | host: ${hostOut}`;
      record({ at: new Date().toISOString(), action: 'disk-cleanup', ip: req.ip || 'unknown', result: 'ok', detail });

      res.json({
        summary: 'Disk cleanup ran: pruned docker, vacuumed journal logs older than 7d, removed /tmp files older than 7d.',
        docker: dockerOut,
        host: hostOut,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      record({ at: new Date().toISOString(), action: 'disk-cleanup', ip: req.ip || 'unknown', result: 'error', detail: e.message });
      res.status(500).json({ error: e.message, summary: 'Disk cleanup failed.' });
    }
  });

  router.post('/actions/docker-prune', async (req, res) => {
    if (!checkRate('docker-prune')) {
      record({ at: new Date().toISOString(), action: 'docker-prune', ip: req.ip || 'unknown', result: 'rate-limited' });
      res.status(429).json({ error: 'Rate limited', summary: 'Docker prune was run within the last minute.' });
      return;
    }
    try {
      const out = await dockerExec(['system', 'prune', '-f'], 120_000);
      const reclaimed = (out.match(/Total reclaimed space:\s*(.+)$/m) || [])[1] || 'unknown';
      const detail = `reclaimed=${reclaimed}`;
      record({ at: new Date().toISOString(), action: 'docker-prune', ip: req.ip || 'unknown', result: 'ok', detail });
      res.json({
        summary: `Docker prune complete. Reclaimed: ${reclaimed}.`,
        output: out,
        reclaimed,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      record({ at: new Date().toISOString(), action: 'docker-prune', ip: req.ip || 'unknown', result: 'error', detail: e.message });
      res.status(500).json({ error: e.message, summary: 'Docker prune failed.' });
    }
  });

  router.post('/actions/container-restart', async (req, res) => {
    const allowlist = loadRestartAllowlist();
    const requested = String(req.body?.container || '').trim();

    // No container ⇒ return the available options so the caller can pick.
    if (!requested) {
      res.status(400).json({
        error: 'container required',
        summary: 'Specify a container to restart. Allowed: ' + Array.from(allowlist).join(', '),
        allowed: Array.from(allowlist),
      });
      return;
    }
    if (!allowlist.has(requested)) {
      res.status(403).json({
        error: 'container not in allowlist',
        summary: `Container "${requested}" is not on the allowlist. Allowed: ${Array.from(allowlist).join(', ')}.`,
        allowed: Array.from(allowlist),
      });
      return;
    }
    const rateKey = `container-restart:${requested}`;
    if (!checkRate(rateKey)) {
      record({ at: new Date().toISOString(), action: rateKey, ip: req.ip || 'unknown', result: 'rate-limited' });
      res.status(429).json({ error: 'Rate limited', summary: `Container ${requested} was restarted within the last minute.` });
      return;
    }
    try {
      const out = await dockerExec(['restart', requested], 60_000);
      const detail = `restarted=${requested}`;
      record({ at: new Date().toISOString(), action: rateKey, ip: req.ip || 'unknown', result: 'ok', detail });
      res.json({
        summary: `Container "${requested}" restarted.`,
        container: requested,
        output: out,
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      record({ at: new Date().toISOString(), action: rateKey, ip: req.ip || 'unknown', result: 'error', detail: e.message });
      res.status(500).json({ error: e.message, summary: `Failed to restart "${requested}".` });
    }
  });

  // ── Audit log ─────────────────────────────────────────────────────────
  router.get('/audit', (_req, res) => {
    res.json({ summary: `${auditBuffer.length} recent external API call(s).`, entries: auditBuffer.slice().reverse() });
  });

  return router;
}

// Convert "1.2GB" / "500MB" / "2.3kB" / "1234B" into bytes. docker
// system df --format produces these short suffixes, not bytes.
function parseSize(raw: string): number {
  const m = /^([\d.]+)\s*([kKmMgGtT]?)([bB]?)$/.exec((raw || '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return n * (mult[m[2].toLowerCase()] ?? 1);
}

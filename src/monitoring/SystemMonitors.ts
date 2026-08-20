// SystemMonitors — host-level health probes that open / auto-resolve
// incidents via IncidentManager.
//
// Six independent monitor categories, all driven from the same interval
// the existing health-monitor loop in src/web/server.ts already runs:
//   1. CPU sustained load            (load1 / cores; per server)
//   2. Docker container health      (unhealthy / restart-loop / bad-exit; per server)
//   3. Systemd service failures      (is-active via the executor; per server)
//   4. Disk I/O wait                 (/proc/stat iowait delta; per server)
//   5. SSL/TLS certificate expiry    (openssl s_client per domain; global)
//   6. Network connectivity          (ping; global, runs from local)
//
// Per-server vs global
// ────────────────────
// Categories 1–4 run against every enabled server in the ServerRegistry:
// local uses RemoteExecutor's nsenter path (CAP_SYS_ADMIN + pid:host),
// remote uses the ssh path with the spec's algorithm flags. Categories
// 5 + 6 stay global — they probe destinations on the public internet,
// not the monitored server, so running them once per tick is enough.
//
// Backward-compat sourceRefs
// ──────────────────────────
// For the local server the sourceRef stays exactly as it was before
// multi-server (e.g. `cpu:sustained`) so any incidents currently open
// against that ref continue to dedup. Remote servers get a name suffix
// (`cpu:sustained:production-1`). Titles always include the server tag
// for human readability.
//
// Streak hysteresis
// ─────────────────
// All monitors:
//   • Are individually toggleable via env vars.
//   • Use stable sourceRefs so dedup suppresses re-open spam across ticks.
//   • Auto-resolve their own incident when the underlying condition has
//     been clear for N consecutive ticks (StreakTracker keys are also
//     server-scoped so two servers don't share open/close streaks).

import * as fs from 'fs';
import * as tls from 'tls';
import type { IncidentManager } from '../incidents/IncidentManager.js';
import type { ComponentLogger } from '../observability/Logger.js';
import type { RemoteExecutor } from './RemoteExecutor.js';
import type { ServerRegistry, MonitoredServer } from './ServerRegistry.js';
import { LOCAL_SERVER_ID } from './ServerRegistry.js';
import { serviceCandidates } from './ServiceAliases.js';

export interface SystemMonitorsDeps {
  incidentManager: IncidentManager;
  registry: ServerRegistry;
  executor: RemoteExecutor;
  notify: (opts: {
    type: 'info' | 'warning' | 'error';
    title: string;
    message: string;
  }) => void;
  log: ComponentLogger;
}

interface MonitorConfig {
  cpu: { enabled: boolean; thresholdPct: number; sustainedChecks: number; clearChecks: number };
  docker: { enabled: boolean; restartWindowMs: number; restartThreshold: number; clearChecks: number };
  service: { enabled: boolean; names: string[]; clearChecks: number };
  iowait: { enabled: boolean; thresholdPct: number; sustainedChecks: number; clearChecks: number };
  cert: { enabled: boolean; domains: string[]; warnDays: number; criticalDays: number };
  net: { enabled: boolean; hosts: string[]; failuresToAlert: number; clearChecks: number };
}

function parseList(raw: string | undefined, fallback: string[] = []): string[] {
  if (!raw) return fallback;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function envBool(name: string, defaultVal: boolean): boolean {
  const v = process.env[name];
  if (v == null) return defaultVal;
  return /^(1|true|yes|on)$/i.test(v);
}

function envInt(name: string, defaultVal: number): number {
  const v = process.env[name];
  if (!v) return defaultVal;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : defaultVal;
}

function loadConfig(): MonitorConfig {
  return {
    cpu: {
      enabled: envBool('MONITOR_CPU_ENABLED', true),
      thresholdPct: envInt('MONITOR_CPU_THRESHOLD_PCT', 80),
      sustainedChecks: envInt('MONITOR_CPU_SUSTAINED_CHECKS', 3),
      clearChecks: envInt('MONITOR_CPU_CLEAR_CHECKS', 2),
    },
    docker: {
      enabled: envBool('MONITOR_DOCKER_ENABLED', true),
      restartWindowMs: envInt('MONITOR_DOCKER_RESTART_WINDOW_MS', 10 * 60_000),
      restartThreshold: envInt('MONITOR_DOCKER_RESTART_THRESHOLD', 3),
      clearChecks: envInt('MONITOR_DOCKER_CLEAR_CHECKS', 2),
    },
    service: {
      enabled: envBool('MONITOR_SERVICES_ENABLED', true),
      names: parseList(process.env.MONITORED_SERVICES, ['docker', 'ssh', 'fail2ban']),
      clearChecks: envInt('MONITOR_SERVICES_CLEAR_CHECKS', 2),
    },
    iowait: {
      enabled: envBool('MONITOR_IOWAIT_ENABLED', true),
      thresholdPct: envInt('MONITOR_IOWAIT_THRESHOLD_PCT', 30),
      sustainedChecks: envInt('MONITOR_IOWAIT_SUSTAINED_CHECKS', 3),
      clearChecks: envInt('MONITOR_IOWAIT_CLEAR_CHECKS', 2),
    },
    cert: {
      enabled: envBool('MONITOR_CERTS_ENABLED', true),
      domains: parseList(process.env.MONITORED_DOMAINS),
      warnDays: envInt('MONITOR_CERTS_WARN_DAYS', 14),
      criticalDays: envInt('MONITOR_CERTS_CRITICAL_DAYS', 7),
    },
    net: {
      enabled: envBool('MONITOR_NETWORK_ENABLED', true),
      hosts: parseList(process.env.MONITORED_HOSTS, ['8.8.8.8', '1.1.1.1']),
      failuresToAlert: envInt('MONITOR_NETWORK_FAILURES_TO_ALERT', 2),
      clearChecks: envInt('MONITOR_NETWORK_CLEAR_CHECKS', 2),
    },
  };
}

interface CpuStat {
  total: number;
  idle: number;
  iowait: number;
}

function parseCpuStat(raw: string): CpuStat | null {
  const first = raw.split('\n')[0] || '';
  if (!first.startsWith('cpu ')) return null;
  const parts = first.trim().split(/\s+/).slice(1).map(n => parseInt(n, 10));
  // cpu user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait counts as idle in classic load
  const iowait = parts[4] || 0;
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { total, idle, iowait };
}

interface LoadAvg {
  load1: number;
  load5: number;
  load15: number;
  cores: number;
}

/** Streak counter keyed by string. Tracks consecutive "bad" ticks plus
 *  consecutive "good" ticks since the last alert, so we can apply
 *  hysteresis to both opening and closing. */
class StreakTracker {
  private bad = new Map<string, number>();
  private good = new Map<string, number>();
  private alerted = new Set<string>();

  /** Returns true if the bad-streak just crossed the open threshold this tick. */
  bumpBad(key: string, threshold: number): boolean {
    const next = (this.bad.get(key) || 0) + 1;
    this.bad.set(key, next);
    this.good.set(key, 0);
    if (next >= threshold && !this.alerted.has(key)) {
      this.alerted.add(key);
      return true;
    }
    return false;
  }

  /** Returns true if we have an active alert AND the good-streak just
   *  reached the clear threshold (i.e. we should auto-resolve now). */
  bumpGood(key: string, threshold: number): boolean {
    if (!this.alerted.has(key)) {
      this.bad.set(key, 0);
      return false;
    }
    const next = (this.good.get(key) || 0) + 1;
    this.good.set(key, next);
    if (next >= threshold) {
      this.alerted.delete(key);
      this.bad.set(key, 0);
      this.good.set(key, 0);
      return true;
    }
    return false;
  }

  hasAlert(key: string): boolean {
    return this.alerted.has(key);
  }
}

/** Build the sourceRef for a monitor + server. Local server keeps the
 *  legacy (un-suffixed) refs so any incidents already open at upgrade
 *  time stay matched. Remote servers always get the name suffix. */
function refFor(monitor: string, server: MonitoredServer): string {
  return server.isLocal ? monitor : `${monitor}:${server.name}`;
}

/** Title prefix to make per-server incidents readable in the UI. */
function titlePrefix(server: MonitoredServer): string {
  return server.isLocal ? '' : `[${server.name}] `;
}

export class SystemMonitors {
  private cfg: MonitorConfig;
  private cpu = new StreakTracker();
  private iowait = new StreakTracker();
  private services = new StreakTracker();
  private dockerStreak = new StreakTracker();
  private net = new StreakTracker();
  /** Last /proc/stat reading per server — delta-based iowait needs a prior sample. */
  private lastCpuStat = new Map<string, CpuStat>();
  /** RestartCount snapshot per (serverId, container) plus a sliding window
   *  of when restart-count increased. The window is what we threshold against. */
  private dockerRestartHistory = new Map<string, { lastCount: number; events: number[] }>();
  /** Avoid re-alerting on the same exited container until we see it
   *  recover or get recreated (track by startedAt). */
  private dockerLastExitedSeen = new Map<string, string>();

  constructor(private deps: SystemMonitorsDeps) {
    this.cfg = loadConfig();
    this.deps.log.info('system-monitors initialised', {
      cpu: this.cfg.cpu.enabled,
      docker: this.cfg.docker.enabled,
      services: this.cfg.service.enabled ? this.cfg.service.names : false,
      iowait: this.cfg.iowait.enabled,
      certs: this.cfg.cert.enabled ? this.cfg.cert.domains.length : false,
      net: this.cfg.net.enabled ? this.cfg.net.hosts : false,
    });
  }

  /** Run every monitor once across every enabled server. Per-server
   *  probes run in parallel via Promise.allSettled so one host being
   *  slow or unreachable doesn't block the rest. Global probes (cert,
   *  network) run once per tick after the per-server pass. */
  async tick(): Promise<void> {
    const servers = this.deps.registry.enabledServers();
    await Promise.allSettled(servers.map(s => this.tickServer(s)));
    // Global probes — only one instance of each per tick.
    await Promise.allSettled([
      this.checkCerts().catch(e => this.deps.log.error('cert monitor failed', { err: e.message })),
      this.checkNetwork().catch(e => this.deps.log.error('network monitor failed', { err: e.message })),
    ]);
  }

  private async tickServer(server: MonitoredServer): Promise<void> {
    await Promise.all([
      this.checkCpu(server).catch(e => this.deps.log.error('cpu monitor failed', { server: server.name, err: e.message })),
      this.checkDocker(server).catch(e => this.deps.log.error('docker monitor failed', { server: server.name, err: e.message })),
      this.checkServices(server).catch(e => this.deps.log.error('service monitor failed', { server: server.name, err: e.message })),
      this.checkIoWait(server).catch(e => this.deps.log.error('iowait monitor failed', { server: server.name, err: e.message })),
    ]);
  }

  // ─── 1. CPU sustained load ─────────────────────────────────────────────
  private async checkCpu(server: MonitoredServer): Promise<void> {
    if (!this.cfg.cpu.enabled) return;
    const la = await this.readLoadAvg(server);
    if (!la) return;
    const pct = Math.round((la.load1 / la.cores) * 100);
    const over = pct >= this.cfg.cpu.thresholdPct;
    const key = refFor('cpu:sustained', server);

    if (over) {
      if (this.cpu.bumpBad(key, this.cfg.cpu.sustainedChecks)) {
        this.openIncident(server, {
          title: `CPU sustained load: ${pct}% of ${la.cores} cores`,
          description: `Load average (1m) has been at or above ${this.cfg.cpu.thresholdPct}% of capacity for ${this.cfg.cpu.sustainedChecks} consecutive checks. Current: load1=${la.load1.toFixed(2)} on ${la.cores} cores (${pct}%).`,
          severity: 'high',
          sourceRef: key,
          notify: { title: 'CPU Sustained Load', type: 'warning' },
        });
      }
    } else {
      if (this.cpu.bumpGood(key, this.cfg.cpu.clearChecks)) {
        this.resolveIncident(key, `CPU load recovered to ${pct}% of capacity`);
      }
    }
  }

  /** /proc/loadavg + nproc gives us the same shape `os.loadavg()` did,
   *  but for any target server via the executor. */
  private async readLoadAvg(server: MonitoredServer): Promise<LoadAvg | null> {
    try {
      // Single shell so we get both pieces in one round-trip.
      const r = await this.deps.executor.execute(
        server,
        'cat /proc/loadavg; echo ---; nproc',
        { timeoutMs: 8_000 },
      );
      if (r.exitCode !== 0) return null;
      const [loadStr, _sep, nprocStr] = r.stdout.split(/\n/);
      const m = (loadStr || '').trim().split(/\s+/);
      const load1 = Number(m[0]); const load5 = Number(m[1]); const load15 = Number(m[2]);
      const cores = Math.max(1, parseInt((nprocStr || '1').trim(), 10) || 1);
      if (!Number.isFinite(load1)) return null;
      return { load1, load5, load15, cores };
    } catch (e: any) {
      this.deps.log.debug('loadavg probe failed', { server: server.name, err: e.message });
      return null;
    }
  }

  // ─── 2. Docker container health ────────────────────────────────────────
  private async checkDocker(server: MonitoredServer): Promise<void> {
    if (!this.cfg.docker.enabled) return;
    const containers = await this.dockerInspectAll(server);
    if (containers == null) return; // docker not reachable on this server; skip silently

    const now = Date.now();
    const windowStart = now - this.cfg.docker.restartWindowMs;

    for (const c of containers) {
      const name = c.name;
      const unhealthyKey = refFor(`container:unhealthy:${name}`, server);
      const restartKey   = refFor(`container:restartloop:${name}`, server);
      const exitedKey    = refFor(`container:exited:${name}`, server);
      const histKey      = `${server.id}::${name}`;

      // Unhealthy state (only when a healthcheck is defined; absent = "none")
      const unhealthy = c.health === 'unhealthy';
      if (unhealthy) {
        if (this.dockerStreak.bumpBad(unhealthyKey, 1)) {
          this.openIncident(server, {
            title: `Container unhealthy: ${name}`,
            description: `Container "${name}" (image ${c.image}) is in state "${c.state}" with healthcheck status "unhealthy". RestartCount=${c.restartCount}.`,
            severity: 'high',
            sourceRef: unhealthyKey,
            notify: { title: 'Container Unhealthy', type: 'error' },
          });
        }
      } else if (c.health === 'healthy' || c.health === 'none') {
        if (this.dockerStreak.bumpGood(unhealthyKey, this.cfg.docker.clearChecks)) {
          this.resolveIncident(unhealthyKey, `Container "${name}" healthy again`);
        }
      }

      // Restart loop — track restart count deltas over a sliding window
      const hist = this.dockerRestartHistory.get(histKey) ?? { lastCount: c.restartCount, events: [] };
      const delta = c.restartCount - hist.lastCount;
      if (delta > 0) {
        for (let i = 0; i < delta; i++) hist.events.push(now);
      }
      hist.events = hist.events.filter(t => t >= windowStart);
      hist.lastCount = c.restartCount;
      this.dockerRestartHistory.set(histKey, hist);

      if (hist.events.length >= this.cfg.docker.restartThreshold) {
        if (this.dockerStreak.bumpBad(restartKey, 1)) {
          this.openIncident(server, {
            title: `Container restart loop: ${name}`,
            description: `Container "${name}" has restarted ${hist.events.length} times within ${Math.round(this.cfg.docker.restartWindowMs / 60000)} minutes. RestartCount=${c.restartCount}, state=${c.state}.`,
            severity: 'high',
            sourceRef: restartKey,
            notify: { title: 'Container Restart Loop', type: 'error' },
          });
        }
      } else {
        if (this.dockerStreak.bumpGood(restartKey, this.cfg.docker.clearChecks)) {
          this.resolveIncident(restartKey, `Container "${name}" stable for ${this.cfg.docker.clearChecks} ticks`);
        }
      }

      // Exited with non-zero — alert once per (container, startedAt). When
      // the container is started fresh, startedAt changes and we re-arm.
      if (c.state === 'exited' && c.exitCode !== 0) {
        const stamp = `${c.startedAt}|${c.exitCode}`;
        if (this.dockerLastExitedSeen.get(histKey) !== stamp) {
          this.dockerLastExitedSeen.set(histKey, stamp);
          if (this.dockerStreak.bumpBad(exitedKey, 1)) {
            this.openIncident(server, {
              title: `Container exited (${c.exitCode}): ${name}`,
              description: `Container "${name}" exited with code ${c.exitCode} at ${c.finishedAt || 'unknown'}. Image: ${c.image}.`,
              severity: 'high',
              sourceRef: exitedKey,
              notify: { title: 'Container Exited', type: 'error' },
            });
          }
        }
      } else if (c.state === 'running') {
        this.dockerLastExitedSeen.delete(histKey);
        if (this.dockerStreak.bumpGood(exitedKey, this.cfg.docker.clearChecks)) {
          this.resolveIncident(exitedKey, `Container "${name}" running again`);
        }
      }
    }

    // Prune state for containers we no longer see on this server.
    const seenKeys = new Set(containers.map(c => `${server.id}::${c.name}`));
    for (const k of [...this.dockerRestartHistory.keys()]) {
      if (k.startsWith(`${server.id}::`) && !seenKeys.has(k)) this.dockerRestartHistory.delete(k);
    }
    for (const k of [...this.dockerLastExitedSeen.keys()]) {
      if (k.startsWith(`${server.id}::`) && !seenKeys.has(k)) this.dockerLastExitedSeen.delete(k);
    }
  }

  private async dockerInspectAll(server: MonitoredServer): Promise<Array<{
    name: string;
    image: string;
    state: string;
    health: 'healthy' | 'unhealthy' | 'starting' | 'none';
    restartCount: number;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
  }> | null> {
    try {
      const ids = await this.deps.executor.executeFile(server, 'docker', ['ps', '-a', '--format', '{{.Names}}'], { timeoutMs: 8_000 });
      if (ids.exitCode !== 0) return null; // docker not present / not reachable
      if (!ids.stdout.trim()) return [];
      const names = ids.stdout.trim().split('\n').filter(Boolean);
      const inspectFmt =
        '{{.Name}}|{{.Config.Image}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.ExitCode}}|{{.State.StartedAt}}|{{.State.FinishedAt}}';
      const out = await this.deps.executor.executeFile(server, 'docker', ['inspect', '--format', inspectFmt, ...names], { timeoutMs: 15_000 });
      if (out.exitCode !== 0) return null;
      const rows = out.stdout.trim().split('\n').filter(Boolean);
      return rows.map(line => {
        const [name, image, state, health, rc, ec, sa, fa] = line.split('|');
        return {
          name: (name || '').replace(/^\//, ''),
          image: image || '',
          state: state || '',
          health: (health as any) || 'none',
          restartCount: parseInt(rc, 10) || 0,
          exitCode: parseInt(ec, 10) || 0,
          startedAt: sa || '',
          finishedAt: fa || '',
        };
      });
    } catch (e: any) {
      this.deps.log.debug('docker inspect failed', { server: server.name, err: e.message });
      return null;
    }
  }

  // ─── 3. Systemd service failures ───────────────────────────────────────
  private async checkServices(server: MonitoredServer): Promise<void> {
    if (!this.cfg.service.enabled || this.cfg.service.names.length === 0) return;
    for (const svc of this.cfg.service.names) {
      const key = refFor(`service:failed:${svc}`, server);
      const status = await this.systemctlStatus(server, svc);
      if (status === 'active' || status === 'activating') {
        if (this.services.bumpGood(key, this.cfg.service.clearChecks)) {
          this.resolveIncident(key, `Service "${svc}" active again`);
        }
        continue;
      }
      if (status == null) {
        // systemctl probe itself failed (ssh down, systemctl missing) — skip.
        this.deps.log.debug('service probe inconclusive', { server: server.name, svc });
        continue;
      }
      // failed / inactive / unknown — open an incident.
      if (this.services.bumpBad(key, 1)) {
        this.openIncident(server, {
          title: `Service down: ${svc}`,
          description: `systemctl reports "${svc}" status="${status}". This service is in the MONITORED_SERVICES list and must be running.`,
          severity: 'critical',
          sourceRef: key,
          notify: { title: 'Service Down', type: 'error' },
        });
      }
    }
  }

  private async systemctlStatus(server: MonitoredServer, svc: string): Promise<string | null> {
    try {
      // `is-active` prints "active" | "inactive" | "failed" | "activating"
      // | "deactivating" | "unknown" and exits non-zero on anything other
      // than "active". The executor returns the captured output regardless
      // of exit code, so we key off stdout.
      let inactiveStatus: string | null = null;
      for (const candidate of serviceCandidates(svc)) {
        const r = await this.deps.executor.executeFile(server, 'systemctl', ['is-active', candidate], { timeoutMs: 8_000 });
        const status = (r.stdout || '').trim();
        if (status === 'active' || status === 'activating') return status;
        if (['inactive', 'failed', 'deactivating'].includes(status) || r.exitCode === 3) inactiveStatus = status || 'inactive';
      }
      return inactiveStatus;
    } catch {
      return null;
    }
  }

  // ─── 4. Disk I/O wait ──────────────────────────────────────────────────
  private async checkIoWait(server: MonitoredServer): Promise<void> {
    if (!this.cfg.iowait.enabled) return;
    const cur = await this.readCpuStat(server);
    if (!cur) return;
    const prev = this.lastCpuStat.get(server.id);
    this.lastCpuStat.set(server.id, cur);
    if (!prev) return; // need a baseline first

    const dTotal = cur.total - prev.total;
    const dIowait = cur.iowait - prev.iowait;
    if (dTotal <= 0) return; // clock anomaly
    const pct = Math.round((dIowait / dTotal) * 100);
    const key = refFor('iowait:sustained', server);

    if (pct >= this.cfg.iowait.thresholdPct) {
      if (this.iowait.bumpBad(key, this.cfg.iowait.sustainedChecks)) {
        this.openIncident(server, {
          title: `Disk I/O wait sustained: ${pct}%`,
          description: `CPU iowait has been at or above ${this.cfg.iowait.thresholdPct}% for ${this.cfg.iowait.sustainedChecks} consecutive checks. Current delta: ${pct}% (${dIowait}/${dTotal} jiffies).`,
          severity: 'high',
          sourceRef: key,
          notify: { title: 'High I/O Wait', type: 'warning' },
        });
      }
    } else {
      if (this.iowait.bumpGood(key, this.cfg.iowait.clearChecks)) {
        this.resolveIncident(key, `I/O wait recovered to ${pct}%`);
      }
    }
  }

  private async readCpuStat(server: MonitoredServer): Promise<CpuStat | null> {
    try {
      // For the local server we used to read /proc/stat via fs directly —
      // keep that fast path as a fallback when the executor isn't usable
      // (e.g. nsenter binary missing in dev environments), but prefer the
      // executor so the iowait monitor works identically across hosts.
      const r = await this.deps.executor.execute(server, 'cat /proc/stat', { timeoutMs: 5_000 });
      if (r.exitCode === 0 && r.stdout) {
        return parseCpuStat(r.stdout);
      }
      if (server.isLocal) {
        return parseCpuStat(fs.readFileSync('/proc/stat', 'utf8'));
      }
      return null;
    } catch {
      if (server.isLocal) {
        try { return parseCpuStat(fs.readFileSync('/proc/stat', 'utf8')); } catch { /* fall through */ }
      }
      return null;
    }
  }

  // ─── 5. SSL/TLS certificate expiry ────────────────────────────────────
  // Global probe — the domain list isn't bound to any single server; the
  // check runs once per tick regardless of how many servers are enabled.
  private async checkCerts(): Promise<void> {
    if (!this.cfg.cert.enabled || this.cfg.cert.domains.length === 0) return;
    // Cert incidents are filed against the local server — they're an
    // observation by the monitor host, not about a remote box.
    const local = this.deps.registry.get(LOCAL_SERVER_ID) ?? this.deps.registry.enabledServers()[0];
    if (!local) return;
    for (const domain of this.cfg.cert.domains) {
      const key = `cert:expiring:${domain}`;
      const notAfter = await this.certExpiry(domain);
      if (notAfter == null) {
        this.deps.log.debug('cert probe inconclusive', { domain });
        continue;
      }
      const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
      if (daysLeft <= this.cfg.cert.warnDays) {
        const severity: 'medium' | 'high' = daysLeft <= this.cfg.cert.criticalDays ? 'high' : 'medium';
        this.deps.incidentManager.create({
          title: `TLS cert expiring (${daysLeft}d): ${domain}`,
          description: `Certificate for ${domain} expires at ${notAfter.toISOString()} (${daysLeft} days left). Threshold ${this.cfg.cert.warnDays}d (warn) / ${this.cfg.cert.criticalDays}d (critical).`,
          severity,
          source: 'health-monitor',
          sourceRef: key,
          serverId: local.id,
          dedupBy: 'sourceRef',
          updateOnDup: true,
        });
        this.deps.notify({
          type: severity === 'high' ? 'error' : 'warning',
          title: 'TLS Cert Expiring',
          message: `${domain}: ${daysLeft} days left`,
        });
      } else {
        // Comfortably valid — auto-resolve any prior alert.
        this.resolveIncident(key, `Certificate for ${domain} now valid for ${daysLeft} days`);
      }
    }
  }

  private certExpiry(domain: string): Promise<Date | null> {
    const [host, portStr] = domain.split(':');
    const port = parseInt(portStr || '443', 10);
    return new Promise(resolve => {
      const socket = tls.connect({
        host,
        port,
        servername: host,
        // We want the cert, not a trust verdict — a self-signed or expired
        // cert shouldn't make us silently fail to read the expiry date.
        rejectUnauthorized: false,
        timeout: 5000,
      });
      const done = (v: Date | null) => {
        try { socket.destroy(); } catch {}
        resolve(v);
      };
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return done(null);
        const d = new Date(cert.valid_to);
        done(isNaN(d.getTime()) ? null : d);
      });
      socket.once('timeout', () => done(null));
      socket.once('error', () => done(null));
    });
  }

  // ─── 6. Network connectivity ───────────────────────────────────────────
  // Global probe — pings external hosts from the local server's network
  // namespace. Running it per-server would just replicate the same probe.
  private async checkNetwork(): Promise<void> {
    if (!this.cfg.net.enabled || this.cfg.net.hosts.length === 0) return;
    const local = this.deps.registry.get(LOCAL_SERVER_ID) ?? this.deps.registry.enabledServers()[0];
    if (!local) return;
    for (const host of this.cfg.net.hosts) {
      const key = `network:unreachable:${host}`;
      const ok = await this.pingHost(local, host);
      if (ok) {
        if (this.net.bumpGood(key, this.cfg.net.clearChecks)) {
          this.resolveIncident(key, `Host ${host} reachable again`);
        }
      } else {
        if (this.net.bumpBad(key, this.cfg.net.failuresToAlert)) {
          this.openIncident(local, {
            title: `Network unreachable: ${host}`,
            description: `Host ${host} did not respond to ICMP echo for ${this.cfg.net.failuresToAlert} consecutive checks.`,
            severity: 'high',
            sourceRef: key,
            notify: { title: 'Network Unreachable', type: 'error' },
          });
        }
      }
    }
  }

  private async pingHost(server: MonitoredServer, host: string): Promise<boolean> {
    try {
      const r = await this.deps.executor.executeFile(server, 'ping', ['-c', '1', '-W', '2', host], { timeoutMs: 8_000 });
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  private openIncident(server: MonitoredServer, args: {
    title: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    sourceRef: string;
    notify?: { title: string; type: 'info' | 'warning' | 'error' };
  }): void {
    try {
      this.deps.incidentManager.create({
        title: `${titlePrefix(server)}${args.title}`,
        description: args.description,
        severity: args.severity,
        source: 'health-monitor',
        sourceRef: args.sourceRef,
        serverId: server.id,
        dedupBy: 'sourceRef',
        // No assignedTo — dispatchIncidentToAgent fills it from the
        // picker output. Hardcoding 'IT Director' here used to bypass
        // the picker because assignAgent only fills assignedTo when
        // it's null, leaving every health-monitor incident permanently
        // labelled "IT Director" even after Ops Bravo / Ops Charlie /
        // etc. were actually doing the work via assignedAgent.
      });
      if (args.notify) {
        this.deps.notify({
          type: args.notify.type,
          title: args.notify.title,
          message: `${titlePrefix(server)}${args.title}`,
        });
      }
      this.deps.log.warn('opened incident', { server: server.name, sourceRef: args.sourceRef, severity: args.severity });
    } catch (e: any) {
      this.deps.log.error('failed to open incident', { err: e.message, server: server.name, sourceRef: args.sourceRef });
    }
  }

  private resolveIncident(sourceRef: string, reason: string): void {
    try {
      const ids = this.deps.incidentManager.resolveActiveByRef(
        inc => inc.source === 'health-monitor' && inc.sourceRef === sourceRef,
        reason,
        'health-monitor',
        { verifyAfterResolve: true },
      );
      if (ids.length > 0) {
        this.deps.log.info('auto-resolved incident', { ids, sourceRef, reason });
      }
    } catch (e: any) {
      this.deps.log.error('failed to resolve incident', { err: e.message, sourceRef });
    }
  }
}

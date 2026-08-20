// PrometheusPlugin — exposes itops events as Prometheus metrics.
//
// Doesn't make outbound HTTP calls. Instead it owns an in-memory registry
// of counters + gauges, updates them on lifecycle hooks, and renders the
// classic text exposition format on demand. The existing /metrics handler
// concatenates this plugin's output, so external Prometheus scrapers see
// itops_* metrics alongside the legacy beacon_* gauges.
//
// Metric set (matches the spec):
//   itops_incidents_total{severity, status, server}      counter
//   itops_incidents_active{severity, server}             gauge   (snapshot)
//   itops_server_cpu_percent{server}                     gauge
//   itops_server_memory_percent{server}                  gauge
//   itops_server_disk_percent{server, mount}             gauge
//   itops_runbook_runs_total{runbook, status}            counter
//   itops_alerts_fired_total{severity, rule}             counter
//
// Notes on cardinality: we label by server + mount which can balloon on
// hosts with many filesystems. The PrometheusPlugin only stores the
// LATEST gauge value per (server, mount), so a host churning through
// ephemeral mounts ends up with stale labels — that's the standard
// Prometheus tradeoff; not solving it here.

import type {
  ITOpsPlugin, PluginConfigField, PluginContext,
  MetricCollectedPayload,
} from '../PluginInterface.js';
import type { Incident } from '../../persistence/SqliteStore.js';
import type { RunbookRun } from '../../runbooks/RunbookTypes.js';
import type { AlertPayload } from '../PluginInterface.js';

interface Cfg {
  /** Reserved for future use — e.g. registering with a remote-write
   *  endpoint. For now the plugin always renders into the local /metrics
   *  handler so this is informational. */
  prometheusUrl?: string;
  scrapeInterval?: number;
}

type LabelMap = Record<string, string>;

function labelKey(labels: LabelMap): string {
  return Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join('|');
}

function formatLabels(labels: LabelMap): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  // Sort by key so the rendered output is deterministic — important
  // for both Prometheus parsers and for our tests that assert on
  // specific label orderings.
  return '{' + keys.map(k => `${k}="${escapeLabel(labels[k])}"`).join(',') + '}';
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Counter {
  private values = new Map<string, { labels: LabelMap; value: number }>();
  constructor(public readonly name: string, public readonly help: string) {}
  inc(labels: LabelMap, by = 1): void {
    const k = labelKey(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else this.values.set(k, { labels, value: by });
  }
  render(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      out.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return out.join('\n');
  }
}

class Gauge {
  private values = new Map<string, { labels: LabelMap; value: number }>();
  constructor(public readonly name: string, public readonly help: string) {}
  set(labels: LabelMap, value: number): void {
    this.values.set(labelKey(labels), { labels, value });
  }
  clear(): void { this.values.clear(); }
  render(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      out.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return out.join('\n');
  }
}

export class PrometheusPlugin implements ITOpsPlugin {
  readonly id = 'prometheus';
  readonly name = 'Prometheus';
  readonly version = '1.0.0';
  readonly description = 'Exposes itops_* counters/gauges (incidents, servers, runbooks, alerts) on the existing /metrics endpoint.';

  readonly configSchema: PluginConfigField[] = [
    { key: 'prometheusUrl', label: 'Prometheus base URL (optional)', type: 'url', required: false, placeholder: 'http://prometheus:9090', helpText: 'Used for the status tile only — itops always emits metrics locally on /metrics.' },
    { key: 'scrapeInterval', label: 'Recommended scrape interval (seconds)', type: 'number', required: false, default: 30, helpText: 'Surfaced in the status tile so an operator can configure their Prometheus correctly.' },
  ];

  private cfg: Cfg | null = null;
  private ctx: PluginContext | null = null;

  // ── Metric registry ──────────────────────────────────────────────────
  private readonly incidentsTotal = new Counter('itops_incidents_total', 'Cumulative itops incidents by severity, status, server.');
  private readonly incidentsActive = new Gauge('itops_incidents_active', 'Currently-active itops incidents by severity, server.');
  private readonly serverCpu     = new Gauge('itops_server_cpu_percent', 'CPU usage % of last health-monitor tick, per server.');
  private readonly serverMemory  = new Gauge('itops_server_memory_percent', 'Memory usage % of last tick, per server.');
  private readonly serverDisk    = new Gauge('itops_server_disk_percent', 'Disk usage % of last tick, per server + mount.');
  private readonly runbookRuns   = new Counter('itops_runbook_runs_total', 'Runbook runs by template + final status.');
  private readonly alertsFired   = new Counter('itops_alerts_fired_total', 'Alerts fired by severity + rule.');

  async onLoad(rawConfig: Record<string, unknown>, context: PluginContext): Promise<void> {
    this.cfg = {
      prometheusUrl: rawConfig.prometheusUrl ? String(rawConfig.prometheusUrl) : undefined,
      scrapeInterval: typeof rawConfig.scrapeInterval === 'number' ? rawConfig.scrapeInterval : 30,
    };
    this.ctx = context;
    context.logger.info('[PrometheusPlugin] loaded — metrics will be merged into /metrics');
  }

  async onUnload(): Promise<void> {
    // Don't clear the metric registry on unload — operators can still see
    // last-known values until process restart. (Mimics how prom-client
    // behaves when an exporter is briefly down.)
    this.cfg = null;
    this.ctx = null;
  }

  async onIncidentCreated(incident: Incident): Promise<void> {
    this.incidentsTotal.inc({
      severity: incident.severity,
      status: 'open',
      server: incident.serverId ?? 'unknown',
    });
    this.refreshActiveGauge();
  }

  async onIncidentResolved(incident: Incident): Promise<void> {
    this.incidentsTotal.inc({
      severity: incident.severity,
      status: 'resolved',
      server: incident.serverId ?? 'unknown',
    });
    this.refreshActiveGauge();
  }

  async onIncidentEscalated(incident: Incident, level: number): Promise<void> {
    this.incidentsTotal.inc({
      severity: incident.severity,
      status: `escalated_L${level}`,
      server: incident.serverId ?? 'unknown',
    });
  }

  async onMetricCollected(payload: MetricCollectedPayload): Promise<void> {
    const serverId = payload.server.id;
    for (const s of payload.samples) {
      switch (s.metricType) {
        case 'cpu':    this.serverCpu.set({ server: serverId }, s.value); break;
        case 'memory': this.serverMemory.set({ server: serverId }, s.value); break;
        case 'disk':   this.serverDisk.set({ server: serverId, mount: s.dimension ?? '/' }, s.value); break;
        // load1 / load5 omitted from the gauge set — spec lists CPU/mem/
        // disk only. Could add later via `itops_server_load*` if needed.
      }
    }
  }

  async onRunbookCompleted(run: RunbookRun): Promise<void> {
    this.runbookRuns.inc({ runbook: run.templateId, status: run.status });
  }

  async onAlertFired(alert: AlertPayload): Promise<void> {
    this.alertsFired.inc({ severity: alert.severity, rule: alert.ruleName });
  }

  async getExternalStatus(): Promise<Record<string, unknown>> {
    return {
      configured: !!this.cfg,
      scrapeInterval: this.cfg?.scrapeInterval ?? 30,
      prometheusUrl: this.cfg?.prometheusUrl ?? null,
      metrics: {
        incidents_total_series: this.countSeries(this.incidentsTotal),
        active_gauge_series: this.countSeries(this.incidentsActive),
        server_metrics_series:
          this.countSeries(this.serverCpu) +
          this.countSeries(this.serverMemory) +
          this.countSeries(this.serverDisk),
        runbook_runs_series: this.countSeries(this.runbookRuns),
        alerts_fired_series: this.countSeries(this.alertsFired),
      },
    };
  }

  renderPrometheus(): string {
    return [
      this.incidentsTotal.render(),
      this.incidentsActive.render(),
      this.serverCpu.render(),
      this.serverMemory.render(),
      this.serverDisk.render(),
      this.runbookRuns.render(),
      this.alertsFired.render(),
    ].join('\n') + '\n';
  }

  /** Refresh the `itops_incidents_active` gauge from the live store
   *  rather than tracking deltas. Cheap (sqlite read) and resilient to
   *  in-flight transitions we didn't see (e.g. an operator resolving via
   *  the CLI). */
  private refreshActiveGauge(): void {
    if (!this.ctx) return;
    this.incidentsActive.clear();
    const open = this.ctx.incidents.list({ status: 'open' });
    const investigating = this.ctx.incidents.list({ status: 'investigating' });
    const mitigating = this.ctx.incidents.list({ status: 'mitigating' });
    const counts = new Map<string, number>();
    for (const inc of [...open, ...investigating, ...mitigating]) {
      const k = labelKey({ severity: inc.severity, server: inc.serverId ?? 'unknown' });
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const inc of [...open, ...investigating, ...mitigating]) {
      const labels = { severity: inc.severity, server: inc.serverId ?? 'unknown' };
      const count = counts.get(labelKey(labels)) ?? 0;
      this.incidentsActive.set(labels, count);
    }
  }

  private countSeries(reg: Counter | Gauge): number {
    return (reg as unknown as { values: Map<string, unknown> }).values.size;
  }
}

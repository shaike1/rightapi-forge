import * as os from 'os';

// Simple Prometheus-compatible text exposition format
export class MetricsExporter {
  private counters: Map<string, { value: number; labels?: Record<string, string>; help: string }[]> = new Map();
  private gauges: Map<string, { value: number; labels?: Record<string, string>; help: string }[]> = new Map();
  private histograms: Map<string, { buckets: number[]; counts: number[]; sum: number; count: number; help: string }> = new Map();

  // ── Registration ────────────────────────────────────────────────────────────

  counter(name: string, help: string, value: number, labels?: Record<string, string>): void {
    if (!this.counters.has(name)) this.counters.set(name, []);
    const existing = this.counters.get(name)!;
    const idx = existing.findIndex(e => JSON.stringify(e.labels) === JSON.stringify(labels));
    if (idx >= 0) existing[idx].value += value;
    else existing.push({ value, labels, help });
  }

  gauge(name: string, help: string, value: number, labels?: Record<string, string>): void {
    if (!this.gauges.has(name)) this.gauges.set(name, []);
    const existing = this.gauges.get(name)!;
    const idx = existing.findIndex(e => JSON.stringify(e.labels) === JSON.stringify(labels));
    if (idx >= 0) existing[idx].value = value;
    else existing.push({ value, labels, help });
  }

  // ── Exposition ──────────────────────────────────────────────────────────────

  render(): string {
    const lines: string[] = [];

    // Counters
    this.counters.forEach((entries, name) => {
      if (entries.length) {
        lines.push('# HELP ' + name + ' ' + entries[0].help);
        lines.push('# TYPE ' + name + ' counter');
        entries.forEach(e => lines.push(this.formatLine(name, e.value, e.labels)));
      }
    });

    // Gauges
    this.gauges.forEach((entries, name) => {
      if (entries.length) {
        lines.push('# HELP ' + name + ' ' + entries[0].help);
        lines.push('# TYPE ' + name + ' gauge');
        entries.forEach(e => lines.push(this.formatLine(name, e.value, e.labels)));
      }
    });

    return lines.join('\n') + '\n';
  }

  private formatLine(name: string, value: number, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name + ' ' + value;
    const labelStr = Object.entries(labels).map(([k, v]) => k + '="' + v.replace(/"/g, '\\"') + '"').join(',');
    return name + '{' + labelStr + '} ' + value;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
  }
}

// ── System Metrics Collector ───────────────────────────────────────────────

export function collectSystemMetrics(exporter: MetricsExporter): void {
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const uptime = process.uptime();

  // Process metrics
  exporter.gauge('itops_process_heap_bytes', 'Node.js heap memory used in bytes', mem.heapUsed);
  exporter.gauge('itops_process_heap_total_bytes', 'Node.js heap total in bytes', mem.heapTotal);
  exporter.gauge('itops_process_rss_bytes', 'Node.js RSS memory in bytes', mem.rss);
  exporter.gauge('itops_process_uptime_seconds', 'Process uptime in seconds', Math.round(uptime));

  // OS metrics
  exporter.gauge('itops_os_load_avg_1m', 'OS load average 1 minute', parseFloat(load[0].toFixed(3)));
  exporter.gauge('itops_os_load_avg_5m', 'OS load average 5 minutes', parseFloat(load[1].toFixed(3)));
  exporter.gauge('itops_os_load_avg_15m', 'OS load average 15 minutes', parseFloat(load[2].toFixed(3)));
  exporter.gauge('itops_os_memory_total_bytes', 'Total OS memory in bytes', os.totalmem());
  exporter.gauge('itops_os_memory_free_bytes', 'Free OS memory in bytes', os.freemem());
  exporter.gauge('itops_os_cpu_count', 'Number of CPU cores', os.cpus().length);
}

export function collectAgentMetrics(
  exporter: MetricsExporter,
  agents: Array<{ id: string; name: string; role: string; currentLoad: number; available: boolean }>
): void {
  exporter.gauge('itops_agents_total', 'Total number of agents', agents.length);
  exporter.gauge('itops_agents_available', 'Number of available agents', agents.filter(a => a.available).length);

  agents.forEach(agent => {
    exporter.gauge('itops_agent_load', 'Agent workload (0-1)', agent.currentLoad, {
      agent_id: agent.id,
      agent_name: agent.name,
      role: agent.role
    });
    exporter.gauge('itops_agent_available', 'Agent availability (1=available)', agent.available ? 1 : 0, {
      agent_id: agent.id,
      agent_name: agent.name
    });
  });
}

export function collectTaskMetrics(
  exporter: MetricsExporter,
  tasks: { total: number; running: number; completed: number; failed: number; pending: number }
): void {
  exporter.gauge('itops_tasks_total', 'Total tasks', tasks.total);
  exporter.gauge('itops_tasks_running', 'Currently running tasks', tasks.running);
  exporter.gauge('itops_tasks_completed', 'Completed tasks', tasks.completed);
  exporter.gauge('itops_tasks_failed', 'Failed tasks', tasks.failed);
  exporter.gauge('itops_tasks_pending', 'Pending tasks', tasks.pending);
}

export function collectAlertMetrics(
  exporter: MetricsExporter,
  alerts: { open: number; acknowledged: number; resolved: number; bySeverity: Record<string, number> }
): void {
  exporter.gauge('itops_alerts_open', 'Open alerts', alerts.open);
  exporter.gauge('itops_alerts_acknowledged', 'Acknowledged alerts', alerts.acknowledged);
  exporter.gauge('itops_alerts_resolved', 'Resolved alerts', alerts.resolved);

  Object.entries(alerts.bySeverity || {}).forEach(([severity, count]) => {
    exporter.gauge('itops_alerts_by_severity', 'Alerts by severity', count, { severity });
  });
}

export function collectGatewayMetrics(
  exporter: MetricsExporter,
  stats: { totalKeys: number; activeKeys: number; requestsLastHour: number; requestsLastDay: number; avgDurationMs: number }
): void {
  exporter.gauge('itops_gateway_keys_total', 'Total API keys', stats.totalKeys);
  exporter.gauge('itops_gateway_keys_active', 'Active API keys', stats.activeKeys);
  exporter.gauge('itops_gateway_requests_last_hour', 'API requests in last hour', stats.requestsLastHour);
  exporter.gauge('itops_gateway_requests_last_day', 'API requests in last day', stats.requestsLastDay);
  exporter.gauge('itops_gateway_avg_duration_ms', 'Average request duration in ms', stats.avgDurationMs);
}

export function collectWsMetrics(
  exporter: MetricsExporter,
  stats: { connectedClients: number; totalMessages: number }
): void {
  exporter.gauge('itops_ws_connected_clients', 'Connected WebSocket clients', stats.connectedClients);
  exporter.counter('itops_ws_messages_total', 'Total WebSocket messages sent', stats.totalMessages);
}

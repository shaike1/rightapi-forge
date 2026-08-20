import { TimeSeriesStore, Granularity } from './TimeSeriesStore.js';

export interface TrendResult {
  metric: string;
  trend: 'up' | 'down' | 'stable';
  changePercent: number;
  current: number;
  previous: number;
}

export interface SystemSnapshot {
  ts: number;
  tasks: { total: number; completed: number; pending: number; failed: number };
  agents: { total: number; active: number };
  alerts: { firing: number; critical: number };
  anomalies: number;
}

export class AnalyticsEngine {
  constructor(private store: TimeSeriesStore) {}

  // Record a snapshot of system state
  recordSystemSnapshot(snapshot: SystemSnapshot): void {
    const ts = snapshot.ts || Date.now();
    this.store.insert('system.tasks.total',     snapshot.tasks.total,     {}, ts);
    this.store.insert('system.tasks.completed', snapshot.tasks.completed, {}, ts);
    this.store.insert('system.tasks.pending',   snapshot.tasks.pending,   {}, ts);
    this.store.insert('system.tasks.failed',    snapshot.tasks.failed,    {}, ts);
    this.store.insert('system.agents.total',    snapshot.agents.total,    {}, ts);
    this.store.insert('system.agents.active',   snapshot.agents.active,   {}, ts);
    this.store.insert('system.alerts.firing',   snapshot.alerts.firing,   {}, ts);
    this.store.insert('system.alerts.critical', snapshot.alerts.critical, {}, ts);
    this.store.insert('system.anomalies',       snapshot.anomalies,       {}, ts);
  }

  // Get trend for a metric over the last N hours
  getTrend(metric: string, hours = 24): TrendResult {
    const now = Date.now();
    const midpoint = now - (hours / 2) * 3_600_000;
    const from = now - hours * 3_600_000;

    const first = this.store.query(metric, from, midpoint, '1h');
    const second = this.store.query(metric, midpoint, now, '1h');

    const prev = first.length ? first.reduce((s, p) => s + p.avg, 0) / first.length : 0;
    const curr = second.length ? second.reduce((s, p) => s + p.avg, 0) / second.length : 0;

    const changePercent = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    const trend = changePercent > 5 ? 'up' : changePercent < -5 ? 'down' : 'stable';

    return { metric, trend, changePercent: Math.round(changePercent * 10) / 10, current: Math.round(curr * 100) / 100, previous: Math.round(prev * 100) / 100 };
  }

  // Get all trends for system metrics
  getSystemTrends(hours = 24): TrendResult[] {
    const metrics = [
      'system.tasks.total', 'system.tasks.completed', 'system.tasks.failed',
      'system.agents.active', 'system.alerts.firing', 'system.anomalies'
    ];
    return metrics.map(m => this.getTrend(m, hours)).filter(t => t.current > 0 || t.previous > 0);
  }

  // Get chart data for a metric
  getChartData(metric: string, from: number, to: number, granularity: Granularity = '1h') {
    const points = this.store.query(metric, from, to, granularity);
    return {
      metric,
      granularity,
      labels: points.map(p => new Date(p.bucket).toISOString()),
      datasets: {
        avg: points.map(p => Math.round(p.avg * 100) / 100),
        min: points.map(p => Math.round(p.min * 100) / 100),
        max: points.map(p => Math.round(p.max * 100) / 100),
      },
      points: points.length
    };
  }

  // Get summary report
  getSummaryReport(hours = 24) {
    const now = Date.now();
    const from = now - hours * 3_600_000;
    const storeStats = this.store.stats();
    const metrics = this.store.listMetrics();
    const trends = this.getSystemTrends(hours);

    return {
      generatedAt: new Date().toISOString(),
      period: { hours, from: new Date(from).toISOString(), to: new Date(now).toISOString() },
      store: storeStats,
      metricsTracked: metrics.length,
      trends,
      summary: {
        totalDataPoints: storeStats.totalPoints,
        metricsCollected: metrics,
      }
    };
  }

  // Auto-collect from system (called periodically)
  async collectFromSystem(
    getTaskStats: () => { total: number; completed: number; pending: number; failed: number },
    getAgentStats: () => { total: number; active: number },
    getAlertStats: () => { firing: number; critical: number },
    getAnomalyCount: () => number
  ): Promise<void> {
    try {
      this.recordSystemSnapshot({
        ts: Date.now(),
        tasks: getTaskStats(),
        agents: getAgentStats(),
        alerts: getAlertStats(),
        anomalies: getAnomalyCount()
      });
    } catch (err) {
      console.error('[AnalyticsEngine] Collection failed:', err);
    }
  }
}

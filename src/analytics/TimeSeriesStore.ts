// @ts-ignore
import * as fs from 'fs';
import * as path from 'path';

export interface MetricPoint {
  metric: string;
  value: number;
  labels: Record<string, string>;
  ts: number;
}

export interface AggregatedMetric {
  metric: string;
  bucket: number;
  avg: number;
  min: number;
  max: number;
  count: number;
  sum: number;
}

export type Granularity = '1m' | '5m' | '15m' | '1h' | '6h' | '1d';

const GRANULARITY_MS: Record<Granularity, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '6h':  21_600_000,
  '1d':  86_400_000,
};

export class TimeSeriesStore {
  private dataPath: string;
  private cache: Map<string, MetricPoint[]> = new Map();
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataPath: string = '/data/itops-agents/analytics') {
    this.dataPath = dataPath;
    if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });
    this.load();
    // Flush to disk every 30s
    this.flushTimer = setInterval(() => { if (this.dirty) this.flush(); }, 30_000);
    console.log('[TimeSeriesStore] Ready (JSON store)');
  }

  insert(metric: string, value: number, labels: Record<string, string> = {}, ts?: number): void {
    if (!this.cache.has(metric)) this.cache.set(metric, []);
    this.cache.get(metric)!.push({ metric, value, labels, ts: ts ?? Date.now() });
    this.dirty = true;
  }

  insertBatch(points: MetricPoint[]): void {
    for (const p of points) this.insert(p.metric, p.value, p.labels, p.ts);
  }

  query(metric: string, from: number, to: number, granularity: Granularity = '1h'): AggregatedMetric[] {
    const rows = (this.cache.get(metric) || []).filter(p => p.ts >= from && p.ts <= to);
    if (!rows.length) return [];

    const bucketMs = GRANULARITY_MS[granularity];
    const buckets = new Map<number, number[]>();
    for (const row of rows) {
      const bucket = Math.floor(row.ts / bucketMs) * bucketMs;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(row.value);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([bucket, values]) => ({
        metric,
        bucket,
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        sum: values.reduce((a, b) => a + b, 0),
        count: values.length
      }));
  }

  latest(metric: string, limit = 1): MetricPoint[] {
    const pts = (this.cache.get(metric) || []).slice().sort((a, b) => b.ts - a.ts);
    return pts.slice(0, limit);
  }

  listMetrics(): string[] {
    return Array.from(this.cache.keys()).sort();
  }

  getRange(metric: string): { from: number; to: number; count: number } | null {
    const pts = this.cache.get(metric);
    if (!pts || !pts.length) return null;
    const tss = pts.map(p => p.ts);
    return { from: Math.min(...tss), to: Math.max(...tss), count: pts.length };
  }

  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [metric, pts] of this.cache.entries()) {
      const before = pts.length;
      const filtered = pts.filter(p => p.ts >= cutoff);
      this.cache.set(metric, filtered);
      removed += before - filtered.length;
    }
    if (removed > 0) { this.dirty = true; this.flush(); }
    return removed;
  }

  stats(): { totalPoints: number; metrics: number; oldestTs: number | null } {
    let total = 0;
    let oldest: number | null = null;
    for (const pts of this.cache.values()) {
      total += pts.length;
      for (const p of pts) {
        if (oldest === null || p.ts < oldest) oldest = p.ts;
      }
    }
    return { totalPoints: total, metrics: this.cache.size, oldestTs: oldest };
  }

  private flush(): void {
    try {
      const obj: Record<string, MetricPoint[]> = {};
      for (const [k, v] of this.cache.entries()) obj[k] = v;
      fs.writeFileSync(path.join(this.dataPath, 'metrics.json'), JSON.stringify(obj), 'utf8');
      this.dirty = false;
    } catch (e) { console.error('[TimeSeriesStore] Flush failed:', e); }
  }

  private load(): void {
    try {
      const file = path.join(this.dataPath, 'metrics.json');
      if (fs.existsSync(file)) {
        const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(obj)) this.cache.set(k, v as MetricPoint[]);
        console.log('[TimeSeriesStore] Loaded ' + this.cache.size + ' metric series');
      }
    } catch (e) { console.error('[TimeSeriesStore] Load failed:', e); }
  }
}

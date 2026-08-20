// Anomaly Detection Service
// Detects deviations from baseline behavior

import { EventEmitter } from 'events';

export interface Metric {
  name: string;
  value: number;
  timestamp: Date;
  tags?: Record<string, string>;
}

export interface Baseline {
  metric: string;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  sampleCount: number;
  lastUpdated: Date;
}

export interface Anomaly {
  id: string;
  metric: string;
  value: number;
  baseline: Baseline;
  deviation: number; // standard deviations from mean
  severity: 'info' | 'warning' | 'critical';
  timestamp: Date;
  acknowledged: boolean;
  remediated: boolean;
}

export class AnomalyDetector extends EventEmitter {
  private baselines: Map<string, Baseline> = new Map();
  private recentMetrics: Map<string, Metric[]> = new Map();
  private anomalies: Map<string, Anomaly> = new Map();
  
  private readonly baselineWindow = 100; // samples for baseline
  private readonly criticalThreshold = 3; // std devs
  private readonly warningThreshold = 2; // std devs
  
  constructor() {
    super();
  }
  
  recordMetric(metric: Metric): void {
    const key = metric.name;
    
    // Store recent metrics
    if (!this.recentMetrics.has(key)) {
      this.recentMetrics.set(key, []);
    }
    const recent = this.recentMetrics.get(key)!;
    recent.push(metric);
    
    // Keep only last N samples
    if (recent.length > this.baselineWindow * 2) {
      recent.shift();
    }
    
    // Update baseline if we have enough samples
    if (recent.length >= 10) {
      this.updateBaseline(key, recent);
    }
    
    // Check for anomaly
    const baseline = this.baselines.get(key);
    if (baseline && baseline.sampleCount >= 30) {
      this.checkAnomaly(metric, baseline);
    }
  }
  
  private updateBaseline(metricName: string, samples: Metric[]): void {
    // Use last N samples for baseline
    const baselineSamples = samples.slice(-this.baselineWindow);
    const values = baselineSamples.map(m => m.value);
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    const baseline: Baseline = {
      metric: metricName,
      mean,
      stdDev,
      min,
      max,
      sampleCount: baselineSamples.length,
      lastUpdated: new Date()
    };
    
    this.baselines.set(metricName, baseline);
  }
  
  private checkAnomaly(metric: Metric, baseline: Baseline): void {
    // Skip if stdDev is too small (metric is too stable)
    if (baseline.stdDev < 0.01) return;
    
    const deviation = Math.abs(metric.value - baseline.mean) / baseline.stdDev;
    
    let severity: 'info' | 'warning' | 'critical' | null = null;
    
    if (deviation >= this.criticalThreshold) {
      severity = 'critical';
    } else if (deviation >= this.warningThreshold) {
      severity = 'warning';
    }
    
    if (severity) {
      const anomalyId = `${metric.name}-${Date.now()}`;
      const anomaly: Anomaly = {
        id: anomalyId,
        metric: metric.name,
        value: metric.value,
        baseline,
        deviation,
        severity,
        timestamp: new Date(),
        acknowledged: false,
        remediated: false
      };
      
      this.anomalies.set(anomalyId, anomaly);
      this.emit('anomaly', anomaly);
      
      console.log(`[AnomalyDetector] ${severity.toUpperCase()}: ${metric.name} = ${metric.value} ` +
                  `(baseline: ${baseline.mean.toFixed(2)} ± ${baseline.stdDev.toFixed(2)}, deviation: ${deviation.toFixed(2)}σ)`);
    }
  }
  
  getBaseline(metricName: string): Baseline | undefined {
    return this.baselines.get(metricName);
  }
  
  getAllBaselines(): Baseline[] {
    return Array.from(this.baselines.values());
  }
  
  getAnomalies(filter?: { acknowledged?: boolean; remediated?: boolean }): Anomaly[] {
    let anomalies = Array.from(this.anomalies.values());
    
    if (filter?.acknowledged !== undefined) {
      anomalies = anomalies.filter(a => a.acknowledged === filter.acknowledged);
    }
    
    if (filter?.remediated !== undefined) {
      anomalies = anomalies.filter(a => a.remediated === filter.remediated);
    }
    
    return anomalies.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
  
  acknowledgeAnomaly(id: string): boolean {
    const anomaly = this.anomalies.get(id);
    if (!anomaly) return false;
    
    anomaly.acknowledged = true;
    return true;
  }
  
  markRemediated(id: string): boolean {
    const anomaly = this.anomalies.get(id);
    if (!anomaly) return false;
    
    anomaly.remediated = true;
    return true;
  }
  
  // Cleanup old anomalies (keep last 1000)
  cleanup(): void {
    if (this.anomalies.size > 1000) {
      const sorted = Array.from(this.anomalies.entries())
        .sort((a, b) => b[1].timestamp.getTime() - a[1].timestamp.getTime());
      
      this.anomalies.clear();
      sorted.slice(0, 1000).forEach(([id, anomaly]) => {
        this.anomalies.set(id, anomaly);
      });
    }
  }
}

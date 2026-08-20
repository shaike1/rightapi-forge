import fs from 'node:fs';
import path from 'node:path';
import type { OpenAIRouteHealth } from './openai.js';

export type ProviderHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unavailable';

export interface ProviderHealthAlert {
  id: string;
  active: boolean;
  severity: 'warning' | 'critical';
  reason: string;
  openedAt: string;
  clearedAt: string | null;
}

export interface ProviderHealthSnapshot {
  status: ProviderHealthStatus;
  activeRoute: 'primary' | 'fallback' | null;
  lastProbeAt: string | null;
  routes: OpenAIRouteHealth[];
  alert: ProviderHealthAlert | null;
}

export class ProviderHealthMonitor {
  private state: ProviderHealthSnapshot = {
    status: 'unknown', activeRoute: null, lastProbeAt: null, routes: [], alert: null,
  };

  constructor(private readonly statePath?: string, private readonly now: () => Date = () => new Date()) {
    this.load();
  }

  evaluate(routes: OpenAIRouteHealth[], activeRoute: 'primary' | 'fallback' | null): ProviderHealthSnapshot {
    const now = this.now().toISOString();
    const primary = routes.find(route => route.route === 'primary');
    const fallback = routes.find(route => route.route === 'fallback');
    const primaryHealthy = isHealthy(primary);
    const fallbackHealthy = isHealthy(fallback);
    const status: ProviderHealthStatus = primaryHealthy
      ? 'healthy'
      : fallbackHealthy ? 'degraded' : 'unavailable';

    let alert = this.state.alert;
    if (status !== 'healthy') {
      const reason = failureReason(primary, fallback);
      if (!alert?.active) {
        alert = {
          id: `provider-health-${Date.now()}`,
          active: true,
          severity: status === 'unavailable' ? 'critical' : 'warning',
          reason,
          openedAt: now,
          clearedAt: null,
        };
      } else {
        alert = { ...alert, severity: status === 'unavailable' ? 'critical' : 'warning', reason };
      }
    } else if (alert?.active) {
      alert = { ...alert, active: false, clearedAt: now };
    }

    this.state = { status, activeRoute, lastProbeAt: now, routes, alert };
    this.save();
    return this.snapshot();
  }

  snapshot(): ProviderHealthSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as ProviderHealthSnapshot;
  }

  private load(): void {
    if (!this.statePath) return;
    try {
      if (!fs.existsSync(this.statePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as ProviderHealthSnapshot;
      if (parsed && Array.isArray(parsed.routes)) this.state = parsed;
    } catch { /* start from unknown */ }
  }

  private save(): void {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }
}

function isHealthy(route: OpenAIRouteHealth | undefined): boolean {
  return Boolean(route && route.configured && route.modelAligned && route.breaker.state !== 'OPEN' && !route.budgetExceeded && route.lastSuccessAt);
}

function failureReason(primary: OpenAIRouteHealth | undefined, fallback: OpenAIRouteHealth | undefined): string {
  if (!primary) return 'primary route is not configured';
  if (!primary.modelAligned) return `primary route/model mismatch: configured=${primary.model} expected=${primary.expectedModel}`;
  if (primary.breaker.state === 'OPEN') return fallback && isHealthy(fallback)
    ? 'primary breaker is open; controlled fallback is healthy'
    : 'primary breaker is open and no healthy fallback is available';
  if (primary.lastError) return fallback && isHealthy(fallback)
    ? `primary probe failed; controlled fallback is healthy: ${primary.lastError}`
    : `primary probe failed and no healthy fallback is available: ${primary.lastError}`;
  if (primary.budgetExceeded) return 'primary route exceeded latency or error-rate budget';
  return 'primary route has not completed a successful authenticated probe';
}

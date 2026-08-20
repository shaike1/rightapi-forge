// Alert Correlation Engine — groups related alerts to suppress noise

import { randomUUID } from 'crypto';

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  server: string;
  metric: string;
  value: number;
  severity: string;
  firedAt: Date;
}

export interface CorrelationGroup {
  id: string;
  alerts: AlertEvent[];
  compositeSeverity: 'low' | 'medium' | 'high' | 'critical';
  affectedServers: string[];
  affectedMetrics: string[];
  firstFiredAt: Date;
  lastFiredAt: Date;
  isDuplicate: boolean;
  suppressedCount: number;
}

type CompositeSeverity = CorrelationGroup['compositeSeverity'];

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, warning: 1, high: 2, critical: 3 };
const SEVERITY_LEVELS: CompositeSeverity[] = ['low', 'medium', 'high', 'critical'];

/** Normalise rule severity (warning → medium) to composite severity scale */
function normSeverity(s: string): CompositeSeverity {
  if (s === 'warning') return 'medium';
  if ((SEVERITY_LEVELS as string[]).includes(s)) return s as CompositeSeverity;
  return 'low';
}

function maxSeverity(alerts: AlertEvent[]): CompositeSeverity {
  let max: CompositeSeverity = 'low';
  for (const a of alerts) {
    const n = normSeverity(a.severity);
    if (SEVERITY_RANK[n] > SEVERITY_RANK[max]) max = n;
  }
  return max;
}

const GROUP_WINDOW_MS  = 5  * 60 * 1000; // 5 min — group window
const ACTIVE_TTL_MS    = 30 * 60 * 1000; // 30 min — how long a group stays active

export class AlertCorrelationEngine {
  private groups = new Map<string, CorrelationGroup>();
  private cleanupHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupHandle = setInterval(() => this.cleanOldGroups(), 60_000);
  }

  /** Add a new alert, suppressing it into an existing group when applicable. */
  addAlert(alert: AlertEvent): void {
    const now = alert.firedAt.getTime();

    // Find a matching group: same server + metric within the 5-min window
    let matched: CorrelationGroup | null = null;
    for (const g of this.groups.values()) {
      if (
        g.affectedServers.includes(alert.server) &&
        g.affectedMetrics.includes(alert.metric) &&
        now - g.lastFiredAt.getTime() <= GROUP_WINDOW_MS
      ) {
        matched = g;
        break;
      }
    }

    if (matched) {
      matched.suppressedCount++;
      matched.lastFiredAt = alert.firedAt;
      matched.compositeSeverity = maxSeverity([...matched.alerts, alert]);
      matched.isDuplicate = matched.alerts.every(a => a.ruleId === alert.ruleId);
      // Add to alerts array for the expanded-row view (cap at 100 to avoid memory growth)
      if (matched.alerts.length < 100) matched.alerts.push(alert);
    } else {
      const group: CorrelationGroup = {
        id: randomUUID(),
        alerts: [alert],
        compositeSeverity: normSeverity(alert.severity),
        affectedServers: [alert.server],
        affectedMetrics: [alert.metric],
        firstFiredAt: alert.firedAt,
        lastFiredAt: alert.firedAt,
        isDuplicate: false,
        suppressedCount: 0,
      };
      this.groups.set(group.id, group);
    }
  }

  /** Return all groups active within the last 30 minutes. */
  getGroups(): CorrelationGroup[] {
    const cutoff = Date.now() - ACTIVE_TTL_MS;
    return [...this.groups.values()].filter(g => g.lastFiredAt.getTime() >= cutoff);
  }

  getGroupById(id: string): CorrelationGroup | undefined {
    return this.groups.get(id);
  }

  getStats(): {
    totalAlerts: number;
    suppressedAlerts: number;
    activeGroups: number;
    suppressionRate: number;
  } {
    const groups = this.getGroups();
    let totalAlerts = 0;
    let suppressedAlerts = 0;
    for (const g of groups) {
      totalAlerts    += g.alerts.length + g.suppressedCount;
      suppressedAlerts += g.suppressedCount;
    }
    const suppressionRate = totalAlerts > 0 ? Math.round((suppressedAlerts / totalAlerts) * 100) : 0;
    return { totalAlerts, suppressedAlerts, activeGroups: groups.length, suppressionRate };
  }

  /** Remove groups older than 30 minutes — called every minute by the internal timer. */
  cleanOldGroups(): void {
    const cutoff = Date.now() - ACTIVE_TTL_MS;
    for (const [id, g] of this.groups.entries()) {
      if (g.lastFiredAt.getTime() < cutoff) this.groups.delete(id);
    }
  }

  stop(): void {
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle);
      this.cleanupHandle = null;
    }
  }
}

export const correlationEngine = new AlertCorrelationEngine();

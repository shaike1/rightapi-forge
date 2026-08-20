import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'firing' | 'acknowledged' | 'resolved';
export type AlertSource =
  | 'self-healing'
  | 'scheduling'
  | 'task'
  | 'manual'
  | 'rule-engine'
  | 'monitoring'
  | 'operational';

export interface Alert {
  id: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  status: AlertStatus;
  source: AlertSource;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  firedAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  acknowledgedBy?: string;
  assignedTo?: string;
  incidentId?: string;
  count: number;
  lastFiredAt: Date;
  fingerprint: string;
}

export interface ReconciledAlertInput {
  key: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: 'slack' | 'webhook' | 'email';
  enabled: boolean;
  config: Record<string, string>;
  minSeverity: AlertSeverity;
}

export interface AlertRoute {
  id: string;
  name: string;
  matchers: Array<{ label: string; value: string }>;
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
  lastNotifiedAt?: Date;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };

export class AlertManager extends EventEmitter {
  private alerts: Map<string, Alert> = new Map();
  private channels: Map<string, NotificationChannel> = new Map();
  private routes: Map<string, AlertRoute> = new Map();
  private dataPath: string;

  constructor(dataPath: string = '/data/itops-agents/alerting') {
    super();
    this.dataPath = dataPath;
    this.ensureDir();
    this.load();
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
  }

  // ── Alerts ──────────────────────────────────────────────────────────────────

  fire(data: {
    title: string;
    message: string;
    severity: AlertSeverity;
    source: AlertSource;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  }): Alert {
    const labels = data.labels || {};
    const fingerprint = this.fingerprint(data.title, data.source, labels);
    const existing = this.findActiveByFingerprint(fingerprint);

    if (existing) {
      existing.count++;
      existing.lastFiredAt = new Date();
      existing.title = data.title;
      existing.message = data.message;
      existing.severity = data.severity;
      existing.labels = labels;
      existing.annotations = data.annotations || {};
      this.save();
      this.emit('alert-deduplicated', existing);
      return existing;
    }

    return this.createAlert({
      ...data,
      labels,
      annotations: data.annotations || {},
      fingerprint
    });
  }

  reconcile(source: AlertSource, conditions: ReconciledAlertInput[]): Alert[] {
    const activeFingerprints = new Set<string>();
    const reconciled: Alert[] = [];

    for (const condition of conditions) {
      const labels = {
        ...(condition.labels || {}),
        alertKey: condition.key
      };
      const fingerprint = this.fingerprint(condition.key, source, labels);
      activeFingerprints.add(fingerprint);
      const existing = this.findActiveByFingerprint(fingerprint);

      if (existing) {
        existing.title = condition.title;
        existing.message = condition.message;
        existing.severity = condition.severity;
        existing.labels = labels;
        existing.annotations = {
          ...(condition.annotations || {}),
          managedBy: 'reconcile'
        };
        existing.count++;
        existing.lastFiredAt = new Date();
        reconciled.push(existing);
        continue;
      }

      reconciled.push(this.createAlert({
        title: condition.title,
        message: condition.message,
        severity: condition.severity,
        source,
        labels,
        annotations: {
          ...(condition.annotations || {}),
          managedBy: 'reconcile'
        },
        fingerprint
      }, false));
    }

    for (const alert of this.alerts.values()) {
      if (
        alert.source === source
        && alert.status !== 'resolved'
        && alert.annotations?.managedBy === 'reconcile'
        && !activeFingerprints.has(alert.fingerprint)
      ) {
        alert.status = 'resolved';
        alert.resolvedAt = new Date();
        this.emit('alert-resolved', alert);
      }
    }

    this.save();
    for (const alert of reconciled.filter(alert => alert.count === 1)) {
      this.emit('alert-fired', alert);
      this.routeAlert(alert);
    }
    return reconciled;
  }

  acknowledge(id: string, by: string = 'system'): Alert | null {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    if (alert.status === 'resolved') return alert;
    alert.status = 'acknowledged';
    alert.acknowledgedAt = new Date();
    alert.acknowledgedBy = by;
    this.save();
    this.emit('alert-acknowledged', alert);
    return alert;
  }

  resolve(id: string): Alert | null {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    alert.status = 'resolved';
    alert.resolvedAt = new Date();
    this.save();
    this.emit('alert-resolved', alert);
    return alert;
  }

  assign(id: string, assignedTo: string): Alert | null {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    alert.assignedTo = assignedTo;
    this.save();
    this.emit('alert-assigned', alert);
    return alert;
  }

  linkIncident(id: string, incidentId: string): Alert | null {
    const alert = this.alerts.get(id);
    if (!alert) return null;
    alert.incidentId = incidentId;
    this.save();
    this.emit('alert-incident-linked', alert);
    return alert;
  }

  getAlert(id: string): Alert | null {
    return this.alerts.get(id) || null;
  }

  getAlerts(filter?: { status?: AlertStatus; severity?: AlertSeverity; source?: AlertSource; limit?: number }): Alert[] {
    let list = Array.from(this.alerts.values());
    if (filter?.status) list = list.filter(a => a.status === filter.status);
    if (filter?.severity) list = list.filter(a => a.severity === filter.severity);
    if (filter?.source) list = list.filter(a => a.source === filter.source);
    list.sort((a, b) => new Date(b.lastFiredAt).getTime() - new Date(a.lastFiredAt).getTime());
    if (filter?.limit) list = list.slice(0, filter.limit);
    return list;
  }

  getStats() {
    const all = Array.from(this.alerts.values());
    const active = all.filter(a => a.status !== 'resolved');
    return {
      total: all.length,
      firing: all.filter(a => a.status === 'firing').length,
      unacknowledged: all.filter(a => a.status === 'firing').length,
      acknowledged: all.filter(a => a.status === 'acknowledged').length,
      resolved: all.filter(a => a.status === 'resolved').length,
      critical: active.filter(a => a.severity === 'critical').length,
      warning: active.filter(a => a.severity === 'warning').length,
      info: active.filter(a => a.severity === 'info').length,
      bySeverity: {
        critical: active.filter(a => a.severity === 'critical').length,
        warning: active.filter(a => a.severity === 'warning').length,
        info: active.filter(a => a.severity === 'info').length
      },
      bySource: active.reduce<Record<string, number>>((acc, alert) => {
        acc[alert.source] = (acc[alert.source] || 0) + 1;
        return acc;
      }, {})
    };
  }

  // ── Channels ─────────────────────────────────────────────────────────────────

  addChannel(data: Omit<NotificationChannel, 'id'>): NotificationChannel {
    const ch: NotificationChannel = { ...data, id: uuidv4() };
    this.channels.set(ch.id, ch);
    this.save();
    return ch;
  }

  updateChannel(id: string, updates: Partial<NotificationChannel>): NotificationChannel | null {
    const ch = this.channels.get(id);
    if (!ch) return null;
    Object.assign(ch, updates);
    this.save();
    return ch;
  }

  deleteChannel(id: string): boolean {
    const ok = this.channels.delete(id);
    if (ok) this.save();
    return ok;
  }

  getChannels(): NotificationChannel[] {
    return Array.from(this.channels.values());
  }

  // ── Routes ────────────────────────────────────────────────────────────────────

  addRoute(data: Omit<AlertRoute, 'id'>): AlertRoute {
    const route: AlertRoute = { ...data, id: uuidv4() };
    this.routes.set(route.id, route);
    this.save();
    return route;
  }

  updateRoute(id: string, updates: Partial<AlertRoute>): AlertRoute | null {
    const route = this.routes.get(id);
    if (!route) return null;
    Object.assign(route, updates);
    this.save();
    return route;
  }

  deleteRoute(id: string): boolean {
    const ok = this.routes.delete(id);
    if (ok) this.save();
    return ok;
  }

  getRoutes(): AlertRoute[] {
    return Array.from(this.routes.values());
  }

  // ── Routing ───────────────────────────────────────────────────────────────────

  private routeAlert(alert: Alert): void {
    const matchedRoutes = Array.from(this.routes.values()).filter(r => {
      if (!r.enabled) return false;
      return r.matchers.every(m => alert.labels[m.label] === m.value || alert.severity === m.value);
    });

    // Also route to all channels that match min severity
    const severityChannels = Array.from(this.channels.values()).filter(ch => {
      if (!ch.enabled) return false;
      return SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[ch.minSeverity];
    });

    const channelIds = new Set<string>([
      ...severityChannels.map(c => c.id),
      ...matchedRoutes.flatMap(r => r.channels)
    ]);

    channelIds.forEach(chId => {
      const ch = this.channels.get(chId);
      if (ch) this.notify(alert, ch);
    });
  }

  notify(alert: Alert, channel: NotificationChannel): void {
    this.emit('notify', { alert, channel });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private fingerprint(title: string, source: string, labels: Record<string, string>): string {
    const parts = [title, source, ...Object.entries(labels).map(([k, v]) => k + '=' + v)].sort();
    return Buffer.from(parts.join('|')).toString('base64').slice(0, 32);
  }

  private findActiveByFingerprint(fp: string): Alert | undefined {
    return Array.from(this.alerts.values()).find(
      alert => alert.fingerprint === fp && alert.status !== 'resolved'
    );
  }

  private createAlert(data: {
    title: string;
    message: string;
    severity: AlertSeverity;
    source: AlertSource;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    fingerprint: string;
  }, persistAndNotify = true): Alert {
    const now = new Date();
    const alert: Alert = {
      id: uuidv4(),
      title: data.title,
      message: data.message,
      severity: data.severity,
      status: 'firing',
      source: data.source,
      labels: data.labels,
      annotations: data.annotations,
      firedAt: now,
      lastFiredAt: now,
      count: 1,
      fingerprint: data.fingerprint
    };

    this.alerts.set(alert.id, alert);
    if (persistAndNotify) {
      this.save();
      this.emit('alert-fired', alert);
      this.routeAlert(alert);
      console.log('[AlertManager] Alert fired: ' + alert.severity.toUpperCase() + ' — ' + alert.title);
    }
    return alert;
  }

  private save(): void {
    try {
      fs.writeFileSync(
        path.join(this.dataPath, 'alerts.json'),
        JSON.stringify(Array.from(this.alerts.entries()), null, 2)
      );
      fs.writeFileSync(
        path.join(this.dataPath, 'channels.json'),
        JSON.stringify(Array.from(this.channels.entries()), null, 2)
      );
      fs.writeFileSync(
        path.join(this.dataPath, 'routes.json'),
        JSON.stringify(Array.from(this.routes.entries()), null, 2)
      );
    } catch (e) {
      console.error('[AlertManager] Save failed:', e);
    }
  }

  private load(): void {
    try {
      const af = path.join(this.dataPath, 'alerts.json');
      const cf = path.join(this.dataPath, 'channels.json');
      const rf = path.join(this.dataPath, 'routes.json');
      if (fs.existsSync(af)) {
        const entries = JSON.parse(fs.readFileSync(af, 'utf8')) as Array<[string, Alert]>;
        this.alerts = new Map(entries.map(([id, alert]) => [id, {
          ...alert,
          firedAt: new Date(alert.firedAt),
          lastFiredAt: new Date(alert.lastFiredAt),
          acknowledgedAt: alert.acknowledgedAt ? new Date(alert.acknowledgedAt) : undefined,
          resolvedAt: alert.resolvedAt ? new Date(alert.resolvedAt) : undefined
        }]));
      }
      if (fs.existsSync(cf)) this.channels = new Map(JSON.parse(fs.readFileSync(cf, 'utf8')));
      if (fs.existsSync(rf)) this.routes = new Map(JSON.parse(fs.readFileSync(rf, 'utf8')));
      console.log('[AlertManager] Loaded: ' + this.alerts.size + ' alerts, ' + this.channels.size + ' channels, ' + this.routes.size + ' routes');
    } catch (e) {
      console.error('[AlertManager] Load failed:', e);
    }
  }
}

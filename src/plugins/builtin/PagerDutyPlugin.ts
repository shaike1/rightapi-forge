// PagerDutyPlugin — bridges itops incidents to PagerDuty's Events API v2.
//
// One PagerDuty incident per itops incident, keyed by `dedup_key =
// incident.id` so resolve/escalate updates land on the right page. We use
// the public Events API v2 (https://events.pagerduty.com/v2/enqueue), not
// the REST API — the v2 endpoint takes a routing key directly and never
// hits the auth-token-rotation path.
//
// `apiKey` (REST API token) is required for getExternalStatus and the
// listed `serviceId` lookup. The routing key is what actually addresses
// the page.

import type {
  ITOpsPlugin, PluginConfigField, PluginContext,
} from '../PluginInterface.js';
import type { Incident } from '../../persistence/SqliteStore.js';

const EVENTS_V2_URL = 'https://events.pagerduty.com/v2/enqueue';
const REST_BASE = 'https://api.pagerduty.com';

interface Cfg {
  routingKey: string;
  apiKey?: string;
  serviceId?: string;
}

const SEVERITY_MAP: Record<string, 'info' | 'warning' | 'error' | 'critical'> = {
  low: 'info',
  medium: 'warning',
  high: 'error',
  critical: 'critical',
};

export class PagerDutyPlugin implements ITOpsPlugin {
  readonly id = 'pagerduty';
  readonly name = 'PagerDuty';
  readonly version = '1.0.0';
  readonly description = 'Routes incidents to PagerDuty via Events API v2. Auto-resolves and re-escalates as itops incident state changes.';

  readonly configSchema: PluginConfigField[] = [
    { key: 'routingKey', label: 'Routing key (Events API v2 integration key)', type: 'password', required: true, placeholder: 'R0UTING1KEYHEX', helpText: 'Found in your PagerDuty service → Integrations → Events API v2.' },
    { key: 'apiKey',     label: 'REST API token (optional, for status probe)', type: 'password', required: false, helpText: 'Read-only token. Used only by Test Connection and the dashboard status tile.' },
    { key: 'serviceId',  label: 'Service ID (optional)', type: 'string', required: false, placeholder: 'P12345', helpText: 'Surfaced in the status tile.' },
  ];

  private cfg: Cfg | null = null;
  private ctx: PluginContext | null = null;

  async onLoad(rawConfig: Record<string, unknown>, context: PluginContext): Promise<void> {
    const cfg: Cfg = {
      routingKey: String(rawConfig.routingKey ?? ''),
      apiKey: rawConfig.apiKey ? String(rawConfig.apiKey) : undefined,
      serviceId: rawConfig.serviceId ? String(rawConfig.serviceId) : undefined,
    };
    if (!cfg.routingKey) {
      throw new Error('routingKey is required');
    }
    // Best-effort health check: ping the Events API with a noop trigger?
    // No — Events API doesn't have a probe endpoint, and sending a real
    // event during onLoad would page on-call. We trust the config here;
    // the first real incident is the first integration test.
    if (cfg.apiKey) {
      // Validate apiKey by hitting /users/me — cheap and read-only.
      const res = await context.http.get(`${REST_BASE}/users/me`, {
        headers: { Authorization: `Token token=${cfg.apiKey}`, Accept: 'application/vnd.pagerduty+json;version=2' },
        timeoutMs: 5_000,
      });
      if (!res.ok) {
        throw new Error(`PagerDuty REST auth check failed: HTTP ${res.status}`);
      }
    }
    this.cfg = cfg;
    this.ctx = context;
    context.logger.info('[PagerDutyPlugin] loaded', { hasApiKey: !!cfg.apiKey, hasServiceId: !!cfg.serviceId });
  }

  async onUnload(): Promise<void> {
    this.cfg = null;
    this.ctx = null;
  }

  async onIncidentCreated(incident: Incident): Promise<void> {
    if (!this.cfg || !this.ctx) return;
    const payload = {
      routing_key: this.cfg.routingKey,
      event_action: 'trigger' as const,
      dedup_key: incident.id,
      payload: {
        summary: `${incident.id}: ${incident.title}`,
        source: incident.serverId ?? 'itops-agents',
        severity: SEVERITY_MAP[incident.severity] ?? 'warning',
        timestamp: incident.createdAt,
        custom_details: {
          incident_id: incident.id,
          description: incident.description ?? '',
          source: incident.source,
          source_ref: incident.sourceRef,
        },
      },
    };
    const res = await this.ctx.http.post(EVENTS_V2_URL, payload);
    if (!res.ok) {
      throw new Error(`PagerDuty trigger failed: HTTP ${res.status}`);
    }
    this.ctx.audit.log('pagerduty.trigger', `incident=${incident.id} severity=${incident.severity}`);
  }

  async onIncidentResolved(incident: Incident): Promise<void> {
    if (!this.cfg || !this.ctx) return;
    const res = await this.ctx.http.post(EVENTS_V2_URL, {
      routing_key: this.cfg.routingKey,
      event_action: 'resolve' as const,
      dedup_key: incident.id,
    });
    if (!res.ok) {
      throw new Error(`PagerDuty resolve failed: HTTP ${res.status}`);
    }
    this.ctx.audit.log('pagerduty.resolve', `incident=${incident.id}`);
  }

  async onIncidentEscalated(incident: Incident, level: number): Promise<void> {
    if (!this.cfg || !this.ctx) return;
    // Events API v2 doesn't expose urgency directly. We re-trigger with
    // the new severity so the PD-side de-dupe upgrades the existing page.
    const res = await this.ctx.http.post(EVENTS_V2_URL, {
      routing_key: this.cfg.routingKey,
      event_action: 'trigger' as const,
      dedup_key: incident.id,
      payload: {
        summary: `[L${level}] ${incident.id}: ${incident.title}`,
        source: incident.serverId ?? 'itops-agents',
        severity: SEVERITY_MAP[incident.severity] ?? 'error',
        timestamp: new Date().toISOString(),
        custom_details: { escalation_level: level },
      },
    });
    if (!res.ok) {
      throw new Error(`PagerDuty escalate failed: HTTP ${res.status}`);
    }
    this.ctx.audit.log('pagerduty.escalate', `incident=${incident.id} level=${level}`);
  }

  async syncIncident(incident: Incident): Promise<void> {
    // The lifecycle hooks above already do the right thing on each
    // transition. syncIncident is the manual "push current state" path,
    // useful after an outage when itops and PD diverged.
    if (incident.status === 'resolved' || incident.status === 'closed') {
      return this.onIncidentResolved(incident);
    }
    return this.onIncidentCreated(incident);
  }

  async getExternalStatus(): Promise<Record<string, unknown>> {
    if (!this.cfg || !this.ctx) return { configured: false };
    const out: Record<string, unknown> = { configured: true, hasApiKey: !!this.cfg.apiKey };
    if (this.cfg.apiKey && this.cfg.serviceId) {
      const res = await this.ctx.http.get(`${REST_BASE}/services/${this.cfg.serviceId}`, {
        headers: { Authorization: `Token token=${this.cfg.apiKey}`, Accept: 'application/vnd.pagerduty+json;version=2' },
        timeoutMs: 5_000,
      });
      out.serviceProbeStatus = res.status;
      if (res.ok) {
        const body = await res.body() as { service?: { id?: string; name?: string; status?: string } };
        out.service = body.service ? { id: body.service.id, name: body.service.name, status: body.service.status } : null;
      }
    }
    return out;
  }
}

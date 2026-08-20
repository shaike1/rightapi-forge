// OpsGeniePlugin — mirrors PagerDuty but for OpsGenie's REST alerts API.
//
// Each itops incident maps to an OpsGenie alert keyed by the itops
// incident id (`alias`). Resolve/escalate operate on the same alias so
// the OpsGenie side stays in sync. EU vs US regions are switchable via
// the `region` config field — the only API-shape difference is the host.

import type { ITOpsPlugin, PluginConfigField, PluginContext } from '../PluginInterface.js';
import type { Incident } from '../../persistence/SqliteStore.js';

const HOSTS = {
  us: 'https://api.opsgenie.com',
  eu: 'https://api.eu.opsgenie.com',
};

const PRIORITY_MAP: Record<string, 'P1' | 'P2' | 'P3' | 'P4' | 'P5'> = {
  critical: 'P1',
  high:     'P2',
  medium:   'P3',
  low:      'P4',
};

interface Cfg {
  apiKey: string;
  region: 'us' | 'eu';
  teamName?: string;
}

export class OpsGeniePlugin implements ITOpsPlugin {
  readonly id = 'opsgenie';
  readonly name = 'OpsGenie';
  readonly version = '1.0.0';
  readonly description = 'Routes incidents to OpsGenie alerts. Severity maps to OG priority (critical→P1, high→P2, …).';

  readonly configSchema: PluginConfigField[] = [
    { key: 'apiKey', label: 'API key', type: 'password', required: true, helpText: 'OpsGenie API integration key (Settings → Integrations → API).' },
    { key: 'region', label: 'Region', type: 'select', required: true, default: 'us', options: [
      { value: 'us', label: 'US (api.opsgenie.com)' },
      { value: 'eu', label: 'EU (api.eu.opsgenie.com)' },
    ] },
    { key: 'teamName', label: 'Default team (optional)', type: 'string', required: false, helpText: 'Team that alerts will be routed to. Leave blank to use the API key default.' },
  ];

  private cfg: Cfg | null = null;
  private ctx: PluginContext | null = null;

  async onLoad(rawConfig: Record<string, unknown>, context: PluginContext): Promise<void> {
    const region = String(rawConfig.region ?? 'us') as 'us' | 'eu';
    if (region !== 'us' && region !== 'eu') throw new Error('region must be "us" or "eu"');
    const cfg: Cfg = {
      apiKey: String(rawConfig.apiKey ?? ''),
      region,
      teamName: rawConfig.teamName ? String(rawConfig.teamName) : undefined,
    };
    if (!cfg.apiKey) throw new Error('apiKey is required');
    // Health probe: hit /v2/integrations/authenticate or /v2/account.
    // /v2/account is read-only and cheap.
    const res = await context.http.get(`${HOSTS[cfg.region]}/v2/account`, {
      headers: { Authorization: `GenieKey ${cfg.apiKey}` },
      timeoutMs: 5_000,
    });
    if (!res.ok) {
      throw new Error(`OpsGenie auth check failed: HTTP ${res.status}`);
    }
    this.cfg = cfg;
    this.ctx = context;
    context.logger.info('[OpsGeniePlugin] loaded', { region });
  }

  async onUnload(): Promise<void> {
    this.cfg = null;
    this.ctx = null;
  }

  async onIncidentCreated(incident: Incident): Promise<void> {
    if (!this.cfg || !this.ctx) return;
    const payload: Record<string, unknown> = {
      message: `${incident.id}: ${incident.title}`,
      alias: incident.id,
      description: incident.description ?? '',
      priority: PRIORITY_MAP[incident.severity] ?? 'P3',
      source: incident.serverId ?? 'itops-agents',
      details: {
        incident_id: incident.id,
        severity: incident.severity,
        source: incident.source,
        source_ref: incident.sourceRef ?? '',
      },
      tags: ['itops', `severity:${incident.severity}`],
    };
    if (this.cfg.teamName) payload.responders = [{ name: this.cfg.teamName, type: 'team' }];
    const res = await this.ctx.http.post(`${HOSTS[this.cfg.region]}/v2/alerts`, payload, {
      headers: { Authorization: `GenieKey ${this.cfg.apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`OpsGenie alert create failed: HTTP ${res.status}`);
    }
    this.ctx.audit.log('opsgenie.create', `incident=${incident.id} priority=${PRIORITY_MAP[incident.severity] ?? 'P3'}`);
  }

  async onIncidentResolved(incident: Incident): Promise<void> {
    if (!this.cfg || !this.ctx) return;
    const res = await this.ctx.http.post(
      `${HOSTS[this.cfg.region]}/v2/alerts/${encodeURIComponent(incident.id)}/close?identifierType=alias`,
      { note: `Closed by itops-agents — ${incident.id} resolved.` },
      { headers: { Authorization: `GenieKey ${this.cfg.apiKey}` } },
    );
    if (!res.ok) {
      throw new Error(`OpsGenie alert close failed: HTTP ${res.status}`);
    }
    this.ctx.audit.log('opsgenie.close', `incident=${incident.id}`);
  }

  async onIncidentEscalated(incident: Incident, level: number): Promise<void> {
    if (!this.cfg || !this.ctx) return;
    // Bump priority on the existing alias-addressed alert.
    const res = await this.ctx.http.put(
      `${HOSTS[this.cfg.region]}/v2/alerts/${encodeURIComponent(incident.id)}/priority?identifierType=alias`,
      { priority: PRIORITY_MAP[incident.severity] ?? 'P1' },
      { headers: { Authorization: `GenieKey ${this.cfg.apiKey}` } },
    );
    if (!res.ok) {
      throw new Error(`OpsGenie priority update failed: HTTP ${res.status}`);
    }
    this.ctx.audit.log('opsgenie.escalate', `incident=${incident.id} level=${level}`);
  }

  async syncIncident(incident: Incident): Promise<void> {
    if (incident.status === 'resolved' || incident.status === 'closed') {
      return this.onIncidentResolved(incident);
    }
    return this.onIncidentCreated(incident);
  }

  async getExternalStatus(): Promise<Record<string, unknown>> {
    if (!this.cfg || !this.ctx) return { configured: false };
    const res = await this.ctx.http.get(`${HOSTS[this.cfg.region]}/v2/account`, {
      headers: { Authorization: `GenieKey ${this.cfg.apiKey}` },
      timeoutMs: 5_000,
    });
    const out: Record<string, unknown> = { configured: true, region: this.cfg.region, probeStatus: res.status };
    if (res.ok) {
      const body = await res.body() as { data?: { name?: string; plan?: { name?: string } } };
      if (body?.data) {
        out.account = { name: body.data.name, plan: body.data.plan?.name };
      }
    }
    return out;
  }
}

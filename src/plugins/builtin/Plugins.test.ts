import test from 'node:test';
import assert from 'node:assert/strict';
import { PagerDutyPlugin } from './PagerDutyPlugin.js';
import { OpsGeniePlugin } from './OpsGeniePlugin.js';
import { PrometheusPlugin } from './PrometheusPlugin.js';
import type { PluginContext, PluginHttp } from '../PluginInterface.js';
import type { Incident } from '../../persistence/SqliteStore.js';

// ── Test fixtures ─────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function recordingHttp(responses?: Record<string, { status: number; body?: unknown }>): { http: PluginHttp; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  function reply(url: string, method: string) {
    const matched = responses && Object.keys(responses).find(k => url.includes(k));
    const r = matched ? responses[matched] : { status: 200, body: {} };
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      body: async () => r.body ?? {},
      text: async () => typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}),
    });
  }
  const http: PluginHttp = {
    get:    (url, opts) => { calls.push({ method: 'GET',    url, headers: opts?.headers }); return reply(url, 'GET'); },
    post:   (url, body, opts) => { calls.push({ method: 'POST',   url, body, headers: opts?.headers }); return reply(url, 'POST'); },
    put:    (url, body, opts) => { calls.push({ method: 'PUT',    url, body, headers: opts?.headers }); return reply(url, 'PUT'); },
    delete: (url, opts) => { calls.push({ method: 'DELETE', url, headers: opts?.headers }); return reply(url, 'DELETE'); },
  };
  return { http, calls };
}

function contextWith(http: PluginHttp): PluginContext & { audited: string[] } {
  const audited: string[] = [];
  const ctx: any = {
    pluginId: 'test',
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    incidents: {
      create: () => ({} as Incident),
      resolve: () => null,
      escalate: () => null,
      list: () => [],
      get: () => null,
    },
    servers: { list: () => [], get: () => null },
    metrics: { latest: () => [] },
    audit: { log: (action: string, detail?: string) => { audited.push(`${action}|${detail ?? ''}`); } },
    http,
    audited,
  };
  return ctx;
}

function fakeIncident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'INC-ABCD1234', title: 'Disk full /data', description: 'auto', severity: 'high', status: 'open',
    assignedTo: null, assignedAgent: null, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', resolvedAt: null, source: 'health-monitor',
    sourceRef: 'disk:/data', slaMinutes: 240, serverId: 'web01', ...over,
  };
}

// ── PagerDutyPlugin ───────────────────────────────────────────────────

test('PagerDuty: onLoad without apiKey accepts routingKey-only config', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PagerDutyPlugin();
  await p.onLoad({ routingKey: 'R123' }, ctx);
  // No REST validation call since apiKey is absent.
  await p.onUnload();
});

test('PagerDuty: onLoad rejects missing routingKey', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PagerDutyPlugin();
  await assert.rejects(p.onLoad({}, ctx), /routingKey is required/);
});

test('PagerDuty: onLoad with apiKey validates against /users/me', async () => {
  const { http, calls } = recordingHttp({ '/users/me': { status: 200, body: { user: { id: 'P1' } } } });
  const ctx = contextWith(http);
  const p = new PagerDutyPlugin();
  await p.onLoad({ routingKey: 'R', apiKey: 'KEY' }, ctx);
  const probe = calls.find(c => c.url.includes('/users/me'));
  assert.ok(probe);
  assert.match(probe!.headers!.Authorization ?? '', /Token token=KEY/);
});

test('PagerDuty: onIncidentCreated fires Events API v2 trigger with dedup_key=incidentId', async () => {
  const { http, calls } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PagerDutyPlugin();
  await p.onLoad({ routingKey: 'R' }, ctx);
  await p.onIncidentCreated(fakeIncident());
  const trigger = calls.find(c => c.url.includes('events.pagerduty.com'));
  assert.ok(trigger);
  const body = trigger!.body as any;
  assert.equal(body.event_action, 'trigger');
  assert.equal(body.dedup_key, 'INC-ABCD1234');
  assert.equal(body.routing_key, 'R');
  assert.equal(body.payload.severity, 'error', 'high → error per spec map');
  assert.match(body.payload.summary, /Disk full \/data/);
  assert.ok(ctx.audited.find(a => a.startsWith('pagerduty.trigger|')));
});

test('PagerDuty: onIncidentResolved fires resolve with the same dedup_key', async () => {
  const { http, calls } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PagerDutyPlugin();
  await p.onLoad({ routingKey: 'R' }, ctx);
  await p.onIncidentResolved(fakeIncident({ status: 'resolved' }));
  const body = calls.find(c => c.url.includes('events.pagerduty.com'))!.body as any;
  assert.equal(body.event_action, 'resolve');
  assert.equal(body.dedup_key, 'INC-ABCD1234');
});

test('PagerDuty: a non-2xx response throws so PluginManager records last_error', async () => {
  const { http } = recordingHttp({ 'events.pagerduty.com': { status: 503 } });
  const ctx = contextWith(http);
  const p = new PagerDutyPlugin();
  await p.onLoad({ routingKey: 'R' }, ctx);
  await assert.rejects(p.onIncidentCreated(fakeIncident()), /HTTP 503/);
});

// ── OpsGeniePlugin ────────────────────────────────────────────────────

test('OpsGenie: onLoad probes /v2/account in the right region (eu vs us)', async () => {
  const { http: httpEu, calls: callsEu } = recordingHttp();
  await new OpsGeniePlugin().onLoad({ apiKey: 'K', region: 'eu' }, contextWith(httpEu));
  assert.ok(callsEu[0].url.includes('api.eu.opsgenie.com/v2/account'));

  const { http: httpUs, calls: callsUs } = recordingHttp();
  await new OpsGeniePlugin().onLoad({ apiKey: 'K', region: 'us' }, contextWith(httpUs));
  assert.ok(callsUs[0].url.includes('api.opsgenie.com/v2/account'));
});

test('OpsGenie: onLoad rejects bad region', async () => {
  const { http } = recordingHttp();
  await assert.rejects(
    new OpsGeniePlugin().onLoad({ apiKey: 'K', region: 'mars' } as any, contextWith(http)),
    /region must be/,
  );
});

test('OpsGenie: onIncidentCreated posts to /v2/alerts with alias=incident.id and priority map', async () => {
  const { http, calls } = recordingHttp();
  const ctx = contextWith(http);
  const p = new OpsGeniePlugin();
  await p.onLoad({ apiKey: 'K', region: 'us' }, ctx);
  await p.onIncidentCreated(fakeIncident({ severity: 'critical' }));
  const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/v2/alerts'));
  assert.ok(create);
  const body = create!.body as any;
  assert.equal(body.alias, 'INC-ABCD1234');
  assert.equal(body.priority, 'P1', 'critical → P1');
  assert.match(create!.headers!.Authorization ?? '', /GenieKey K/);
});

test('OpsGenie: onIncidentResolved closes the alert by alias', async () => {
  const { http, calls } = recordingHttp();
  const ctx = contextWith(http);
  const p = new OpsGeniePlugin();
  await p.onLoad({ apiKey: 'K', region: 'us' }, ctx);
  await p.onIncidentResolved(fakeIncident({ status: 'resolved' }));
  const close = calls.find(c => c.url.includes('/v2/alerts/INC-ABCD1234/close'));
  assert.ok(close);
  assert.match(close!.url, /identifierType=alias/);
});

test('OpsGenie: onIncidentEscalated raises priority via PUT', async () => {
  const { http, calls } = recordingHttp();
  const ctx = contextWith(http);
  const p = new OpsGeniePlugin();
  await p.onLoad({ apiKey: 'K', region: 'us' }, ctx);
  await p.onIncidentEscalated(fakeIncident({ severity: 'critical' }), 3);
  const put = calls.find(c => c.method === 'PUT' && c.url.includes('/priority'));
  assert.ok(put);
  assert.equal((put!.body as any).priority, 'P1');
});

test('OpsGenie: teamName routes alerts to that team', async () => {
  const { http, calls } = recordingHttp();
  const ctx = contextWith(http);
  const p = new OpsGeniePlugin();
  await p.onLoad({ apiKey: 'K', region: 'us', teamName: 'sre' }, ctx);
  await p.onIncidentCreated(fakeIncident());
  const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/v2/alerts'));
  assert.deepEqual((create!.body as any).responders, [{ name: 'sre', type: 'team' }]);
});

// ── PrometheusPlugin ──────────────────────────────────────────────────

test('Prometheus: onIncidentCreated bumps incidents_total counter with severity+server labels', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PrometheusPlugin();
  await p.onLoad({}, ctx);
  await p.onIncidentCreated(fakeIncident());
  const out = p.renderPrometheus();
  assert.match(out, /^# HELP itops_incidents_total/m);
  assert.match(out, /itops_incidents_total\{[^}]*severity="high"[^}]*\} 1/);
  assert.match(out, /itops_incidents_total\{[^}]*server="web01"[^}]*\} 1/);
});

test('Prometheus: onMetricCollected sets gauges per server+mount', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PrometheusPlugin();
  await p.onLoad({}, ctx);
  await p.onMetricCollected({
    server: { id: 'web01', name: 'web01' } as any,
    samples: [
      { timestamp: 'x', serverId: 'web01', metricType: 'cpu',    value: 42, dimension: null },
      { timestamp: 'x', serverId: 'web01', metricType: 'memory', value: 71, dimension: null },
      { timestamp: 'x', serverId: 'web01', metricType: 'disk',   value: 88, dimension: '/data' },
      { timestamp: 'x', serverId: 'web01', metricType: 'disk',   value: 12, dimension: '/' },
    ] as any,
  });
  const out = p.renderPrometheus();
  assert.match(out, /itops_server_cpu_percent\{server="web01"\} 42/);
  assert.match(out, /itops_server_memory_percent\{server="web01"\} 71/);
  assert.match(out, /itops_server_disk_percent\{[^}]*mount="\/data"[^}]*\} 88/);
  assert.match(out, /itops_server_disk_percent\{[^}]*mount="\/"[^}]*\} 12/);
});

test('Prometheus: onRunbookCompleted increments runbook_runs_total{runbook, status}', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PrometheusPlugin();
  await p.onLoad({}, ctx);
  await p.onRunbookCompleted({ templateId: 'rb-x', templateName: 'X', status: 'completed' } as any);
  await p.onRunbookCompleted({ templateId: 'rb-x', templateName: 'X', status: 'completed' } as any);
  await p.onRunbookCompleted({ templateId: 'rb-x', templateName: 'X', status: 'failed' } as any);
  const out = p.renderPrometheus();
  assert.match(out, /itops_runbook_runs_total\{[^}]*runbook="rb-x"[^}]*status="completed"[^}]*\} 2/);
  assert.match(out, /itops_runbook_runs_total\{[^}]*runbook="rb-x"[^}]*status="failed"[^}]*\} 1/);
});

test('Prometheus: onAlertFired increments alerts_fired_total', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PrometheusPlugin();
  await p.onLoad({}, ctx);
  await p.onAlertFired({ ruleName: 'Disk', severity: 'critical', firedAt: 'now' });
  await p.onAlertFired({ ruleName: 'Disk', severity: 'critical', firedAt: 'now' });
  const out = p.renderPrometheus();
  assert.match(out, /itops_alerts_fired_total\{[^}]*rule="Disk"[^}]*severity="critical"[^}]*\} 2/);
});

test('Prometheus: getExternalStatus reports series counts and config', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PrometheusPlugin();
  await p.onLoad({ prometheusUrl: 'http://p:9090', scrapeInterval: 60 }, ctx);
  await p.onIncidentCreated(fakeIncident());
  const status = await p.getExternalStatus!();
  assert.equal(status.configured, true);
  assert.equal(status.scrapeInterval, 60);
  assert.equal((status.metrics as any).incidents_total_series, 1);
});

test('Prometheus: label values with special chars are escaped properly', async () => {
  const { http } = recordingHttp();
  const ctx = contextWith(http);
  const p = new PrometheusPlugin();
  await p.onLoad({}, ctx);
  await p.onIncidentCreated(fakeIncident({ serverId: 'web"01\nbad' }));
  const out = p.renderPrometheus();
  // " becomes \" and newline becomes \n inside the label value.
  assert.match(out, /server="web\\"01\\nbad"/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAlerter } from './telegram.js';
import type { Incident } from '../persistence/SqliteStore.js';

interface RecordedCall {
  url: string;
  body: any;
}

/** Build a fake fetch that records the request body the alerter would
 *  send, so we can assert payload shape without hitting Telegram. */
function fakeFetch(): { fetch: any; calls: RecordedCall[]; setStatus: (s: number) => void } {
  const calls: RecordedCall[] = [];
  let status = 200;
  const fetch = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => '',
    } as any;
  };
  return { fetch, calls, setStatus: (s) => { status = s; } };
}

function fakeIncident(over: Partial<Incident> = {}): Incident {
  return {
    id: 'INC-FAKE',
    title: 'Disk full on data',
    description: 'Disk /data at 95% — auto-detected',
    severity: 'high',
    status: 'open',
    assignedTo: null,
    assignedAgent: null,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedAt: null,
    source: 'health-monitor',
    sourceRef: 'disk:/data',
    slaMinutes: 240,
    serverId: 'vps2',
    ...over,
  };
}

const ENABLED_ENV = {
  TELEGRAM_BOT_TOKEN: 'TESTTOKEN',
  TELEGRAM_CHAT_ID: '-100123',
  TELEGRAM_ALERT_ENABLED: 'true',
  TELEGRAM_ALERT_MIN_SEVERITY: 'high',
};

test('TelegramAlerter is disabled until token + chat id are set AND flag is on', () => {
  // Flag on, no creds → not configured
  const a = new TelegramAlerter({ TELEGRAM_ALERT_ENABLED: 'true' });
  assert.equal(a.isConfigured(), false);
  // Creds set but flag absent → not configured (avoids accidental send)
  const b = new TelegramAlerter({
    TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1',
  });
  assert.equal(b.isConfigured(), false);
  // All three present → configured
  const c = new TelegramAlerter(ENABLED_ENV);
  assert.equal(c.isConfigured(), true);
});

test('sendAlert respects min-severity floor', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(ENABLED_ENV, fetch);
  // Medium is below the default "high" floor.
  const sent = await a.sendAlert(fakeIncident({ severity: 'medium' }), 'vps2');
  assert.equal(sent, false);
  assert.equal(calls.length, 0);
});

test('sendAlert hits the Bot API with HTML payload + chat id', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(ENABLED_ENV, fetch);
  const ok = await a.sendAlert(fakeIncident(), 'vps2');
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telegram\.org\/botTESTTOKEN\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, '-100123');
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.match(calls[0].body.text, /<b>ALERT:/);
  assert.match(calls[0].body.text, /Server: vps2/);
  assert.match(calls[0].body.text, /Severity: <b>HIGH/);
});

test('sendAlert escapes HTML in incident title + description', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(ENABLED_ENV, fetch);
  await a.sendAlert(fakeIncident({
    title: 'pod <crash> on cluster & node',
    description: 'error: <unknown> in /proc',
  }));
  // Source title contains <crash>, output must escape it.
  assert.doesNotMatch(calls[0].body.text, /<crash>/);
  assert.match(calls[0].body.text, /&lt;crash&gt;/);
  assert.match(calls[0].body.text, /&amp;/);
});

test('sendEscalation L4 bypasses severity floor', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(
    { ...ENABLED_ENV, TELEGRAM_ALERT_MIN_SEVERITY: 'critical' },
    fetch,
  );
  // High incident, but L4 is intrinsically urgent — should send.
  const ok = await a.sendEscalation(fakeIncident({ severity: 'high' }), 4, {
    agentName: 'Ops Bravo',
    agentIterations: 7,
    remediatorKind: 'disk-cleanup',
    reason: 'L4 — no human action 30m after L3',
  });
  assert.equal(ok, true);
  assert.match(calls[0].body.text, /ESCALATED L4/);
  assert.match(calls[0].body.text, /Ops Bravo/);
});

test("sendApprovalRequest hits the Bot API and includes approval URL", async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(ENABLED_ENV, fetch);
  const ok = await a.sendApprovalRequest("kubectl delete ns app", "Agent X requested to delete namespace", "tok-123");
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /APPROVAL REQUIRED/);
  assert.match(calls[0].body.text, /kubectl delete ns app/);
  assert.match(calls[0].body.text, /tok-123/);
  assert.match(calls[0].body.text, /\/app\/approvals/);
});

test('sendEscalation L3 honours the floor when severity is below it', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(
    { ...ENABLED_ENV, TELEGRAM_ALERT_MIN_SEVERITY: 'high' },
    fetch,
  );
  const ok = await a.sendEscalation(fakeIncident({ severity: 'medium' }), 3, {});
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

test('sendResolution emits duration + resolved-by', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter(ENABLED_ENV, fetch);
  const ok = await a.sendResolution(
    fakeIncident({ resolvedAt: new Date().toISOString() }),
    { durationMs: 7 * 60_000, resolvedBy: 'Ops Bravo', serverName: 'vps2' },
  );
  assert.equal(ok, true);
  assert.match(calls[0].body.text, /✅ <b>RESOLVED/);
  assert.match(calls[0].body.text, /Duration: 7m/);
  assert.match(calls[0].body.text, /Ops Bravo/);
  assert.match(calls[0].body.text, /Server: vps2/);
});

test('a 4xx response from Telegram is logged and returns false (no throw)', async () => {
  const { fetch, calls, setStatus } = fakeFetch();
  setStatus(401);
  const a = new TelegramAlerter(ENABLED_ENV, fetch);
  const ok = await a.sendAlert(fakeIncident());
  assert.equal(ok, false, 'returned false for 4xx');
  assert.equal(calls.length, 1, 'request was attempted');
});

test('not-configured alerter does nothing (no fetch call)', async () => {
  const { fetch, calls } = fakeFetch();
  const a = new TelegramAlerter({}, fetch);
  const ok = await a.sendAlert(fakeIncident());
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

test('passesSeverityFilter ranks severities correctly', () => {
  const a = new TelegramAlerter({ ...ENABLED_ENV, TELEGRAM_ALERT_MIN_SEVERITY: 'high' });
  assert.equal(a.passesSeverityFilter('low'),      false);
  assert.equal(a.passesSeverityFilter('medium'),   false);
  assert.equal(a.passesSeverityFilter('high'),     true);
  assert.equal(a.passesSeverityFilter('critical'), true);
});

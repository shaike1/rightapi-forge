import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatBotService, type ChatPushEvent, type IncidentCard, type ServerCard } from './ChatBotService.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';
import { ServerRegistry } from '../monitoring/ServerRegistry.js';
import { MetricsHistoryStore } from '../monitoring/MetricsHistoryStore.js';

/** Build a stub AIProviderFactory whose default provider's chat() returns
 *  a fixed payload — usually a JSON intent classification. The provider's
 *  streamChat is never used by ChatBotService (streaming is done through
 *  the direct Anthropic SDK path, exercised separately). */
function mockFactory(answer: string | Error) {
  return {
    async getDefaultProvider() {
      return {
        name: 'mock',
        async initialize() {},
        async chat() {
          if (answer instanceof Error) throw answer;
          return { content: answer, model: 'mock-1', usage: undefined };
        },
        async streamChat() { throw new Error('not used'); },
        isAvailable() { return true; },
      };
    },
    async getProvider() { return this.getDefaultProvider(); },
  } as any;
}

function newStack(opts: { withMetrics?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-test-'));
  const incidents = new IncidentManager(new SqliteIncidentStore(join(dir, 'incidents.db')));
  const servers = new ServerRegistry(join(dir, 'servers.db'));
  servers.upsert({ id: 'local', name: 'Local', isLocal: true });
  servers.upsert({ id: 'web01', name: 'Web 01', host: 'web01.example', sshUser: 'root', tags: ['prod'] });
  const metrics = opts.withMetrics ? new MetricsHistoryStore(join(dir, 'metrics.db')) : null;
  return { dir, incidents, servers, metrics };
}

// ── Reports + suggestions ─────────────────────────────────────────────

test('report_incident creates incident, returns card + after-report suggestions', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({
    intent: 'report_incident',
    title: 'Web 01 is unreachable',
    severity: 'high',
    serverId: 'web01',
    description: 'web01 stopped responding to pings',
  }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'web01 is down!' });
  assert.ok(reply.incidentId);
  assert.equal(reply.cards?.length, 1);
  const card = reply.cards![0] as IncidentCard;
  assert.equal(card.kind, 'incident');
  assert.equal(card.id, reply.incidentId);
  assert.equal(card.severity, 'high');
  assert.deepEqual(reply.suggestions, ['סטטוס הקריאה', 'קריאות פתוחות', 'escalate']);
});

test('report_incident ignores unknown serverId from classifier', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({
    intent: 'report_incident',
    title: 'Phantom box is on fire',
    severity: 'medium',
    serverId: 'phantom-not-in-registry',
  }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'something on phantom' });
  const stored = incidents.get(reply.incidentId!);
  assert.equal(stored!.serverId, null);
});

// ── Status check + watcher subscription ───────────────────────────────

test('check_status returns incident card and subscribes the session', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'Disk full /data', severity: 'high', source: 'manual' });
  const factory = mockFactory(JSON.stringify({ intent: 'check_status', incidentId: created.id }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 'sX', text: `status of ${created.id}` });
  assert.equal(reply.incidentId, created.id);
  assert.equal(reply.cards?.length, 1);
  assert.equal((reply.cards![0] as IncidentCard).id, created.id);
  assert.deepEqual(reply.suggestions, ['escalate', 'resolve', 'קריאות פתוחות']);
  assert.ok(bot._watchersOf(created.id).has('sX'));
});

test('check_status unknown id returns helpful not-found + greeting suggestions', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({ intent: 'check_status', incidentId: 'INC-DOESNOT' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'status of INC-DOESNOT' });
  assert.match(reply.text, /No incident with id INC-DOESNOT/);
  assert.equal(reply.cards, undefined);
  assert.ok(reply.suggestions && reply.suggestions.length > 0);
});

// ── Listings → cards ──────────────────────────────────────────────────

test('list_incidents returns one incident card per active row', async () => {
  const { incidents, servers } = newStack();
  const open  = incidents.create({ title: 'CPU spike', severity: 'medium', source: 'manual' });
  const inv   = incidents.create({ title: 'Latency',   severity: 'high',   source: 'manual' });
  incidents.update(inv.id, { status: 'investigating' });
  const done  = incidents.create({ title: 'Old thing', severity: 'low',    source: 'manual' });
  incidents.resolve(done.id, 'fixed');
  const factory = mockFactory(JSON.stringify({ intent: 'list_incidents' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'show open incidents' });
  assert.equal(reply.cards?.length, 2);
  const ids = (reply.cards as IncidentCard[]).map(c => c.id).sort();
  assert.deepEqual(ids, [open.id, inv.id].sort());
});

test('list_servers returns server cards with status + metrics when MetricsHistoryStore is wired', async () => {
  const { incidents, servers, metrics } = newStack({ withMetrics: true });
  // Insert a sample CPU/memory/disk reading for web01.
  const now = new Date().toISOString();
  metrics!.record([
    { timestamp: now, serverId: 'web01', metricType: 'cpu',    value: 42 },
    { timestamp: now, serverId: 'web01', metricType: 'memory', value: 71 },
    { timestamp: now, serverId: 'web01', metricType: 'disk',   value: 88, dimension: '/data' },
  ]);
  const factory = mockFactory(JSON.stringify({ intent: 'list_servers' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers, metrics });
  const reply = await bot.handle({ sessionId: 's1', text: 'which servers are monitored?' });
  assert.equal(reply.cards?.length, 2);
  const web = (reply.cards as ServerCard[]).find(c => c.id === 'web01')!;
  assert.equal(web.kind, 'server');
  assert.equal(web.metrics?.cpu, 42);
  assert.equal(web.metrics?.memory, 71);
  assert.equal(web.metrics?.disk, 88);
});

test('list_servers without metrics store omits the metrics field', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({ intent: 'list_servers' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'servers' });
  const local = (reply.cards as ServerCard[]).find(c => c.id === 'local')!;
  assert.equal(local.metrics, undefined);
});

// ── General intent — deterministic fallback when no Anthropic SDK ─────

test('general intent without anthropic config returns deterministic help blurb', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({ intent: 'general', question: 'what can you do?' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'hi' });
  assert.match(reply.text, /open incidents/);
  assert.ok(reply.suggestions && reply.suggestions.includes('קריאות פתוחות'));
});

// ── Streaming — onChunk wiring ────────────────────────────────────────

test('onChunk is not invoked for deterministic intents', async () => {
  const { incidents, servers } = newStack();
  incidents.create({ title: 'X', severity: 'high', source: 'manual' });
  const factory = mockFactory(JSON.stringify({ intent: 'list_incidents' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const chunks: string[] = [];
  await bot.handle({ sessionId: 's1', text: 'open?' }, { onChunk: c => chunks.push(c) });
  assert.equal(chunks.length, 0, 'list_incidents must not stream — it is a DB lookup');
});

// ── chat:action — escalate / resolve ──────────────────────────────────

test('handleAction escalate raises severity and returns updated card', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'Memory pressure', severity: 'medium', source: 'manual' });
  const factory = mockFactory('');
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handleAction({ sessionId: 's1', action: 'escalate', targetId: created.id });
  assert.equal(reply.incidentId, created.id);
  const card = reply.cards?.[0] as IncidentCard;
  assert.equal(card.severity, 'high');
  assert.match(reply.text, /Escalated/);
  assert.ok(bot._watchersOf(created.id).has('s1'));
});

test('handleAction resolve flips status to resolved', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'Service down', severity: 'high', source: 'manual' });
  const factory = mockFactory('');
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handleAction({ sessionId: 's1', action: 'resolve', targetId: created.id });
  const card = reply.cards?.[0] as IncidentCard;
  assert.equal(card.status, 'resolved');
  assert.match(reply.text, /Resolved/);
});

test('handleAction with unknown targetId returns a friendly not-found', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory('');
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handleAction({ sessionId: 's1', action: 'escalate', targetId: 'INC-NOPE' });
  assert.match(reply.text, /No incident with id INC-NOPE/);
});

// ── Attachments — vision routing ──────────────────────────────────────

test('image attachment without anthropic config returns a polite fallback', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({ intent: 'general' })); // would route to general; vision short-circuits
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'look at this',
    attachment: { name: 'shot.png', type: 'image/png', data: 'AAAA' },
  });
  assert.match(reply.text, /Image analysis isn't configured/i);
});

test('unsupported attachment mime type is rejected with a clear message', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({ intent: 'general' }));
  const bot = new ChatBotService({
    aiFactory: factory, incidents, servers,
    // Even with a key set, an unsupported MIME shouldn't trigger an API call.
    anthropicApiKey: 'sk-test', anthropicBaseUrl: 'http://127.0.0.1:1', anthropicModel: 'mock',
  });
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'check this file',
    attachment: { name: 'doc.pdf', type: 'application/pdf', data: 'AAAA' },
  });
  assert.match(reply.text, /isn't supported|not supported/i);
});

// ── Heuristic fallback still works ────────────────────────────────────

test('classifier failure routes through heuristic intent detection', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'Down host', severity: 'high', source: 'manual' });
  const factory = mockFactory(new Error('AI provider unreachable'));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: `status of ${created.id}` });
  assert.equal(reply.incidentId, created.id);
});

test('heuristic detects open-incidents query in Hebrew when classifier fails', async () => {
  const { incidents, servers } = newStack();
  incidents.create({ title: 'thing', severity: 'medium', source: 'manual' });
  const factory = mockFactory(new Error('boom'));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'קריאות פתוחות' });
  assert.equal(reply.cards?.length, 1);
});

// ── Bookkeeping ───────────────────────────────────────────────────────

test('notifyIncidentChange pushes updates only to subscribed sessions', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'Memory pressure', severity: 'high', source: 'manual' });
  const factory = mockFactory(JSON.stringify({ intent: 'check_status', incidentId: created.id }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const pushed: ChatPushEvent[] = [];
  bot.setPushSender(evt => { pushed.push(evt); });
  await bot.handle({ sessionId: 'watcher', text: `status of ${created.id}` });
  bot.notifyIncidentChange({ id: created.id, title: created.title, status: 'investigating', severity: 'high' });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].sessionId, 'watcher');
});

test('forgetSession clears watchers + history', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'thing', severity: 'medium', source: 'manual' });
  const factory = mockFactory(JSON.stringify({ intent: 'check_status', incidentId: created.id }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  await bot.handle({ sessionId: 's1', text: `status of ${created.id}` });
  bot.forgetSession('s1');
  assert.equal(bot._watchersOf(created.id).has('s1'), false);
  assert.equal(bot._historyFor('s1').length, 0);
});

test('per-session history is kept separate', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({ intent: 'general' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  await bot.handle({ sessionId: 'A', text: 'hi from A' });
  await bot.handle({ sessionId: 'B', text: 'hi from B' });
  assert.equal(bot._historyFor('A').length, 2);
  assert.equal(bot._historyFor('B').length, 2);
});

test('parseIntent tolerates code-fenced JSON from the classifier', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory('```json\n{"intent":"list_incidents"}\n```');
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({ sessionId: 's1', text: 'open ones?' });
  assert.match(reply.text, /No active incidents|active incident/);
});

// ── User context + role-gated refusals ────────────────────────────────

test('viewer cannot create incidents — handle() refuses in Hebrew before any DB write', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({
    intent: 'report_incident', title: 'web01 down', severity: 'high',
  }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const beforeCount = incidents.list({}).length;
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'web01 לא עובד!',
    user: { username: 'casual', role: 'viewer' },
  });
  assert.match(reply.text, /אין לך הרשאה/);
  assert.equal(incidents.list({}).length, beforeCount, 'no incident should have been created');
  assert.equal(reply.incidentId, undefined);
});

test('viewer CAN run read-only intents (list_incidents)', async () => {
  const { incidents, servers } = newStack();
  incidents.create({ title: 'thing', severity: 'medium', source: 'manual' });
  const factory = mockFactory(JSON.stringify({ intent: 'list_incidents' }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'open ones?',
    user: { username: 'casual', role: 'viewer' },
  });
  assert.equal(reply.cards?.length, 1);
});

test('operator can create incidents', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({
    intent: 'report_incident', title: 'CPU spike', severity: 'medium',
  }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'cpu spiking',
    user: { username: 'op1', role: 'operator' },
  });
  assert.ok(reply.incidentId, 'operator should be allowed to create incidents');
});

test('handleAction refuses viewer with Hebrew message before touching incident', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'Service down', severity: 'high', source: 'manual' });
  const factory = mockFactory('');
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handleAction({
    sessionId: 's1', action: 'escalate', targetId: created.id,
    user: { username: 'casual', role: 'viewer' },
  });
  assert.match(reply.text, /אין לך הרשאה/);
  // Severity must be unchanged.
  const after = incidents.get(created.id);
  assert.equal(after!.severity, 'high');
  assert.equal(after!.status, 'open');
});

test('handleAction admin can still resolve', async () => {
  const { incidents, servers } = newStack();
  const created = incidents.create({ title: 'X', severity: 'medium', source: 'manual' });
  const factory = mockFactory('');
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handleAction({
    sessionId: 's1', action: 'resolve', targetId: created.id,
    user: { username: 'admin', role: 'admin' },
  });
  assert.match(reply.text, /Resolved/);
  assert.equal(incidents.get(created.id)!.status, 'resolved');
});

// ── create_runbook intent ─────────────────────────────────────────────

test('create_runbook intent calls the generator and returns a preview card', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({
    intent: 'create_runbook',
    runbookPrompt: 'Create a runbook for when nginx goes down on web01',
  }));
  const generatorCalls: any[] = [];
  const bot = new ChatBotService({
    aiFactory: factory, incidents, servers,
    runbookGenerator: {
      fromPrompt: async (input) => {
        generatorCalls.push(input);
        return {
          id: 'restart-nginx',
          name: 'Restart Nginx',
          description: 'Restart and verify nginx',
          category: 'infrastructure',
          tags: ['nginx'],
          steps: [
            { id: 'check',   type: 'check_metric', description: 'systemctl status nginx' },
            { id: 'restart', type: 'command',      description: 'systemctl restart nginx' },
          ],
          enabled: false,
          reasoning: 'Two-step fix',
          confidence: 0.78,
        };
      },
    },
  });
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'create a runbook for when nginx goes down on web01',
    user: { username: 'alice', role: 'operator' },
  });
  assert.equal(generatorCalls.length, 1);
  assert.match(generatorCalls[0].prompt, /nginx/);
  assert.equal(generatorCalls[0].actor, 'alice');
  assert.match(reply.text, /Restart Nginx/);
  assert.match(reply.text, /restart-nginx/);
  assert.match(reply.text, /disabled/);
});

test('create_runbook intent falls back to a friendly message when generator is absent', async () => {
  const { incidents, servers } = newStack();
  const factory = mockFactory(JSON.stringify({
    intent: 'create_runbook',
    runbookPrompt: 'something',
  }));
  const bot = new ChatBotService({ aiFactory: factory, incidents, servers });
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'create a runbook for when nginx goes down',
  });
  assert.match(reply.text, /not configured/i);
});

test('create_runbook heuristic intent path triggers before report_incident', async () => {
  const { incidents, servers } = newStack();
  // Classifier throws so the service falls back to the heuristic.
  const factory = mockFactory(new Error('classifier offline'));
  const generatorCalls: any[] = [];
  const bot = new ChatBotService({
    aiFactory: factory, incidents, servers,
    runbookGenerator: {
      fromPrompt: async (input) => {
        generatorCalls.push(input);
        return {
          id: 'auto-clean-disk',
          name: 'Auto Clean Disk',
          description: 'Free /var when above 90%',
          category: 'infrastructure',
          tags: ['disk'],
          steps: [{ id: 's1', type: 'command', description: 'truncate logs' }],
          enabled: false,
          reasoning: '',
          confidence: 0.6,
        };
      },
    },
  });
  // Phrase contains both "runbook" + "down" — the heuristic must route
  // to create_runbook, not report_incident.
  const reply = await bot.handle({
    sessionId: 's1',
    text: 'make a runbook for when disk fills up and nginx goes down',
  });
  assert.equal(generatorCalls.length, 1);
  assert.match(reply.text, /Auto Clean Disk/);
});

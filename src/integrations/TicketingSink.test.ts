import test from 'node:test';
import assert from 'node:assert/strict';
import { TicketingSink } from './TicketingSink.js';
import * as Metrics from '../observability/Metrics.js';

async function ticketingMetricValue(system: string, status: string): Promise<number> {
  const metric = (await Metrics.registry.getMetricsAsJSON())
    .find(m => m.name === 'beacon_ticketing_sync_total');
  return metric?.values.find(v => v.labels.system === system && v.labels.status === status)?.value ?? 0;
}

test('TicketingSink ignores unresolved incidents', async () => {
  const sink = new TicketingSink({ store: { getTimeline: () => [] } as any });
  const before = await ticketingMetricValue('none', 'ignored_unresolved');
  const result = await sink.syncResolvedIncident({ id: 'INC-1', status: 'open' } as any);
  assert.equal(result, false);
  assert.equal(await ticketingMetricValue('none', 'ignored_unresolved'), before + 1);
});

test('TicketingSink ignores already synced incidents (idempotency)', async () => {
  const sink = new TicketingSink({ store: { getTimeline: () => [] } as any });
  const before = await ticketingMetricValue('none', 'ignored_already_synced');
  const result = await sink.syncResolvedIncident({ id: 'INC-IDEMPOTENT', status: 'resolved', ticketingSynced: true } as any);
  assert.equal(result, false);
  assert.equal(await ticketingMetricValue('none', 'ignored_already_synced'), before + 1);
});

test('TicketingSink ignores persisted ticketingSynced incidents before side effects', async () => {
  let transitionCount = 0;
  const sink = new TicketingSink({
    getJiraService: () => ({
      isEnabled: () => true,
      transitionTicket: async () => { transitionCount++; },
      addCommentToTicket: async () => {},
    } as any),
    store: {
      get: () => ({ id: 'INC-PERSISTED', status: 'resolved', ticketingSynced: true }),
      getTimeline: () => [],
    } as any,
  });

  assert.equal(await sink.syncResolvedIncident({ id: 'INC-PERSISTED', status: 'resolved', ticketingSynced: false } as any), false);
  assert.equal(transitionCount, 0);
});

test('TicketingSink transitions and comments existing Jira ticket, marks synced', async () => {
  let transitioned = '';
  let commented = '';
  let markedSyncedId = '';
  const before = await ticketingMetricValue('jira', 'success');
  const jiraService = {
    isEnabled: () => true,
    transitionTicket: async (key: string, st: string) => { transitioned = `${key}:${st}`; },
    addCommentToTicket: async (key: string, c: string) => { commented = c; }
  };
  
  const sink = new TicketingSink({
    getJiraService: () => jiraService as any,
    store: {
      getTimeline: () => [{ type: 'resolved', message: 'The fix was applied successfully.' }],
      markTicketingSynced: (id: string) => { markedSyncedId = id; }
    } as any
  });

  const result = await sink.syncResolvedIncident({ id: 'INC-2', status: 'resolved', jiraKey: 'OPS-100', ticketingSynced: false } as any);
  assert.equal(result, true);
  assert.equal(transitioned, 'OPS-100:resolved');
  assert.match(commented, /The fix was applied successfully/);
  assert.equal(markedSyncedId, 'INC-2');
  assert.equal(await ticketingMetricValue('jira', 'success'), before + 1);
});

test('TicketingSink creates new Jira ticket if Jira enabled but not linked', async () => {
  let created = false;
  let transitioned = '';
  let markedSyncedId = '';
  let persistedJiraKey = '';
  let persistedJiraUrl = '';
  const jiraService = {
    isEnabled: () => true,
    createTicketForIncident: async () => { created = true; return 'OPS-101'; },
    transitionTicket: async (key: string, st: string) => { transitioned = `${key}:${st}`; },
    addCommentToTicket: async () => {}
  };
  
  const sink = new TicketingSink({
    getJiraService: () => jiraService as any,
    store: {
      get: () => ({ jiraUrl: 'https://jira.example/browse/OPS-101' }),
      getTimeline: () => [],
      updateJiraKey: (_id: string, key: string, url: string) => { persistedJiraKey = key; persistedJiraUrl = url; },
      markTicketingSynced: (id: string) => { markedSyncedId = id; }
    } as any
  });

  const result = await sink.syncResolvedIncident({ id: 'INC-3', status: 'resolved' } as any);
  assert.equal(result, true);
  assert.equal(created, true);
  assert.equal(persistedJiraKey, 'OPS-101');
  assert.equal(persistedJiraUrl, 'https://jira.example/browse/OPS-101');
  assert.equal(transitioned, 'OPS-101:resolved');
  assert.equal(markedSyncedId, 'INC-3');
});

test('TicketingSink does not mark Jira synced when transition or comment reports failure', async () => {
  let markedSynced = false;
  const before = await ticketingMetricValue('jira', 'error');
  const sink = new TicketingSink({
    getJiraService: () => ({
      isEnabled: () => true,
      transitionTicket: async () => false,
      addCommentToTicket: async () => true,
    } as any),
    store: {
      getTimeline: () => [],
      markTicketingSynced: () => { markedSynced = true; },
    } as any,
  });

  assert.equal(await sink.syncResolvedIncident({ id: 'INC-JIRA-FALSE', status: 'resolved', jiraKey: 'OPS-FALSE', ticketingSynced: false } as any), false);
  assert.equal(markedSynced, false);
  assert.equal(await ticketingMetricValue('jira', 'error'), before + 1);
});

test('TicketingSink retries Jira side effects without creating a duplicate after a crash', async () => {
  let persistedJiraKey: string | undefined;
  let createCount = 0;
  let transitionCount = 0;
  const incident = { id: 'INC-CRASH', status: 'resolved', ticketingSynced: false } as any;
  const store = {
    get: () => ({ ...incident, jiraKey: persistedJiraKey }),
    getTimeline: () => [],
    updateJiraKey: (_id: string, key: string) => { persistedJiraKey = key; },
    markTicketingSynced: () => {},
  } as any;
  const jiraService = {
    isEnabled: () => true,
    createTicketForIncident: async () => { createCount++; return 'OPS-CRASH'; },
    transitionTicket: async () => {
      transitionCount++;
      if (transitionCount === 1) throw new Error('simulated crash');
    },
    addCommentToTicket: async () => {},
  };

  const firstSink = new TicketingSink({ getJiraService: () => jiraService as any, store });
  await assert.rejects(firstSink.syncResolvedIncident(incident), /simulated crash/);
  assert.equal(persistedJiraKey, 'OPS-CRASH');

  const retrySink = new TicketingSink({ getJiraService: () => jiraService as any, store });
  assert.equal(await retrySink.syncResolvedIncident({ ...incident, jiraKey: undefined }), true);
  assert.equal(createCount, 1);
});

test('TicketingSink records Jira errors before rethrowing', async () => {
  const before = await ticketingMetricValue('jira', 'error');
  const sink = new TicketingSink({
    getJiraService: () => ({
      isEnabled: () => true,
      transitionTicket: async () => { throw new Error('transition failed'); },
      addCommentToTicket: async () => {},
    } as any),
    store: {
      getTimeline: () => [],
    } as any,
  });

  await assert.rejects(
    sink.syncResolvedIncident({ id: 'INC-JIRA-ERR', status: 'resolved', jiraKey: 'OPS-ERR', ticketingSynced: false } as any),
    /transition failed/,
  );
  assert.equal(await ticketingMetricValue('jira', 'error'), before + 1);
});

test('TicketingSink suppresses concurrent duplicate syncs for the same incident', async () => {
  let releaseTransition!: () => void;
  let markTransitionStarted!: () => void;
  let transitionCount = 0;
  const transitionStarted = new Promise<void>(resolve => { markTransitionStarted = resolve; });
  const releaseTransitionPromise = new Promise<void>(resolve => { releaseTransition = resolve; });
  const jiraService = {
    isEnabled: () => true,
    transitionTicket: async () => {
      transitionCount++;
      markTransitionStarted();
      await releaseTransitionPromise;
    },
    addCommentToTicket: async () => {},
  };
  const sink = new TicketingSink({
    getJiraService: () => jiraService as any,
    store: {
      get: () => ({ id: 'INC-CONCURRENT', status: 'resolved', jiraKey: 'OPS-CONCURRENT', ticketingSynced: false }),
      getTimeline: () => [],
      markTicketingSynced: () => {},
    } as any,
  });

  const first = sink.syncResolvedIncident({ id: 'INC-CONCURRENT', status: 'resolved', jiraKey: 'OPS-CONCURRENT', ticketingSynced: false } as any);
  await transitionStarted;
  assert.equal(await sink.syncResolvedIncident({ id: 'INC-CONCURRENT', status: 'resolved', jiraKey: 'OPS-CONCURRENT', ticketingSynced: false } as any), false);
  releaseTransition();
  assert.equal(await first, true);
  assert.equal(transitionCount, 1);
});

test('TicketingSink falls back to GitHub if Jira disabled, marks synced with issue number', async () => {
  let closedNumber = 0;
  let payload: any = null;
  let syncedArgs: any[] = [];

  class FakeGh {
    config = { enabled: true, token: 'x', owner: 'a', repo: 'b' };
    async createIssue(p: any) { payload = p; return { number: 42, url: 'gh' }; }
    async closeIssue(n: number) { closedNumber = n; return true; }
  }
  
  const sink = new TicketingSink({
    getJiraService: () => ({ isEnabled: () => false } as any),
    getGitHubConfig: () => ({ enabled: true, token: 'gh-token', owner: 'test', repo: 'repo' }),
    store: {
      getTimeline: () => [{ type: 'resolved', message: 'GH resolution' }],
      updateGitHubIssueNumber: () => {},
      markTicketingSynced: (id: string, issueNum?: number) => { syncedArgs = [id, issueNum]; }
    } as any
  });
  // Inject mock
  (sink as any).githubService = new FakeGh();

  const result = await sink.syncResolvedIncident({ id: 'INC-4', title: 'DB down', status: 'resolved', severity: 'high', source: 'monitor', ticketingSynced: false } as any);
  assert.equal(result, true);
  assert.equal(closedNumber, 42);
  assert.equal(payload.title, '[Resolved] DB down');
  assert.match(payload.body, /GH resolution/);
  assert.deepEqual(syncedArgs, ['INC-4', 42]);
});

test('TicketingSink closes persisted GitHub issue without creating a duplicate', async () => {
  let createCount = 0;
  let closedNumber = 0;

  class FakeGh {
    config = { enabled: true, token: 'x', owner: 'a', repo: 'b' };
    async createIssue() { createCount++; return { number: 99, url: 'gh' }; }
    async closeIssue(n: number) { closedNumber = n; return true; }
  }

  const sink = new TicketingSink({
    getJiraService: () => ({ isEnabled: () => false } as any),
    getGitHubConfig: () => ({ enabled: true, token: 'gh-token', owner: 'test', repo: 'repo' }),
    store: {
      get: () => ({ id: 'INC-GH-PERSISTED', status: 'resolved', githubIssueNumber: 77, ticketingSynced: false }),
      getTimeline: () => [],
      updateGitHubIssueNumber: () => { throw new Error('must not update persisted issue number'); },
      markTicketingSynced: () => {},
    } as any,
  });
  (sink as any).githubService = new FakeGh();

  assert.equal(await sink.syncResolvedIncident({ id: 'INC-GH-PERSISTED', title: 'API down', status: 'resolved', severity: 'medium', source: 'monitor', ticketingSynced: false } as any), true);
  assert.equal(createCount, 0);
  assert.equal(closedNumber, 77);
});

test('TicketingSink records skipped metric when no backend is configured', async () => {
  const before = await ticketingMetricValue('none', 'skipped');
  const sink = new TicketingSink({
    store: {
      getTimeline: () => [],
    } as any,
  });

  assert.equal(await sink.syncResolvedIncident({ id: 'INC-NO-BACKEND', status: 'resolved', ticketingSynced: false } as any), false);
  assert.equal(await ticketingMetricValue('none', 'skipped'), before + 1);
});

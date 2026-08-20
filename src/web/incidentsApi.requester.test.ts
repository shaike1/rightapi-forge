// Scoped-access tests for the self-service requester role. Asserts:
//   • Requesters can create incidents (incidents.create.own perm)
//   • Created incidents are stamped with createdBy = the JWT subject
//   • /api/incidents/mine returns only the caller's rows
//   • GET /:id refuses to read someone else's incident with 404 (no
//     leak between 403 / 404 — same response either way)
//   • Mutation routes (PATCH/escalate/resolve) remain forbidden
//   • Admin and operator stay unscoped — they still see /mine = own
//     created rows but the legacy list returns everything

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createIncidentsRouter } from './incidentsApi.js';
import { IncidentManager } from '../incidents/IncidentManager.js';
import { SqliteIncidentStore } from '../persistence/SqliteStore.js';

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itops-inc-req-'));
  return path.join(dir, 'inc.db');
}

type Principal = { ok: true; username: string; role: 'admin' | 'operator' | 'viewer' | 'requester' };
type Role = Principal['role'];

const PERMISSIONS: Record<Role, Set<string>> = {
  admin:     new Set(['security.read', 'security.write', 'incidents.read.own', 'incidents.create.own']),
  operator:  new Set(['security.read', 'security.write', 'incidents.read.own', 'incidents.create.own']),
  viewer:    new Set(['security.read']),
  requester: new Set(['incidents.read.own', 'incidents.create.own']),
};

/** Fake validateAuth that pulls the role from a header. Tests pick the
 *  caller's identity by setting `Authorization: <username>:<role>`. */
function fakeValidateAuth(authHeader: string | undefined, permission?: string) {
  if (!authHeader) return { ok: false, reason: 'no auth' };
  const m = authHeader.replace(/^Bearer\s+/i, '').split(':');
  if (m.length !== 2) return { ok: false, reason: 'malformed' };
  const [username, role] = m as [string, Role];
  if (!PERMISSIONS[role]) return { ok: false, reason: 'bad role' };
  if (permission && !PERMISSIONS[role].has(permission)) return { ok: false, reason: `missing ${permission}` };
  return { ok: true, username, role };
}

async function startApp() {
  const dbPath = tempDb();
  const store = new SqliteIncidentStore(dbPath);
  const incidentManager = new IncidentManager(store);
  const app = express();
  app.use(express.json());
  app.use('/api/incidents', createIncidentsRouter({
    incidentManager,
    incidentAnalyzer: { analyze: async () => ({}) } as any,
    getJiraService: () => null,
    teamsProvider: { sendIncidentCard: async () => {} } as any,
    teamsConfigStore: { getWebhookUrl: () => '' } as any,
    slackService: { loadConfig: () => ({ events: {} }), notifyIncident: async () => {} } as any,
    discordService: { loadConfig: () => ({ events: {} }), notifyIncident: async () => {} } as any,
    broadcast: () => {},
    createNotification: () => {},
    validateAuth: fakeValidateAuth as any,
    validateAuthToken: fakeValidateAuth as any,
    logError: () => {},
  }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    incidentManager,
    store,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function asUser(username: string, role: Role) {
  return `Bearer ${username}:${role}`;
}

test('requester can create an incident and it is stamped with createdBy', async () => {
  const app = await startApp();
  try {
    const resp = await fetch(`${app.base}/api/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: asUser('alice', 'requester') },
      body: JSON.stringify({ title: 'mail outage', description: 'cant send', severity: 'high' }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json() as any;
    assert.equal(body.title, 'mail outage');
    assert.equal(body.createdBy, 'alice');
  } finally { await app.close(); app.store.close(); }
});

test('requester /mine returns only their own incidents', async () => {
  const app = await startApp();
  try {
    // Three rows: alice x 2, bob x 1
    await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('alice', 'requester') },
      body: JSON.stringify({ title: 'a1', severity: 'low' }),
    });
    await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('alice', 'requester') },
      body: JSON.stringify({ title: 'a2', severity: 'low' }),
    });
    await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('bob', 'requester') },
      body: JSON.stringify({ title: 'b1', severity: 'medium' }),
    });

    const mineResp = await fetch(`${app.base}/api/incidents/mine`, {
      headers: { Authorization: asUser('alice', 'requester') },
    });
    assert.equal(mineResp.status, 200);
    const mine = await mineResp.json() as any;
    assert.equal(mine.total, 2);
    assert.ok(mine.incidents.every((i: any) => i.createdBy === 'alice'));
  } finally { await app.close(); app.store.close(); }
});

test('requester cannot read another requester incident via GET /:id (404 not 403)', async () => {
  const app = await startApp();
  try {
    const createBob = await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('bob', 'requester') },
      body: JSON.stringify({ title: 'bobs ticket', severity: 'medium' }),
    });
    const bobIncident = await createBob.json() as any;

    // Alice tries to peek at Bob's ticket. Should look like the row
    // doesn't exist — same 404 as truly-missing — so the API surface
    // doesn't leak ID existence.
    const peek = await fetch(`${app.base}/api/incidents/${bobIncident.id}`, {
      headers: { Authorization: asUser('alice', 'requester') },
    });
    assert.equal(peek.status, 404);

    // Bob can still read his own row.
    const own = await fetch(`${app.base}/api/incidents/${bobIncident.id}`, {
      headers: { Authorization: asUser('bob', 'requester') },
    });
    assert.equal(own.status, 200);
    const ownBody = await own.json() as any;
    assert.equal(ownBody.id, bobIncident.id);
  } finally { await app.close(); app.store.close(); }
});

test('requester cannot list all incidents (no security.read)', async () => {
  const app = await startApp();
  try {
    const r = await fetch(`${app.base}/api/incidents`, {
      headers: { Authorization: asUser('alice', 'requester') },
    });
    assert.equal(r.status, 403);
  } finally { await app.close(); app.store.close(); }
});

test('requester cannot mutate via PATCH (no security.write)', async () => {
  const app = await startApp();
  try {
    const create = await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('alice', 'requester') },
      body: JSON.stringify({ title: 'mine', severity: 'low' }),
    });
    const inc = await create.json() as any;
    const patch = await fetch(`${app.base}/api/incidents/${inc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: asUser('alice', 'requester') },
      body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(patch.status, 403);
  } finally { await app.close(); app.store.close(); }
});

test('admin /mine returns only incidents the admin personally filed', async () => {
  const app = await startApp();
  try {
    // alice (requester) files one, admin1 files one — admin sees only theirs in /mine.
    await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('alice', 'requester') },
      body: JSON.stringify({ title: 'alice ticket', severity: 'low' }),
    });
    await fetch(`${app.base}/api/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: asUser('admin1', 'admin') },
      body: JSON.stringify({ title: 'admin ticket', severity: 'low' }),
    });
    const mine = await fetch(`${app.base}/api/incidents/mine`, {
      headers: { Authorization: asUser('admin1', 'admin') },
    });
    const body = await mine.json() as any;
    assert.equal(body.total, 1);
    assert.equal(body.incidents[0].createdBy, 'admin1');

    // But admin's legacy list endpoint still sees everything.
    const list = await fetch(`${app.base}/api/incidents`, {
      headers: { Authorization: asUser('admin1', 'admin') },
    });
    const listBody = await list.json() as any;
    assert.equal(listBody.total, 2);
  } finally { await app.close(); app.store.close(); }
});

test('requester GET /:id 404 is indistinguishable from a truly-missing id', async () => {
  const app = await startApp();
  try {
    const r = await fetch(`${app.base}/api/incidents/INC-DOES-NOT-EXIST`, {
      headers: { Authorization: asUser('alice', 'requester') },
    });
    assert.equal(r.status, 404);
    const body = await r.json() as any;
    assert.equal(body.error, 'Not found');
  } finally { await app.close(); app.store.close(); }
});

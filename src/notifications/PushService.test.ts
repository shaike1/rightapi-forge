import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PushService, type PushSender } from './PushService.js';

function tempPaths(): { dir: string; db: string; vapid: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pushtest-'));
  return { dir, db: join(dir, 'push.db'), vapid: join(dir, 'vapid.json') };
}

function fakeSubscription(endpoint: string) {
  return {
    endpoint,
    keys: { p256dh: 'p256dh_' + endpoint.slice(-6), auth: 'auth_' + endpoint.slice(-6) },
  };
}

test('PushService: generates VAPID keys on first boot', () => {
  const { dir, db, vapid } = tempPaths();
  try {
    assert.equal(existsSync(vapid), false);
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid });
    const pub = svc.getVapidPublicKey();
    assert.ok(pub && pub.length > 40, 'public key should be a non-trivial string');
    // Wrote the keypair to disk so it survives restarts.
    assert.equal(existsSync(vapid), true);
    const persisted = JSON.parse(readFileSync(vapid, 'utf8'));
    assert.equal(persisted.publicKey, pub);
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: reuses VAPID keys across restarts', () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const a = new PushService({ dbPath: db, vapidKeyPath: vapid });
    const pubA = a.getVapidPublicKey();
    a.close();
    const b = new PushService({ dbPath: db, vapidKeyPath: vapid });
    assert.equal(b.getVapidPublicKey(), pubA, 'second boot should load same keypair');
    b.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: subscribe is idempotent on endpoint collision', () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid });
    const sub = fakeSubscription('https://push.example.com/abc');
    const a = svc.subscribe('alice', sub);
    const b = svc.subscribe('alice', sub);
    assert.equal(a.endpoint, b.endpoint);
    assert.equal(svc.count(), 1, 'second subscribe of same endpoint must not insert a new row');
    // Re-subscribe with a different user updates ownership atomically.
    const c = svc.subscribe('bob', sub);
    assert.equal(c.userId, 'bob');
    assert.equal(svc.count(), 1);
    assert.equal(svc.listSubscriptions('alice').length, 0);
    assert.equal(svc.listSubscriptions('bob').length, 1);
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: subscribe rejects malformed inputs', () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid });
    assert.throws(() => svc.subscribe('', fakeSubscription('https://x/1')), /userId/);
    assert.throws(() => svc.subscribe('alice', { endpoint: '', keys: { p256dh: 'p', auth: 'a' } } as any), /endpoint/);
    assert.throws(() => svc.subscribe('alice', { endpoint: 'https://x/2', keys: { p256dh: '', auth: 'a' } } as any), /keys/);
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: unsubscribe removes only the matching row', () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid });
    svc.subscribe('alice', fakeSubscription('https://push/alice-laptop'));
    svc.subscribe('alice', fakeSubscription('https://push/alice-phone'));
    svc.subscribe('bob',   fakeSubscription('https://push/bob-laptop'));
    assert.equal(svc.count(), 3);

    const removed = svc.unsubscribe('alice', 'https://push/alice-phone');
    assert.equal(removed, true);
    assert.equal(svc.count(), 2);

    // Wrong owner can't remove someone else's row.
    const denied = svc.unsubscribe('bob', 'https://push/alice-laptop');
    assert.equal(denied, false);
    assert.equal(svc.count(), 2);
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: sendNotification fans out to every device the user has', async () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const sent: Array<{ endpoint: string; payload: any }> = [];
    const sender: PushSender = async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    };
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid, sender });
    svc.subscribe('alice', fakeSubscription('https://push/alice-1'));
    svc.subscribe('alice', fakeSubscription('https://push/alice-2'));
    svc.subscribe('bob',   fakeSubscription('https://push/bob-1'));

    const result = await svc.sendNotification('alice', { title: 'Hi', body: 'Hello', url: '/app/' });
    assert.equal(result.sent, 2);
    assert.equal(result.failed, 0);
    assert.equal(sent.length, 2);
    assert.ok(sent.every(s => s.payload.title === 'Hi'));
    // Default icon stamped in
    assert.ok(sent[0].payload.icon, 'icon default should be filled in');
    // Bob got nothing.
    assert.equal(sent.filter(s => s.endpoint.includes('bob')).length, 0);
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: sendToUsers dedupes the recipient list', async () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const sent: any[] = [];
    const sender: PushSender = async (sub, p) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(p) }); };
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid, sender });
    svc.subscribe('alice', fakeSubscription('https://push/alice-1'));
    svc.subscribe('bob',   fakeSubscription('https://push/bob-1'));
    const r = await svc.sendToUsers(['alice', 'alice', 'bob', '', 'alice'], { title: 't', body: 'b' });
    assert.equal(r.sent, 2, 'each user reached once, no duplicate fan-out');
    assert.equal(sent.length, 2);
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: 410/404 errors auto-prune the dead endpoint', async () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const sender: PushSender = async (sub) => {
      // First endpoint returns 410 Gone — browser told us it's dead.
      if (sub.endpoint.endsWith('dead')) {
        const err: any = new Error('Gone');
        err.statusCode = 410;
        throw err;
      }
    };
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid, sender });
    svc.subscribe('alice', fakeSubscription('https://push/dead'));
    svc.subscribe('alice', fakeSubscription('https://push/alive'));
    assert.equal(svc.count(), 2);
    const r = await svc.sendNotification('alice', { title: 't', body: 'b' });
    assert.equal(r.sent, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.pruned, 1);
    assert.equal(svc.count(), 1, 'dead endpoint removed from store');
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: transient (non-410) error does NOT prune the endpoint', async () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const sender: PushSender = async () => {
      const err: any = new Error('5xx flap');
      err.statusCode = 502;
      throw err;
    };
    const svc = new PushService({ dbPath: db, vapidKeyPath: vapid, sender });
    svc.subscribe('alice', fakeSubscription('https://push/alice-flap'));
    const r = await svc.sendNotification('alice', { title: 't', body: 'b' });
    assert.equal(r.failed, 1);
    assert.equal(r.pruned, 0);
    assert.equal(svc.count(), 1, 'transient errors must not delete the row');
    svc.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

test('PushService: subscriptions persist across restarts', () => {
  const { dir, db, vapid } = tempPaths();
  try {
    const a = new PushService({ dbPath: db, vapidKeyPath: vapid });
    a.subscribe('alice', fakeSubscription('https://push/alice-keep'));
    a.close();
    const b = new PushService({ dbPath: db, vapidKeyPath: vapid });
    assert.equal(b.count(), 1);
    const rows = b.listSubscriptions('alice');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, 'https://push/alice-keep');
    b.close();
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows file-lock; pre-existing pattern */ } }
});

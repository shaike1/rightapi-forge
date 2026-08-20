// PushService — Web Push (PWA) notifications backed by SQLite.
//
// Storage:
//   /data/itops-agents/push.db        — SQLite, table `push_subscriptions`
//   /data/itops-agents/vapid.json     — VAPID key pair (generated on first boot)
//
// Design notes:
//   • Endpoints are unique. A second subscribe with the same endpoint
//     just refreshes the row — handles the case where the same browser
//     re-subscribes after permission revoke/re-grant.
//   • sendNotification fans out to every subscription the user has
//     across devices; failed sends with a 404/410 are auto-pruned (the
//     browser told us the endpoint is gone).
//   • Tests inject a `sender` mock so the wire-format is exercised
//     without hitting the network. Production wraps webpush.sendNotification.
//   • web-push throws synchronously when sendNotification is given a
//     malformed subscription — we catch & log, never reject the calling
//     handler.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { logger } from '../utils/logger.js';

export interface PushSubscriptionDTO {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Deep-link to open when the user clicks the notification. Defaults
   *  to /app/ (the SPA root). Click handler in sw.js focuses an existing
   *  tab on this URL or opens a new one. */
  url?: string;
  /** Optional notification tag — collapses repeated notifications with
   *  the same tag into a single bubble (e.g. tag='sla:INC-123'). */
  tag?: string;
  icon?: string;
  badge?: string;
}

export interface SubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  pruned: number;
}

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

export type PushSender = (sub: WebPushSubscription, payload: string) => Promise<unknown>;

export interface PushServiceOptions {
  /** SQLite db path. Created if missing. */
  dbPath: string;
  /** JSON file storing the VAPID keypair. Created with fresh keys if missing. */
  vapidKeyPath: string;
  /** RFC 8292 "sub" claim — a mailto: or https: URL identifying who runs
   *  the push server. Defaults to mailto:ops@itops-agents.local. Browsers
   *  reject sends without it. */
  vapidSubject?: string;
  /** Test-only: override the wire send. Defaults to webpush.sendNotification. */
  sender?: PushSender;
}

export class PushService {
  private db: Database.Database;
  private vapid: VapidKeyPair;
  private vapidSubject: string;
  private sender: PushSender;

  constructor(opts: PushServiceOptions) {
    // ── DB ────────────────────────────────────────────────────────────
    const dir = dirname(opts.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();

    // ── VAPID keypair (load or generate) ─────────────────────────────
    this.vapidSubject = opts.vapidSubject || 'mailto:ops@itops-agents.local';
    this.vapid = this.loadOrGenerateVapid(opts.vapidKeyPath);
    webpush.setVapidDetails(this.vapidSubject, this.vapid.publicKey, this.vapid.privateKey);

    // ── Sender ────────────────────────────────────────────────────────
    this.sender = opts.sender ?? ((sub, payload) => webpush.sendNotification(sub, payload));

    logger.info('[PushService] ready', {
      vapidPublicKey: this.vapid.publicKey.slice(0, 16) + '…',
      vapidKeyPath: opts.vapidKeyPath,
      dbPath: opts.dbPath,
      subjects: this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get(),
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        endpoint    TEXT NOT NULL UNIQUE,
        p256dh      TEXT NOT NULL,
        auth        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    `);
  }

  private loadOrGenerateVapid(path: string): VapidKeyPair {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
          return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        }
      } catch {
        // Fall through to regenerate. If the file is corrupt we
        // deliberately overwrite — the keys are platform-local, no
        // other system depends on them.
      }
    }
    const keys = webpush.generateVAPIDKeys();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
    logger.info('[PushService] generated fresh VAPID keys', { path });
    return keys;
  }

  getVapidPublicKey(): string {
    return this.vapid.publicKey;
  }

  /** Idempotent subscribe. Same endpoint twice updates user_id +
   *  keys but doesn't create a second row — handles the case where a
   *  user re-grants permission after revoking. */
  subscribe(userId: string, sub: PushSubscriptionDTO): SubscriptionRow {
    if (!userId) throw new Error('userId is required');
    if (!sub || !sub.endpoint) throw new Error('subscription.endpoint is required');
    if (!sub.keys?.p256dh || !sub.keys?.auth) throw new Error('subscription.keys.{p256dh,auth} are required');
    const now = new Date().toISOString();
    // Stable, collision-resistant id derived from the endpoint. Slicing
    // base64url of the raw endpoint string is NOT safe — endpoints from
    // the same push service often share a long common prefix, so a
    // prefix slice loses entropy and we'd see PK collisions. SHA-256
    // gives us a uniform hash space regardless of input shape.
    const id = 'sub_' + createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24);
    this.db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
      VALUES (@id, @user_id, @endpoint, @p256dh, @auth, @created_at)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh  = excluded.p256dh,
        auth    = excluded.auth
    `).run({
      id, user_id: userId, endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh, auth: sub.keys.auth, created_at: now,
    });
    const row = this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint) as any;
    return this.toRow(row);
  }

  unsubscribe(userId: string, endpoint: string): boolean {
    const r = this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
    return r.changes > 0;
  }

  unsubscribeAll(userId: string): number {
    const r = this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    return r.changes;
  }

  listSubscriptions(userId: string): SubscriptionRow[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[];
    return rows.map(r => this.toRow(r));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n;
  }

  /** Send a notification to every device the user has subscribed.
   *  Failed sends with 404/410 prune the dead endpoint automatically.
   *  Never throws — returns a result tally so callers (UI, hooks) can
   *  log/audit without try/catch. */
  async sendNotification(userId: string, payload: PushPayload): Promise<PushSendResult> {
    const subs = this.listSubscriptions(userId);
    return this.fanOut(subs, payload);
  }

  /** Fan-out to a list of users (e.g. "all admins"). Resolved by the
   *  caller — PushService doesn't know about roles, AuthService does. */
  async sendToUsers(userIds: string[], payload: PushPayload): Promise<PushSendResult> {
    const tally: PushSendResult = { sent: 0, failed: 0, pruned: 0 };
    const seen = new Set<string>();
    for (const u of userIds) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      const subs = this.listSubscriptions(u);
      const part = await this.fanOut(subs, payload);
      tally.sent   += part.sent;
      tally.failed += part.failed;
      tally.pruned += part.pruned;
    }
    return tally;
  }

  private async fanOut(subs: SubscriptionRow[], payload: PushPayload): Promise<PushSendResult> {
    let sent = 0, failed = 0, pruned = 0;
    const body = JSON.stringify({
      title: payload.title,
      body:  payload.body,
      url:   payload.url ?? '/app/',
      tag:   payload.tag,
      icon:  payload.icon ?? '/icons/icon-192.png',
      badge: payload.badge ?? '/icons/icon-192.png',
    });
    for (const s of subs) {
      const wpSub: WebPushSubscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await this.sender(wpSub, body);
        sent++;
      } catch (e: any) {
        failed++;
        // 404 / 410 = endpoint dead (user revoked, browser uninstalled).
        // Prune so we don't keep retrying. webpush exposes statusCode on
        // its WebPushError; defensive `Number()` for shaped errors.
        const code = Number(e?.statusCode);
        if (code === 404 || code === 410) {
          try {
            this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
            pruned++;
          } catch {
            // Storage error pruning is non-fatal — fall through.
          }
        } else {
          logger.warn('[PushService] send failed', {
            endpoint: s.endpoint.slice(0, 64),
            err: e?.message || String(e),
            code,
          });
        }
      }
    }
    return { sent, failed, pruned };
  }

  private toRow(r: any): SubscriptionRow {
    return {
      id: r.id, userId: r.user_id, endpoint: r.endpoint,
      p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at,
    };
  }

  close(): void {
    try { this.db.close(); } catch { /* idempotent */ }
  }
}

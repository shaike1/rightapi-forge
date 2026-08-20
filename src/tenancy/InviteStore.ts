// InviteStore — single-use, time-limited invite tokens that let an
// admin pre-authorise a new member into their tenant.
//
// Workflow:
//   1. Admin calls POST /api/auth/invite with { email, role }.
//      Server inserts a row with a random token + expiry.
//   2. The token is delivered to the invitee out-of-band (chat / email
//      forwarded by the admin) — this build does NOT send mail itself.
//   3. The invitee calls POST /api/auth/join with { token, username,
//      password }. The token is consumed (status flips to 'accepted')
//      and a new user is created in the tenant with the role from the
//      invite.
//
// Token shape: 32 bytes of hex (64 chars), unguessable in practice.
// Expiry: default 7 days. Configurable via INVITE_TTL_DAYS env.
//
// Audit:
//   • Every invite create + accept lands in the audit log via the
//     caller (we don't take an audit dep here — keeping the store
//     focused on persistence).

import Database from 'better-sqlite3';
import crypto from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { applyStandardPragmas } from '../utils/SqlitePragmas.js';
import type { UserRole } from '../security/AuthService.js';

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InviteRecord {
  /** Token itself — stored hashed in the row. Returned only on create()
   *  so the admin can hand it off; subsequent get-by-token compares
   *  the SHA-256 hash. */
  token?: string;
  /** Database primary key — short opaque id surfaced in the UI. */
  id: string;
  tenantId: string;
  email: string;
  role: UserRole;
  invitedBy: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
}

interface RawInviteRow {
  id: string;
  tenant_id: string;
  email: string;
  role: UserRole;
  invited_by: string;
  token_hash: string;
  status: InviteStatus;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
}

export interface InviteCreateInput {
  tenantId: string;
  email: string;
  role: UserRole;
  invitedBy: string;
  ttlDays?: number;
}

export class InviteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    applyStandardPragmas(this.db);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenant_invites (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        email       TEXT NOT NULL,
        role        TEXT NOT NULL,
        invited_by  TEXT NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        accepted_at TEXT,
        accepted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invites_tenant ON tenant_invites(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_invites_email  ON tenant_invites(email);
      CREATE INDEX IF NOT EXISTS idx_invites_status ON tenant_invites(status);
    `);
  }

  /** Create a new invite. Returns the record WITH the raw token —
   *  the only time the token is exposed. After this call, the store
   *  holds only the SHA-256 hash. */
  create(input: InviteCreateInput): InviteRecord {
    const now = new Date();
    const ttlDays = Math.max(1, input.ttlDays ?? 7);
    const id = 'inv-' + crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO tenant_invites (id, tenant_id, email, role, invited_by, token_hash, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, input.tenantId, input.email.toLowerCase(), input.role, input.invitedBy, tokenHash, now.toISOString(), expiresAt);
    return {
      id, tenantId: input.tenantId, email: input.email.toLowerCase(),
      role: input.role, invitedBy: input.invitedBy,
      status: 'pending', createdAt: now.toISOString(), expiresAt,
      acceptedAt: null, acceptedBy: null,
      token,
    };
  }

  /** Look up an invite by its plaintext token. Returns null when the
   *  token is unknown, expired, or already consumed. */
  findByToken(token: string): InviteRecord | null {
    const hash = sha256(token);
    const row = this.db.prepare('SELECT * FROM tenant_invites WHERE token_hash = ?').get(hash) as RawInviteRow | undefined;
    if (!row) return null;
    const rec = hydrate(row);
    if (rec.status !== 'pending') return rec; // surface as-is so caller can produce specific error
    if (new Date(rec.expiresAt) < new Date()) {
      this.db.prepare(`UPDATE tenant_invites SET status = 'expired' WHERE id = ?`).run(rec.id);
      return { ...rec, status: 'expired' };
    }
    return rec;
  }

  /** Mark an invite consumed. Idempotent: a second call on the same id
   *  is a no-op. */
  markAccepted(id: string, acceptedBy: string): InviteRecord | null {
    this.db.prepare(`
      UPDATE tenant_invites
      SET status = 'accepted', accepted_at = ?, accepted_by = ?
      WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), acceptedBy, id);
    const row = this.db.prepare('SELECT * FROM tenant_invites WHERE id = ?').get(id) as RawInviteRow | undefined;
    return row ? hydrate(row) : null;
  }

  /** Admin revokes a pending invite. Idempotent. */
  revoke(id: string): boolean {
    const r = this.db.prepare(`
      UPDATE tenant_invites SET status = 'revoked'
      WHERE id = ? AND status = 'pending'
    `).run(id);
    return r.changes > 0;
  }

  /** List invites for a tenant — pending first, newest first within
   *  status. Used by the tenant admin panel's "Pending Invites" card. */
  listForTenant(tenantId: string, opts: { includeAccepted?: boolean } = {}): InviteRecord[] {
    const where = opts.includeAccepted
      ? `WHERE tenant_id = ?`
      : `WHERE tenant_id = ? AND status = 'pending'`;
    const rows = this.db.prepare(`
      SELECT * FROM tenant_invites ${where}
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
    `).all(tenantId) as RawInviteRow[];
    return rows.map(hydrate);
  }

  close(): void { this.db.close(); }
}

function hydrate(r: RawInviteRow): InviteRecord {
  return {
    id: r.id, tenantId: r.tenant_id, email: r.email, role: r.role,
    invitedBy: r.invited_by, status: r.status,
    createdAt: r.created_at, expiresAt: r.expires_at,
    acceptedAt: r.accepted_at, acceptedBy: r.accepted_by,
  };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

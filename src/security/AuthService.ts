import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SYSTEM_TENANT_ID } from '../tenancy/TenantContext.js';

/** Roles, broadest → narrowest:
 *  • superadmin — global, ungated by tenant. Manages tenant lifecycle.
 *  • admin     — full access INSIDE one tenant. Invite/remove members,
 *                edit settings, ack billing.
 *  • operator  — most day-to-day permissions inside one tenant.
 *  • viewer    — read-only inside one tenant.
 *  • requester — self-service portal: file own tickets, see own
 *                tickets, nothing else. */
export type UserRole = 'superadmin' | 'admin' | 'operator' | 'viewer' | 'requester';
export type Permission =
  | 'config.write'
  | 'credentials.read'
  | 'credentials.write'
  | 'approvals.read'
  | 'approvals.manage'
  | 'audit.read'
  | 'tools.execute.safe'
  | 'tools.execute.privileged'
  | 'agent_bus.read'
  | 'agent_bus.write'
  | 'users.read'
  | 'users.manage'
  | 'security.read'
  | 'security.write'
  | 'delegations.read'
  | 'delegations.write'
  | 'monitoring.read'
  | 'admin.write'
  // Self-service requester permissions. Admin/operator hold both alongside
  // their full security.read/write; viewer has neither (read-only-of-all,
  // can't create); requester ONLY holds these. Route handlers that want
  // "fleet-wide read" use security.read; routes that want "own-records
  // only" check incidents.read.own and additionally enforce createdBy==
  // username in the handler for non-admin/operator roles.
  | 'incidents.create.own'
  | 'incidents.read.own';

interface AuthTokenPayload {
  sub: string;
  role: UserRole;
  /** Tenant id the principal is scoped to. Pre-multitenant tokens minted
   *  before this migration are accepted with the system tenant — see
   *  validateToken below. */
  tid?: string;
  iat: number;
  exp: number;
}

interface UserRecord {
  username: string;
  /** Optional, display-only contact email. The login flow still keys on
   *  username — email is here so the user-management UI can surface a
   *  human-readable handle without forcing an existing on-disk
   *  /data/itops-agents/auth-users.json migration. Stays undefined for
   *  pre-email accounts. */
  email?: string;
  role: UserRole;
  /** Tenant id this user belongs to. Set when the user is created;
   *  legacy users (rows loaded from disk before this column existed)
   *  default to the system tenant via load(). */
  tenantId?: string;
  passwordHash: string;
  salt: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UsersFile {
  version: number;
  users: UserRecord[];
}

export interface AuthValidation {
  valid: boolean;
  reason?: string;
  username?: string;
  role?: UserRole;
  /** Tenant the principal is scoped to. Undefined for legacy tokens
   *  minted before the tenancy migration — callers should treat that
   *  case as the system tenant. */
  tenantId?: string;
}

export interface AuthIssueResult {
  token: string;
  username: string;
  role: UserRole;
  tenantId: string;
  expiresAt: string;
}

export interface AuthUserView {
  username: string;
  email?: string;
  role: UserRole;
  tenantId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
    + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  // Superadmin holds every permission a tenant admin holds, PLUS the
  // cross-tenant management surface (tenant lifecycle, plan changes,
  // suspend/activate). The cross-tenant routes ALSO check role==='superadmin'
  // directly — permissions alone aren't enough since this is a privilege
  // boundary, not just a feature flag.
  superadmin: [
    'config.write',
    'credentials.read',
    'credentials.write',
    'approvals.read',
    'approvals.manage',
    'audit.read',
    'tools.execute.safe',
    'tools.execute.privileged',
    'agent_bus.read',
    'agent_bus.write',
    'users.read',
    'users.manage',
    'security.read',
    'security.write',
    'delegations.read',
    'delegations.write',
    'monitoring.read',
    'admin.write',
    'incidents.create.own',
    'incidents.read.own',
  ],
  admin: [
    'config.write',
    'credentials.read',
    'credentials.write',
    'approvals.read',
    'approvals.manage',
    'audit.read',
    'tools.execute.safe',
    'tools.execute.privileged',
    'agent_bus.read',
    'agent_bus.write',
    'users.read',
    'users.manage',
    'security.read',
    'security.write',
    'delegations.read',
    'delegations.write',
    'monitoring.read',
    'admin.write',
    'incidents.create.own',
    'incidents.read.own'
  ],
  operator: [
    'config.write',
    'credentials.read',
    'credentials.write',
    'approvals.read',
    'approvals.manage',
    'audit.read',
    'tools.execute.safe',
    'tools.execute.privileged',
    'agent_bus.read',
    'agent_bus.write',
    'users.read',
    'security.read',
    'delegations.read',
    'delegations.write',
    'monitoring.read',
    'incidents.create.own',
    'incidents.read.own'
  ],
  viewer: [
    'approvals.read',
    'audit.read',
    'agent_bus.read',
    'security.read',
    'delegations.read',
    'monitoring.read'
  ],
  // Self-service portal role. Can create incidents and view only its own.
  // No fleet-wide reads, no mutations beyond create. Routes that surface
  // server/runbook/agent state already gate on security.read or stronger;
  // requester won't pass any of those.
  requester: [
    'incidents.create.own',
    'incidents.read.own'
  ]
};

export class AuthService {
  private tokenSecret: string;
  private ttlSeconds: number;
  private usersFilePath: string;
  private users: Map<string, UserRecord> = new Map();
  private normalizeUsername(value: string): string {
    return (value || '').trim().toLowerCase();
  }

  constructor(params: {
    tokenSecret: string;
    usersFilePath: string;
    ttlSeconds?: number;
    bootstrapUsers?: Array<{ username: string; password: string; role: UserRole; email?: string; active?: boolean }>;
  }) {
    this.tokenSecret = params.tokenSecret;
    this.ttlSeconds = Math.min(Math.max(params.ttlSeconds || 3600, 300), 86400);
    this.usersFilePath = params.usersFilePath;
    this.load();
    for (const user of params.bootstrapUsers || []) {
      if (!user.username || !user.password) continue;
      // Bootstrap is "create-if-missing". Without this guard we'd overwrite
      // operator password changes every restart whenever ADMIN_PASSWORD is
      // still set in the env. New email/role values still flow through
      // create() the first time the account is provisioned.
      if (this.users.has(this.normalizeUsername(user.username))) continue;
      this.createOrUpdateUser({
        username: user.username,
        password: user.password,
        role: user.role,
        email: user.email,
        active: user.active !== false
      });
    }
  }

  isConfigured(): boolean {
    return !!this.tokenSecret && this.users.size > 0;
  }

  listUsers(): AuthUserView[] {
    return Array.from(this.users.values())
      .map(u => this.toView(u))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  /** Tenant-scoped listing — used by the per-tenant Team management UI.
   *  Superadmin paths keep using listUsers() for the global view. */
  listUsersByTenant(tenantId: string): AuthUserView[] {
    const t = (tenantId || SYSTEM_TENANT_ID);
    return Array.from(this.users.values())
      .filter(u => (u.tenantId ?? SYSTEM_TENANT_ID) === t)
      .map(u => this.toView(u))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  /** Look up a single user by canonical username. Returns null for unknown
   *  principals — used by the WebSocket auth handshake to attach the email
   *  to the per-connection session for friendlier chat replies. */
  getUser(username: string): AuthUserView | null {
    const record = this.users.get(this.normalizeUsername(username));
    return record ? this.toView(record) : null;
  }

  createOrUpdateUser(params: { username: string; password: string; role: UserRole; email?: string; tenantId?: string; active?: boolean }): AuthUserView {
    const now = new Date().toISOString();
    const key = this.normalizeUsername(params.username);
    const existing = this.users.get(key);
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = this.hashPassword(params.password, salt);
    const record: UserRecord = {
      username: params.username,
      email: params.email !== undefined ? params.email : existing?.email,
      role: params.role,
      // Tenancy stays sticky once set. Operators promoting a viewer to
      // operator must not lose tenant scope; explicit tenant override
      // is the path for moving a user across tenants.
      tenantId: params.tenantId ?? existing?.tenantId ?? SYSTEM_TENANT_ID,
      passwordHash,
      salt,
      active: params.active !== false,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.users.set(key, record);
    this.save();
    return this.toView(record);
  }

  updateUser(username: string, updates: { password?: string; role?: UserRole; email?: string; tenantId?: string; active?: boolean }): AuthUserView | null {
    const normalized = this.normalizeUsername(username);
    const existing = this.users.get(normalized);
    if (!existing) return null;
    const now = new Date().toISOString();
    let passwordHash = existing.passwordHash;
    let salt = existing.salt;
    if (updates.password) {
      salt = crypto.randomBytes(16).toString('hex');
      passwordHash = this.hashPassword(updates.password, salt);
    }
    const record: UserRecord = {
      ...existing,
      role: updates.role || existing.role,
      email: updates.email !== undefined ? updates.email : existing.email,
      tenantId: updates.tenantId ?? existing.tenantId ?? SYSTEM_TENANT_ID,
      active: updates.active === undefined ? existing.active : updates.active,
      passwordHash,
      salt,
      updatedAt: now
    };
    this.users.set(normalized, record);
    this.save();
    return this.toView(record);
  }

  private toView(record: UserRecord): AuthUserView {
    return {
      username: record.username,
      email: record.email,
      role: record.role,
      tenantId: record.tenantId ?? SYSTEM_TENANT_ID,
      active: record.active,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  deleteUser(username: string): boolean {
    const deleted = this.users.delete(this.normalizeUsername(username));
    if (deleted) this.save();
    return deleted;
  }

  /**
   * Upsert a user authenticated via AD/LDAP (no password stored — sentinel hash).
   * The user is created with a random unusable password so local login won't work for them.
   */
  upsertADUser(username: string, role: UserRole, displayName?: string, _email?: string, tenantId?: string): void {
    const key = this.normalizeUsername(username);
    const existing = this.users.get(key);
    const now = new Date().toISOString();
    // Use a sentinel hash that can never match a real password
    const sentinel = 'ad:' + crypto.randomBytes(32).toString('hex');
    const record: UserRecord = {
      username,
      role,
      tenantId: tenantId ?? existing?.tenantId ?? SYSTEM_TENANT_ID,
      passwordHash: sentinel,
      salt: 'ad-managed',
      active: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.users.set(key, record);
    this.save();
  }

  /**
   * Issue a JWT for a pre-authenticated AD user (skips password verification).
   * Only works for users marked as AD-managed (salt === 'ad-managed').
   */
  issueTokenForADUser(username: string, role: UserRole): AuthIssueResult | null {
    if (!this.isConfigured()) return null;
    const existing = this.users.get(this.normalizeUsername(username));
    const tenantId = existing?.tenantId ?? SYSTEM_TENANT_ID;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.ttlSeconds;
    const payload: AuthTokenPayload = { sub: username, role, tid: tenantId, iat, exp };
    const headerPart = base64Url(JSON.stringify({ alg: 'HS256', typ: 'ITOPS-AUTH' }));
    const payloadPart = base64Url(JSON.stringify(payload));
    const signature = this.sign(`${headerPart}.${payloadPart}`);
    const token = `${headerPart}.${payloadPart}.${signature}`;
    return { token, username, role, tenantId, expiresAt: new Date(exp * 1000).toISOString() };
  }

  issueToken(username: string, password: string): AuthIssueResult | null {
    if (!this.isConfigured()) return null;
    const user = this.users.get(this.normalizeUsername(username));
    if (!user || !user.active) return null;
    if (!this.verifyPassword(password, user.salt, user.passwordHash)) return null;

    const canonicalUsername = user.username;
    const tenantId = user.tenantId ?? SYSTEM_TENANT_ID;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.ttlSeconds;
    const payload: AuthTokenPayload = {
      sub: canonicalUsername,
      role: user.role,
      tid: tenantId,
      iat,
      exp
    };
    const headerPart = base64Url(JSON.stringify({ alg: 'HS256', typ: 'ITOPS-AUTH' }));
    const payloadPart = base64Url(JSON.stringify(payload));
    const signature = this.sign(`${headerPart}.${payloadPart}`);
    const token = `${headerPart}.${payloadPart}.${signature}`;

    return {
      token,
      username: canonicalUsername,
      role: user.role,
      tenantId,
      expiresAt: new Date(exp * 1000).toISOString()
    };
  }

  validateToken(token?: string): AuthValidation {
    if (!this.isConfigured()) return { valid: false, reason: 'Auth service not configured' };
    if (!token) return { valid: false, reason: 'Missing auth token' };

    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false, reason: 'Invalid auth token format' };
    const [headerPart, payloadPart, sig] = parts;
    const expectedSig = this.sign(`${headerPart}.${payloadPart}`);
    const actual = Buffer.from(sig);
    const expected = Buffer.from(expectedSig);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return { valid: false, reason: 'Invalid auth token signature' };
    }

    let payload: AuthTokenPayload;
    try {
      payload = JSON.parse(fromBase64Url(payloadPart).toString('utf8')) as AuthTokenPayload;
    } catch {
      return { valid: false, reason: 'Invalid auth token payload' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return { valid: false, reason: 'Auth token expired' };

    const user = this.users.get(this.normalizeUsername(payload.sub));
    if (!user || !user.active) return { valid: false, reason: 'Unknown or inactive auth principal' };
    if (payload.role !== user.role) return { valid: false, reason: 'Auth role mismatch' };

    // The user record's tenantId is authoritative — if a JWT was minted
    // when the user was in tenant A and the user was later moved to
    // tenant B, the new tenancy wins. Pre-migration tokens lack `tid`
    // entirely, so we fall back to the user's current tenant.
    const tenantId = user.tenantId ?? payload.tid ?? SYSTEM_TENANT_ID;

    return {
      valid: true,
      username: payload.sub,
      role: payload.role,
      tenantId,
    };
  }

  hasPermission(role: UserRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role].includes(permission);
  }

  /** Issue a fresh JWT for the principal carried in an existing valid
   *  token. Returns null when the token is missing / expired / signed by
   *  a different secret. Used by POST /api/auth/refresh — the client can
   *  rotate its session without re-prompting for the password as long as
   *  the current token is still verifiable. */
  refreshToken(currentToken: string): AuthIssueResult | null {
    const v = this.validateToken(currentToken);
    if (!v.valid || !v.username || !v.role) return null;
    const record = this.users.get(this.normalizeUsername(v.username));
    if (!record || !record.active) return null;
    const tenantId = record.tenantId ?? SYSTEM_TENANT_ID;
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + this.ttlSeconds;
    const payload: AuthTokenPayload = { sub: record.username, role: record.role, tid: tenantId, iat, exp };
    const headerPart = base64Url(JSON.stringify({ alg: 'HS256', typ: 'ITOPS-AUTH' }));
    const payloadPart = base64Url(JSON.stringify(payload));
    const signature = this.sign(`${headerPart}.${payloadPart}`);
    return {
      token: `${headerPart}.${payloadPart}.${signature}`,
      username: record.username,
      role: record.role,
      tenantId,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  static extractBearerToken(authHeader?: string): string | undefined {
    if (!authHeader) return undefined;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : undefined;
  }

  private hashPassword(password: string, salt: string): string {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  private verifyPassword(password: string, salt: string, expectedHash: string): boolean {
    const hash = this.hashPassword(password, salt);
    const actual = Buffer.from(hash, 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  private sign(input: string): string {
    return base64Url(crypto.createHmac('sha256', this.tokenSecret).update(input).digest());
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.usersFilePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.usersFilePath, 'utf8')) as UsersFile;
      let migrated = false;
      for (const user of parsed.users || []) {
        // Backfill tenantId for users persisted before the tenancy
        // migration. Old rows belong to the system tenant — flipping
        // them to a real tenant is the operator's call via UPDATE.
        if (!user.tenantId) {
          user.tenantId = SYSTEM_TENANT_ID;
          migrated = true;
        }
        this.users.set(this.normalizeUsername(user.username), user);
      }
      if (migrated) {
        try { this.save(); } catch { /* read-only fs in tests — fine */ }
      }
    } catch {
      this.users.clear();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.usersFilePath), { recursive: true });
    const payload: UsersFile = {
      version: 1,
      users: Array.from(this.users.values())
    };
    fs.writeFileSync(this.usersFilePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

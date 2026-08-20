import crypto from 'node:crypto';
import type { GeneratedApplication } from './AppGenerator.js';

export type PreviewStatus = 'building' | 'starting' | 'ready' | 'failed' | 'stopped' | 'expired';

export interface PreviewSession {
  id: string;
  tenantId: string;
  projectId: string;
  revision: number;
  status: PreviewStatus;
  roleId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  stoppedAt?: string;
  error?: string;
}

export interface PreviewRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

export interface PreviewResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PreviewBackend {
  initialize(activeSessionIds: Set<string>): Promise<void>;
  start(input: {
    sessionId: string;
    tenantId: string;
    artifact: GeneratedApplication;
    appToken: string;
  }): Promise<void>;
  request(sessionId: string, roleId: string, request: PreviewRequest): Promise<PreviewResponse>;
  logs(sessionId: string, tail: number): Promise<string>;
  stop(sessionId: string): Promise<void>;
}

interface InternalSession extends PreviewSession {
  tokenHash: Buffer;
  appToken: string;
}

export class PreviewRuntime {
  private sessions = new Map<string, InternalSession>();
  private expiryTimer: NodeJS.Timeout;

  constructor(
    private backend: PreviewBackend,
    private limits: { maxPerTenant?: number; maxGlobal?: number; defaultTtlMinutes?: number; maxTtlMinutes?: number } = {},
    private now: () => number = Date.now,
  ) {
    this.expiryTimer = setInterval(() => { void this.expireDueSessions(); }, 30_000);
    this.expiryTimer.unref();
  }

  async initialize(): Promise<void> {
    await this.backend.initialize(new Set(this.sessions.keys()));
  }

  async create(input: {
    tenantId: string;
    projectId: string;
    revision: number;
    roleId: string;
    actor: string;
    artifact: GeneratedApplication;
    ttlMinutes?: number;
  }): Promise<{ session: PreviewSession; accessToken: string }> {
    const active = [...this.sessions.values()].filter(session => isActive(session.status));
    const tenantActive = active.filter(session => session.tenantId === input.tenantId);
    if (active.length >= (this.limits.maxGlobal ?? 10)) throw new Error('preview capacity reached');
    if (tenantActive.length >= (this.limits.maxPerTenant ?? 3)) throw new Error('tenant preview capacity reached');

    const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? this.limits.defaultTtlMinutes ?? 30, 1), this.limits.maxTtlMinutes ?? 60);
    const ttlMs = ttlMinutes * 60_000;
    const id = `preview-${crypto.randomBytes(10).toString('hex')}`;
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const appToken = crypto.randomBytes(32).toString('base64url');
    const now = new Date(this.now());
    const session: InternalSession = {
      id, tenantId: input.tenantId, projectId: input.projectId, revision: input.revision,
      status: 'building', roleId: input.roleId, createdBy: input.actor,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      tokenHash: sha256Buffer(accessToken), appToken,
    };
    this.sessions.set(id, session);
    try {
      session.status = 'starting';
      await this.backend.start({ sessionId: id, tenantId: input.tenantId, artifact: input.artifact, appToken });
      session.expiresAt = new Date(this.now() + ttlMs).toISOString();
      session.status = 'ready';
    } catch (error) {
      session.status = 'failed';
      session.error = error instanceof Error ? error.message : String(error);
      await this.backend.stop(id).catch(() => undefined);
      throw new Error(`preview start failed: ${session.error}`);
    }
    return { session: publicSession(session), accessToken };
  }

  list(tenantId: string): PreviewSession[] {
    return [...this.sessions.values()]
      .filter(session => session.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicSession);
  }

  get(id: string, tenantId: string): PreviewSession | null {
    const session = this.sessions.get(id);
    return session?.tenantId === tenantId ? publicSession(session) : null;
  }

  authorize(id: string, token: string): PreviewSession | null {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'ready' || Date.parse(session.expiresAt) <= this.now()) return null;
    const supplied = sha256Buffer(token);
    return supplied.length === session.tokenHash.length && crypto.timingSafeEqual(supplied, session.tokenHash)
      ? publicSession(session)
      : null;
  }

  async request(id: string, token: string, request: PreviewRequest): Promise<PreviewResponse> {
    const session = this.sessions.get(id);
    if (!session || !this.authorize(id, token)) throw new Error('preview access denied');
    if (!/^\/[a-zA-Z0-9/_?&=.%+-]*$/.test(request.path) || request.path.length > 2048) {
      throw new Error('invalid preview path');
    }
    return this.backend.request(id, session.roleId, request);
  }

  async logs(id: string, tenantId: string, tail = 200): Promise<string | null> {
    const session = this.sessions.get(id);
    if (!session || session.tenantId !== tenantId) return null;
    return this.backend.logs(id, Math.min(Math.max(tail, 1), 1000));
  }

  async stop(id: string, tenantId: string, reason: 'stopped' | 'expired' = 'stopped'): Promise<PreviewSession | null> {
    const session = this.sessions.get(id);
    if (!session || session.tenantId !== tenantId) return null;
    if (isActive(session.status)) await this.backend.stop(id);
    session.status = reason;
    session.stoppedAt = new Date(this.now()).toISOString();
    session.appToken = '';
    return publicSession(session);
  }

  async dispose(): Promise<void> {
    clearInterval(this.expiryTimer);
    await Promise.all([...this.sessions.values()].filter(session => isActive(session.status)).map(session => this.stop(session.id, session.tenantId)));
  }

  async sweepExpired(): Promise<void> {
    await this.expireDueSessions();
  }

  private async expireDueSessions(): Promise<void> {
    const due = [...this.sessions.values()].filter(session => isActive(session.status) && Date.parse(session.expiresAt) <= this.now());
    await Promise.all(due.map(session => this.stop(session.id, session.tenantId, 'expired').catch(() => undefined)));
  }
}

function publicSession(session: InternalSession): PreviewSession {
  const { tokenHash: _tokenHash, appToken: _appToken, ...safe } = session;
  return { ...safe };
}

function isActive(status: PreviewStatus): boolean {
  return status === 'building' || status === 'starting' || status === 'ready';
}

function sha256Buffer(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

import crypto from 'node:crypto';

export interface ToolLaunchRequest { method: string; path: string; headers: Record<string, string>; body?: Buffer }
export interface ToolLaunchResponse { status: number; headers: Record<string, string>; body: Buffer }
export interface ToolRuntimeGateway { request(runtimeRef: string, request: ToolLaunchRequest): Promise<ToolLaunchResponse> }
export interface ToolLaunchSession {
  id: string; tenantId: string; projectId: string; deploymentId: string; actor: string;
  status: 'active' | 'expired'; createdAt: string; expiresAt: string;
}

interface StoredLaunch extends ToolLaunchSession { runtimeRef: string; accessHash: string; cookieHash?: string }

export class ToolLaunchRuntime {
  private sessions = new Map<string, StoredLaunch>();
  constructor(private gateway: ToolRuntimeGateway, private ttlMinutes = 480, private now: () => Date = () => new Date()) {}

  create(input: { tenantId: string; projectId: string; deploymentId: string; runtimeRef: string; actor: string }): { session: ToolLaunchSession; accessToken: string } {
    this.expire();
    const id = `launch-${crypto.randomBytes(12).toString('hex')}`; const accessToken = crypto.randomBytes(32).toString('base64url');
    const created = this.now(); const stored: StoredLaunch = { id, tenantId: input.tenantId, projectId: input.projectId,
      deploymentId: input.deploymentId, runtimeRef: input.runtimeRef, actor: input.actor, status: 'active',
      createdAt: created.toISOString(), expiresAt: new Date(created.getTime() + this.ttlMinutes * 60_000).toISOString(), accessHash: hash(accessToken) };
    this.sessions.set(id, stored); return { session: view(stored), accessToken };
  }

  exchange(id: string, accessToken: string): { session: ToolLaunchSession; cookie: string } | null {
    const session = this.active(id); if (!session || !safeEqual(session.accessHash, hash(accessToken))) return null;
    const cookie = crypto.randomBytes(32).toString('base64url'); session.cookieHash = hash(cookie); session.accessHash = hash(crypto.randomBytes(32).toString('base64url'));
    return { session: view(session), cookie };
  }

  authorize(id: string, cookie: string): ToolLaunchSession | null {
    const session = this.active(id); return session?.cookieHash && safeEqual(session.cookieHash, hash(cookie)) ? view(session) : null;
  }

  async request(id: string, cookie: string, request: ToolLaunchRequest): Promise<ToolLaunchResponse> {
    const session = this.active(id); if (!session?.cookieHash || !safeEqual(session.cookieHash, hash(cookie))) throw new Error('launch session unauthorized');
    return this.gateway.request(session.runtimeRef, request);
  }

  private active(id: string): StoredLaunch | null { this.expire(); const session = this.sessions.get(id); return session?.status === 'active' ? session : null; }
  private expire(): void { const now = this.now().getTime(); for (const session of this.sessions.values()) if (Date.parse(session.expiresAt) <= now) session.status = 'expired'; }
}

function view(value: StoredLaunch): ToolLaunchSession { const { runtimeRef: _runtimeRef, accessHash: _accessHash, cookieHash: _cookieHash, ...session } = value; return session; }
function hash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeEqual(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); }

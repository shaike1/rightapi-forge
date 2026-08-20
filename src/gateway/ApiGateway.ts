import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';

export interface ApiKey {
  id: string;
  key: string;          // hashed
  keyPrefix: string;    // first 8 chars (for display)
  name: string;
  owner: string;
  scopes: ApiScope[];
  rateLimit: { requestsPerMinute: number; requestsPerHour: number };
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  enabled: boolean;
  usageCount: number;
}

export type ApiScope =
  | 'tasks:read' | 'tasks:write'
  | 'agents:read' | 'agents:write'
  | 'workflows:read' | 'workflows:write'
  | 'pipelines:read' | 'pipelines:write'
  | 'alerts:read' | 'alerts:write'
  | 'analytics:read'
  | 'security:read' | 'security:write'
  | 'admin';

export interface RateLimitState {
  minute: { count: number; resetAt: number };
  hour: { count: number; resetAt: number };
}

export interface ApiRequest {
  id: string;
  timestamp: Date;
  keyId: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string;
}

export class ApiGateway {
  private keys: Map<string, ApiKey> = new Map();      // id -> ApiKey
  private keyIndex: Map<string, string> = new Map();  // hash -> id
  private rateLimits: Map<string, RateLimitState> = new Map();
  private requests: ApiRequest[] = [];
  private dataPath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataPath: string = '/data/itops-agents/gateway') {
    this.dataPath = dataPath;
    this.ensureDir();
    this.load();
    this.flushTimer = setInterval(() => this.flush(), 30_000);
    console.log('[ApiGateway] Ready with', this.keys.size, 'keys');
  }

  // ── Key Management ──────────────────────────────────────────────────────────

  createKey(data: {
    name: string;
    owner: string;
    scopes: ApiScope[];
    rateLimit?: { requestsPerMinute: number; requestsPerHour: number };
    expiresAt?: Date;
  }): { apiKey: ApiKey; plainKey: string } {
    const plain = 'itops_' + uuidv4().replace(/-/g, '');
    const hash = this.hashKey(plain);
    const prefix = plain.slice(0, 12);

    const apiKey: ApiKey = {
      id: uuidv4(),
      key: hash,
      keyPrefix: prefix,
      name: data.name,
      owner: data.owner,
      scopes: data.scopes,
      rateLimit: data.rateLimit || { requestsPerMinute: 60, requestsPerHour: 1000 },
      createdAt: new Date(),
      expiresAt: data.expiresAt,
      enabled: true,
      usageCount: 0
    };

    this.keys.set(apiKey.id, apiKey);
    this.keyIndex.set(hash, apiKey.id);
    this.flush();
    return { apiKey, plainKey: plain };
  }

  validateKey(plain: string): { valid: boolean; key?: ApiKey; error?: string } {
    const hash = this.hashKey(plain);
    const id = this.keyIndex.get(hash);
    if (!id) return { valid: false, error: 'Invalid API key' };

    const key = this.keys.get(id);
    if (!key) return { valid: false, error: 'Key not found' };
    if (!key.enabled) return { valid: false, error: 'Key is disabled' };
    if (key.expiresAt && new Date(key.expiresAt) < new Date()) {
      return { valid: false, error: 'Key has expired' };
    }
    return { valid: true, key };
  }

  checkRateLimit(keyId: string, limit: ApiKey['rateLimit']): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    let state = this.rateLimits.get(keyId);

    if (!state) {
      state = {
        minute: { count: 0, resetAt: now + 60_000 },
        hour: { count: 0, resetAt: now + 3_600_000 }
      };
    }

    // Reset windows if expired
    if (now > state.minute.resetAt) state.minute = { count: 0, resetAt: now + 60_000 };
    if (now > state.hour.resetAt) state.hour = { count: 0, resetAt: now + 3_600_000 };

    if (state.minute.count >= limit.requestsPerMinute) {
      return { allowed: false, retryAfter: Math.ceil((state.minute.resetAt - now) / 1000) };
    }
    if (state.hour.count >= limit.requestsPerHour) {
      return { allowed: false, retryAfter: Math.ceil((state.hour.resetAt - now) / 1000) };
    }

    state.minute.count++;
    state.hour.count++;
    this.rateLimits.set(keyId, state);
    return { allowed: true };
  }

  recordUsage(keyId: string, req: Omit<ApiRequest, 'id' | 'timestamp' | 'keyId'>): void {
    const key = this.keys.get(keyId);
    if (key) {
      key.lastUsedAt = new Date();
      key.usageCount++;
    }

    this.requests.push({
      ...req,
      id: uuidv4(),
      timestamp: new Date(),
      keyId
    });

    // Keep last 10k requests in memory
    if (this.requests.length > 10_000) this.requests = this.requests.slice(-10_000);
  }

  hasScope(key: ApiKey, required: ApiScope): boolean {
    return key.scopes.includes('admin') || key.scopes.includes(required);
  }

  getKey(id: string): ApiKey | undefined { return this.keys.get(id); }

  listKeys(owner?: string): ApiKey[] {
    let list = Array.from(this.keys.values());
    if (owner) list = list.filter(k => k.owner === owner);
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  revokeKey(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;
    key.enabled = false;
    this.flush();
    return true;
  }

  deleteKey(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;
    this.keyIndex.delete(key.key);
    this.keys.delete(id);
    this.flush();
    return true;
  }

  getStats() {
    const now = Date.now();
    const lastHour = this.requests.filter(r => now - new Date(r.timestamp).getTime() < 3_600_000);
    const lastDay = this.requests.filter(r => now - new Date(r.timestamp).getTime() < 86_400_000);
    
    const statusCodes: Record<string, number> = {};
    lastHour.forEach(r => {
      const bucket = String(Math.floor(r.statusCode / 100) * 100);
      statusCodes[bucket] = (statusCodes[bucket] || 0) + 1;
    });

    const avgDuration = lastHour.length
      ? Math.round(lastHour.reduce((s, r) => s + r.durationMs, 0) / lastHour.length)
      : 0;

    return {
      totalKeys: this.keys.size,
      activeKeys: Array.from(this.keys.values()).filter(k => k.enabled).length,
      requestsLastHour: lastHour.length,
      requestsLastDay: lastDay.length,
      totalRequests: this.requests.length,
      avgDurationMs: avgDuration,
      statusCodes
    };
  }

  getRequests(filter?: { keyId?: string; limit?: number }): ApiRequest[] {
    let list = [...this.requests];
    if (filter?.keyId) list = list.filter(r => r.keyId === filter.keyId);
    list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filter?.limit ? list.slice(0, filter.limit) : list;
  }

  private hashKey(plain: string): string {
    return createHmac('sha256', 'itops-gateway-secret').update(plain).digest('hex');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
  }

  private flush(): void {
    try {
      fs.writeFileSync(
        path.join(this.dataPath, 'keys.json'),
        JSON.stringify(Array.from(this.keys.entries()), null, 2),
        'utf8'
      );
      fs.writeFileSync(
        path.join(this.dataPath, 'key-index.json'),
        JSON.stringify(Array.from(this.keyIndex.entries()), null, 2),
        'utf8'
      );
    } catch (e) { console.error('[ApiGateway] Flush failed:', e); }
  }

  private load(): void {
    try {
      const kf = path.join(this.dataPath, 'keys.json');
      const ki = path.join(this.dataPath, 'key-index.json');
      if (fs.existsSync(kf)) this.keys = new Map(JSON.parse(fs.readFileSync(kf, 'utf8')));
      if (fs.existsSync(ki)) this.keyIndex = new Map(JSON.parse(fs.readFileSync(ki, 'utf8')));
    } catch (e) { console.error('[ApiGateway] Load failed:', e); }
  }
}

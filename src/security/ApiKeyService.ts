import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { UserRole, Permission } from './AuthService.js';

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  prefix: string;       // first 8 chars for display (itops_xxxx...)
  role: UserRole;
  scopes: Permission[];  // empty = all permissions for role
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  active: boolean;
  /** Tenant the key is bound to. Defaults to "system" for backwards
   *  compatibility with keys minted before multi-tenancy landed. The
   *  tenantMiddleware uses this to scope every request to a specific
   *  tenant unless the caller is an admin acting cross-tenant. */
  tenantId?: string;
}

interface ApiKeyFile {
  version: number;
  keys: ApiKey[];
}

export interface ApiKeyCreateResult {
  id: string;
  name: string;
  key: string;           // full key, only shown once
  prefix: string;
  role: UserRole;
  scopes: Permission[];
  expiresAt: string | null;
}

export class ApiKeyService {
  private filePath: string;
  private keys: Map<string, ApiKey> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  create(params: {
    name: string;
    role: UserRole;
    scopes?: Permission[];
    createdBy: string;
    expiresInDays?: number;
    /** Tenant to bind the key to. Defaults to "system" for backwards
     *  compatibility — keys minted from the legacy single-tenant code
     *  path keep working as system-tenant keys. */
    tenantId?: string;
  }): ApiKeyCreateResult {
    const rawKey = 'itops_' + crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const keyHash = this.hash(rawKey);
    const prefix = rawKey.slice(0, 12) + '...';
    const expiresAt = params.expiresInDays
      ? new Date(Date.now() + params.expiresInDays * 86400000).toISOString()
      : null;

    const apiKey: ApiKey = {
      id,
      name: params.name,
      keyHash,
      prefix,
      role: params.role,
      scopes: params.scopes || [],
      createdBy: params.createdBy,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt,
      active: true,
      tenantId: params.tenantId ?? 'system',
    };

    this.keys.set(id, apiKey);
    this.save();

    return { id, name: params.name, key: rawKey, prefix, role: params.role, scopes: apiKey.scopes, expiresAt };
  }

  validate(rawKey: string): { valid: boolean; apiKey?: ApiKey; reason?: string } {
    if (!rawKey || !rawKey.startsWith('itops_')) {
      return { valid: false, reason: 'Invalid API key format' };
    }
    const keyHash = this.hash(rawKey);
    for (const ak of this.keys.values()) {
      if (ak.keyHash === keyHash) {
        if (!ak.active) return { valid: false, reason: 'API key is disabled' };
        if (ak.expiresAt && new Date(ak.expiresAt) < new Date()) {
          return { valid: false, reason: 'API key expired' };
        }
        // Update last used
        ak.lastUsedAt = new Date().toISOString();
        this.save();
        return { valid: true, apiKey: ak };
      }
    }
    return { valid: false, reason: 'Unknown API key' };
  }

  list(): Omit<ApiKey, 'keyHash'>[] {
    return Array.from(this.keys.values()).map(({ keyHash, ...rest }) => rest);
  }

  revoke(id: string): boolean {
    const key = this.keys.get(id);
    if (!key) return false;
    key.active = false;
    this.save();
    return true;
  }

  delete(id: string): boolean {
    const deleted = this.keys.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  private hash(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ApiKeyFile;
      for (const k of data.keys || []) this.keys.set(k.id, k);
    } catch { this.keys.clear(); }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: ApiKeyFile = { version: 1, keys: Array.from(this.keys.values()) };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}

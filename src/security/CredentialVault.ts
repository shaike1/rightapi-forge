import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getCurrentTenantId, SYSTEM_TENANT_ID } from '../tenancy/index.js';

/** What kind of credential this is — drives which rotator the
 *  CredentialRotationManager picks. Optional for backwards-compatibility
 *  (existing vault files don't have it). */
export type CredentialKind = 'api-key' | 'token' | 'cert' | 'password' | 'other';

export interface CredentialRecordMeta {
  id: string;
  agentId: string;
  name: string;
  scope: string;
  /** Tenant the credential is bound to. Defaults to SYSTEM_TENANT_ID
   *  for records that predate multi-tenancy so existing vault files
   *  load without migration ceremony. New writes capture the active
   *  scope from getCurrentTenantId(). */
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  /** Lifecycle metadata — all optional. Older records loaded from disk that
   *  predate auto-rotation simply have these fields undefined; the rotation
   *  manager treats them as "no rotation policy". */
  kind?: CredentialKind;
  /** ISO-8601 timestamp at which this credential is considered expired.
   *  Rotation is attempted before this point (controlled by warnBeforeMs in
   *  the manager). Past-due credentials are surfaced as alerts. */
  expiresAt?: string;
  /** When non-zero, the manager rotates every N days regardless of
   *  expiresAt. Useful for credentials with no native expiry (database
   *  passwords, signing tokens). */
  rotationIntervalDays?: number;
  /** ISO-8601 timestamp of the last successful rotation. Updated by
   *  markRotated(); used to drive interval-based rotation. */
  lastRotatedAt?: string;
  /** Failure metadata cleared on next successful rotation. */
  lastRotationFailureAt?: string;
  lastRotationFailureMessage?: string;
}

interface CredentialRecord extends CredentialRecordMeta {
  encryptedSecret: string;
  iv: string;
  authTag: string;
}

interface VaultFile {
  version: number;
  records: CredentialRecord[];
}

export class CredentialVault {
  private filePath: string;
  private key: Buffer;
  private records: Map<string, CredentialRecord> = new Map();

  constructor(filePath: string, masterKey: string) {
    this.filePath = filePath;
    this.key = crypto.createHash('sha256').update(masterKey).digest();
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as VaultFile;
      for (const record of parsed.records || []) {
        // Backfill tenantId for records that predate multi-tenancy.
        // The system tenant is intentional: pre-tenancy deployments
        // are single-tenant by definition, so their credentials all
        // belong to the implicit system tenant.
        if (!record.tenantId) record.tenantId = SYSTEM_TENANT_ID;
        this.records.set(record.id, record);
      }
    } catch {
      // Keep service running even if vault file is invalid.
      this.records.clear();
    }
  }

  /** Resolve the active tenant for the call. Optional override wins;
   *  otherwise getCurrentTenantId() consults the AsyncLocalStorage
   *  scope set by the tenant middleware. */
  private resolveTenant(tenantId?: string): string {
    return tenantId ?? getCurrentTenantId();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: VaultFile = { version: 1, records: Array.from(this.records.values()) };
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private deriveKey(masterKey: string): Buffer {
    return crypto.createHash('sha256').update(masterKey).digest();
  }

  private encryptWithKey(secret: string, key: Buffer): { encryptedSecret: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      encryptedSecret: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  private encrypt(secret: string): { encryptedSecret: string; iv: string; authTag: string } {
    return this.encryptWithKey(secret, this.key);
  }

  private decryptWithKey(record: CredentialRecord, key: Buffer): string {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(record.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.encryptedSecret, 'base64')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  private decrypt(record: CredentialRecord): string {
    return this.decryptWithKey(record, this.key);
  }

  rotateMasterKey(nextMasterKey: string): { recordsReencrypted: number } {
    if (!nextMasterKey) {
      throw new Error('nextMasterKey is required');
    }
    const nextKey = this.deriveKey(nextMasterKey);
    if (nextKey.equals(this.key)) {
      throw new Error('nextMasterKey must differ from current key');
    }

    // Decrypt first to keep this operation atomic on failure.
    const decrypted = Array.from(this.records.values()).map(record => ({
      record,
      secret: this.decryptWithKey(record, this.key)
    }));

    const now = new Date().toISOString();
    for (const item of decrypted) {
      const reencryption = this.encryptWithKey(item.secret, nextKey);
      this.records.set(item.record.id, {
        ...item.record,
        ...reencryption,
        updatedAt: now
      });
    }
    this.key = nextKey;
    this.save();
    return { recordsReencrypted: decrypted.length };
  }

  upsert(params: {
    id?: string;
    agentId: string;
    name: string;
    scope: string;
    secret: string;
    kind?: CredentialKind;
    expiresAt?: string;
    rotationIntervalDays?: number;
    /** Override the active tenant for this write. Pre-multi-tenant
     *  deployments don't need to set this; the system fallback applies. */
    tenantId?: string;
  }): CredentialRecordMeta {
    const now = new Date().toISOString();
    const id = params.id || crypto.randomUUID();
    const existing = this.records.get(id);
    // Existing tenant wins on update so a routine rotation can't move
    // a credential into another tenant's bucket. Only fresh inserts
    // pick up the active scope.
    const tenantId = existing?.tenantId ?? this.resolveTenant(params.tenantId);
    const encrypted = this.encrypt(params.secret);
    const record: CredentialRecord = {
      id,
      agentId: params.agentId,
      name: params.name,
      scope: params.scope,
      tenantId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      // Lifecycle: explicitly-passed fields override; otherwise carry over
      // from the existing record so a routine secret rotation doesn't wipe
      // expiry metadata.
      kind: params.kind ?? existing?.kind,
      expiresAt: params.expiresAt ?? existing?.expiresAt,
      rotationIntervalDays: params.rotationIntervalDays ?? existing?.rotationIntervalDays,
      lastRotatedAt: existing?.lastRotatedAt,
      lastRotationFailureAt: existing?.lastRotationFailureAt,
      lastRotationFailureMessage: existing?.lastRotationFailureMessage,
      ...encrypted
    };
    this.records.set(id, record);
    this.save();
    return this.meta(record);
  }

  /** Set or clear lifecycle metadata without touching the secret. */
  setLifecycle(id: string, opts: {
    kind?: CredentialKind;
    expiresAt?: string | null;
    rotationIntervalDays?: number | null;
  }): CredentialRecordMeta | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (opts.kind !== undefined) record.kind = opts.kind;
    if (opts.expiresAt !== undefined) {
      record.expiresAt = opts.expiresAt === null ? undefined : opts.expiresAt;
    }
    if (opts.rotationIntervalDays !== undefined) {
      record.rotationIntervalDays =
        opts.rotationIntervalDays === null ? undefined : opts.rotationIntervalDays;
    }
    record.updatedAt = new Date().toISOString();
    this.records.set(id, record);
    this.save();
    return this.meta(record);
  }

  /** Replace the secret in-place and update lifecycle markers as a successful
   *  rotation: bump lastRotatedAt, clear failure state, optionally set a new
   *  expiresAt. Returns null if the id is unknown. */
  applyRotation(id: string, params: { secret: string; expiresAt?: string }): CredentialRecordMeta | null {
    const record = this.records.get(id);
    if (!record) return null;
    const now = new Date().toISOString();
    const encrypted = this.encrypt(params.secret);
    const next: CredentialRecord = {
      ...record,
      ...encrypted,
      updatedAt: now,
      lastRotatedAt: now,
      // Caller can supply a fresh expiry; otherwise leave existing in place.
      expiresAt: params.expiresAt ?? record.expiresAt,
      // Successful rotation clears prior failure state.
      lastRotationFailureAt: undefined,
      lastRotationFailureMessage: undefined,
    };
    this.records.set(id, next);
    this.save();
    return this.meta(next);
  }

  /** Record a failed rotation attempt without changing the secret. */
  markRotationFailure(id: string, message: string): CredentialRecordMeta | null {
    const record = this.records.get(id);
    if (!record) return null;
    const now = new Date().toISOString();
    record.lastRotationFailureAt = now;
    record.lastRotationFailureMessage = message;
    record.updatedAt = now;
    this.records.set(id, record);
    this.save();
    return this.meta(record);
  }

  /** Returns credentials whose rotation is due (or coming due within
   *  warnBeforeMs). Used by the rotation manager's sweep. */
  listDueForRotation(opts?: { now?: Date; warnBeforeMs?: number }): CredentialRecordMeta[] {
    const now = (opts?.now ?? new Date()).getTime();
    const horizon = now + (opts?.warnBeforeMs ?? 0);
    const due: CredentialRecordMeta[] = [];
    for (const r of this.records.values()) {
      if (this.isDue(r, now, horizon)) due.push(this.meta(r));
    }
    return due;
  }

  private isDue(r: CredentialRecord, now: number, horizon: number): boolean {
    // Nothing to do if neither expiry nor interval is configured.
    if (!r.expiresAt && !r.rotationIntervalDays) return false;
    if (r.expiresAt) {
      const exp = new Date(r.expiresAt).getTime();
      if (Number.isFinite(exp) && exp <= horizon) return true;
    }
    if (r.rotationIntervalDays && r.rotationIntervalDays > 0) {
      const baseStr = r.lastRotatedAt ?? r.createdAt;
      const base = new Date(baseStr).getTime();
      if (Number.isFinite(base)) {
        const next = base + r.rotationIntervalDays * 86_400_000;
        if (next <= horizon) return true;
      }
    }
    return false;
  }

  listByAgent(agentId: string, tenantId?: string): CredentialRecordMeta[] {
    const t = this.resolveTenant(tenantId);
    return Array.from(this.records.values())
      .filter(r => r.agentId === agentId && r.tenantId === t)
      .map(r => this.meta(r));
  }

  listByIdsForAgent(agentId: string, ids: string[], tenantId?: string): CredentialRecordMeta[] {
    const t = this.resolveTenant(tenantId);
    const idSet = new Set(ids);
    return Array.from(this.records.values())
      .filter(r => r.agentId === agentId && r.tenantId === t && idSet.has(r.id))
      .map(r => this.meta(r));
  }

  resolveSecret(id: string, tenantId?: string): string | null {
    const t = this.resolveTenant(tenantId);
    const record = this.records.get(id);
    if (!record || record.tenantId !== t) return null;
    return this.decrypt(record);
  }

  delete(id: string, tenantId?: string): boolean {
    const t = this.resolveTenant(tenantId);
    const record = this.records.get(id);
    if (!record || record.tenantId !== t) return false;
    this.records.delete(id);
    this.save();
    return true;
  }

  private meta(record: CredentialRecord): CredentialRecordMeta {
    return {
      id: record.id,
      agentId: record.agentId,
      name: record.name,
      scope: record.scope,
      tenantId: record.tenantId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      kind: record.kind,
      expiresAt: record.expiresAt,
      rotationIntervalDays: record.rotationIntervalDays,
      lastRotatedAt: record.lastRotatedAt,
      lastRotationFailureAt: record.lastRotationFailureAt,
      lastRotationFailureMessage: record.lastRotationFailureMessage,
    };
  }
}

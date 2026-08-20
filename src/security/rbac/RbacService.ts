// Resolves "what is this user allowed to do in this tenant?" against
// the assignment table, with a backwards-compat fallback.
//
// Two routes for permission resolution:
//   1. RBAC table lookup (preferred). For (userId, tenantId), pick the
//      highest-rank role assignment, fold in any extraPermissions from
//      its role definition, and return the union.
//   2. Legacy fallback. When the user has no RBAC assignments AND the
//      `legacyFallbackToSuperAdmin` flag is on (default true), they
//      get super_admin so existing API keys keep working. Operators
//      switch this off per tenant once they've populated assignments.
//
// The service caches resolution results for a short TTL (default 60s)
// so the request hot path doesn't query the DB on every call. A
// successful upsert / removeAssignment busts the cache for the
// affected user+tenant.

import { createLogger } from '../../observability/Logger.js';
import {
  permissionsForRole,
  ROLES,
  ROLE_RANK,
  type RbacPermission,
  type RbacRole,
  type ResolvedPermissions,
  type RoleDefinition,
  type UserRoleAssignment,
} from './RbacTypes.js';
import type { RbacStore } from '../../persistence/index.js';

const log = createLogger({ component: 'rbac' });

export interface RbacServiceOptions {
  store: RbacStore;
  /** When a user has no assignment, treat them as super_admin. Existing
   *  deployments rely on this — the gate flips off once an operator has
   *  populated the table. Default true. */
  legacyFallbackToSuperAdmin?: boolean;
  /** TTL for the in-process resolution cache. Default 60 seconds. */
  cacheTtlMs?: number;
  now?: () => Date;
}

interface CacheEntry {
  resolved: ResolvedPermissions;
  expiresAt: number;
}

export class RbacService {
  private readonly store: RbacStore;
  private readonly legacyFallback: boolean;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(opts: RbacServiceOptions) {
    this.store = opts.store;
    this.legacyFallback = opts.legacyFallbackToSuperAdmin ?? true;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Seed built-in role definitions. Idempotent — existing rows are
   *  left intact unless the row is also marked `builtin`, in which case
   *  the latest baseline overwrites the description / inherits-from
   *  fields. */
  async seedBuiltins(): Promise<void> {
    const now = this.now().toISOString();
    for (const role of ROLES) {
      const existing = await Promise.resolve(this.store.getRole(role));
      const def: RoleDefinition = {
        id: role,
        name: roleDisplayName(role),
        description: roleDescription(role),
        builtin: true,
        extraPermissions: [],
        inheritsFrom: role,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await Promise.resolve(this.store.upsertRole(def));
    }
    log.info('rbac built-in roles seeded');
  }

  // ── Role admin ─────────────────────────────────────────────────────

  async upsertCustomRole(input: {
    id: string;
    name: string;
    description?: string;
    inheritsFrom: RbacRole;
    extraPermissions: RbacPermission[];
  }): Promise<RoleDefinition> {
    if (!input.id || !/^[a-z0-9_-]+$/.test(input.id)) {
      throw new Error('role id must be lowercase, alphanumeric / underscore / hyphen');
    }
    if ((ROLES as readonly string[]).includes(input.id)) {
      throw new Error(`"${input.id}" is reserved for a built-in role`);
    }
    const existing = await Promise.resolve(this.store.getRole(input.id));
    if (existing && existing.builtin) {
      throw new Error('cannot overwrite a built-in role');
    }
    const now = this.now().toISOString();
    const def: RoleDefinition = {
      id: input.id,
      name: input.name,
      description: input.description,
      builtin: false,
      extraPermissions: dedupePerms(input.extraPermissions),
      inheritsFrom: input.inheritsFrom,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await Promise.resolve(this.store.upsertRole(def));
    this.cache.clear();
    return def;
  }

  async listRoles(): Promise<RoleDefinition[]> {
    return Promise.resolve(this.store.listRoles());
  }

  async deleteCustomRole(id: string): Promise<boolean> {
    const res = await Promise.resolve(this.store.deleteRole(id));
    if (res) this.cache.clear();
    return res;
  }

  // ── Assignment admin ───────────────────────────────────────────────

  async assign(userId: string, tenantId: string, roleId: string): Promise<UserRoleAssignment> {
    const role = await Promise.resolve(this.store.getRole(roleId));
    if (!role) throw new Error(`role "${roleId}" does not exist`);
    const now = this.now().toISOString();
    const assignment: UserRoleAssignment = { userId, tenantId, roleId, createdAt: now, updatedAt: now };
    await Promise.resolve(this.store.upsertAssignment(assignment));
    this.cache.delete(cacheKey(userId, tenantId));
    return assignment;
  }

  async unassign(userId: string, tenantId: string, roleId: string): Promise<boolean> {
    const ok = await Promise.resolve(this.store.removeAssignment(userId, tenantId, roleId));
    if (ok) this.cache.delete(cacheKey(userId, tenantId));
    return ok;
  }

  async listAssignments(filter?: { userId?: string; tenantId?: string }): Promise<UserRoleAssignment[]> {
    return Promise.resolve(this.store.listAssignments(filter));
  }

  // ── Resolution (the request hot path) ───────────────────────────────

  /** Compute the effective permissions for a (userId, tenantId) pair.
   *  Cached. */
  async resolve(userId: string, tenantId: string): Promise<ResolvedPermissions> {
    const key = cacheKey(userId, tenantId);
    const cached = this.cache.get(key);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAt > nowMs) return cached.resolved;

    const assignments = await Promise.resolve(this.store.getAssignments(userId, tenantId));
    let resolved: ResolvedPermissions;
    if (assignments.length === 0) {
      // No explicit assignment → fall back to super_admin (legacy
      // behaviour) or to the most-restrictive viewer set.
      const role: RbacRole = this.legacyFallback ? 'super_admin' : 'viewer';
      resolved = {
        userId, tenantId,
        effectiveRole: role,
        permissions: permissionsForRole(role),
        fromFallback: true,
      };
    } else {
      // Walk every assignment, fold its definition's permissions in.
      // The "effective role" is the highest tier across the assignments.
      const perms = new Set<RbacPermission>();
      let topRank = 0;
      let topTier: RbacRole = 'viewer';
      for (const a of assignments) {
        const def = await Promise.resolve(this.store.getRole(a.roleId));
        if (!def) continue;
        for (const p of permissionsForRole(def.inheritsFrom)) perms.add(p);
        for (const p of def.extraPermissions) perms.add(p);
        if (ROLE_RANK[def.inheritsFrom] > topRank) {
          topRank = ROLE_RANK[def.inheritsFrom];
          topTier = def.inheritsFrom;
        }
      }
      resolved = { userId, tenantId, effectiveRole: topTier, permissions: perms, fromFallback: false };
    }

    this.cache.set(key, { resolved, expiresAt: nowMs + this.cacheTtlMs });
    return resolved;
  }

  /** Drop the resolution cache entirely — used by tests. */
  clearCache(): void { this.cache.clear(); }
}

// ─── helpers ────────────────────────────────────────────────────────

function cacheKey(userId: string, tenantId: string): string {
  return `${userId}@@${tenantId}`;
}

function dedupePerms(perms: RbacPermission[]): RbacPermission[] {
  return Array.from(new Set(perms));
}

function roleDisplayName(role: RbacRole): string {
  switch (role) {
    case 'super_admin':  return 'Super Admin';
    case 'tenant_admin': return 'Tenant Admin';
    case 'operator':     return 'Operator';
    case 'viewer':       return 'Viewer';
  }
}
function roleDescription(role: RbacRole): string {
  switch (role) {
    case 'super_admin':  return 'Cross-tenant administration. Full permission set.';
    case 'tenant_admin': return 'Full read+write within a tenant.';
    case 'operator':     return 'Day-to-day operations within a tenant.';
    case 'viewer':       return 'Read-only access within a tenant.';
  }
}

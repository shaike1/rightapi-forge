// Extended RBAC for itops-agents.
//
// Coexists with the legacy AuthService.UserRole (admin/operator/viewer).
// The legacy model lives at the JWT layer and continues to gate routes
// the way it always did. RBAC adds a finer-grained, tenant-scoped layer
// on top, used by NEW endpoints and progressively rolled out to old ones.
//
// Backwards compatibility:
//   - API keys / JWTs that have no explicit RBAC assignment fall back to
//     SUPER_ADMIN. Existing single-tenant deployments keep working
//     unchanged. Operators flip the fallback off explicitly per tenant
//     once they've populated the role table.
//
// Hierarchy: super_admin ⊇ tenant_admin ⊇ operator ⊇ viewer. A higher
// role implies every permission of the lower roles. Permissions can be
// granted directly on top of the role baseline so a viewer-with-extras
// is expressible without minting a custom role for every minor delta.

export const ROLES = ['super_admin', 'tenant_admin', 'operator', 'viewer'] as const;
export type RbacRole = (typeof ROLES)[number];

/** Numeric rank — higher = more privileged. Used for "is this role at
 *  least X" comparisons. */
export const ROLE_RANK: Record<RbacRole, number> = {
  super_admin:  4,
  tenant_admin: 3,
  operator:     2,
  viewer:       1,
};

/** The fine-grained per-resource permission catalogue. New permissions
 *  go here so the type checker flags unknown strings at every call site. */
export const PERMISSIONS = [
  'agents.read',
  'agents.write',
  'agents.execute',
  'workflows.read',
  'workflows.write',
  'workflows.execute',
  'credentials.read',
  'credentials.write',
  'credentials.rotate',
  'events.read',
  'tenants.manage',
  'plugins.manage',
  'settings.manage',
  'builder.read',
  'builder.build',
  'builder.review',
  'builder.deploy',
] as const;

export type RbacPermission = (typeof PERMISSIONS)[number];

/** Default permission set per role. The hierarchy is collapsed at
 *  resolution time (see resolveEffectivePermissions below); this map
 *  describes what each role grants *on top of* its lower neighbour, so
 *  super_admin is the union of all sets but each set lists only the
 *  permissions added at that level. */
export const ROLE_PERMISSIONS: Record<RbacRole, RbacPermission[]> = {
  viewer: [
    'agents.read',
    'workflows.read',
    'events.read',
    'builder.read',
  ],
  operator: [
    'agents.execute',
    'workflows.write',
    'workflows.execute',
    'credentials.read',
    'builder.build',
  ],
  tenant_admin: [
    'agents.write',
    'credentials.write',
    'credentials.rotate',
    'plugins.manage',
    'settings.manage',
    'builder.review',
    'builder.deploy',
  ],
  super_admin: [
    'tenants.manage',
  ],
};

/** Stored role definition. Same shape for built-ins (super_admin / …)
 *  and operator-defined custom roles — the only difference is `builtin`. */
export interface RoleDefinition {
  /** Stable id; built-in roles use their RbacRole string. */
  id: string;
  name: string;
  description?: string;
  /** Built-in roles can't be deleted or renamed; the seed step writes
   *  them at startup. */
  builtin: boolean;
  /** Permissions granted *in addition to* the role's hierarchy
   *  baseline. Lets an operator-tier role add e.g. "credentials.write"
   *  without minting a whole tenant_admin. */
  extraPermissions: RbacPermission[];
  /** When this role definition is itself a built-in tier, the rank from
   *  ROLE_RANK applies. Custom roles list the tier they inherit from. */
  inheritsFrom: RbacRole;
  createdAt: string;
  updatedAt: string;
}

/** Bind a user (username from AuthService or API key id) to a role,
 *  scoped to a tenant. A user can be tenant_admin in tenant A and
 *  viewer in tenant B; resolution always passes the active tenantId. */
export interface UserRoleAssignment {
  /** Stable identifier — username for JWT users, "apikey:<id>" for keys. */
  userId: string;
  tenantId: string;
  /** Role definition id. Must match a row in the role-definitions table. */
  roleId: string;
  createdAt: string;
  updatedAt: string;
}

/** Resolution result returned by RbacService.resolve(). */
export interface ResolvedPermissions {
  userId: string;
  tenantId: string;
  /** The role tier the user effectively has. The highest tier wins
   *  when multiple assignments exist for the same user+tenant. */
  effectiveRole: RbacRole;
  /** Every permission the user has via tier + extras. Pre-computed so
   *  middleware is a Set.has() check on the request hot path. */
  permissions: Set<RbacPermission>;
  /** True when the resolution came from the backwards-compat fallback
   *  rather than a real assignment. Surfaced in audit logs so we can
   *  spot legacy keys that should be migrated. */
  fromFallback: boolean;
}

/** Compute the full permission set for a role by collapsing the
 *  hierarchy. A super_admin gets everything below; a viewer gets only
 *  ROLE_PERMISSIONS.viewer. */
export function permissionsForRole(role: RbacRole): Set<RbacPermission> {
  const out = new Set<RbacPermission>();
  for (const r of ROLES) {
    if (ROLE_RANK[r] <= ROLE_RANK[role]) {
      for (const p of ROLE_PERMISSIONS[r]) out.add(p);
    }
  }
  return out;
}

/** Returns true when the resolved set covers the requested permission. */
export function hasPermission(perms: Set<RbacPermission>, required: RbacPermission): boolean {
  return perms.has(required);
}

// Tenant context — flows the active tenant id through async work without
// every function signature having to grow a parameter.
//
// We use AsyncLocalStorage from node:async_hooks: requests enter via the
// tenant middleware, set the context, and any await chain originating
// from that request observes the same getCurrentTenantId(). Code paths
// that aren't request-scoped (background sweeps, scheduled tasks, the
// initial system bootstrap) fall back to SYSTEM_TENANT — a real, named
// tenant used by anything that ran before multi-tenant support landed.
// That keeps existing single-tenant deployments working without code
// changes while still giving multi-tenant deployments strict isolation.
//
// Why AsyncLocalStorage and not a request-arg-threaded approach: the
// codebase has 30+ stores and ~60 endpoints. Threading a tenantId
// parameter through every existing call site was rejected as a flag-day
// rewrite. AsyncLocalStorage is the way Node's own ecosystem (Express
// middleware, OpenTelemetry, pino loggers) propagate request-scoped
// data; we use the same pattern so future-tenant-aware code reads
// naturally and existing code stays untouched.

import { AsyncLocalStorage } from 'async_hooks';

/** ID used by everything that runs outside an explicit tenant scope —
 *  background sweeps, system bootstrap, anonymous health checks. Treated
 *  as a real tenant by the storage layer; existing rows that predate
 *  multi-tenancy are mapped to it. */
export const SYSTEM_TENANT_ID = 'system';

/** Anything carried through a request beyond the auth subject. Add
 *  fields here as new tenant-scoped concepts (region, plan tier, …)
 *  appear; the AsyncLocalStorage carries them all. */
export interface TenantContext {
  tenantId: string;
  /** Display name surfaced in logs + audit; defaults to tenantId. */
  tenantName?: string;
  /** When the auth subject is a member of multiple tenants, this is the
   *  one they're acting in for this request. Equal to tenantId in most
   *  flows. */
  actingAsTenantId?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

/** Run a callback inside a tenant scope. Anything awaited inside `fn`
 *  observes the supplied context via getCurrentTenant(). Nesting is
 *  permitted: the inner scope wins until it returns. */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Read the active context. Returns undefined when called outside a
 *  scope — callers that need a tenant must use getCurrentTenantId() to
 *  get the SYSTEM_TENANT_ID fallback. */
export function getCurrentTenant(): TenantContext | undefined {
  return storage.getStore();
}

/** Read the active tenant id, falling back to the system tenant. The
 *  fallback is intentional: any code path that runs before middleware
 *  has fired (system.started event, background timers) belongs to the
 *  system tenant by definition. */
export function getCurrentTenantId(): string {
  return storage.getStore()?.tenantId ?? SYSTEM_TENANT_ID;
}

/** Express the context as one-line metadata for the JSON logger. */
export function tenantLogFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return { tenant: SYSTEM_TENANT_ID };
  return ctx.tenantName && ctx.tenantName !== ctx.tenantId
    ? { tenant: ctx.tenantId, tenantName: ctx.tenantName }
    : { tenant: ctx.tenantId };
}

// Public API barrel for the tenancy module.
//
// Outside-module callers must import only the names re-exported here.
// The boundary enforcer (tools/checkModuleBoundaries.mjs) flags any
// cross-module import that bypasses this barrel.

export {
  SYSTEM_TENANT_ID,
  runWithTenant,
  getCurrentTenant,
  getCurrentTenantId,
  tenantLogFields,
  type TenantContext,
} from './TenantContext.js';

export {
  type TenantStatus,
  type TenantRecord,
  type TenantStore,
  SqliteTenantStore,
  PostgresTenantStore,
} from './TenantStore.js';

export { createTenantMiddleware } from './tenantMiddleware.js';
// TenantScopedEventBus moved to the events module — re-import directly
// from `events/index.js` (it depends on EventBus + EventStore which
// would otherwise force tenancy → events → persistence → tenancy cycle).

// PlanEnforcer — plan-tier limits applied to incident creation, server
// addition, and AI feature toggles. The system tenant is hard-coded to
// 'enterprise' so the legacy single-tenant deployment hits no limits.
//
// Limits:
//   free        — 3 servers, 50 incidents/month, auto-resolve OFF.
//   pro         — 20 servers, unlimited incidents, all AI features.
//   enterprise  — unlimited servers, unlimited incidents, all AI features.
//
// Counting:
//   • Per-tenant counts are fetched via injected `counters` so the
//     enforcer stays decoupled from store internals.
//   • Incident counts are calendar-month-based (UTC). The counter
//     receives a `since` ISO string and returns the count of incidents
//     created within that window.
//
// Errors:
//   • check(...) returns { ok: boolean, reason?: string }. Callers
//     decide whether to throw HTTP 402 (payment required) or 403.

import type { TenantPlan, TenantRecord, TenantStore } from './TenantStore.js';

export interface PlanLimits {
  servers: number;          // -1 means unlimited
  incidentsPerMonth: number;
  autoResolveAllowed: boolean;
  predictiveAlertsAllowed: boolean;
  runbookGenerationAllowed: boolean;
}

export const PLAN_LIMITS: Record<TenantPlan, PlanLimits> = {
  free:       { servers: 3,  incidentsPerMonth: 50,  autoResolveAllowed: false, predictiveAlertsAllowed: false, runbookGenerationAllowed: false },
  pro:        { servers: 20, incidentsPerMonth: -1,  autoResolveAllowed: true,  predictiveAlertsAllowed: true,  runbookGenerationAllowed: true  },
  enterprise: { servers: -1, incidentsPerMonth: -1,  autoResolveAllowed: true,  predictiveAlertsAllowed: true,  runbookGenerationAllowed: true  },
};

export interface PlanCheckResult {
  ok: boolean;
  reason?: string;
  /** Numeric current/limit pair for the dashboard. */
  current?: number;
  limit?: number;
  plan?: TenantPlan;
}

export interface PlanUsage {
  tenantId: string;
  plan: TenantPlan;
  servers: { current: number; limit: number };
  incidentsThisMonth: { current: number; limit: number };
  aiDecisionsThisMonth: number;
  featureFlags: {
    autoResolveAllowed: boolean;
    predictiveAlertsAllowed: boolean;
    runbookGenerationAllowed: boolean;
  };
}

export interface PlanCounters {
  countServers(tenantId: string): number | Promise<number>;
  countIncidentsSince(tenantId: string, sinceIso: string): number | Promise<number>;
  countAiDecisionsSince(tenantId: string, sinceIso: string): number | Promise<number>;
}

export class PlanEnforcer {
  constructor(
    private readonly tenants: TenantStore,
    private readonly counters: PlanCounters,
  ) {}

  /** Verify a tenant can add another server. Returns ok=true when the
   *  plan allows it, ok=false with a reason otherwise. */
  async checkServerAdd(tenantId: string): Promise<PlanCheckResult> {
    const tenant = await this.requireTenant(tenantId);
    const limits = PLAN_LIMITS[tenant.plan];
    if (limits.servers < 0) return { ok: true, plan: tenant.plan };
    const current = await Promise.resolve(this.counters.countServers(tenantId));
    if (current >= limits.servers) {
      return { ok: false, reason: `Server limit reached for the ${tenant.plan} plan (${current}/${limits.servers}). Upgrade to add more.`,
               current, limit: limits.servers, plan: tenant.plan };
    }
    return { ok: true, current, limit: limits.servers, plan: tenant.plan };
  }

  /** Verify a tenant can create another incident this calendar month. */
  async checkIncidentCreate(tenantId: string): Promise<PlanCheckResult> {
    const tenant = await this.requireTenant(tenantId);
    const limits = PLAN_LIMITS[tenant.plan];
    if (limits.incidentsPerMonth < 0) return { ok: true, plan: tenant.plan };
    const since = monthStartIso();
    const current = await Promise.resolve(this.counters.countIncidentsSince(tenantId, since));
    if (current >= limits.incidentsPerMonth) {
      return { ok: false, reason: `Monthly incident cap reached for the ${tenant.plan} plan (${current}/${limits.incidentsPerMonth}). Upgrade or wait until next month.`,
               current, limit: limits.incidentsPerMonth, plan: tenant.plan };
    }
    return { ok: true, current, limit: limits.incidentsPerMonth, plan: tenant.plan };
  }

  async checkFeature(tenantId: string, feature: 'autoResolve' | 'predictiveAlerts' | 'runbookGeneration'): Promise<PlanCheckResult> {
    const tenant = await this.requireTenant(tenantId);
    const limits = PLAN_LIMITS[tenant.plan];
    const allowed =
      feature === 'autoResolve' ? limits.autoResolveAllowed :
      feature === 'predictiveAlerts' ? limits.predictiveAlertsAllowed :
      limits.runbookGenerationAllowed;
    return allowed
      ? { ok: true, plan: tenant.plan }
      : { ok: false, reason: `The ${feature} feature requires the pro or enterprise plan (you're on ${tenant.plan}).`, plan: tenant.plan };
  }

  /** Snapshot for the TenantSettings billing card. */
  async usage(tenantId: string): Promise<PlanUsage> {
    const tenant = await this.requireTenant(tenantId);
    const limits = PLAN_LIMITS[tenant.plan];
    const since = monthStartIso();
    const [servers, incidents, ai] = await Promise.all([
      Promise.resolve(this.counters.countServers(tenantId)),
      Promise.resolve(this.counters.countIncidentsSince(tenantId, since)),
      Promise.resolve(this.counters.countAiDecisionsSince(tenantId, since)),
    ]);
    return {
      tenantId, plan: tenant.plan,
      servers: { current: servers, limit: limits.servers },
      incidentsThisMonth: { current: incidents, limit: limits.incidentsPerMonth },
      aiDecisionsThisMonth: ai,
      featureFlags: {
        autoResolveAllowed: limits.autoResolveAllowed,
        predictiveAlertsAllowed: limits.predictiveAlertsAllowed,
        runbookGenerationAllowed: limits.runbookGenerationAllowed,
      },
    };
  }

  private async requireTenant(tenantId: string): Promise<TenantRecord> {
    const t = await Promise.resolve(this.tenants.get(tenantId));
    if (!t) throw new Error(`Tenant not found: ${tenantId}`);
    return t;
  }
}

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString();
}

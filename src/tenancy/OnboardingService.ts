// OnboardingService — small state-machine that drives the post-
// registration wizard. The persistent state lives in TenantStore's
// `settings.onboarding` JSON blob so a brand-new install doesn't have
// a separate table.
//
// Steps:
//   1. welcome     — confirm org name + pick a timezone
//   2. servers     — optionally add monitored servers
//   3. sla         — pick an SLA preset
//   4. team        — invite teammates by email
//   5. done        — completion flag flipped
//
// `complete: true` short-circuits the wizard for subsequent logins
// so a finished tenant isn't bothered again.

import type { TenantStore, TenantRecord } from './TenantStore.js';

export type OnboardingStep = 'welcome' | 'servers' | 'sla' | 'team' | 'done';

export interface OnboardingState {
  completed: boolean;
  currentStep: number;       // 1..5 mirrors the wizard step
  /** Per-step payloads — preserved so the user can navigate back. */
  steps?: {
    welcome?: { orgName?: string; timezone?: string };
    servers?: { count?: number; addedAt?: string };
    sla?:     { preset?: 'startup' | 'standard' | 'enterprise' | 'custom' };
    team?:    { invitesSent?: number };
  };
  startedAt?: string;
  completedAt?: string;
}

export interface OnboardingStatus {
  tenantId: string;
  state: OnboardingState;
  /** Convenience pointer to the next step name. */
  nextStep: OnboardingStep;
}

export const STEP_NUMBERS: Record<OnboardingStep, number> = {
  welcome: 1, servers: 2, sla: 3, team: 4, done: 5,
};
const STEP_NAMES: OnboardingStep[] = ['welcome', 'servers', 'sla', 'team', 'done'];

export class OnboardingService {
  constructor(private readonly tenants: TenantStore) {}

  async status(tenantId: string): Promise<OnboardingStatus> {
    const t = await this.requireTenant(tenantId);
    const state = (t.settings.onboarding as OnboardingState | undefined) ?? this.defaultState();
    const nextStep = state.completed
      ? 'done'
      : (STEP_NAMES[Math.max(0, Math.min(STEP_NAMES.length - 1, state.currentStep - 1))]);
    return { tenantId, state, nextStep };
  }

  /** Save one step's payload + advance the cursor. Idempotent: re-saving
   *  the same step keeps the data but does not double-advance. */
  async saveStep(tenantId: string, step: OnboardingStep, payload: Record<string, unknown>): Promise<OnboardingStatus> {
    const t = await this.requireTenant(tenantId);
    const state = ((t.settings.onboarding as OnboardingState | undefined) ?? this.defaultState());
    state.steps = state.steps ?? {};
    if (step === 'welcome') state.steps.welcome = pickPayload(payload, ['orgName', 'timezone']);
    if (step === 'servers') state.steps.servers = pickPayload(payload, ['count', 'addedAt']);
    if (step === 'sla')     state.steps.sla     = pickPayload(payload, ['preset']);
    if (step === 'team')    state.steps.team    = pickPayload(payload, ['invitesSent']);
    if (step === 'done')    state.completed = true;

    const stepNum = STEP_NUMBERS[step];
    if (stepNum > (state.currentStep ?? 0)) state.currentStep = stepNum;
    if (step === 'done' || state.completed) {
      state.completed = true;
      state.completedAt = state.completedAt ?? new Date().toISOString();
      state.currentStep = STEP_NUMBERS.done;
    }
    state.startedAt = state.startedAt ?? new Date().toISOString();

    const nextSettings = { ...t.settings, onboarding: state };
    await Promise.resolve(this.tenants.upsert({
      id: t.id, slug: t.slug, name: t.name, plan: t.plan, status: t.status,
      ownerUsername: t.ownerUsername, settings: nextSettings,
    }));
    return this.status(tenantId);
  }

  /** Reset onboarding back to step 1. Used by the admin "show me the
   *  tour again" affordance in TenantSettings. */
  async reset(tenantId: string): Promise<OnboardingStatus> {
    const t = await this.requireTenant(tenantId);
    const nextSettings = { ...t.settings, onboarding: this.defaultState() };
    await Promise.resolve(this.tenants.upsert({
      id: t.id, slug: t.slug, name: t.name, plan: t.plan, status: t.status,
      ownerUsername: t.ownerUsername, settings: nextSettings,
    }));
    return this.status(tenantId);
  }

  private defaultState(): OnboardingState {
    return { completed: false, currentStep: 1, steps: {} };
  }

  private async requireTenant(tenantId: string): Promise<TenantRecord> {
    const t = await Promise.resolve(this.tenants.get(tenantId));
    if (!t) throw new Error(`Tenant not found: ${tenantId}`);
    return t;
  }
}

function pickPayload<T extends string>(payload: Record<string, unknown>, keys: T[]): Record<T, unknown> {
  const out: any = {};
  for (const k of keys) if (k in payload) out[k] = (payload as any)[k];
  return out;
}

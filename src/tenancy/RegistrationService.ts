// RegistrationService — handles self-service tenant + admin user
// creation, plus invite-based join flows. Centralises validation +
// idempotency logic so the HTTP route stays thin.
//
// What it does:
//   • register(): builds a unique slug from the org name, creates the
//     tenant, then creates an admin user inside that tenant. Returns
//     a fresh JWT.
//   • inviteUser(): admin creates an invite for someone to join their
//     tenant. Returns the raw token only (subsequent reads see hash).
//   • join(): consumes a pending invite token, creates a user in the
//     scoped tenant with the role from the invite. Returns a JWT.
//
// Slug strategy: lowercase, ASCII letters/digits/hyphens, max 32.
// Collisions append a short random suffix.
//
// Email validation: shape only — RFC-grade verification is too brittle
// and we don't send mail. Reject obvious garbage and rely on the user
// to enter their real address.

import crypto from 'crypto';
import type { AuthService, AuthIssueResult, UserRole } from '../security/AuthService.js';
import type { TenantStore, TenantPlan } from './TenantStore.js';
import type { InviteStore } from './InviteStore.js';
import type { CloudflareDnsService } from './CloudflareDnsService.js';
import { createLogger } from '../observability/Logger.js';

const log = createLogger({ component: 'registration' });

export interface RegistrationResult {
  tenantId: string;
  slug: string;
  username: string;
  session: AuthIssueResult;
}

export interface RegistrationServiceDeps {
  tenants: TenantStore;
  invites: InviteStore;
  authService: AuthService;
  /** Default plan for new self-service tenants. Defaults to 'free'. */
  defaultPlan?: TenantPlan;
  /** Optional — when present, the service provisions a proxied CNAME
   *  for the tenant's subdomain on register(). DNS failures never
   *  abort registration; they are logged. */
  dnsService?: CloudflareDnsService;
}

export class RegistrationService {
  private deps: RegistrationServiceDeps;

  constructor(deps: RegistrationServiceDeps) {
    this.deps = deps;
  }

  /** Public registration. Validates input, derives a unique slug, then
   *  creates a tenant + admin user atomically (in code, not in a
   *  cross-store transaction — each store is its own SQLite). On error
   *  partway through, the partial state is left behind for an operator
   *  to clean up. */
  async register(input: { email: string; password: string; orgName: string; fullName?: string }): Promise<RegistrationResult> {
    validateEmail(input.email);
    validatePassword(input.password);
    validateOrgName(input.orgName);

    const username = input.email.trim().toLowerCase();
    if (this.deps.authService.getUser(username)) {
      throw new RegistrationError('A user with this email already exists', 409);
    }

    const slug = await this.findUniqueSlug(input.orgName);
    const tenantId = 't-' + crypto.randomBytes(8).toString('hex');
    await Promise.resolve(this.deps.tenants.upsert({
      id: tenantId, slug, name: input.orgName.trim(),
      plan: this.deps.defaultPlan ?? 'free',
      ownerUsername: username,
      status: 'active',
      settings: {
        fullName: input.fullName ?? null,
        onboarding: { completed: false, currentStep: 1 },
      },
    }));

    this.deps.authService.createOrUpdateUser({
      username, password: input.password, role: 'admin',
      email: input.email, tenantId, active: true,
    });

    const session = this.deps.authService.issueToken(username, input.password);
    if (!session) {
      throw new RegistrationError('Failed to issue session token — auth service mis-configured', 500);
    }

    if (this.deps.dnsService) {
      try {
        const r = await this.deps.dnsService.createRecord(slug, { comment: `itops tenant: ${slug} (${tenantId})` });
        if (!r.ok) {
          log.warn('DNS provisioning failed for new tenant', { tenantId, slug, hostname: r.hostname, error: r.error });
        }
      } catch (e: any) {
        log.warn('DNS provisioning threw for new tenant', { tenantId, slug, error: e?.message ?? String(e) });
      }
    }

    return { tenantId, slug, username, session };
  }

  /** Admin invites another user into their tenant. Returns the raw
   *  token + the row's id; the token is the bearer the invitee uses
   *  on /api/auth/join. */
  inviteUser(input: { tenantId: string; email: string; role: UserRole; invitedBy: string; ttlDays?: number }): { id: string; token: string; expiresAt: string } {
    validateEmail(input.email);
    if (input.role === 'superadmin') {
      throw new RegistrationError('Cannot invite a superadmin via tenant invite', 400);
    }
    if (input.role === 'admin' || input.role === 'operator' || input.role === 'viewer' || input.role === 'requester') {
      const rec = this.deps.invites.create({
        tenantId: input.tenantId,
        email: input.email,
        role: input.role,
        invitedBy: input.invitedBy,
        ttlDays: input.ttlDays,
      });
      return { id: rec.id, token: rec.token!, expiresAt: rec.expiresAt };
    }
    throw new RegistrationError(`Invalid role: ${input.role}`, 400);
  }

  /** Invitee accepts an invite — creates the user account in the
   *  tenant scoped by the invite. */
  async join(input: { token: string; username: string; password: string; fullName?: string }): Promise<RegistrationResult> {
    validatePassword(input.password);
    const invite = this.deps.invites.findByToken(input.token);
    if (!invite) throw new RegistrationError('Invite not found', 404);
    if (invite.status !== 'pending') {
      throw new RegistrationError(`Invite is ${invite.status}`, 410);
    }
    const tenant = await Promise.resolve(this.deps.tenants.get(invite.tenantId));
    if (!tenant) throw new RegistrationError('Tenant for this invite no longer exists', 410);

    const username = (input.username || invite.email).trim().toLowerCase();
    if (this.deps.authService.getUser(username)) {
      throw new RegistrationError('A user with this username already exists', 409);
    }
    this.deps.authService.createOrUpdateUser({
      username, password: input.password, role: invite.role,
      email: invite.email, tenantId: invite.tenantId, active: true,
    });
    this.deps.invites.markAccepted(invite.id, username);

    const session = this.deps.authService.issueToken(username, input.password);
    if (!session) throw new RegistrationError('Failed to issue session token', 500);
    return { tenantId: invite.tenantId, slug: tenant.slug, username, session };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /** Try the bare slug first; on collision, append `-<rand4>` and retry
   *  up to MAX_TRIES. Practical: with a 4-char hex suffix we'd need a
   *  collision rate above 1/65536 to fail, so the loop almost always
   *  exits on the first try. */
  private async findUniqueSlug(orgName: string): Promise<string> {
    const base = slugify(orgName);
    const MAX_TRIES = 8;
    for (let i = 0; i < MAX_TRIES; i++) {
      const candidate = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
      const existing = await Promise.resolve(this.deps.tenants.getBySlug(candidate));
      if (!existing) return candidate;
    }
    // Final fallback: random hex. Stable but ugly.
    return `org-${crypto.randomBytes(6).toString('hex')}`;
  }
}

export class RegistrationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'RegistrationError';
  }
}

// Shape-only email validation. Rejects empty/whitespace-only, missing @,
// missing domain segment, or anything longer than the SMTP-side limit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email: string): void {
  const trimmed = (email ?? '').trim();
  if (!trimmed) throw new RegistrationError('Email is required', 400);
  if (trimmed.length > 254) throw new RegistrationError('Email too long', 400);
  if (!EMAIL_RE.test(trimmed)) throw new RegistrationError('Email format is invalid', 400);
}

function validatePassword(pw: string): void {
  if (typeof pw !== 'string') throw new RegistrationError('Password is required', 400);
  if (pw.length < 8) throw new RegistrationError('Password must be at least 8 characters', 400);
  if (pw.length > 256) throw new RegistrationError('Password too long', 400);
}

function validateOrgName(name: string): void {
  const trimmed = (name ?? '').trim();
  if (trimmed.length < 2) throw new RegistrationError('Organization name must be at least 2 characters', 400);
  if (trimmed.length > 80) throw new RegistrationError('Organization name too long', 400);
}

/** Lowercase, ASCII a-z/0-9/-, max 32 chars, no leading/trailing dash. */
export function slugify(input: string): string {
  const s = input.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
  return s || 'org';
}

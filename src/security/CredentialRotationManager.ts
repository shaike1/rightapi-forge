// Periodic auto-rotation for credentials in CredentialVault.
//
// What this does:
//   - Sweeps the vault on a fixed interval (default: hourly).
//   - For each credential whose expiry is within `warnBeforeMs` OR whose
//     rotation interval has elapsed, looks up a Rotator registered for the
//     credential's `kind` and calls it.
//   - Successful rotation: applyRotation() — bump lastRotatedAt, swap secret,
//     optionally set a new expiresAt, clear any prior failure state.
//   - Failed rotation: markRotationFailure() + onAlert() — secret stays put,
//     failure surfaces in /api/health and the operator's alert channel.
//
// Why this design:
//   - Rotators are pluggable (per kind). The vault never reaches out to a
//     network on its own; it's just storage. An ApiKeyRotator implementation
//     might call your IdP, a CertRotator might re-issue from your internal CA.
//     This module is the orchestration glue, not the rotation logic.
//   - Failure does NOT throw or block other credentials. One broken rotator
//     can't take down the sweep — it logs, alerts, and the next credential
//     is attempted.
//   - The sweep is best-effort. A missed tick (host restart) just means the
//     next sweep picks up the slack — credentials track their own lastRotated
//     state, so we never double-rotate based on intervals.

import { createLogger } from '../observability/Logger.js';
import type { CredentialKind, CredentialRecordMeta, CredentialVault } from './CredentialVault.js';

const log = createLogger({ component: 'credential-rotation' });

/** Result a Rotator returns to swap a credential's secret. */
export interface RotationResult {
  /** New secret string the vault should encrypt + store. */
  secret: string;
  /** Optional updated expiry. Omit to leave the existing expiresAt alone. */
  expiresAt?: string;
}

/** Plug-in that knows how to mint a new credential of a given kind. The
 *  manager calls this when a credential is due. Implementations are free to
 *  call out to an IdP, certificate authority, or anything else; throwing is
 *  the standard way to signal "rotation failed". */
export type Rotator = (
  meta: CredentialRecordMeta,
  currentSecret: string | null,
) => Promise<RotationResult>;

/** Alert payload emitted on rotation failure / overdue credentials. */
export interface RotationAlert {
  level: 'warn' | 'error';
  /** Stable identifier so consumers can dedupe ("rotation-failed:<id>"). */
  key: string;
  message: string;
  credentialId: string;
  agentId: string;
  name: string;
  kind?: CredentialKind;
  expiresAt?: string;
  reason?: string;
}

export type AlertSink = (alert: RotationAlert) => void;

export interface CredentialRotationManagerOptions {
  /** How often to run the sweep. Default 1h. */
  checkIntervalMs?: number;
  /** How far ahead of expiry we attempt rotation. Default 7d. */
  warnBeforeMs?: number;
  /** Where alerts go (failed rotations, overdue credentials with no rotator). */
  onAlert?: AlertSink;
  /** Override `Date.now()` — used by tests for deterministic timing. */
  now?: () => Date;
}

/** Snapshot returned from runOnce() — handy for tests + the API endpoint. */
export interface SweepResult {
  checked: number;
  rotated: number;
  failed: number;
  noRotator: number;
  /** Keyed by credential id — most recent error message for the failures. */
  failures: Array<{ credentialId: string; message: string }>;
}

export class CredentialRotationManager {
  private readonly vault: CredentialVault;
  private readonly checkIntervalMs: number;
  private readonly warnBeforeMs: number;
  private readonly onAlert: AlertSink;
  private readonly now: () => Date;

  /** kind → Rotator. Registered separately so tests can swap fakes. */
  private readonly rotators: Map<CredentialKind, Rotator> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Last sweep result, exposed for the health probe + dashboards. */
  private lastSweep: SweepResult | null = null;
  private lastSweepAt: string | null = null;

  constructor(vault: CredentialVault, opts?: CredentialRotationManagerOptions) {
    this.vault           = vault;
    this.checkIntervalMs = opts?.checkIntervalMs ?? 60 * 60 * 1000;
    this.warnBeforeMs    = opts?.warnBeforeMs    ?? 7 * 24 * 60 * 60 * 1000;
    this.onAlert         = opts?.onAlert         ?? (() => { /* default: no-op */ });
    this.now             = opts?.now             ?? (() => new Date());
  }

  /** Register a rotator for a credential kind. Last-write-wins. */
  registerRotator(kind: CredentialKind, rotator: Rotator): void {
    this.rotators.set(kind, rotator);
  }

  /** Begin periodic sweeps. Idempotent. */
  start(): void {
    if (this.timer) return;
    log.info('credential rotation sweeps started', {
      intervalMs: this.checkIntervalMs,
      warnBeforeMs: this.warnBeforeMs,
      kinds: Array.from(this.rotators.keys()),
    });
    // Use unref so the timer doesn't keep the process alive during tests /
    // graceful shutdown — the parent shutdown coordinator owns lifecycle.
    this.timer = setInterval(() => { void this.runOnce(); }, this.checkIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop sweeping. Pending in-flight sweep is allowed to finish — start()
   *  has its own re-entry guard. Idempotent. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Snapshot for /api/health + dashboards. */
  getStatus(): { lastSweepAt: string | null; lastSweep: SweepResult | null } {
    return { lastSweepAt: this.lastSweepAt, lastSweep: this.lastSweep };
  }

  /** Run one full sweep. Safe to call manually (tests, admin endpoints).
   *  Re-entrant calls are coalesced — the second runOnce() returns the
   *  in-flight sweep's eventual result rather than running twice. */
  async runOnce(): Promise<SweepResult> {
    if (this.running) {
      // Wait for the running sweep to finish, then return its cached result.
      // We don't run a second sweep — the first one already covered the work.
      while (this.running) await new Promise(r => setTimeout(r, 25));
      return this.lastSweep ?? { checked: 0, rotated: 0, failed: 0, noRotator: 0, failures: [] };
    }
    this.running = true;
    try {
      const result: SweepResult = { checked: 0, rotated: 0, failed: 0, noRotator: 0, failures: [] };
      const now = this.now();
      const due = this.vault.listDueForRotation({ now, warnBeforeMs: this.warnBeforeMs });
      result.checked = due.length;

      for (const meta of due) {
        const rotator = meta.kind ? this.rotators.get(meta.kind) : undefined;
        if (!rotator) {
          // No rotator registered for this kind — nothing to do but alert so
          // an operator can rotate by hand or register a rotator. We do NOT
          // count this as a failure; failure is reserved for "we tried and it
          // broke", which is a different signal.
          result.noRotator++;
          this.onAlert({
            level: 'warn',
            key: `no-rotator:${meta.id}`,
            message: meta.kind
              ? `No rotator registered for credential kind "${meta.kind}"`
              : `Credential "${meta.name}" is due for rotation but has no kind set`,
            credentialId: meta.id,
            agentId: meta.agentId,
            name: meta.name,
            kind: meta.kind,
            expiresAt: meta.expiresAt,
          });
          continue;
        }

        try {
          const currentSecret = this.vault.resolveSecret(meta.id);
          const next = await rotator(meta, currentSecret);
          if (!next || typeof next.secret !== 'string' || next.secret.length === 0) {
            throw new Error('rotator returned no secret');
          }
          this.vault.applyRotation(meta.id, { secret: next.secret, expiresAt: next.expiresAt });
          result.rotated++;
          log.info('credential rotated', {
            credentialId: meta.id, name: meta.name, kind: meta.kind,
          });
        } catch (err: any) {
          const message = err?.message ?? String(err);
          this.vault.markRotationFailure(meta.id, message);
          result.failed++;
          result.failures.push({ credentialId: meta.id, message });
          this.onAlert({
            level: 'error',
            key: `rotation-failed:${meta.id}`,
            message: `Rotation failed for credential "${meta.name}": ${message}`,
            credentialId: meta.id,
            agentId: meta.agentId,
            name: meta.name,
            kind: meta.kind,
            expiresAt: meta.expiresAt,
            reason: message,
          });
          log.error('credential rotation failed', {
            credentialId: meta.id, name: meta.name, kind: meta.kind, err: message,
          });
        }
      }

      this.lastSweep = result;
      this.lastSweepAt = now.toISOString();
      if (result.checked > 0) {
        log.info('credential rotation sweep finished', { ...result, totalChecked: result.checked });
      }
      return result;
    } finally {
      this.running = false;
    }
  }
}

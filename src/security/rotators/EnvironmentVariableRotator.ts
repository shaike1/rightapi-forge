// Rotates a secret stored in a .env file (or any KEY=VALUE file) +
// signals the host process that it should reload.
//
// Use case: legacy services that read their secret from process.env at
// startup. The vault holds the truth, and on rotation we (a) generate
// a fresh secret, (b) rewrite the .env line, (c) emit a reload signal
// — typically SIGHUP to a long-running process or a configurable
// post-write callback that calls into a process manager.
//
// The vault always stores the rotated secret too (the
// CredentialRotationManager handles that side). This rotator's job is
// to make sure the file the legacy process reads matches what the vault
// just stored.
//
// Wiring example (server.ts):
//
//   rotationManager.registerRotator('password', new EnvironmentVariableRotator({
//     filePath: '/data/itops-agents/.env',
//     mapping: { 'POSTGRES_PASSWORD': cred => cred.name === 'pg-pass' },
//     generator: () => crypto.randomBytes(24).toString('base64url'),
//     onWritten: async () => { await execAsync('systemctl reload my-app'); },
//   }).rotate);

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../../observability/Logger.js';
import type { Rotator, RotationResult } from '../CredentialRotationManager.js';
import type { CredentialRecordMeta } from '../CredentialVault.js';

const log = createLogger({ component: 'rotator-env' });

export interface EnvironmentVariableRotatorConfig {
  /** Absolute path to the .env file. */
  filePath: string;
  /**
   * Map of ENV_KEY → predicate. The predicate decides whether *this*
   * credential should be written under *this* env key. Lets one
   * rotator instance manage several credentials in one .env file
   * without an awkward 1:1 mapping.
   */
  mapping: Record<string, (cred: CredentialRecordMeta) => boolean>;
  /** Generator for the new secret. Default: 24 bytes base64url. */
  generator?: () => string;
  /** Optional fresh-expiry computer. Default: 90 days from now. */
  expiryFor?: (cred: CredentialRecordMeta) => string | undefined;
  /**
   * Hook fired after the file has been rewritten — e.g. to send SIGHUP
   * to a running process or call a process manager. Failures here are
   * logged but DO NOT fail the rotation; the vault + .env are already
   * consistent at this point.
   */
  onWritten?: (writtenKeys: string[], cred: CredentialRecordMeta) => Promise<void> | void;
  /** Override fs for tests. */
  fsImpl?: Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'access' | 'mkdir'>;
}

export class EnvironmentVariableRotator {
  private readonly cfg: Required<Omit<EnvironmentVariableRotatorConfig, 'onWritten' | 'fsImpl'>> & {
    onWritten?: EnvironmentVariableRotatorConfig['onWritten'];
    fs: Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'access' | 'mkdir'>;
  };

  constructor(cfg: EnvironmentVariableRotatorConfig) {
    if (!cfg.filePath) throw new Error('EnvironmentVariableRotator: filePath is required');
    if (!cfg.mapping || Object.keys(cfg.mapping).length === 0) {
      throw new Error('EnvironmentVariableRotator: mapping must list at least one key');
    }
    this.cfg = {
      filePath: cfg.filePath,
      mapping: cfg.mapping,
      generator: cfg.generator ?? defaultGenerator,
      expiryFor: cfg.expiryFor ?? defaultExpiry,
      onWritten: cfg.onWritten,
      fs: cfg.fsImpl ?? fs.promises,
    };
  }

  rotate: Rotator = async (meta, _currentSecret) => {
    // Find the env keys this credential should be written under.
    const targetKeys = Object.entries(this.cfg.mapping)
      .filter(([, pred]) => pred(meta))
      .map(([k]) => k);
    if (targetKeys.length === 0) {
      // No env key claimed this credential — refuse to mint a secret
      // we won't write anywhere. Authors should narrow the predicate
      // OR add the credential's name to the mapping.
      throw new Error(`no env key in mapping matched credential "${meta.name}" (${meta.id})`);
    }

    const newSecret = this.cfg.generator();
    if (!newSecret || newSecret.length === 0) throw new Error('generator returned empty secret');

    // Read the current file (or empty when missing).
    const dir = path.dirname(this.cfg.filePath);
    await this.ensureDir(dir);
    let existing = '';
    try { existing = await this.cfg.fs.readFile(this.cfg.filePath, 'utf8'); }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; }

    const next = updateEnvFile(existing, targetKeys, newSecret);
    await this.cfg.fs.writeFile(this.cfg.filePath, next, 'utf8');

    if (this.cfg.onWritten) {
      try { await this.cfg.onWritten(targetKeys, meta); }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('env rotator onWritten hook failed (rotation succeeded)', {
          credentialId: meta.id, err: msg,
        });
      }
    }

    log.info('env-backed secret rotated', {
      credentialId: meta.id, name: meta.name, keys: targetKeys, file: this.cfg.filePath,
    });

    return {
      secret: newSecret,
      expiresAt: this.cfg.expiryFor(meta),
    };
  };

  private async ensureDir(dir: string): Promise<void> {
    try {
      await this.cfg.fs.access(dir);
    } catch {
      await this.cfg.fs.mkdir(dir, { recursive: true });
    }
  }
}

// Exported for direct tests of the rewrite logic.
export function updateEnvFile(content: string, keys: string[], value: string): string {
  // Lines that match KEY=... get replaced; missing keys are appended.
  // Preserves blank lines + comments + non-target lines so the file
  // stays reviewable.
  const lines = content.split(/\r?\n/);
  const seen = new Set<string>();
  const updated = lines.map(line => {
    const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) return line;
    if (keys.includes(m[2])) {
      seen.add(m[2]);
      return `${m[1]}${m[2]}=${shellEscape(value)}`;
    }
    return line;
  });
  for (const k of keys) if (!seen.has(k)) updated.push(`${k}=${shellEscape(value)}`);
  // Normalise trailing newline.
  let out = updated.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function shellEscape(value: string): string {
  // Wrap in double quotes when the value contains whitespace or a few
  // shell-significant characters; otherwise leave bare. This is the
  // same convention every .env file shipped by Compose / dotenv uses.
  if (/^[A-Za-z0-9_\-./@:=+,]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
}

function defaultGenerator(): string {
  return crypto.randomBytes(24).toString('base64url');
}
function defaultExpiry(): string {
  return new Date(Date.now() + 90 * 86_400_000).toISOString();
}

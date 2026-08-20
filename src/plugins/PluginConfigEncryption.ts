// PluginConfigEncryption — encrypt-at-rest envelope for plugin configs.
//
// Plugins receive secrets (PagerDuty API keys, OpsGenie tokens, etc.).
// Storing those in plaintext SQLite rows is unacceptable, so each row's
// `config` column holds a JSON envelope produced by encrypt() below.
//
// Algorithm: AES-256-GCM with a per-record 12-byte IV. Same shape that
// CredentialVault uses for operator secrets — kept independent because
// the key derivation is different (operator vault key vs platform key).
//
// Key source priority:
//   1. PLUGIN_ENCRYPTION_KEY   — preferred, dedicated to plugins
//   2. JWT_SECRET              — pragmatic fallback; deploy already has one
//   3. AUTH_TOKEN_SECRET       — used by /api/auth/refresh, same trust level
//
// We hash the chosen secret with SHA-256 so any string length becomes a
// 32-byte AES key without forcing operators to manage byte-exact secrets.
//
// Backward compatibility: encrypt() returns a stringified envelope; the
// caller stores it verbatim. decrypt() rejects malformed envelopes with a
// thrown error so callers don't accidentally use cleartext as ciphertext.

import crypto from 'crypto';

interface Envelope {
  v: 1;
  ciphertext: string; // base64
  iv: string;         // base64
  tag: string;        // base64
}

export class PluginConfigEncryption {
  private readonly key: Buffer;

  constructor(rawSecret: string) {
    if (!rawSecret) {
      throw new Error('PluginConfigEncryption requires a non-empty secret');
    }
    this.key = crypto.createHash('sha256').update(rawSecret, 'utf8').digest();
  }

  /** Pick the best available secret from the environment. Throws if none
   *  is set — boot should fail loudly rather than silently using a
   *  hardcoded default. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): PluginConfigEncryption {
    const secret = env.PLUGIN_ENCRYPTION_KEY || env.JWT_SECRET || env.AUTH_TOKEN_SECRET;
    if (!secret) {
      throw new Error(
        'PluginConfigEncryption: no encryption key found — set PLUGIN_ENCRYPTION_KEY (preferred) or JWT_SECRET/AUTH_TOKEN_SECRET',
      );
    }
    return new PluginConfigEncryption(secret);
  }

  /** Encrypt a JS object (typically a plugin config). Returns the JSON
   *  string of an envelope ready for SQLite storage. */
  encrypt(value: unknown): string {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const env: Envelope = {
      v: 1,
      ciphertext: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
    return JSON.stringify(env);
  }

  /** Decrypt and JSON-parse. Throws if the envelope is malformed, the
   *  auth tag check fails, or the JSON parse fails. */
  decrypt<T = unknown>(envelopeJson: string): T {
    let env: Envelope;
    try {
      env = JSON.parse(envelopeJson) as Envelope;
    } catch {
      throw new Error('PluginConfigEncryption.decrypt: envelope is not valid JSON');
    }
    if (!env || env.v !== 1 || !env.ciphertext || !env.iv || !env.tag) {
      throw new Error('PluginConfigEncryption.decrypt: malformed envelope');
    }
    const iv = Buffer.from(env.iv, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    const ct = Buffer.from(env.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }

  /** Convenience for callers that want to know whether a stored string
   *  looks like an envelope. Avoids brittle try/catch flows for non-secret
   *  rows (e.g. config fields that ship in plaintext for default plugins). */
  static isEnvelope(raw: string | null | undefined): boolean {
    if (!raw) return false;
    try {
      const env = JSON.parse(raw);
      return env && env.v === 1 && typeof env.ciphertext === 'string' && typeof env.iv === 'string' && typeof env.tag === 'string';
    } catch {
      return false;
    }
  }
}

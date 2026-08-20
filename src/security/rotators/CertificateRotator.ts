// Certificate rotator using openssl as the primitive.
//
// What we cover here vs what we don't:
//   - We can mint a self-signed cert (operator opts in via the
//     `mode: 'self-signed'` config) — useful for internal services
//     that just need rotation without an external CA.
//   - We can produce a CSR and call back into a custom signer that the
//     operator wires up (`mode: 'csr'` + `signCsr` callback). This is
//     the path for real CAs (internal PKI, Let's Encrypt via the ACME
//     client of your choice, AWS ACM, etc.).
//
// What we deliberately don't do:
//   - Talk to a CA directly. Each CA has its own protocol (ACME, EJBCA,
//     CloudFlare, …) and integrating any of them is a per-deployment
//     decision. The `signCsr` hook is the seam.
//   - Rotate the matching private key without explicit consent. By
//     default a fresh keypair is generated each rotation — set
//     `reusePrivateKey: true` to preserve the existing key (rare, but
//     occasionally required for pinned-key clients).
//
// The vault stores a JSON envelope holding both the PEM cert and the
// PEM key under one secret. resolveSecret returns the JSON string;
// callers parse it. (Storing the key alongside the cert is the
// convention for vault-backed certs; operators with a hardware-key
// requirement should not use this rotator.)

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../../observability/Logger.js';
import type { Rotator, RotationResult } from '../CredentialRotationManager.js';
import type { CredentialRecordMeta } from '../CredentialVault.js';

const log = createLogger({ component: 'rotator-cert' });

export interface CertificateBundle {
  certPem: string;
  keyPem: string;
  /** Convenience: full chain when an external signer returns one. */
  chainPem?: string;
  /** The mode used to produce this bundle (audit trail). */
  mode: 'self-signed' | 'csr';
}

export interface CertificateRotatorConfig {
  /** 'self-signed' for in-house certs; 'csr' to delegate signing. */
  mode: 'self-signed' | 'csr';
  /** Subject Common Name (must be set; this is the cert identity). */
  commonName: string;
  /** Subject Alternative Names (DNS:foo, IP:1.2.3.4). Optional but
   *  almost always wanted for TLS. */
  subjectAltNames?: string[];
  /** Validity in days. Default 365. */
  validDays?: number;
  /** RSA key size. Default 2048. */
  rsaBits?: number;
  /** Skip generating a fresh keypair on rotation; reuse the existing
   *  one. Only honoured when the current secret already contains a
   *  parseable bundle. */
  reusePrivateKey?: boolean;
  /** Operator-supplied signer for `mode: 'csr'`. Receives the CSR PEM
   *  and is expected to return the signed cert PEM (and optionally a
   *  chain). Throw to abort rotation. */
  signCsr?: (csrPem: string, meta: CredentialRecordMeta) => Promise<{ certPem: string; chainPem?: string }>;
  /** Override the openssl binary. Default 'openssl'. */
  opensslPath?: string;
  /** Wall-clock timeout for openssl invocations. Default 30s. */
  timeoutMs?: number;
}

export class CertificateRotator {
  private readonly cfg: Required<Omit<CertificateRotatorConfig, 'subjectAltNames' | 'signCsr' | 'opensslPath'>> & {
    subjectAltNames: string[];
    signCsr?: CertificateRotatorConfig['signCsr'];
    opensslPath: string;
  };

  constructor(cfg: CertificateRotatorConfig) {
    if (!cfg.commonName) throw new Error('CertificateRotator: commonName is required');
    if (cfg.mode === 'csr' && !cfg.signCsr) {
      throw new Error('CertificateRotator: mode=csr requires a signCsr callback');
    }
    this.cfg = {
      mode: cfg.mode,
      commonName: cfg.commonName,
      subjectAltNames: cfg.subjectAltNames ?? [],
      validDays: cfg.validDays ?? 365,
      rsaBits: cfg.rsaBits ?? 2048,
      reusePrivateKey: cfg.reusePrivateKey ?? false,
      signCsr: cfg.signCsr,
      opensslPath: cfg.opensslPath ?? 'openssl',
      timeoutMs: cfg.timeoutMs ?? 30_000,
    };
  }

  rotate: Rotator = async (meta, currentSecret) => {
    const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cert-rot-'));
    try {
      const keyPath = path.join(workdir, 'key.pem');
      let keyPem: string;
      if (this.cfg.reusePrivateKey && currentSecret) {
        // Try to extract the existing key from the bundle JSON.
        try {
          const parsed = JSON.parse(currentSecret) as CertificateBundle;
          if (parsed.keyPem) {
            keyPem = parsed.keyPem;
            await fs.promises.writeFile(keyPath, keyPem, 'utf8');
          } else {
            keyPem = await this.generateKey(keyPath);
          }
        } catch {
          keyPem = await this.generateKey(keyPath);
        }
      } else {
        keyPem = await this.generateKey(keyPath);
      }

      const subj = `/CN=${this.cfg.commonName}`;
      let bundle: CertificateBundle;

      if (this.cfg.mode === 'self-signed') {
        const certPath = path.join(workdir, 'cert.pem');
        const args = [
          'req', '-x509', '-new', '-key', keyPath, '-out', certPath,
          '-days', String(this.cfg.validDays),
          '-subj', subj,
          ...(this.cfg.subjectAltNames.length > 0
            ? ['-addext', `subjectAltName=${this.cfg.subjectAltNames.join(',')}`]
            : []),
        ];
        await this.runOpenssl(args);
        const certPem = await fs.promises.readFile(certPath, 'utf8');
        bundle = { mode: 'self-signed', certPem, keyPem };
      } else {
        // CSR mode — generate the request, hand to the operator's signer.
        const csrPath = path.join(workdir, 'request.csr');
        const args = [
          'req', '-new', '-key', keyPath, '-out', csrPath,
          '-subj', subj,
          ...(this.cfg.subjectAltNames.length > 0
            ? ['-addext', `subjectAltName=${this.cfg.subjectAltNames.join(',')}`]
            : []),
        ];
        await this.runOpenssl(args);
        const csrPem = await fs.promises.readFile(csrPath, 'utf8');
        const signed = await this.cfg.signCsr!(csrPem, meta);
        if (!signed?.certPem) throw new Error('signCsr returned no certPem');
        bundle = { mode: 'csr', certPem: signed.certPem, chainPem: signed.chainPem, keyPem };
      }

      const expiresAt = new Date(Date.now() + this.cfg.validDays * 86_400_000).toISOString();
      const result: RotationResult = { secret: JSON.stringify(bundle), expiresAt };
      log.info('certificate rotated', {
        credentialId: meta.id, name: meta.name, mode: bundle.mode,
        commonName: this.cfg.commonName, validDays: this.cfg.validDays,
      });
      return result;
    } finally {
      try { await fs.promises.rm(workdir, { recursive: true, force: true }); }
      catch { /* tmpdir reaper will get it */ }
    }
  };

  // ─── helpers ─────────────────────────────────────────────────────────

  private async generateKey(keyPath: string): Promise<string> {
    await this.runOpenssl(['genrsa', '-out', keyPath, String(this.cfg.rsaBits)]);
    return fs.promises.readFile(keyPath, 'utf8');
  }

  /** Run an openssl invocation; throw with stderr on non-zero exit. */
  private runOpenssl(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.cfg.opensslPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const errChunks: Buffer[] = [];
      const t = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`openssl ${args[0]} timed out`)); }, this.cfg.timeoutMs);
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('error', (err) => { clearTimeout(t); reject(err); });
      proc.on('close', (code) => {
        clearTimeout(t);
        if (code === 0) resolve();
        else reject(new Error(`openssl ${args[0]} exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`));
      });
    });
  }
}

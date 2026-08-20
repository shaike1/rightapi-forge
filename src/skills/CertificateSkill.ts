// Certificate & SSL Management Skill

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  const stderr = (e?.stderr ?? '').toString().trim();
  const msg = stderr || e?.message || String(e);
  return encode(fail(`${action}: ${msg}`, action));
}

export class CertificateSkill {
  getSkill(): Skill {
    return {
      id: 'certificate',
      name: 'Certificate & SSL Management',
      description: 'SSL certificates, LetsEncrypt, certificate renewal, validation',
      category: 'security',
      enabled: true,
      commands: [
        { name: 'cert.check',     description: 'Check SSL certificate details',                                                                       handler: 'certCheck',    parameters: { host: 'string', port: 'number' } },
        { name: 'cert.expiry',    description: 'Check certificate expiry date',                                                                       handler: 'certExpiry',   parameters: { host: 'string', port: 'number' } },
        { name: 'cert.chain',     description: 'Get certificate chain',                                                                               handler: 'certChain',    parameters: { host: 'string', port: 'number' } },
        { name: 'cert.create',    description: 'Create self-signed certificate',                                                                       handler: 'certCreate',   parameters: { domain: 'string', days: 'number', path: 'string' } },
        { name: 'cert.install',   description: 'Validate cert/key files and return Nginx install steps (does NOT modify Nginx)',                       handler: 'certInstall',  parameters: { certPath: 'string', keyPath: 'string', domain: 'string' } },
        // certRenew is advisory: it does NOT actually renew the certificate; it
        // returns the certbot command the operator should run. Renaming the
        // skill summary clarifies this for the agent.
        { name: 'cert.renew',     description: 'Return the certbot command to renew a certificate (advisory, does NOT execute renewal)',              handler: 'certRenew',    parameters: { domain: 'string', email: 'string' } },
        { name: 'cert.list',      description: 'List installed certificates',                                                                          handler: 'certList' },
        { name: 'cert.validate',  description: 'Validate certificate file',                                                                            handler: 'certValidate', parameters: { path: 'string' } },
        { name: 'cert.convert',   description: 'Convert certificate format',                                                                           handler: 'certConvert',  parameters: { inputPath: 'string', outputPath: 'string', inputFormat: 'string', outputFormat: 'string' } },
        { name: 'cert.csr',       description: 'Generate CSR (Certificate Signing Request)',                                                           handler: 'certCSR',      parameters: { domain: 'string', path: 'string' } }
      ]
    };
  }

  async certCheck(params: { host: string; port?: number }): Promise<string> {
    if (!params?.host) return encode(fail('cert.check requires { host }'));
    const port = params.port || 443;
    try {
      const { stdout } = await execAsync(
        `echo | openssl s_client -connect ${params.host}:${port} 2>/dev/null | openssl x509 -noout -text`,
        { timeout: 15000 }
      );
      return encode(ok({ raw: stdout, host: params.host, port }, stdout.trim() ? `cert details for ${params.host}:${port}` : 'no certificate'));
    } catch (error) {
      return failure(`checking cert at ${params.host}:${port}`, error);
    }
  }

  async certExpiry(params: { host: string; port?: number }): Promise<string> {
    if (!params?.host) return encode(fail('cert.expiry requires { host }'));
    const port = params.port || 443;
    try {
      const { stdout } = await execAsync(
        `echo | openssl s_client -connect ${params.host}:${port} 2>/dev/null | openssl x509 -noout -enddate`,
        { timeout: 15000 }
      );
      const match = stdout.match(/notAfter=(.+)/);
      const notAfter = match ? match[1].trim() : null;
      return encode(ok({ raw: stdout, notAfter, host: params.host, port }, notAfter ? `expires ${notAfter}` : 'no expiry parsed'));
    } catch (error) {
      return failure(`checking expiry for ${params.host}:${port}`, error);
    }
  }

  async certChain(params: { host: string; port?: number }): Promise<string> {
    if (!params?.host) return encode(fail('cert.chain requires { host }'));
    const port = params.port || 443;
    try {
      const { stdout } = await execAsync(
        `echo | openssl s_client -showcerts -connect ${params.host}:${port} 2>/dev/null`,
        { timeout: 15000 }
      );
      return encode(ok({ raw: stdout, host: params.host, port }, 'cert chain captured'));
    } catch (error) {
      return failure(`fetching chain for ${params.host}:${port}`, error);
    }
  }

  async certCreate(params: { domain: string; days?: number; path?: string }): Promise<string> {
    if (!params?.domain) return encode(fail('cert.create requires { domain }'));
    const days = params.days || 365;
    const certPath = params.path || '/tmp';
    const keyPath = path.join(certPath, params.domain + '.key');
    const certFilePath = path.join(certPath, params.domain + '.crt');

    try {
      await execAsync(
        `openssl req -x509 -nodes -days ${days} -newkey rsa:2048 -keyout ${keyPath} -out ${certFilePath}` +
        ` -subj "/C=US/ST=State/L=City/O=Organization/CN=${params.domain}"`,
        { timeout: 15000 }
      );
      return encode(ok({ keyPath, certPath: certFilePath, domain: params.domain, days }, `created self-signed cert for ${params.domain}`));
    } catch (error) {
      return failure(`creating cert for ${params.domain}`, error);
    }
  }

  async certInstall(params: { certPath: string; keyPath: string; domain: string }): Promise<string> {
    if (!params?.certPath || !params?.keyPath || !params?.domain) {
      return encode(fail('cert.install requires { certPath, keyPath, domain }'));
    }
    if (!fs.existsSync(params.certPath)) return encode(fail(`certificate file not found: ${params.certPath}`));
    if (!fs.existsSync(params.keyPath))  return encode(fail(`key file not found: ${params.keyPath}`));

    return encode(ok({
      domain: params.domain,
      certPath: params.certPath,
      keyPath: params.keyPath,
      steps: [
        `cp ${params.certPath} /etc/ssl/certs/${params.domain}.crt`,
        `cp ${params.keyPath} /etc/ssl/private/${params.domain}.key`,
        `systemctl reload nginx`
      ],
      note: 'advisory only — this command does not modify Nginx; run the steps as root.'
    }, `nginx install steps for ${params.domain}`));
  }

  async certRenew(params: { domain: string; email?: string }): Promise<string> {
    if (!params?.domain) return encode(fail('cert.renew requires { domain }'));
    const email = params.email || 'admin@' + params.domain;
    try {
      await execAsync('which certbot');
    } catch {
      return encode(fail('certbot not installed. Install with: sudo apt install certbot python3-certbot-nginx', 'certbot missing'));
    }
    // This handler is advisory — it never actually triggers a renewal because
    // certbot must be invoked by root and the domain must already point to this
    // host with 80/443 open. The agent gets the exact command to run.
    return encode(ok({
      command: `sudo certbot certonly --nginx -d ${params.domain} --email ${email} --agree-tos --non-interactive`,
      domain: params.domain,
      email,
      preconditions: [`Domain ${params.domain} must resolve to this server`, 'Ports 80/443 must be open'],
      note: 'advisory only — this skill returns the command but does NOT execute it.'
    }, `certbot renewal command for ${params.domain} (advisory, not executed)`));
  }

  async certList(): Promise<string> {
    const locations = ['/etc/ssl/certs', '/etc/letsencrypt/live', '/etc/pki/tls/certs'];
    const findings: Array<{ location: string; certs: string[]; error: string | null }> = [];

    for (const loc of locations) {
      try {
        if (!fs.existsSync(loc)) {
          findings.push({ location: loc, certs: [], error: 'directory does not exist' });
          continue;
        }
        const files = fs.readdirSync(loc);
        const certs = files.filter(f => f.endsWith('.crt') || f.endsWith('.pem')).slice(0, 50);
        findings.push({ location: loc, certs, error: null });
      } catch (e: any) {
        // Don't swallow silently — distinguish permission/IO failures from
        // empty directories so the agent can act.
        findings.push({ location: loc, certs: [], error: e?.message || 'unreadable' });
      }
    }

    const total = findings.reduce((sum, f) => sum + f.certs.length, 0);
    return encode(ok({ findings, total }, `${total} certificate file(s) found across ${findings.length} location(s)`));
  }

  async certValidate(params: { path: string }): Promise<string> {
    if (!params?.path) return encode(fail('cert.validate requires { path }'));
    if (!fs.existsSync(params.path)) return encode(fail(`file not found: ${params.path}`));
    try {
      const { stdout } = await execAsync(`openssl x509 -in ${params.path} -noout -text`);
      return encode(ok({ valid: true, raw: stdout }, `valid certificate at ${params.path}`));
    } catch (error) {
      return encode(fail(`invalid certificate at ${params.path}: ${(error as Error).message}`, 'invalid'));
    }
  }

  async certConvert(params: { inputPath: string; outputPath: string; inputFormat: string; outputFormat: string }): Promise<string> {
    if (!params?.inputPath || !params?.outputPath || !params?.inputFormat || !params?.outputFormat) {
      return encode(fail('cert.convert requires { inputPath, outputPath, inputFormat, outputFormat }'));
    }
    if (!fs.existsSync(params.inputPath)) return encode(fail(`input file not found: ${params.inputPath}`));

    let cmd = 'openssl ';
    if (params.inputFormat === 'pem' && params.outputFormat === 'der') {
      cmd += `x509 -in ${params.inputPath} -outform DER -out ${params.outputPath}`;
    } else if (params.inputFormat === 'der' && params.outputFormat === 'pem') {
      cmd += `x509 -in ${params.inputPath} -outform PEM -out ${params.outputPath}`;
    } else if (params.inputFormat === 'pem' && params.outputFormat === 'pfx') {
      cmd += `pkcs12 -export -out ${params.outputPath} -in ${params.inputPath} -password pass:changeit`;
    } else {
      return encode(fail(`unsupported conversion: ${params.inputFormat} → ${params.outputFormat}. Supported: pem→der, der→pem, pem→pfx`));
    }

    try {
      await execAsync(cmd);
      return encode(ok({ inputPath: params.inputPath, outputPath: params.outputPath }, `converted ${params.inputFormat} → ${params.outputFormat}`));
    } catch (error) {
      return failure('converting certificate', error);
    }
  }

  async certCSR(params: { domain: string; path?: string }): Promise<string> {
    if (!params?.domain) return encode(fail('cert.csr requires { domain }'));
    const csrPath = params.path || '/tmp';
    const csrFilePath = path.join(csrPath, params.domain + '.csr');
    const keyFilePath = path.join(csrPath, params.domain + '.key');

    try {
      await execAsync(
        `openssl req -new -newkey rsa:2048 -nodes -keyout ${keyFilePath} -out ${csrFilePath}` +
        ` -subj "/C=US/ST=State/L=City/O=Organization/CN=${params.domain}"`,
        { timeout: 15000 }
      );
      return encode(ok({ keyPath: keyFilePath, csrPath: csrFilePath, domain: params.domain }, `CSR generated for ${params.domain}`));
    } catch (error) {
      return failure(`generating CSR for ${params.domain}`, error);
    }
  }
}

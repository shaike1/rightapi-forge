// Network Diagnostics Skill

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  const stderr = (e?.stderr ?? '').toString().trim();
  const code = e?.code ?? '';
  const msg = stderr || e?.message || String(e);
  return encode(fail(`${action}: ${msg}${code ? ` (${code})` : ''}`, action));
}

export class NetworkSkill {
  getSkill(): Skill {
    return {
      // id: 'network' previously collided with NetworkScanSkill — see audit.
      // This skill is the lower-level diagnostics wrapper; NetworkScanSkill is
      // the multi-tier scanner. They are kept as separate registrations.
      id: 'network-diag',
      name: 'Network Diagnostics',
      description: 'Network troubleshooting, DNS, SSL, connectivity tests',
      category: 'infrastructure',
      enabled: true,
      commands: [
        { name: 'network.ping',       description: 'Ping a host',                                              handler: 'networkPing',       parameters: { host: 'string', count: 'number' } },
        { name: 'network.dns',        description: 'DNS lookup',                                               handler: 'networkDns',        parameters: { host: 'string', type: 'string' } },
        { name: 'network.ssl',        description: 'Check SSL certificate',                                    handler: 'networkSSL',        parameters: { host: 'string', port: 'number' } },
        { name: 'network.ports',      description: 'Check open ports',                                         handler: 'networkPorts',      parameters: { host: 'string', portRange: 'string' } },
        // network.traceroute is provided by NetworkScanSkill (multi-tier with
        // tracepath fallback). This skill exposes it as netdiag.traceroute to
        // avoid the command-name collision flagged in the audit.
        { name: 'netdiag.traceroute', description: 'Trace route to host (raw traceroute, no fallback)',         handler: 'networkTraceroute', parameters: { host: 'string' } },
        { name: 'network.curl',       description: 'HTTP request with details',                                handler: 'networkCurl',       parameters: { url: 'string', method: 'string' } },
        { name: 'network.ifconfig',   description: 'Show network interfaces',                                  handler: 'networkIfconfig' },
        { name: 'network.netstat',    description: 'Show network connections',                                 handler: 'networkNetstat',    parameters: { type: 'string' } }
      ]
    };
  }

  async networkPing(params: { host: string; count?: number }): Promise<string> {
    if (!params?.host) return encode(fail('network.ping requires { host }'));
    const count = params.count || 4;
    try {
      const { stdout } = await execAsync(`ping -c ${count} ${params.host}`, { timeout: 10000 });
      return encode(ok({ raw: stdout, host: params.host, count }, `pinged ${params.host} ${count}x`));
    } catch (error) {
      return failure(`pinging ${params.host}`, error);
    }
  }

  async networkDns(params: { host: string; type?: string }): Promise<string> {
    if (!params?.host) return encode(fail('network.dns requires { host }'));
    const type = params.type || 'A';
    try {
      const { stdout } = await execAsync(`dig ${type} ${params.host} +short`, { timeout: 10000 });
      const records = stdout.split('\n').filter(Boolean);
      return encode(ok(
        { records, host: params.host, type },
        records.length ? `${records.length} ${type} record(s)` : `no ${type} records`
      ));
    } catch (error) {
      return failure(`DNS lookup for ${params.host}`, error);
    }
  }

  async networkSSL(params: { host: string; port?: number }): Promise<string> {
    if (!params?.host) return encode(fail('network.ssl requires { host }'));
    const port = params.port || 443;
    try {
      const { stdout } = await execAsync(
        `echo | openssl s_client -connect ${params.host}:${port} 2>/dev/null | openssl x509 -noout -dates -subject`,
        { timeout: 15000 }
      );
      return encode(ok({ raw: stdout, host: params.host, port }, stdout.trim() ? `cert info for ${params.host}:${port}` : 'no SSL certificate found'));
    } catch (error) {
      return failure(`SSL check for ${params.host}:${port}`, error);
    }
  }

  async networkPorts(params: { host: string; portRange?: string }): Promise<string> {
    if (!params?.host) return encode(fail('network.ports requires { host }'));
    const range = params.portRange || '1-1000';
    try {
      const { stdout } = await execAsync(`nc -zv -w5 ${params.host} ${range}`, { timeout: 30000 });
      return encode(ok({ raw: stdout, host: params.host, range }, `port scan ${params.host}:${range}`));
    } catch (error) {
      return failure(`port scan ${params.host}`, error);
    }
  }

  async networkTraceroute(params: { host: string }): Promise<string> {
    if (!params?.host) return encode(fail('netdiag.traceroute requires { host }'));
    try {
      const { stdout } = await execAsync(`traceroute -m 15 ${params.host}`, { timeout: 30000 });
      return encode(ok({ raw: stdout, host: params.host }, `traceroute to ${params.host}`));
    } catch (error) {
      return failure(`traceroute to ${params.host}`, error);
    }
  }

  async networkCurl(params: { url: string; method?: string }): Promise<string> {
    if (!params?.url) return encode(fail('network.curl requires { url }'));
    const method = params.method || 'GET';
    try {
      const { stdout, stderr } = await execAsync(
        `curl -s -w "\\nHTTP_CODE:%{http_code}\\nTIME:%{time_total}s" -X ${method} ${params.url}`,
        { timeout: 15000 }
      );
      return encode(ok({ stdout, stderr, url: params.url, method }, `curl ${method} ${params.url}`));
    } catch (error) {
      return failure(`curl ${method} ${params.url}`, error);
    }
  }

  async networkIfconfig(): Promise<string> {
    try {
      const { stdout } = await execAsync('ip addr show');
      return encode(ok({ raw: stdout }, 'network interfaces'));
    } catch (error) {
      return failure('listing network interfaces', error);
    }
  }

  async networkNetstat(params: { type?: string }): Promise<string> {
    const type = params?.type || 'tuln';
    try {
      const { stdout } = await execAsync(`ss -${type}`);
      return encode(ok({ raw: stdout, type }, `connections (ss -${type})`));
    } catch (error) {
      return failure(`netstat ss -${type}`, error);
    }
  }
}

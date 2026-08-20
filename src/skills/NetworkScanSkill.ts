// Network scanning and diagnostics skills

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  const stderr = (e?.stderr ?? '').toString().trim();
  const code = e?.code ?? '';
  const msg = stderr || e?.message || String(e);
  return encode(fail(`${action}: ${msg}${code ? ` (${code})` : ''}`, action));
}

export class NetworkScanSkill {
  getSkill(): Skill {
    return {
      // id: 'network' previously collided with NetworkSkill — renamed.
      id: 'network-scan',
      name: 'Network Scanner',
      description: 'Network scanning, diagnostics, and connectivity checks',
      category: 'infrastructure',
      enabled: true,
      commands: [
        { name: 'network.ping-sweep', description: 'Ping sweep a CIDR range (e.g. 192.168.1.0/24)',                handler: 'pingSweep',  parameters: { cidr: 'string' } },
        { name: 'network.port-check', description: 'Check if a TCP port is open on a host',                        handler: 'portCheck',  parameters: { host: 'string', port: 'number' } },
        { name: 'network.traceroute', description: 'Traceroute to a host (max 15 hops, with tracepath fallback)',  handler: 'traceroute', parameters: { host: 'string' } },
        { name: 'network.dns-lookup', description: 'DNS lookup for a hostname (with nslookup fallback)',           handler: 'dnsLookup',  parameters: { host: 'string' } },
        { name: 'network.open-ports', description: 'List open listening ports on the local machine',               handler: 'openPorts' },
        { name: 'network.http-check', description: 'HTTP GET health check — status, response time, body preview',   handler: 'httpCheck',  parameters: { url: 'string', timeout: 'number' } },
        { name: 'network.bandwidth',  description: 'Show current network interface stats from /proc/net/dev',       handler: 'bandwidth' }
      ]
    };
  }

  async pingSweep(params: { cidr: string }): Promise<string> {
    const { cidr } = params || ({} as any);
    if (!cidr) return encode(fail('cidr parameter is required'));
    try {
      const { stdout } = await execAsync(`nmap -sn ${cidr}`, { timeout: 30000 });
      return encode(ok({ tool: 'nmap', raw: stdout, cidr }, `nmap ping sweep ${cidr}`));
    } catch (nmapErr) {
      const match = cidr.match(/^(\d+\.\d+\.\d+)\.\d+\/24$/);
      if (!match) {
        return encode(fail(
          `nmap not available and fallback only supports /24 CIDR. nmap error: ${(nmapErr as Error).message}`,
          'cidr fallback unsupported'
        ));
      }
      const base = match[1];
      const pings = Array.from({ length: 254 }, (_, i) => i + 1).map(async (n) => {
        const host = `${base}.${n}`;
        try {
          await execAsync(`ping -c 1 -W 1 ${host}`, { timeout: 3000 });
          return host;
        } catch { return null; }
      });
      const settled = await Promise.all(pings);
      const up = settled.filter(Boolean) as string[];
      return encode(ok({ tool: 'ping-fallback', up, cidr }, `${up.length}/254 hosts up in ${cidr}`));
    }
  }

  async portCheck(params: { host: string; port: number }): Promise<string> {
    const { host, port } = params || ({} as any);
    if (!host || port == null) return encode(fail('host and port parameters are required'));
    try {
      const { stdout, stderr } = await execAsync(`nc -zv -w 3 ${host} ${port} 2>&1`, { timeout: 10000 });
      const output = (stdout + stderr).trim();
      const open = /open|succeeded|connected/i.test(output);
      return encode(ok({ tool: 'nc', open, raw: output, host, port }, `${host}:${port} ${open ? 'OPEN' : 'CLOSED'}`));
    } catch (ncErr) {
      try {
        const { stdout } = await execAsync(
          `timeout 3 bash -c "echo > /dev/tcp/${host}/${port}" && echo "open" || echo "closed"`,
          { timeout: 10000 }
        );
        const open = stdout.trim() === 'open';
        return encode(ok({ tool: 'bash-tcp', open, host, port }, `${host}:${port} ${open ? 'OPEN' : 'CLOSED'}`));
      } catch {
        return encode(fail(
          `port check failed for ${host}:${port} (nc error: ${(ncErr as Error).message})`,
          `${host}:${port} CLOSED/FILTERED`
        ));
      }
    }
  }

  async traceroute(params: { host: string }): Promise<string> {
    const { host } = params || ({} as any);
    if (!host) return encode(fail('host parameter is required'));
    try {
      const { stdout } = await execAsync(`traceroute -m 15 ${host}`, { timeout: 30000 });
      return encode(ok({ tool: 'traceroute', raw: stdout, host }, `traceroute to ${host}`));
    } catch (trErr) {
      try {
        const { stdout } = await execAsync(`tracepath -m 15 ${host}`, { timeout: 30000 });
        return encode(ok({ tool: 'tracepath', raw: stdout, host }, `tracepath to ${host}`));
      } catch {
        return failure(`traceroute to ${host}`, trErr);
      }
    }
  }

  async dnsLookup(params: { host: string }): Promise<string> {
    const { host } = params || ({} as any);
    if (!host) return encode(fail('host parameter is required'));
    try {
      const { stdout } = await execAsync(`dig +short ${host}`, { timeout: 10000 });
      const records = stdout.split('\n').filter(Boolean);
      return encode(ok({ tool: 'dig', records, host }, records.length ? `${records.length} record(s)` : 'no records'));
    } catch (digErr) {
      try {
        const { stdout } = await execAsync(`nslookup ${host}`, { timeout: 10000 });
        return encode(ok({ tool: 'nslookup', raw: stdout, host }, 'nslookup result'));
      } catch {
        return failure(`DNS lookup for ${host}`, digErr);
      }
    }
  }

  async openPorts(): Promise<string> {
    try {
      const { stdout } = await execAsync('ss -tlnp', { timeout: 10000 });
      const count = stdout.split('\n').filter(l => l.trim() && !l.startsWith('State')).length;
      return encode(ok({ raw: stdout }, `${count} listening port(s)`));
    } catch (error) {
      return failure('listing open ports', error);
    }
  }

  async httpCheck(params: { url: string; timeout?: number }): Promise<string> {
    const { url, timeout = 10000 } = params || ({} as any);
    if (!url) return encode(fail('url parameter is required'));
    const start = Date.now();
    try {
      const response = await axios.get(url, {
        timeout,
        validateStatus: () => true,
        maxRedirects: 5
      });
      const elapsed = Date.now() - start;
      const bodyPreview = String(
        typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      ).slice(0, 200);
      return encode(ok(
        { url, status: response.status, statusText: response.statusText, elapsedMs: elapsed, bodyPreview },
        `${response.status} ${response.statusText} in ${elapsed}ms`
      ));
    } catch (error) {
      const elapsed = Date.now() - start;
      return encode(fail(
        `HTTP check for ${url} after ${elapsed}ms: ${(error as Error).message}`,
        `failed in ${elapsed}ms`
      ));
    }
  }

  async bandwidth(): Promise<string> {
    try {
      const { stdout } = await execAsync('cat /proc/net/dev', { timeout: 10000 });
      const lines = stdout.trim().split('\n');
      const interfaces = lines.slice(2).map((line) => {
        const [iface, rest] = line.split(':');
        if (!rest) return null;
        const cols = rest.trim().split(/\s+/);
        return {
          name: iface.trim(),
          rxBytes: parseInt(cols[0] ?? '0', 10),
          rxPackets: parseInt(cols[1] ?? '0', 10),
          txBytes: parseInt(cols[8] ?? '0', 10),
          txPackets: parseInt(cols[9] ?? '0', 10)
        };
      }).filter(Boolean);
      return encode(ok({ interfaces }, `${interfaces.length} interface(s)`));
    } catch (error) {
      return failure('reading bandwidth stats', error);
    }
  }
}

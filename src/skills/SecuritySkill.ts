// Security management skills

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  const stderr = (e?.stderr ?? '').toString().trim();
  const msg = stderr || e?.message || String(e);
  return encode(fail(`${action}: ${msg}`, action));
}

export class SecuritySkill {
  getSkill(): Skill {
    return {
      id: 'security',
      name: 'Security Management',
      description: 'Security scanning, vulnerability assessment, and access control',
      category: 'security',
      enabled: true,
      commands: [
        { name: 'security.scan',     description: 'Run security scan on system',                     handler: 'securityScan' },
        { name: 'security.firewall', description: 'Show firewall rules',                             handler: 'securityFirewall' },
        { name: 'security.users',    description: 'List system users and last login',                handler: 'securityUsers' },
        { name: 'security.ssh',      description: 'Check SSH configuration and active sessions',     handler: 'securitySsh' },
        { name: 'security.ports',    description: 'List open ports and listening services',          handler: 'securityPorts' },
        { name: 'security.sudo',     description: 'Check sudo access and logs',                      handler: 'securitySudo' },
        { name: 'security.logins',   description: 'Show recent login history',                       handler: 'securityLogins' },
        { name: 'security.failed',   description: 'Show failed login attempts',                      handler: 'securityFailed' },
        { name: 'security.patch',    description: 'Check for available security patches',            handler: 'securityPatch' },
        { name: 'docker.scan',       description: 'Scan Docker images for vulnerabilities',          handler: 'dockerScan',     parameters: { image: 'string' } }
      ]
    };
  }

  async securityScan(): Promise<string> {
    try {
      const results = await Promise.all([
        execAsync('uptime').catch(() => ({ stdout: 'N/A' })),
        execAsync('firewall-cmd --state 2>/dev/null || ufw status 2>/dev/null || echo "No firewall detected"')
          .catch(() => ({ stdout: 'N/A' })),
        execAsync('systemctl is-active sshd').catch(() => ({ stdout: 'N/A' }))
      ]);
      return encode(ok({
        uptime: results[0].stdout.trim(),
        firewall: results[1].stdout.trim(),
        ssh: results[2].stdout.trim(),
      }, 'security scan complete'));
    } catch (error) {
      return failure('running security scan', error);
    }
  }

  async securityFirewall(): Promise<string> {
    try {
      const { stdout } = await execAsync('ufw status numbered 2>/dev/null || firewall-cmd --list-all 2>/dev/null || iptables -L -n -v 2>/dev/null');
      return encode(ok({ raw: stdout }, 'firewall rules'));
    } catch (error) { return failure('getting firewall rules', error); }
  }

  async securityUsers(): Promise<string> {
    try {
      const [users, lastLogins, currentUsers] = await Promise.all([
        execAsync('cat /etc/passwd | grep -v "/nologin" | grep -v "/false" | cut -d: -f1'),
        execAsync('lastlog -b 10 | head -20'),
        execAsync('who'),
      ]);
      return encode(ok({
        users: users.stdout.split('\n').filter(Boolean),
        recentLogins: lastLogins.stdout,
        activeSessions: currentUsers.stdout || ''
      }, 'user info collected'));
    } catch (error) { return failure('getting user info', error); }
  }

  async securitySsh(): Promise<string> {
    try {
      const results = await Promise.all([
        execAsync('systemctl status sshd | grep -E "Active:|Loaded:" || service ssh status 2>&1 | head -5'),
        execAsync('ss -tunp | grep ":22" || netstat -tlnp | grep ":22"'),
        execAsync('cat /etc/ssh/sshd_config | grep -v "^#" | grep -v "^$"')
      ]);
      return encode(ok({
        status: results[0].stdout,
        listening: results[1].stdout,
        config: results[2].stdout
      }, 'SSH inspected'));
    } catch (error) { return failure('checking SSH', error); }
  }

  async securityPorts(): Promise<string> {
    try {
      const { stdout } = await execAsync('ss -tulpn || netstat -tulpn');
      return encode(ok({ raw: stdout }, 'open ports'));
    } catch (error) { return failure('listing open ports', error); }
  }

  async securitySudo(): Promise<string> {
    try {
      const [sudoCheck, sudoers] = await Promise.all([
        execAsync('sudo -l 2>&1 || echo "Sudo access check failed"'),
        execAsync('cat /etc/sudoers | grep -v "^#" | grep -v "^$" 2>/dev/null || echo "Cannot read sudoers file"')
      ]);
      return encode(ok({ access: sudoCheck.stdout, sudoers: sudoers.stdout }, 'sudo inspected'));
    } catch (error) { return failure('checking sudo', error); }
  }

  async securityLogins(): Promise<string> {
    try {
      const { stdout } = await execAsync('last -n 20');
      return encode(ok({ raw: stdout }, 'recent logins'));
    } catch (error) { return failure('getting login history', error); }
  }

  async securityFailed(): Promise<string> {
    try {
      const { stdout } = await execAsync('grep "Failed password" /var/log/auth.log 2>/dev/null | tail -20 || journalctl -u ssh -n 50 --no-pager | grep -i "failed"');
      return encode(ok({ raw: stdout, count: stdout ? stdout.split('\n').filter(Boolean).length : 0 }, stdout ? 'failed login attempts found' : 'no failed login attempts'));
    } catch (error) { return failure('checking failed logins', error); }
  }

  async securityPatch(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        'apt list --upgradable 2>/dev/null | grep -i security || yum check-update --security 2>/dev/null || echo "Package manager not supported"'
      );
      return encode(ok({ raw: stdout }, stdout && !stdout.includes('Package manager not supported') ? 'security patches available' : 'no security patches'));
    } catch (error) { return failure('checking security patches', error); }
  }

  async dockerScan(params: { image: string }): Promise<string> {
    if (!params?.image) return encode(fail('docker.scan requires { image }'));
    try {
      const { stdout } = await execAsync(`trivy image ${params.image} 2>/dev/null || echo "Trivy not installed. Install with: apt-get install trivy"`);
      return encode(ok({ raw: stdout, image: params.image }, `scanned ${params.image}`));
    } catch (error) { return failure(`scanning ${params.image}`, error); }
  }
}

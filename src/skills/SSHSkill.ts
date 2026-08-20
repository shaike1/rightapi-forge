// SSH remote execution skill

import type { Skill } from '../types/index.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { shellEscape, assertSafeIdentifier } from '../utils/shellEscape.js';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

export class SSHSkill {
  getSkill(): Skill {
    return {
      id: 'ssh',
      name: 'SSH Remote Execution',
      description: 'Execute commands on remote servers via SSH',
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'ssh.connect',
          description: 'Test SSH connection to a host',
          handler: 'sshConnect',
          parameters: { host: 'string', user: 'string', port: 'number' }
        },
        {
          name: 'ssh.exec',
          description: 'Execute command on remote server',
          handler: 'sshExec',
          parameters: { 
            host: 'string', 
            user: 'string', 
            command: 'string',
            port: 'number',
            key: 'string'
          },
        },
        {
          name: 'ssh.copy',
          description: 'Copy file to remote server via SCP',
          handler: 'sshCopy',
          parameters: { 
            source: 'string', 
            destination: 'string',
            host: 'string',
            user: 'string'
          },
        },
        {
          name: 'ssh.status',
          description: 'Get SSH service status',
          handler: 'sshStatus',
          parameters: { host: 'string', user: 'string' }
        },
        {
          name: 'ssh.keygen',
          description: 'Generate SSH key pair',
          handler: 'sshKeygen',
          parameters: { path: 'string', type: 'string', passphrase: 'string' }
        },
        {
          name: 'ssh.known_hosts',
          description: 'Manage known_hosts file',
          handler: 'sshKnownHosts',
          parameters: { host: 'string', action: 'string' }
        }
      ]
    };
  }

  async sshConnect(params: { host: string; user?: string; port?: number }): Promise<string> {
    if (!params?.host) return encode(fail('ssh.connect requires { host }'));
    const user = params.user || 'root';
    const port = params.port || 22;
    try {
      assertSafeIdentifier(params.host, 'host');
      assertSafeIdentifier(user, 'user');
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(
        `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${port} ${shellEscape(user + '@' + params.host)} 'echo ok'`,
        { timeout: 10000 }
      );
      return encode(ok({ host: params.host, user, port }, `connected to ${user}@${params.host}`));
    } catch (error) {
      return failure(`connecting to ${user}@${params.host}`, error);
    }
  }

  async sshExec(params: {
    host: string;
    user?: string;
    command: string;
    port?: number;
    key?: string;
  }): Promise<string> {
    if (!params?.host || !params?.command) {
      return encode(fail('ssh.exec requires { host, command }'));
    }
    const user = params.user || 'root';
    const port = params.port || 22;
    try {
      assertSafeIdentifier(params.host, 'host');
      assertSafeIdentifier(user, 'user');
    } catch (e) { return encode(fail((e as Error).message)); }

    const parts = ['ssh', '-o', 'ConnectTimeout=30', '-o', 'StrictHostKeyChecking=no'];
    if (port !== 22) parts.push('-p', String(port));
    if (params.key) parts.push('-i', shellEscape(params.key));
    parts.push(`${user}@${params.host}`, shellEscape(params.command));

    const sshCmd = parts.join(' ');
    try {
      const { stdout, stderr } = await execAsync(sshCmd, { timeout: 60000 });
      return encode(ok({ stdout, stderr, host: params.host, user }, `ran on ${user}@${params.host}`));
    } catch (error) {
      return failure(`exec on ${user}@${params.host}`, error);
    }
  }

  async sshCopy(params: {
    source: string;
    destination: string;
    host: string;
    user?: string;
  }): Promise<string> {
    if (!params?.source || !params?.destination || !params?.host) {
      return encode(fail('ssh.copy requires { source, destination, host }'));
    }
    const user = params.user || 'root';
    try {
      assertSafeIdentifier(params.host, 'host');
      assertSafeIdentifier(user, 'user');
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(
        `scp -o StrictHostKeyChecking=no ${shellEscape(params.source)} ${user}@${params.host}:${shellEscape(params.destination)}`,
        { timeout: 60000 }
      );
      return encode(ok({ source: params.source, destination: params.destination, host: params.host, user }, `scp ${params.source} → ${user}@${params.host}:${params.destination}`));
    } catch (error) {
      return failure(`scp to ${user}@${params.host}`, error);
    }
  }

  async sshStatus(params: { host: string; user?: string }): Promise<string> {
    // sshStatus delegates to sshExec — which now returns SkillResult JSON.
    return this.sshExec({
      host: params.host,
      user: params.user || 'root',
      command: 'systemctl status sshd 2>/dev/null || systemctl status ssh 2>/dev/null || echo "SSH service status unknown"'
    });
  }

  async sshKeygen(params: { path?: string; type?: string; passphrase?: string }): Promise<string> {
    const keyPath = params.path || '~/.ssh/id_rsa';
    const keyType = params.type || 'rsa';
    try {
      assertSafeIdentifier(keyType, 'type');
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(
        `ssh-keygen -t ${keyType} -f ${shellEscape(keyPath)} -N ${shellEscape(params.passphrase || '')} -C 'itops-agents'`,
        { timeout: 10000 }
      );
      return encode(ok({ keyPath, keyType }, `generated ${keyType} key at ${keyPath}`));
    } catch (error) {
      return failure(`generating SSH key at ${keyPath}`, error);
    }
  }

  async sshKnownHosts(params: { host: string; action?: string }): Promise<string> {
    if (!params?.host) return encode(fail('ssh.known_hosts requires { host }'));
    const action = params.action || 'add';
    try {
      assertSafeIdentifier(params.host, 'host');
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      if (action === 'add') {
        await execAsync(`ssh-keyscan -H ${shellEscape(params.host)} >> ~/.ssh/known_hosts 2>/dev/null`, { timeout: 10000 });
        return encode(ok({ host: params.host, action }, `added ${params.host}`));
      } else if (action === 'remove') {
        await execAsync(`ssh-keygen -R ${shellEscape(params.host)} -f ~/.ssh/known_hosts 2>/dev/null`, { timeout: 10000 });
        return encode(ok({ host: params.host, action }, `removed ${params.host}`));
      } else if (action === 'list') {
        const { stdout } = await execAsync('cat ~/.ssh/known_hosts');
        const lines = stdout.split('\n').filter(Boolean);
        return encode(ok({ entries: lines, count: lines.length }, `${lines.length} known host(s)`));
      }
      return encode(fail(`unknown action: ${action}`));
    } catch (error) {
      return failure(`known_hosts ${action}`, error);
    }
  }
}

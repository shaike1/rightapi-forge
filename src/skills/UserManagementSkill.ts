// User Management Skill

import type { Skill } from '../types/index.js';
import type { SkillExecutionContext } from './SkillManager.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { shellEscape } from '../utils/shellEscape.js';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  return encode(fail(`${action}: ${e?.message ?? String(e)}`, action));
}

// POSIX user/group names: letters, digits, underscore, hyphen, dot. Anything
// outside this set is a strong indicator of attempted injection (or a typo)
// and we refuse to forward it to useradd/usermod/chpasswd.
function assertPosixName(value: string, paramName: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${paramName} must be a non-empty string`);
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/.test(value)) {
    throw new Error(`${paramName} "${value}" is not a valid POSIX user/group name`);
  }
}

export class UserManagementSkill {
  getSkill(): Skill {
    return {
      id: 'users',
      name: 'User Management',
      description: 'Linux user management, groups, permissions',
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'user.list',
          description: 'List all users',
          handler: 'userList'
        },
        {
          name: 'user.info',
          description: 'Get user info',
          handler: 'userInfo',
          parameters: { username: 'string' }
        },
        {
          name: 'user.create',
          description: 'Create new user',
          handler: 'userCreate',
          parameters: { username: 'string', password: 'string', shell: 'string' }
        },
        {
          name: 'user.delete',
          description: 'Delete user',
          handler: 'userDelete',
          parameters: { username: 'string', removeHome: 'boolean' }
        },
        {
          name: 'user.password',
          description: 'Change user password',
          handler: 'userPassword',
          parameters: { username: 'string', password: 'string' }
        },
        {
          name: 'group.list',
          description: 'List all groups',
          handler: 'groupList'
        },
        {
          name: 'group.adduser',
          description: 'Add user to group',
          handler: 'groupAddUser',
          parameters: { username: 'string', group: 'string' }
        },
        {
          name: 'group.removeuser',
          description: 'Remove user from group',
          handler: 'groupRemoveUser',
          parameters: { username: 'string', group: 'string' }
        },
        {
          name: 'sudo.grant',
          description: 'Grant sudo access',
          handler: 'sudoGrant',
          parameters: { username: 'string' }
        },
        {
          name: 'sudo.revoke',
          description: 'Revoke sudo access',
          handler: 'sudoRevoke',
          parameters: { username: 'string' }
        },
        {
          name: 'sudo.check',
          description: 'Check sudo access',
          handler: 'sudoCheck',
          parameters: { username: 'string' }
        },
        {
          name: 'session.list',
          description: 'List active sessions',
          handler: 'sessionList'
        },
        {
          name: 'session.kill',
          description: 'Kill user session',
          handler: 'sessionKill',
          parameters: { username: 'string' }
        }
      ]
    };
  }

  async userList(): Promise<string> {
    try {
      const { stdout } = await execAsync('getent passwd');
      const users = stdout.split('\n')
        .filter(u => u && !u.includes('/nologin') && !u.includes('/false'))
        .map(line => {
          const [name, , uid, gid, gecos, home, shell] = line.split(':');
          return { name, uid, gid, gecos, home, shell };
        });
      return encode(ok({ users, count: users.length }, `${users.length} login user(s)`));
    } catch (error) { return failure('listing users', error); }
  }

  async userInfo(params: { username: string }): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    try {
      const { stdout } = await execAsync(`id ${params.username}`);
      return encode(ok({ raw: stdout.trim(), username: params.username }, stdout.trim()));
    } catch (error) { return failure(`getting info for ${params.username}`, error); }
  }

  async userCreate(
    params: { username: string; password?: string; shell?: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    const shell = params.shell || '/bin/bash';
    try {
      await execAsync(`useradd -m -s ${shellEscape(shell)} ${params.username}`);
      if (params.password) {
        await execAsync(`echo ${shellEscape(`${params.username}:${params.password}`)} | chpasswd`);
      }

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `created user ${params.username}`,
          rollback: { kind: 'tool', tool: 'user.delete', params: { username: params.username, removeHome: true } },
          skill: 'users',
        });
      }

      return encode(ok({ username: params.username, shell, passwordSet: !!params.password }, `created user ${params.username}`));
    } catch (error) { return failure(`creating user ${params.username}`, error); }
  }

  async userDelete(params: { username: string; removeHome?: boolean }): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    try {
      const homeFlag = params.removeHome ? '-r' : '';
      await execAsync(`userdel ${homeFlag} ${params.username}`.replace(/\s+/g, ' ').trim());
      return encode(ok({ username: params.username, removedHome: !!params.removeHome }, `deleted user ${params.username}`));
    } catch (error) { return failure(`deleting user ${params.username}`, error); }
  }

  async userPassword(params: { username: string; password: string }): Promise<string> {
    try {
      assertPosixName(params.username, 'username');
      if (typeof params.password !== 'string' || params.password.length === 0) {
        throw new Error('password must be a non-empty string');
      }
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(`echo ${shellEscape(`${params.username}:${params.password}`)} | chpasswd`);
      return encode(ok({ username: params.username }, `password updated for ${params.username}`));
    } catch (error) { return failure(`updating password for ${params.username}`, error); }
  }

  async groupList(): Promise<string> {
    try {
      const { stdout } = await execAsync('getent group');
      const groups = stdout.split('\n').filter(Boolean).map(line => {
        const [name, , gid, members] = line.split(':');
        return { name, gid, members: members ? members.split(',').filter(Boolean) : [] };
      });
      return encode(ok({ groups, count: groups.length }, `${groups.length} group(s)`));
    } catch (error) { return failure('listing groups', error); }
  }

  async groupAddUser(
    params: { username: string; group: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    try {
      assertPosixName(params.username, 'username');
      assertPosixName(params.group, 'group');
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(`usermod -aG ${params.group} ${params.username}`);

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `added ${params.username} to group ${params.group}`,
          rollback: { kind: 'tool', tool: 'group.removeuser', params: { username: params.username, group: params.group } },
          skill: 'users',
        });
      }

      return encode(ok({ username: params.username, group: params.group }, `added ${params.username} → ${params.group}`));
    } catch (error) { return failure(`adding ${params.username} to ${params.group}`, error); }
  }

  async groupRemoveUser(params: { username: string; group: string }): Promise<string> {
    try {
      assertPosixName(params.username, 'username');
      assertPosixName(params.group, 'group');
    } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(`gpasswd -d ${params.username} ${params.group}`);
      return encode(ok({ username: params.username, group: params.group }, `removed ${params.username} from ${params.group}`));
    } catch (error) { return failure(`removing ${params.username} from ${params.group}`, error); }
  }

  async sudoGrant(
    params: { username: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(`usermod -aG sudo ${params.username}`);

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `granted sudo to ${params.username}`,
          rollback: { kind: 'tool', tool: 'sudo.revoke', params: { username: params.username } },
          skill: 'users',
        });
      }

      return encode(ok({ username: params.username }, `granted sudo to ${params.username}`));
    } catch (error) { return failure(`granting sudo to ${params.username}`, error); }
  }

  async sudoRevoke(params: { username: string }): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(`deluser ${params.username} sudo`);
      return encode(ok({ username: params.username }, `revoked sudo from ${params.username}`));
    } catch (error) { return failure(`revoking sudo from ${params.username}`, error); }
  }

  async sudoCheck(params: { username: string }): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    try {
      const { stdout } = await execAsync(`groups ${params.username}`);
      const hasSudo = stdout.includes('sudo') || stdout.includes('wheel');
      return encode(ok({ username: params.username, hasSudo, raw: stdout.trim() }, hasSudo ? `${params.username} has sudo` : `${params.username} no sudo`));
    } catch (error) { return failure(`checking sudo for ${params.username}`, error); }
  }

  async sessionList(): Promise<string> {
    try {
      const { stdout } = await execAsync('who');
      const sessions = stdout.split('\n').filter(Boolean);
      return encode(ok({ sessions, count: sessions.length }, `${sessions.length} active session(s)`));
    } catch (error) { return failure('listing sessions', error); }
  }

  async sessionKill(params: { username: string }): Promise<string> {
    try { assertPosixName(params.username, 'username'); } catch (e) { return encode(fail((e as Error).message)); }
    try {
      await execAsync(`pkill -KILL -u ${params.username}`);
      return encode(ok({ username: params.username }, `killed sessions for ${params.username}`));
    } catch (error: any) {
      if (typeof error?.code === 'number' && error.code === 1) {
        return encode(ok({ username: params.username, killed: 0 }, `no sessions for ${params.username}`));
      }
      return failure(`killing sessions for ${params.username}`, error);
    }
  }
}

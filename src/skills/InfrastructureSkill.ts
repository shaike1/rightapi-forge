// Infrastructure management skills

import type { Skill } from '../types/index.js';
import type { SkillExecutionContext } from './SkillManager.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { encode, ok, fail } from './SkillResult.js';

const execAsync = promisify(exec);

function failure(action: string, e: any): string {
  const stderr = (e?.stderr ?? '').toString().trim();
  const msg = stderr || e?.message || String(e);
  return encode(fail(`${action}: ${msg}`, action));
}

export class InfrastructureSkill {
  getSkill(): Skill {
    return {
      id: 'infrastructure',
      name: 'Infrastructure Management',
      description: 'Docker, Kubernetes, server provisioning, and system administration',
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'docker.list',
          description: 'List all Docker containers',
          handler: 'dockerList'
        },
        {
          name: 'docker.stats',
          description: 'Get Docker container statistics',
          handler: 'dockerStats',
          parameters: { containerId: 'string' }
        },
        {
          name: 'docker.logs',
          description: 'Get Docker container logs',
          handler: 'dockerLogs',
          parameters: { containerId: 'string', tail: 'number' }
        },
        {
          name: 'docker.exec',
          description: 'Execute command in Docker container',
          handler: 'dockerExec',
          parameters: { containerId: 'string', command: 'string' }
        },
        {
          name: 'server.info',
          description: 'Get server system information',
          handler: 'serverInfo'
        },
        {
          name: 'server.processes',
          description: 'List running processes',
          handler: 'serverProcesses'
        },
        {
          name: 'server.disk',
          description: 'Get disk usage information',
          handler: 'serverDisk'
        },
        {
          name: 'server.memory',
          description: 'Get memory usage information',
          handler: 'serverMemory'
        },
        {
          name: 'k8s.pods',
          description: 'List Kubernetes pods',
          handler: 'k8sPods',
          parameters: { namespace: 'string' }
        },
        {
          name: 'k8s.deployments',
          description: 'List Kubernetes deployments',
          handler: 'k8sDeployments',
          parameters: { namespace: 'string' }
        },
        {
          name: 'compose.list',
          description: 'List all Docker Compose projects and their service status',
          handler: 'composeList'
        },
        {
          name: 'compose.restart',
          description: 'Restart a named Docker Compose service',
          handler: 'composeRestart',
          parameters: { service: 'string', projectDir: 'string' }
        },
        {
          name: 'compose.logs',
          description: 'Tail logs for a Docker Compose service',
          handler: 'composeLogs',
          parameters: { service: 'string', lines: 'number', projectDir: 'string' }
        },
        {
          name: 'compose.pull-restart',
          description: 'Pull latest image and restart a Docker Compose service',
          handler: 'composePullRestart',
          parameters: { service: 'string', projectDir: 'string' }
        },
        {
          name: 'compose.up',
          description: 'Bring up a Docker Compose project',
          handler: 'composeUp',
          parameters: { projectDir: 'string' }
        },
        {
          name: 'compose.down',
          description: 'Bring down a Docker Compose project',
          handler: 'composeDown',
          parameters: { projectDir: 'string' }
        }
      ]
    };
  }

  async dockerList(): Promise<string> {
    try {
      const { stdout } = await execAsync('docker ps -a --format "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}"');
      return encode(ok({ table: stdout }, `${stdout.split('\n').filter(Boolean).length - 1} container(s)`));
    } catch (error) {
      return failure('listing Docker containers', error);
    }
  }

  async dockerStats(params: { containerId?: string } = {}): Promise<string> {
    const containerId = params?.containerId;
    try {
      const cmd = containerId
        ? `docker stats ${containerId} --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"`
        : 'docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"';
      const { stdout } = await execAsync(cmd);
      return encode(ok({ table: stdout }, containerId ? `stats for ${containerId}` : 'stats for all containers'));
    } catch (error) {
      return failure('getting Docker stats', error);
    }
  }

  async dockerLogs(params: { containerId: string; tail?: number }): Promise<string> {
    const containerId = params?.containerId;
    const tail = params?.tail ?? 100;
    if (!containerId) return encode(fail('docker.logs requires { containerId }'));
    try {
      const { stdout } = await execAsync(`docker logs --tail ${tail} ${containerId}`);
      return encode(ok({ logs: stdout, tail }, `${stdout.split('\n').length} lines from ${containerId}`));
    } catch (error) {
      return failure(`getting Docker logs for ${containerId}`, error);
    }
  }

  async dockerExec(params: { containerId: string; command: string }): Promise<string> {
    const containerId = params?.containerId;
    const command = params?.command;
    if (!containerId || !command) return encode(fail('docker.exec requires { containerId, command }'));
    try {
      const { stdout } = await execAsync(`docker exec ${containerId} ${command}`);
      return encode(ok({ stdout }, `exec ${command} in ${containerId} ok`));
    } catch (error) {
      return failure(`docker exec ${command} in ${containerId}`, error);
    }
  }

  async serverInfo(): Promise<string> {
    try {
      const [uname, uptime, df] = await Promise.all([
        execAsync('uname -a'),
        execAsync('uptime'),
        execAsync('df -h | head -1')
      ]);
      return encode(ok(
        { uname: uname.stdout.trim(), uptime: uptime.stdout.trim(), diskHeader: df.stdout.trim() },
        'server info collected'
      ));
    } catch (error) {
      return failure('getting server info', error);
    }
  }

  async serverProcesses(): Promise<string> {
    try {
      const { stdout } = await execAsync('ps aux --sort=-%mem | head -20');
      return encode(ok({ table: stdout }, 'top 20 processes by memory'));
    } catch (error) {
      return failure('listing processes', error);
    }
  }

  async serverDisk(): Promise<string> {
    try {
      const { stdout } = await execAsync('df -h');
      return encode(ok({ table: stdout }, 'disk usage by filesystem'));
    } catch (error) {
      return failure('getting disk info', error);
    }
  }

  async serverMemory(): Promise<string> {
    try {
      const { stdout } = await execAsync('free -h');
      return encode(ok({ table: stdout }, 'memory usage'));
    } catch (error) {
      return failure('getting memory info', error);
    }
  }

  async k8sPods(params: { namespace?: string } = {}): Promise<string> {
    const namespace = params?.namespace || 'default';
    try {
      const { stdout } = await execAsync(`kubectl get pods -n ${namespace} -o wide`);
      return encode(ok({ table: stdout, namespace }, `pods in ${namespace}`));
    } catch (error) {
      return failure(`listing K8s pods in ${namespace}`, error);
    }
  }

  async k8sDeployments(params: { namespace?: string } = {}): Promise<string> {
    const namespace = params?.namespace || 'default';
    try {
      const { stdout } = await execAsync(`kubectl get deployments -n ${namespace}`);
      return encode(ok({ table: stdout, namespace }, `deployments in ${namespace}`));
    } catch (error) {
      return failure(`listing K8s deployments in ${namespace}`, error);
    }
  }

  async composeList(): Promise<string> {
    try {
      const { stdout } = await execAsync('docker compose ls --all');
      return encode(ok({ table: stdout }, stdout.trim() ? 'compose projects listed' : 'no compose projects found'));
    } catch (error) {
      return failure('listing compose projects', error);
    }
  }

  async composeRestart(
    params: { service: string; projectDir?: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.service) return encode(fail('compose.restart requires { service }'));
    try {
      const dir = params.projectDir || process.cwd();
      const { stdout, stderr } = await execAsync(
        `docker compose restart ${params.service}`,
        { cwd: dir, timeout: 60000 }
      );

      // Restart is self-undoable by another restart — register so an
      // operator can rerun it on rollback if needed.
      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `compose restart ${params.service}`,
          rollback: { kind: 'tool', tool: 'compose.restart', params: { service: params.service, projectDir: dir } },
          skill: 'infrastructure',
        });
      }

      return encode(ok({ stdout, stderr, service: params.service, projectDir: dir }, `restarted ${params.service}`));
    } catch (error) {
      return failure(`restarting ${params.service}`, error);
    }
  }

  async composeLogs(params: { service: string; lines?: number; projectDir?: string }): Promise<string> {
    if (!params?.service) return encode(fail('compose.logs requires { service }'));
    try {
      const dir = params.projectDir || process.cwd();
      const tail = params.lines || 50;
      const { stdout } = await execAsync(
        `docker compose logs --tail=${tail} ${params.service}`,
        { cwd: dir, timeout: 30000 }
      );
      return encode(ok({ logs: stdout, tail, service: params.service }, `${stdout.split('\n').length} lines from ${params.service}`));
    } catch (error) {
      return failure(`fetching logs for ${params.service}`, error);
    }
  }

  async composePullRestart(params: { service: string; projectDir?: string }): Promise<string> {
    if (!params?.service) return encode(fail('compose.pull-restart requires { service }'));
    try {
      const dir = params.projectDir || process.cwd();
      const { stdout: pullOut } = await execAsync(
        `docker compose pull ${params.service}`,
        { cwd: dir, timeout: 120000 }
      );
      const { stdout: upOut } = await execAsync(
        `docker compose up -d ${params.service}`,
        { cwd: dir, timeout: 60000 }
      );
      return encode(ok({ pull: pullOut, up: upOut, service: params.service }, `pull-restart ${params.service} complete`));
    } catch (error) {
      return failure(`pull-restart for ${params.service}`, error);
    }
  }

  async composeUp(
    params: { projectDir: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.projectDir) return encode(fail('compose.up requires { projectDir }'));
    try {
      const { stdout, stderr } = await execAsync(
        'docker compose up -d',
        { cwd: params.projectDir, timeout: 120000 }
      );

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `compose up ${params.projectDir}`,
          rollback: { kind: 'tool', tool: 'compose.down', params: { projectDir: params.projectDir } },
          skill: 'infrastructure',
        });
      }

      return encode(ok({ stdout, stderr, projectDir: params.projectDir }, 'compose project started'));
    } catch (error) {
      return failure('running compose up', error);
    }
  }

  async composeDown(
    params: { projectDir: string },
    ctx?: SkillExecutionContext
  ): Promise<string> {
    if (!params?.projectDir) return encode(fail('compose.down requires { projectDir }'));
    try {
      const { stdout, stderr } = await execAsync(
        'docker compose down',
        { cwd: params.projectDir, timeout: 60000 }
      );

      if (ctx?.registerRollback && ctx.callerAgentId && ctx.taskId) {
        ctx.registerRollback({
          agentId: ctx.callerAgentId,
          taskId: ctx.taskId,
          action: `compose down ${params.projectDir}`,
          rollback: { kind: 'tool', tool: 'compose.up', params: { projectDir: params.projectDir } },
          skill: 'infrastructure',
        });
      }

      return encode(ok({ stdout, stderr, projectDir: params.projectDir }, 'compose project stopped'));
    } catch (error) {
      return failure('running compose down', error);
    }
  }
}

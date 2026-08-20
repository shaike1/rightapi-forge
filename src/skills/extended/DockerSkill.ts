import { exec } from 'child_process';
import { promisify } from 'util';
import type { Skill } from '../../types/index.js';
import { shellEscape, assertSafeIdentifier } from '../../utils/shellEscape.js';
import { encode, ok, fail } from '../SkillResult.js';

const execAsync = promisify(exec);

export interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  data?: any;
}

interface DockerParams {
  all?: boolean;
  container?: string;
  cmd?: string;
  image?: string;
  tail?: number;
  force?: boolean;
}

// Docker Management Skill — per-command handler methods + legacy execute() shim
// for the REST router in src/web/extendedSkillsApi.ts.
export class DockerSkill {
  id = 'docker-mgmt';
  name = 'Docker Management';
  description = 'Manage Docker containers, images, networks, and volumes';
  category = 'infrastructure';
  version = '1.0.0';

  getSkill(): Skill {
    return {
      id: 'docker-mgmt',
      name: this.name,
      description: this.description,
      category: 'infrastructure',
      enabled: true,
      commands: [
        { name: 'docker.mgmt.listContainers', description: 'List Docker containers (running by default; pass {all:true} for all).', handler: 'listContainers', parameters: { all: 'boolean?' } },
        { name: 'docker.mgmt.listImages',     description: 'List Docker images.',                                                  handler: 'listImages' },
        { name: 'docker.mgmt.inspect',        description: 'Inspect a container.',                                                 handler: 'inspect',        parameters: { container: 'string' } },
        { name: 'docker.mgmt.logs',           description: 'Fetch the last {tail} lines of container logs (default 100).',         handler: 'logs',           parameters: { container: 'string', tail: 'number?' } },
        { name: 'docker.mgmt.start',          description: 'Start a stopped container.',                                           handler: 'start',          parameters: { container: 'string' } },
        { name: 'docker.mgmt.stop',           description: 'Stop a running container.',                                            handler: 'stop',           parameters: { container: 'string' } },
        { name: 'docker.mgmt.restart',        description: 'Restart a container.',                                                 handler: 'restart',        parameters: { container: 'string' } },
        { name: 'docker.mgmt.stats',          description: 'One-shot resource stats for all containers.',                          handler: 'stats' },
        { name: 'docker.mgmt.exec',           description: 'Run a command inside a container.',                                    handler: 'execIn',         parameters: { container: 'string', cmd: 'string' } },
        { name: 'docker.mgmt.pull',           description: 'Pull an image.',                                                       handler: 'pull',           parameters: { image: 'string' } },
        { name: 'docker.mgmt.rm',             description: 'Remove a container (pass {force:true} to force).',                     handler: 'rm',             parameters: { container: 'string', force: 'boolean?' } },
        { name: 'docker.mgmt.prune',          description: 'Run docker system prune -f.',                                          handler: 'prune' },
      ],
    };
  }

  // ─── Per-command handlers ────────────────────────────────────────────────

  async listContainers(params: DockerParams = {}): Promise<string> { return resultToString(await this._listContainers(params)); }
  async listImages():                                Promise<string> { return resultToString(await this._listImages()); }
  async inspect(params: DockerParams = {}):          Promise<string> { return resultToString(await this._inspect(params)); }
  async logs(params: DockerParams = {}):             Promise<string> { return resultToString(await this._logs(params)); }
  async start(params: DockerParams = {}):            Promise<string> { return resultToString(await this._start(params)); }
  async stop(params: DockerParams = {}):             Promise<string> { return resultToString(await this._stop(params)); }
  async restart(params: DockerParams = {}):          Promise<string> { return resultToString(await this._restart(params)); }
  async stats():                                     Promise<string> { return resultToString(await this._stats()); }
  async execIn(params: DockerParams = {}):           Promise<string> { return resultToString(await this._exec(params)); }
  async pull(params: DockerParams = {}):             Promise<string> { return resultToString(await this._pull(params)); }
  async rm(params: DockerParams = {}):               Promise<string> { return resultToString(await this._rm(params)); }
  async prune():                                     Promise<string> { return resultToString(await this._prune()); }

  // ─── Legacy REST entry point ─────────────────────────────────────────────

  async execute(action: string, params: any = {}): Promise<SkillResult> {
    try {
      await execAsync('which docker');
    } catch {
      return { success: false, output: 'docker not installed', error: 'Missing docker' };
    }

    try {
      switch (action) {
        case 'list-containers': return await this._listContainers(params);
        case 'list-images':     return await this._listImages();
        case 'inspect':         return await this._inspect(params);
        case 'logs':            return await this._logs(params);
        case 'start':           return await this._start(params);
        case 'stop':            return await this._stop(params);
        case 'restart':         return await this._restart(params);
        case 'stats':           return await this._stats();
        case 'exec':            return await this._exec(params);
        case 'pull':            return await this._pull(params);
        case 'rm':              return await this._rm(params);
        case 'prune':           return await this._prune();
        default:
          return { success: false, output: 'Unknown action: ' + action, error: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, output: String(error), error: error.message };
    }
  }

  // ─── Private implementation ──────────────────────────────────────────────

  private async _listContainers(p: DockerParams): Promise<SkillResult> {
    try {
      const all = p.all ? '-a' : '';
      const r = await execAsync(`docker ps ${all} --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _listImages(): Promise<SkillResult> {
    try {
      const r = await execAsync('docker images --format "table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"');
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _inspect(p: DockerParams): Promise<SkillResult> {
    if (!p.container) return { success: false, output: 'container required', error: 'Missing container' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`docker inspect ${p.container}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _logs(p: DockerParams): Promise<SkillResult> {
    if (!p.container) return { success: false, output: 'container required', error: 'Missing container' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    const tail = p.tail || 100;
    try {
      const r = await execAsync(`docker logs ${p.container} --tail ${tail}`);
      return { success: true, output: r.stdout.trim() + r.stderr.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _start(p: DockerParams): Promise<SkillResult> {
    if (!p.container) return { success: false, output: 'container required', error: 'Missing container' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`docker start ${p.container}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _stop(p: DockerParams): Promise<SkillResult> {
    if (!p.container) return { success: false, output: 'container required', error: 'Missing container' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`docker stop ${p.container}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _restart(p: DockerParams): Promise<SkillResult> {
    if (!p.container) return { success: false, output: 'container required', error: 'Missing container' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`docker restart ${p.container}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _stats(): Promise<SkillResult> {
    try {
      const r = await execAsync('docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}"');
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _exec(p: DockerParams): Promise<SkillResult> {
    if (!p.container || !p.cmd) return { success: false, output: 'container and cmd required', error: 'Missing params' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    // p.cmd is a free-form command line — agents/operators are expected to know
    // what they're sending. We escape it into a single argument so it's
    // delivered to docker exec exactly as written, without re-interpretation
    // by the local shell.
    try {
      const r = await execAsync(`docker exec ${p.container} sh -c ${shellEscape(p.cmd)}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _pull(p: DockerParams): Promise<SkillResult> {
    if (!p.image) return { success: false, output: 'image required', error: 'Missing image' };
    try { assertSafeIdentifier(p.image, 'image'); } catch (e: any) { return validationError(e); }
    try {
      const r = await execAsync(`docker pull ${p.image}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _rm(p: DockerParams): Promise<SkillResult> {
    if (!p.container) return { success: false, output: 'container required', error: 'Missing container' };
    try { assertSafeIdentifier(p.container, 'container'); } catch (e: any) { return validationError(e); }
    const force = p.force ? '-f' : '';
    try {
      const r = await execAsync(`docker rm ${force} ${p.container}`);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
  private async _prune(): Promise<SkillResult> {
    try {
      const r = await execAsync('docker system prune -f');
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }
}

function failure(e: any): SkillResult {
  return { success: false, output: String(e?.stderr ?? e?.message ?? e), error: e?.message ?? String(e) };
}

function validationError(e: any): SkillResult {
  return { success: false, output: e?.message ?? String(e), error: e?.message ?? String(e) };
}

function resultToString(r: SkillResult): string {
  return r.success
    ? encode(ok({ output: r.output, data: r.data }, r.output ? r.output.split('\n')[0].slice(0, 80) : 'ok'))
    : encode(fail(r.error || r.output, 'docker error'));
}

import type { Skill } from '../../types/index.js';
import { encode, ok, fail } from '../SkillResult.js';
import type { ServerRegistry } from '../../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../../monitoring/RemoteExecutor.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
}

interface AwsParams {
  serverId?: string;
  region?: string;
  service: string;
  operation: string;
  args?: string[];
}

interface GcpParams {
  serverId?: string;
  component: string;
  group: string;
  operation: string;
  args?: string[];
}

export class CloudSkill {
  private servers?: Pick<ServerRegistry, 'get'>;
  private executor?: Pick<RemoteExecutor, 'executeFile'>;

  constructor(opts?: { servers?: Pick<ServerRegistry, 'get'>; executor?: Pick<RemoteExecutor, 'executeFile'> }) {
    this.servers = opts?.servers;
    this.executor = opts?.executor;
  }

  setServers(s: Pick<ServerRegistry, 'get'>): void { this.servers = s; }
  setExecutor(e: Pick<RemoteExecutor, 'executeFile'>): void { this.executor = e; }

  id = 'cloud';
  name = 'Cloud Read-Only Skills';
  description = 'Inspect AWS (ec2, rds, s3) and GCP (compute, sql, storage) resources safely.';
  category = 'infrastructure';
  version = '1.0.0';

  getSkill(): Skill {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      category: 'infrastructure',
      enabled: true,
      commands: [
        {
          name: 'cloud.aws',
          description: 'Run a read-only AWS CLI command. service: ec2|rds|s3|s3api. operation must start with describe-, list-, or get-.',
          handler: 'aws',
          parameters: { serverId: 'string?', region: 'string?', service: 'string', operation: 'string', args: 'string[]?' }
        },
        {
          name: 'cloud.gcp',
          description: 'Run a read-only gcloud command. component: compute|sql|storage. group: instances|operations|buckets. operation: list|describe.',
          handler: 'gcp',
          parameters: { serverId: 'string?', component: 'string', group: 'string', operation: 'string', args: 'string[]?' }
        },
      ],
    };
  }

  private async execArgv(serverId: string | undefined, file: string, argv: string[]): Promise<SkillResult> {
    if (serverId) {
      if (!this.servers || !this.executor) return { success: false, output: 'remote host execution is not configured', error: 'unconfigured' };
      const server = this.servers.get(serverId);
      if (!server) return { success: false, output: `unknown server: ${serverId}`, error: 'unknown_server' };
      try {
        const res = await this.executor.executeFile(server, file, argv, { timeoutMs: 30000 });
        if (res.exitCode !== 0) return { success: false, output: res.stderr || res.stdout || `exit ${res.exitCode}`, error: `exit ${res.exitCode}` };
        return { success: true, output: res.stdout.trim() };
      } catch (e: any) {
        return { success: false, output: String(e?.message ?? e), error: e?.message ?? String(e) };
      }
    }

    try {
      const { stdout } = await execFileAsync(file, argv, { timeout: 30000 });
      return { success: true, output: stdout.trim() };
    } catch (e: any) {
      return { success: false, output: String(e?.stderr ?? e?.message ?? e), error: e?.message ?? String(e) };
    }
  }

  async aws(params: AwsParams): Promise<string> {
    if (!params?.service || !params?.operation) return encode(fail('cloud.aws requires { service, operation }'));

    const allowedServices = new Set(['ec2', 'rds', 's3', 's3api']);
    if (!allowedServices.has(params.service)) {
      return encode(fail(`service must be one of: ${Array.from(allowedServices).join(', ')}`));
    }

    if (!/^(describe|list|get)-[a-z0-9-]+$/.test(params.operation)) {
      return encode(fail('operation must be a read-only command starting with describe-, list-, or get-'));
    }

    const argv = [params.service, params.operation];
    if (params.region) {
      if (!/^[a-z0-9-]+$/.test(params.region)) return encode(fail('invalid region format'));
      argv.push('--region', params.region);
    }

    if (params.args && Array.isArray(params.args)) {
      for (const arg of params.args) {
        if (typeof arg !== 'string') return encode(fail('args must be strings'));
        argv.push(arg);
      }
    }
    argv.push('--output', 'json');

    const r = await this.execArgv(params.serverId, 'aws', argv);
    return r.success
      ? encode(ok({ output: r.output }, `aws ${params.service} ${params.operation} ok`))
      : encode(fail(r.error || r.output, 'aws error'));
  }

  async gcp(params: GcpParams): Promise<string> {
    if (!params?.component || !params?.group || !params?.operation) return encode(fail('cloud.gcp requires { component, group, operation }'));

    const allowedComponents = new Set(['compute', 'sql', 'storage']);
    if (!allowedComponents.has(params.component)) {
      return encode(fail(`component must be one of: ${Array.from(allowedComponents).join(', ')}`));
    }

    const allowedGroups = new Set(['instances', 'operations', 'buckets']);
    if (!allowedGroups.has(params.group)) {
      return encode(fail(`group must be one of: ${Array.from(allowedGroups).join(', ')}`));
    }

    if (!/^(list|describe)$/.test(params.operation)) {
      return encode(fail('operation must be list or describe'));
    }

    const argv = [params.component, params.group, params.operation];
    if (params.args && Array.isArray(params.args)) {
      for (const arg of params.args) {
        if (typeof arg !== 'string') return encode(fail('args must be strings'));
        argv.push(arg);
      }
    }
    argv.push('--format', 'json');

    const r = await this.execArgv(params.serverId, 'gcloud', argv);
    return r.success
      ? encode(ok({ output: r.output }, `gcloud ${params.component} ${params.group} ${params.operation} ok`))
      : encode(fail(r.error || r.output, 'gcp error'));
  }
}

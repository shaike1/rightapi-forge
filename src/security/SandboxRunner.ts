import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SandboxLaunchSpec } from './ToolingPolicy.js';

const execFileAsync = promisify(execFile);

export interface SandboxExecutionParams {
  launchSpec: SandboxLaunchSpec;
  payloadB64: string;
  timeoutMs: number;
}

export interface SandboxExecutionResult {
  ok: boolean;
  result: string;
  sandboxId: string;
  runner: 'docker_exec' | 'host_exec';
}

function parseVolume(vol: string): string[] {
  const parts = vol.split(':');
  if (parts.length < 2) return [];
  const hostPath = parts[0];
  const containerPath = parts.length >= 3 ? parts[1] : hostPath;
  const mode = parts.length >= 3 ? parts[2] : parts[1];
  return ['-v', `${hostPath}:${containerPath}:${mode}`];
}

export class SandboxRunner {
  private defaultImage: string;

  constructor(defaultImage: string) {
    this.defaultImage = defaultImage;
  }

  async execute(params: SandboxExecutionParams): Promise<SandboxExecutionResult> {
    const sandboxId = `sbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (params.launchSpec.runner === 'host_exec') {
      return this.executeHost(sandboxId, params);
    }
    return this.executeDocker(sandboxId, params);
  }

  private async executeHost(
    sandboxId: string,
    params: SandboxExecutionParams
  ): Promise<SandboxExecutionResult> {
    const { stdout } = await execFileAsync(
      'node',
      ['dist/security/SandboxWorker.js'],
      {
        env: { ...process.env, SANDBOX_PAYLOAD_B64: params.payloadB64 },
        timeout: params.timeoutMs,
        maxBuffer: 1024 * 1024 * 4
      }
    );
    return this.parseWorkerOutput(stdout, sandboxId, 'host_exec');
  }

  private async executeDocker(
    sandboxId: string,
    params: SandboxExecutionParams
  ): Promise<SandboxExecutionResult> {
    const launch = params.launchSpec;
    const image = launch.image || this.defaultImage;
    const args: string[] = [
      'run',
      '--rm',
      '--name',
      sandboxId
    ];

    if (launch.readOnlyRootFs) {
      args.push('--read-only');
    }
    if (launch.user) {
      args.push('--user', launch.user);
    }
    if (launch.noNewPrivileges) {
      args.push('--security-opt', 'no-new-privileges');
    }
    for (const cap of launch.dropCapabilities || []) {
      args.push('--cap-drop', cap);
    }
    if (launch.network === 'none') {
      args.push('--network', 'none');
    }

    for (const volume of launch.allowedVolumes || []) {
      args.push(...parseVolume(volume));
    }

    args.push(
      '-e',
      `SANDBOX_PAYLOAD_B64=${params.payloadB64}`,
      image,
      'node',
      'dist/security/SandboxWorker.js'
    );

    const { stdout } = await execFileAsync('docker', args, {
      timeout: params.timeoutMs,
      maxBuffer: 1024 * 1024 * 4
    });
    return this.parseWorkerOutput(stdout, sandboxId, 'docker_exec');
  }

  private parseWorkerOutput(
    stdout: string,
    sandboxId: string,
    runner: 'docker_exec' | 'host_exec'
  ): SandboxExecutionResult {
    const text = (stdout || '').trim();
    if (!text) {
      throw new Error('Sandbox worker returned empty output');
    }
    let parsed: { ok: boolean; result?: string; error?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Invalid sandbox worker response: ${text.slice(0, 300)}`);
    }
    if (!parsed.ok) {
      throw new Error(parsed.error || 'Sandbox worker execution failed');
    }
    return {
      ok: true,
      result: parsed.result || '',
      sandboxId,
      runner
    };
  }
}

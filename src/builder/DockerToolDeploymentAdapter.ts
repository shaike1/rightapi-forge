import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import crypto from 'node:crypto';
import type { GeneratedApplication } from './AppGenerator.js';
import type { ToolDeploymentAdapter } from './ToolReleaseManager.js';

const LABEL = 'com.itops-agents.tool';

export class DockerToolDeploymentAdapter implements ToolDeploymentAdapter {
  constructor(private docker = new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock' })) {}

  async deploy(input: { deploymentId: string; tenantId: string; projectId: string; revision: number; artifact: GeneratedApplication }) {
    const projectHash = shortHash(`${input.tenantId}:${input.projectId}`);
    const imageName = `itops-tool:${projectHash}-r${input.revision}-${shortHash(input.deploymentId)}`;
    const labels = { [LABEL]: 'true', [`${LABEL}.deployment`]: input.deploymentId, [`${LABEL}.project`]: projectHash, [`${LABEL}.tenant`]: shortHash(input.tenantId) };
    let container: Docker.Container | undefined;
    try {
      const stream = await this.docker.buildImage(artifactTar(input.artifact), { t: imageName, dockerfile: 'Dockerfile', rm: true, forcerm: true, labels });
      await followProgress(this.docker, stream);
      const network = await this.projectNetwork(projectHash, labels);
      const volume = await this.docker.createVolume({ Name: `${input.deploymentId}-data`, Labels: labels });
      const volumeName = (volume as unknown as { name?: string; Name: string }).name ?? volume.Name;
      const token = crypto.randomBytes(32).toString('base64url');
      container = await this.docker.createContainer({
        name: input.deploymentId, Image: imageName,
        Env: [`APP_AUTH_TOKEN=${token}`, 'APP_DATA_DIR=/app/data', 'PORT=3000', 'NODE_ENV=production'], Labels: labels,
        ExposedPorts: { '3000/tcp': {} },
        HostConfig: { AutoRemove: false, NetworkMode: network.id, ReadonlyRootfs: true, Memory: 512 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 192, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' }, Mounts: [{ Type: 'volume', Source: volumeName, Target: '/app/data', ReadOnly: false }] },
      });
      await container.start();
      const healthy = await this.waitForHealth(container.id);
      if (!healthy) { await container.stop({ t: 2 }).catch(() => undefined); return { healthy: false, runtimeRef: container.id, health: 'candidate health check failed', error: 'candidate did not become healthy within 45 seconds' }; }
      const active = await this.activeContainers(projectHash, container.id);
      await Promise.all(active.map(item => this.docker.getContainer(item.Id).stop({ t: 10 }).catch(() => undefined)));
      return { healthy: true, runtimeRef: container.id, health: 'candidate healthy and promoted' };
    } catch (error) {
      if (container) await container.stop({ t: 2 }).catch(() => undefined);
      return { healthy: false, runtimeRef: container?.id, health: 'deployment failed', error: error instanceof Error ? error.message : String(error) };
    }
  }

  async rollback(input: { activeRuntimeRef?: string; targetRuntimeRef: string }) {
    try {
      if (input.activeRuntimeRef && input.activeRuntimeRef !== input.targetRuntimeRef) await this.docker.getContainer(input.activeRuntimeRef).stop({ t: 5 }).catch(() => undefined);
      const target = this.docker.getContainer(input.targetRuntimeRef);
      const state = await target.inspect(); if (!state.State.Running) await target.start();
      const healthy = await this.waitForHealth(input.targetRuntimeRef);
      return healthy ? { healthy: true, health: 'rollback target healthy and promoted' } : { healthy: false, health: 'rollback target health check failed', error: 'target did not become healthy' };
    } catch (error) { return { healthy: false, health: 'rollback failed', error: error instanceof Error ? error.message : String(error) }; }
  }

  private async projectNetwork(projectHash: string, labels: Record<string, string>): Promise<Docker.Network> {
    const existing = await this.docker.listNetworks({ filters: { label: [`${LABEL}.project=${projectHash}`] } });
    if (existing[0]) return this.docker.getNetwork(existing[0].Id);
    return this.docker.createNetwork({ Name: `itops-tool-${projectHash}`, Internal: true, CheckDuplicate: true, Labels: { ...labels, [`${LABEL}.deployment`]: 'shared' }, Options: { 'com.docker.network.bridge.enable_icc': 'false' } });
  }
  private activeContainers(projectHash: string, exclude: string) { return this.docker.listContainers({ filters: { label: [`${LABEL}=true`, `${LABEL}.project=${projectHash}`] } }).then(items => items.filter(item => item.Id !== exclude)); }
  private async waitForHealth(containerId: string): Promise<boolean> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) { try { const result = await execNode(this.docker, containerId, `fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`); if (result === 0) return true; } catch { /* starting */ } await new Promise(resolve => setTimeout(resolve, 500)); }
    return false;
  }
}

function artifactTar(artifact: GeneratedApplication): NodeJS.ReadableStream { const pack = tar.pack(); for (const file of artifact.files) pack.entry({ name: file.path, mode: 0o600 }, file.content); pack.finalize(); return pack; }
function followProgress(docker: Docker, stream: NodeJS.ReadableStream): Promise<void> { return new Promise((resolve, reject) => docker.modem.followProgress(stream, (error: Error | null) => error ? reject(error) : resolve())); }
function shortHash(value: string): string { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16); }
async function execNode(docker: Docker, containerId: string, script: string): Promise<number> {
  const exec = await docker.getContainer(containerId).exec({ Cmd: ['node', '-e', script], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false }); const sink = new PassThrough(); docker.modem.demuxStream(stream, sink, sink);
  await new Promise<void>((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); });
  return (await exec.inspect()).ExitCode ?? -1;
}

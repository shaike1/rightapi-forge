import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import tar from 'tar-stream';
import type { GeneratedApplication } from './AppGenerator.js';
import type { PreviewBackend, PreviewRequest, PreviewResponse } from './PreviewRuntime.js';

const LABEL = 'com.itops-agents.preview';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

interface DockerPreviewResources {
  containerId: string;
  networkId: string;
  volumeName: string;
  imageName: string;
  appToken: string;
}

export class DockerPreviewBackend implements PreviewBackend {
  private resources = new Map<string, DockerPreviewResources>();

  constructor(private docker = new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock' })) {}

  async initialize(activeSessionIds: Set<string>): Promise<void> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL}=true`] } });
    for (const item of containers) {
      const sessionId = item.Labels?.[`${LABEL}.session`];
      if (!sessionId || !activeSessionIds.has(sessionId)) {
        await this.docker.getContainer(item.Id).remove({ force: true, v: true }).catch(() => undefined);
      }
    }
    const networks = await this.docker.listNetworks({ filters: { label: [`${LABEL}=true`] } });
    for (const network of networks) {
      const sessionId = network.Labels?.[`${LABEL}.session`];
      if (!sessionId || !activeSessionIds.has(sessionId)) await this.docker.getNetwork(network.Id).remove().catch(() => undefined);
    }
    const volumes = await this.docker.listVolumes({ filters: { label: [`${LABEL}=true`] } });
    for (const volume of volumes.Volumes ?? []) {
      const sessionId = volume.Labels?.[`${LABEL}.session`];
      if (!sessionId || !activeSessionIds.has(sessionId)) await this.docker.getVolume(volume.Name).remove({ force: true }).catch(() => undefined);
    }
    const images = await this.docker.listImages({ filters: { label: [`${LABEL}=true`] } });
    for (const image of images) {
      const sessionId = image.Labels?.[`${LABEL}.session`];
      if (!sessionId || !activeSessionIds.has(sessionId)) await this.docker.getImage(image.Id).remove({ force: true }).catch(() => undefined);
    }
  }

  async start(input: { sessionId: string; tenantId: string; artifact: GeneratedApplication; appToken: string }): Promise<void> {
    const imageName = `itops-preview:${input.sessionId}`;
    const resourceLabels = {
      [LABEL]: 'true',
      [`${LABEL}.session`]: input.sessionId,
      [`${LABEL}.tenant`]: shortHash(input.tenantId),
    };
    try {
      const buildStream = await this.docker.buildImage(artifactTar(input.artifact), {
        t: imageName, dockerfile: 'Dockerfile', rm: true, forcerm: true, labels: resourceLabels,
      });
      await followProgress(this.docker, buildStream);
    } catch (error) {
      await this.docker.getImage(imageName).remove({ force: true }).catch(() => undefined);
      throw error;
    }

    const network = await this.docker.createNetwork({
      Name: `${input.sessionId}-network`, Internal: true, CheckDuplicate: true, Labels: resourceLabels,
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    });
    const volume = await this.docker.createVolume({ Name: `${input.sessionId}-data`, Labels: resourceLabels });
    const volumeName = (volume as unknown as { name?: string; Name: string }).name ?? volume.Name;
    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer({
        name: input.sessionId,
        Image: imageName,
        Env: [`APP_AUTH_TOKEN=${input.appToken}`, 'APP_DATA_DIR=/app/data', 'PORT=3000', 'NODE_ENV=production'],
        Labels: resourceLabels,
        ExposedPorts: { '3000/tcp': {} },
        HostConfig: {
          AutoRemove: false,
          NetworkMode: network.id,
          ReadonlyRootfs: true,
          Memory: 256 * 1024 * 1024,
          NanoCpus: 500_000_000,
          PidsLimit: 128,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
          Mounts: [{ Type: 'volume', Source: volumeName, Target: '/app/data', ReadOnly: false }],
        },
      });
      this.resources.set(input.sessionId, {
        containerId: container.id, networkId: network.id, volumeName, imageName, appToken: input.appToken,
      });
      await container.start();
      await this.waitForHealth(input.sessionId);
    } catch (error) {
      if (container) await container.remove({ force: true, v: true }).catch(() => undefined);
      await network.remove().catch(() => undefined);
      await this.docker.getVolume(volumeName).remove({ force: true }).catch(() => undefined);
      await this.docker.getImage(imageName).remove({ force: true }).catch(() => undefined);
      this.resources.delete(input.sessionId);
      throw error;
    }
  }

  async request(sessionId: string, roleId: string, request: PreviewRequest): Promise<PreviewResponse> {
    const resources = this.resources.get(sessionId);
    if (!resources) throw new Error('preview resources not found');
    const safeHeaders: Record<string, string> = {
      authorization: `Bearer ${resources.appToken}`,
      'x-app-role': roleId,
    };
    for (const key of ['accept', 'content-type', 'if-none-match']) {
      const value = request.headers?.[key];
      if (value) safeHeaders[key] = value.slice(0, 1000);
    }
    const payload = Buffer.from(JSON.stringify({
      method: request.method,
      path: request.path,
      headers: safeHeaders,
      bodyBase64: request.body?.toString('base64') ?? '',
      maxBytes: MAX_RESPONSE_BYTES,
    })).toString('base64url');
    const result = await this.execNode(resources.containerId, proxyScript(), [payload]);
    const marker = 'ITOPS_PREVIEW_RESPONSE:';
    const line = result.stdout.split(/\r?\n/).find(value => value.startsWith(marker));
    if (!line) throw new Error(`preview proxy returned no response: ${result.stderr || result.stdout}`);
    const parsed = JSON.parse(Buffer.from(line.slice(marker.length), 'base64url').toString('utf8')) as {
      status: number; headers: Record<string, string>; bodyBase64: string;
    };
    return { status: parsed.status, headers: parsed.headers, body: Buffer.from(parsed.bodyBase64, 'base64') };
  }

  async logs(sessionId: string, tail: number): Promise<string> {
    const resources = this.resources.get(sessionId);
    if (!resources) return '';
    const output = await this.docker.getContainer(resources.containerId).logs({ stdout: true, stderr: true, tail, timestamps: true });
    return Buffer.isBuffer(output) ? decodeDockerLog(output).slice(-100_000) : String(output).slice(-100_000);
  }

  async stop(sessionId: string): Promise<void> {
    const resources = this.resources.get(sessionId);
    if (!resources) return;
    this.resources.delete(sessionId);
    await this.docker.getContainer(resources.containerId).remove({ force: true, v: true }).catch(() => undefined);
    await this.docker.getNetwork(resources.networkId).remove().catch(() => undefined);
    await this.docker.getVolume(resources.volumeName).remove({ force: true }).catch(() => undefined);
    await this.docker.getImage(resources.imageName).remove({ force: true }).catch(() => undefined);
  }

  private async waitForHealth(sessionId: string): Promise<void> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        const response = await this.request(sessionId, 'admin', { method: 'GET', path: '/health' });
        if (response.status === 200) return;
      } catch { /* container is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('preview did not become healthy within 45 seconds');
  }

  private async execNode(containerId: string, script: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({ Cmd: ['node', '-e', script, ...args], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough(); const stderr = new PassThrough();
    let out = ''; let err = '';
    stdout.on('data', chunk => { out += String(chunk); });
    stderr.on('data', chunk => { err += String(chunk); });
    this.docker.modem.demuxStream(stream, stdout, stderr);
    await new Promise<void>((resolve, reject) => {
      stream.on('end', resolve); stream.on('error', reject);
    });
    const inspected = await exec.inspect();
    if (inspected.ExitCode !== 0) throw new Error(`preview exec failed (${inspected.ExitCode}): ${err || out}`);
    return { stdout: out, stderr: err };
  }
}

function artifactTar(artifact: GeneratedApplication): NodeJS.ReadableStream {
  const pack = tar.pack();
  for (const file of artifact.files) pack.entry({ name: file.path, mode: 0o600 }, file.content);
  pack.finalize();
  return pack;
}

function followProgress(docker: Docker, stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error: Error | null) => error ? reject(error) : resolve());
  });
}

function shortHash(value: string): string {
  return Buffer.from(value).toString('base64url').slice(0, 40);
}

function proxyScript(): string {
  return `(async()=>{const p=JSON.parse(Buffer.from(process.argv[1],'base64url').toString());const body=p.bodyBase64?Buffer.from(p.bodyBase64,'base64'):undefined;const r=await fetch('http://127.0.0.1:3000'+p.path,{method:p.method,headers:p.headers,body});const b=Buffer.from(await r.arrayBuffer());if(b.length>p.maxBytes)throw new Error('response too large');const h={};for(const [k,v] of r.headers)if(['content-type','cache-control','etag','location'].includes(k))h[k]=v;const out={status:r.status,headers:h,bodyBase64:b.toString('base64')};console.log('ITOPS_PREVIEW_RESPONSE:'+Buffer.from(JSON.stringify(out)).toString('base64url'));})().catch(e=>{console.error(e.message);process.exit(1)})`;
}

function decodeDockerLog(buffer: Buffer): string {
  let offset = 0; let output = '';
  while (offset + 8 <= buffer.length && (buffer[offset] === 1 || buffer[offset] === 2)) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    output += buffer.subarray(offset + 8, offset + 8 + length).toString('utf8');
    offset += 8 + length;
  }
  return offset > 0 ? output : buffer.toString('utf8');
}

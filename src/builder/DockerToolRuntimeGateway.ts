import { Duplex, PassThrough } from 'node:stream';
import Docker from 'dockerode';
import type { ToolLaunchRequest, ToolLaunchResponse, ToolRuntimeGateway } from './ToolLaunchRuntime.js';

const SCRIPT = `const [method,path,headers64,body64]=process.argv.slice(1);const incoming=JSON.parse(Buffer.from(headers64,'base64url').toString());const headers={authorization:'Bearer '+process.env.APP_AUTH_TOKEN,'x-app-role':'admin',accept:incoming.accept||'*/*','content-type':incoming['content-type']||'application/json'};fetch('http://127.0.0.1:3000'+path,{method,headers,...(body64?{body:Buffer.from(body64,'base64url')}:{}),redirect:'manual',signal:AbortSignal.timeout(15000)}).then(async r=>{const body=Buffer.from(await r.arrayBuffer());if(body.length>2097152)throw Error('response too large');const allowed={};for(const k of ['content-type','etag','cache-control','location']){const v=r.headers.get(k);if(v)allowed[k]=v}process.stdout.write(JSON.stringify({status:r.status,headers:allowed,body:body.toString('base64')}),()=>process.exit(0))}).catch(e=>process.stderr.write(String(e.message||e),()=>process.exit(1)))`;

export class DockerToolRuntimeGateway implements ToolRuntimeGateway {
  constructor(private docker = new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock' })) {}
  async request(runtimeRef: string, request: ToolLaunchRequest): Promise<ToolLaunchResponse> {
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(request.method)) throw new Error('unsupported launch method');
    if (!request.path.startsWith('/') || request.path.includes('..') || request.path.includes('\\') || request.path.length > 2048) throw new Error('invalid launch path');
    if ((request.body?.length ?? 0) > 1_048_576) throw new Error('launch request body too large');
    const container = this.docker.getContainer(runtimeRef); const inspected = await container.inspect();
    if (inspected.Config.Labels?.['com.itops-agents.tool'] !== 'true' || !inspected.State.Running) throw new Error('tool runtime is not active');
    const headers = Buffer.from(JSON.stringify({ accept: request.headers.accept, 'content-type': request.headers['content-type'] })).toString('base64url');
    const body = request.body?.length ? request.body.toString('base64url') : '';
    const exec = await container.exec({ Cmd: ['node', '-e', SCRIPT, request.method, request.path, headers, body], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({ hijack: true, stdin: false }); const stdout = new PassThrough(); const stderr = new PassThrough();
    const output = collect(stdout, 3_000_000); const errorOutput = collect(stderr, 32_000); this.docker.modem.demuxStream(stream, stdout, stderr);
    await waitForDockerStream(stream, 20_000);
    const details = await exec.inspect(); const stdoutBuffer = output(); const stderrBuffer = errorOutput();
    if ((details.ExitCode ?? -1) !== 0) throw new Error(`tool runtime request failed: ${stderrBuffer.toString('utf8').slice(0, 500)}`);
    const parsed = JSON.parse(stdoutBuffer.toString('utf8')) as { status: number; headers: Record<string, string>; body: string };
    return { status: parsed.status, headers: parsed.headers, body: Buffer.from(parsed.body, 'base64') };
  }
}

function collect(stream: PassThrough, limit: number): () => Buffer {
  const chunks: Buffer[] = []; let size = 0; let failure: Error | undefined;
  stream.on('data', chunk => {
    const value = Buffer.from(chunk); size += value.length;
    if (size > limit) failure = new Error('tool runtime response exceeded proxy limit');
    else chunks.push(value);
  });
  stream.on('error', error => { failure = error; });
  return () => { if (failure) throw failure; return Buffer.concat(chunks); };
}

function waitForDockerStream(stream: Duplex, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error('tool runtime request timed out'));
    }, timeoutMs);
    const done = (error?: Error) => {
      clearTimeout(timer);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
      error ? reject(error) : resolve();
    };
    const onEnd = () => done();
    const onClose = () => done();
    const onError = (error: Error) => done(error);
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Skill } from '../../types/index.js';
import { assertSafeIdentifier } from '../../utils/shellEscape.js';
import { encode, ok, fail } from '../SkillResult.js';
import type { ServerRegistry } from '../../monitoring/ServerRegistry.js';
import type { RemoteExecutor } from '../../monitoring/RemoteExecutor.js';

const execAsync = promisify(exec);

export interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  data?: any;
}

interface K8sParams {
  serverId?: string;
  namespace?: string;
  pod?: string;
  deployment?: string;
  replicas?: number;
  tail?: number;
  timeoutSeconds?: number;
}

// Kubernetes Skill — per-command handler methods + legacy execute() shim.
export class KubernetesSkill {
  private servers?: Pick<ServerRegistry, 'get'>;
  private executor?: Pick<RemoteExecutor, 'execute'>;

  constructor(opts?: { servers?: Pick<ServerRegistry, 'get'>; executor?: Pick<RemoteExecutor, 'execute'> }) {
    this.servers = opts?.servers;
    this.executor = opts?.executor;
  }

  setServers(s: Pick<ServerRegistry, 'get'>): void { this.servers = s; }
  setExecutor(e: Pick<RemoteExecutor, 'execute'>): void { this.executor = e; }

  id = 'kubernetes';
  name = 'Kubernetes Management';
  description = 'Manage Kubernetes clusters, pods, deployments, services';
  category = 'infrastructure';
  version = '1.0.0';

  getSkill(): Skill {
    return {
      id: 'kubernetes',
      name: this.name,
      description: this.description,
      category: 'infrastructure',
      enabled: true,
      commands: [
        { name: 'k8s.getPods',        description: 'List pods in a namespace.',                              handler: 'getPods',        parameters: { serverId: 'string?', namespace: 'string?' } },
        { name: 'k8s.getDeployments', description: 'List deployments in a namespace.',                       handler: 'getDeployments', parameters: { serverId: 'string?', namespace: 'string?' } },
        { name: 'k8s.getServices',    description: 'List services in a namespace.',                          handler: 'getServices',    parameters: { serverId: 'string?', namespace: 'string?' } },
        { name: 'k8s.getNodes',       description: 'List cluster nodes.',                                    handler: 'getNodes',       parameters: { serverId: 'string?' } },
        { name: 'k8s.logs',           description: 'Last {tail} lines from a pod (default 50).',             handler: 'logs',           parameters: { serverId: 'string?', pod: 'string', namespace: 'string?', tail: 'number?' } },
        { name: 'k8s.describePod',    description: 'kubectl describe pod.',                                  handler: 'describePod',    parameters: { serverId: 'string?', pod: 'string', namespace: 'string?' } },
        { name: 'k8s.scale',          description: 'Scale a deployment to {replicas}.',                      handler: 'scale',          parameters: { serverId: 'string?', deployment: 'string', replicas: 'number', namespace: 'string?' } },
        { name: 'k8s.restart',        description: 'Roll-restart a deployment.',                             handler: 'restart',        parameters: { serverId: 'string?', deployment: 'string', namespace: 'string?' } },
        { name: 'k8s.rolloutStatus',  description: 'Watch a deployment rollout until it succeeds or times out.', handler: 'rolloutStatus', parameters: { serverId: 'string?', deployment: 'string', namespace: 'string?', timeoutSeconds: 'number?' } },
        { name: 'k8s.topPods',        description: 'kubectl top pods (requires metrics-server).',            handler: 'topPods',        parameters: { serverId: 'string?', namespace: 'string?' } },
        { name: 'k8s.topNodes',       description: 'kubectl top nodes.',                                     handler: 'topNodes',       parameters: { serverId: 'string?' } },
      ],
    };
  }

  // ─── Per-command handlers ────────────────────────────────────────────────

  async getPods(params: K8sParams = {}):        Promise<string> { return resultToString(await this._getPods(params)); }
  async getDeployments(params: K8sParams = {}): Promise<string> { return resultToString(await this._getDeployments(params)); }
  async getServices(params: K8sParams = {}):    Promise<string> { return resultToString(await this._getServices(params)); }
  async getNodes(params: K8sParams = {}):        Promise<string> { return resultToString(await this._getNodes(params)); }
  async logs(params: K8sParams = {}):           Promise<string> { return resultToString(await this._logs(params)); }
  async describePod(params: K8sParams = {}):    Promise<string> { return resultToString(await this._describePod(params)); }
  async scale(params: K8sParams = {}):          Promise<string> { return resultToString(await this._scale(params)); }
  async restart(params: K8sParams = {}):        Promise<string> { return resultToString(await this._restart(params)); }
  async rolloutStatus(params: K8sParams = {}):  Promise<string> { return resultToString(await this._rolloutStatus(params)); }
  async topPods(params: K8sParams = {}):        Promise<string> { return resultToString(await this._topPods(params)); }
  async topNodes(params: K8sParams = {}):        Promise<string> { return resultToString(await this._topNodes(params)); }

  // ─── Legacy REST entry point ─────────────────────────────────────────────

  async execute(action: string, params: any = {}): Promise<SkillResult> {
    try {
      await execAsync('which kubectl');
    } catch {
      return { success: false, output: 'kubectl not installed', error: 'Missing kubectl' };
    }

    try {
      switch (action) {
        case 'get-pods':        return await this._getPods(params);
        case 'get-deployments': return await this._getDeployments(params);
        case 'get-services':    return await this._getServices(params);
        case 'get-nodes':       return await this._getNodes(params);
        case 'logs':            return await this._logs(params);
        case 'describe-pod':    return await this._describePod(params);
        case 'scale':           return await this._scale(params);
        case 'restart':         return await this._restart(params);
        case 'rollout-status':  return await this._rolloutStatus(params);
        case 'top-pods':        return await this._topPods(params);
        case 'top-nodes':       return await this._topNodes(params);
        default:
          return { success: false, output: 'Unknown action: ' + action, error: 'Unknown action' };
      }
    } catch (error: any) {
      return { success: false, output: String(error), error: error.message };
    }
  }

  // ─── Private implementation ──────────────────────────────────────────────

  private async execK8s(p: K8sParams, cmd: string): Promise<SkillResult> {
    if (p.serverId) {
      if (!this.servers || !this.executor) return { success: false, output: 'remote host execution is not configured', error: 'unconfigured' };
      const server = this.servers.get(p.serverId);
      if (!server) return { success: false, output: `unknown server: ${p.serverId}`, error: 'unknown_server' };
      try {
        const res = await this.executor.execute(server, cmd, { timeoutMs: 30000 });
        if (res.exitCode !== 0) return { success: false, output: res.stderr || res.stdout || `exit ${res.exitCode}`, error: `exit ${res.exitCode}` };
        return { success: true, output: res.stdout.trim() };
      } catch (e: any) {
        return failure(e);
      }
    }
    
    try {
      const r = await execAsync(cmd);
      return { success: true, output: r.stdout.trim() };
    } catch (e: any) { return failure(e); }
  }

  private async _getPods(p: K8sParams): Promise<SkillResult> {
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try {
      return this.execK8s(p, `kubectl get pods -n ${ns.value} --no-headers`);
    } catch (e: any) { return failure(e); }
  }
  private async _getDeployments(p: K8sParams): Promise<SkillResult> {
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try {
      return this.execK8s(p, `kubectl get deployments -n ${ns.value} --no-headers`);
    } catch (e: any) { return failure(e); }
  }
  private async _getServices(p: K8sParams): Promise<SkillResult> {
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try {
      return this.execK8s(p, `kubectl get services -n ${ns.value} --no-headers`);
    } catch (e: any) { return failure(e); }
  }
  private async _getNodes(p: K8sParams): Promise<SkillResult> {
    return this.execK8s(p, 'kubectl get nodes --no-headers');
  }

  private async _logs(p: K8sParams): Promise<SkillResult> {
    if (!p.pod) return { success: false, output: 'pod required', error: 'Missing pod' };
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try { assertSafeIdentifier(p.pod, 'pod'); } catch (e: any) { return validationError(e); }
    const tail = p.tail || 50;
    try {
      return this.execK8s(p, `kubectl logs ${p.pod} -n ${ns.value} --tail=${tail}`);
    } catch (e: any) { return failure(e); }
  }
  private async _describePod(p: K8sParams): Promise<SkillResult> {
    if (!p.pod) return { success: false, output: 'pod required', error: 'Missing pod' };
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try { assertSafeIdentifier(p.pod, 'pod'); } catch (e: any) { return validationError(e); }
    try {
      return this.execK8s(p, `kubectl describe pod ${p.pod} -n ${ns.value}`);
    } catch (e: any) { return failure(e); }
  }
  private async _scale(p: K8sParams): Promise<SkillResult> {
    if (!p.deployment || p.replicas === undefined) {
      return { success: false, output: 'deployment and replicas required', error: 'Missing params' };
    }
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try {
      assertSafeIdentifier(p.deployment, 'deployment');
      if (typeof p.replicas !== 'number' || !Number.isFinite(p.replicas) || p.replicas < 0) {
        throw new Error('replicas must be a non-negative number');
      }
    } catch (e: any) { return validationError(e); }
    try {
      return this.execK8s(p, `kubectl scale deployment ${p.deployment} --replicas=${p.replicas} -n ${ns.value}`);
    } catch (e: any) { return failure(e); }
  }
  private async _restart(p: K8sParams): Promise<SkillResult> {
    if (!p.deployment) return { success: false, output: 'deployment required', error: 'Missing deployment' };
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try { assertSafeIdentifier(p.deployment, 'deployment'); } catch (e: any) { return validationError(e); }
    try {
      return this.execK8s(p, `kubectl rollout restart deployment/${p.deployment} -n ${ns.value}`);
    } catch (e: any) { return failure(e); }
  }
  private async _rolloutStatus(p: K8sParams): Promise<SkillResult> {
    if (!p.deployment) return { success: false, output: 'deployment required', error: 'Missing deployment' };
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try { assertSafeIdentifier(p.deployment, 'deployment'); } catch (e: any) { return validationError(e); }
    try {
      const t = typeof p.timeoutSeconds === 'number' && p.timeoutSeconds > 0 ? p.timeoutSeconds : 120;
      const deadline = Date.now() + t * 1000;
      const cmd = `kubectl rollout status deployment/${p.deployment} -n ${ns.value} --timeout=15s`;
      let last = '';
      while (Date.now() < deadline) {
        const r = await this.execK8s(p, cmd);
        last = r.output || last;
        if (r.success && /successfully rolled out/i.test(last)) return { success: true, output: last };
        if (!r.success && !/timeout|error wait/i.test(r.error || '')) return r;
      }
      return { success: false, output: last, error: `rollout timed out after ${t}s` };
    } catch (e: any) { return failure(e); }
  }
  private async _topPods(p: K8sParams): Promise<SkillResult> {
    const ns = resolveNs(p);
    if (!ns.ok) return ns.err;
    try {
      return this.execK8s(p, `kubectl top pods -n ${ns.value}`);
    } catch (e: any) { return failure(e); }
  }
  private async _topNodes(p: K8sParams): Promise<SkillResult> {
    return this.execK8s(p, 'kubectl top nodes');
  }
}

type NsResult = { ok: true; value: string } | { ok: false; err: SkillResult };

function resolveNs(p: K8sParams): NsResult {
  const ns = p.namespace || 'default';
  try {
    assertSafeIdentifier(ns, 'namespace');
    return { ok: true, value: ns };
  } catch (e: any) {
    return { ok: false, err: validationError(e) };
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
    : encode(fail(r.error || r.output, 'k8s error'));
}

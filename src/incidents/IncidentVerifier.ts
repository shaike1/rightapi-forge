import type { SkillManager } from '../skills/SkillManager.js';
import type { RemoteExecutor } from '../monitoring/RemoteExecutor.js';
import type { ServerRegistry } from '../monitoring/ServerRegistry.js';
import type { Incident } from '../persistence/SqliteStore.js';
import type { IncidentVerifier, IncidentVerificationResult } from './IncidentManager.js';
import { serviceCandidates } from '../monitoring/ServiceAliases.js';

export { serviceCandidates } from '../monitoring/ServiceAliases.js';

type Metric = 'disk' | 'memory' | 'cpu' | 'load1' | 'load5';
type ContainerCondition = 'unhealthy' | 'restartloop' | 'exited';
type KubernetesTarget =
  | { kind: 'pod'; condition: 'unhealthy' | 'crashloop' | 'notready'; namespace: string; name: string }
  | { kind: 'deployment'; condition: 'unavailable' | 'degraded' | 'rollout'; namespace: string; name: string };

export interface IncidentVerifierDeps {
  skillManager: Pick<SkillManager, 'execute'>;
  getServerRegistry?: () => Pick<ServerRegistry, 'get'> | undefined;
  getRemoteExecutor?: () => (Pick<RemoteExecutor, 'execute'> & Partial<Pick<RemoteExecutor, 'executeFile'>>) | undefined;
}

export function serviceFromIncident(inc: Pick<Incident, 'sourceRef' | 'title'>): string | null {
  const refMatch = (inc.sourceRef || '').match(/(?:^|:)service:failed:([a-zA-Z0-9_.@-]+)/i);
  const titleMatch = inc.title.match(/service down:\s*([a-zA-Z0-9_.@-]+)/i);
  return refMatch?.[1] || titleMatch?.[1] || null;
}

export function containerFromIncident(inc: Pick<Incident, 'sourceRef'>): { condition: ContainerCondition; name: string } | null {
  const match = (inc.sourceRef || '').match(/(?:^|:)container:(unhealthy|restartloop|exited):([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})(?::|$)/i);
  return match ? { condition: match[1].toLowerCase() as ContainerCondition, name: match[2] } : null;
}

export function kubernetesTargetFromIncident(inc: Pick<Incident, 'sourceRef'>): KubernetesTarget | null {
  const match = (inc.sourceRef || '').match(
    /^(?:k8s|kubernetes):(pod|deployment):(unhealthy|crashloop|notready|unavailable|degraded|rollout):([^:]+):([^:]+)$/i,
  );
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const condition = match[2].toLowerCase();
  const namespace = match[3];
  const name = match[4];
  const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const dnsSubdomain = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
  if (!dnsLabel.test(namespace) || !dnsSubdomain.test(name)) return null;
  if (kind === 'pod' && ['unhealthy', 'crashloop', 'notready'].includes(condition)) {
    return { kind: 'pod', condition: condition as 'unhealthy' | 'crashloop' | 'notready', namespace, name };
  }
  if (kind === 'deployment' && ['unavailable', 'degraded', 'rollout'].includes(condition)) {
    return { kind: 'deployment', condition: condition as 'unavailable' | 'degraded' | 'rollout', namespace, name };
  }
  return null;
}

export function networkTargetFromIncident(inc: Pick<Incident, 'sourceRef'>): string | null {
  const match = (inc.sourceRef || '').match(/^network:unreachable:([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252})$/i);
  return match?.[1] || null;
}

export function endpointFromIncident(inc: Pick<Incident, 'sourceRef'>): { kind: 'port'; host: string; port: number } | { kind: 'http'; url: string } | null {
  const ref = inc.sourceRef || '';
  const portMatch = ref.match(/^port:(?:failed|unreachable):([a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}):(\d{1,5})$/i);
  if (portMatch) {
    const port = Number(portMatch[2]);
    return port >= 1 && port <= 65535 ? { kind: 'port', host: portMatch[1], port } : null;
  }
  const httpMatch = ref.match(/^http:(?:failed|unhealthy):(.+)$/i);
  if (!httpMatch) return null;
  try {
    const url = decodeURIComponent(httpMatch[1]);
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? { kind: 'http', url: parsed.toString() } : null;
  } catch { return null; }
}

export function metricFromIncident(inc: Pick<Incident, 'sourceRef' | 'title'>): Metric | null {
  const ref = (inc.sourceRef || '').toLowerCase();
  const title = inc.title.toLowerCase();
  if (ref.includes('disk') || /disk\s*(full|critical|usage|anomaly)/.test(title)) return 'disk';
  if (ref.includes('memory') || /memory\s*(critical|high|usage|anomaly)/.test(title)) return 'memory';
  if (ref.includes('load5') || /load avg 5m|load5/.test(title)) return 'load5';
  if (ref.includes('load1') || /load avg 1m|load1/.test(title)) return 'load1';
  if (ref.includes('cpu') || /cpu\s*(overload|anomaly|usage|breach)/.test(title)) return 'cpu';
  return null;
}

function parseMetric(text: string, metric: Metric): number {
  const values = Object.fromEntries(
    [...text.matchAll(/(cpu|load1|load5|memory|disk)=(\d+)/g)].map(m => [m[1], Number(m[2])]),
  );
  return values[metric];
}

async function verifyRemoteMetric(
  inc: Incident,
  deps: IncidentVerifierDeps,
): Promise<IncidentVerificationResult | null> {
  const metric = metricFromIncident(inc);
  const serverId = inc.serverId ?? null;
  const registry = deps.getServerRegistry?.();
  const executor = deps.getRemoteExecutor?.();
  if (!serverId || !registry || !executor || !metric) return null;

  const server = registry.get(serverId);
  if (!server) return { ok: false, details: `server not found: ${serverId}` };

  const cmd = [
    "cores=$(nproc 2>/dev/null || echo 1)",
    "load=$(cat /proc/loadavg)",
    "load1=$(echo \"$load\" | awk '{print $1}')",
    "load5=$(echo \"$load\" | awk '{print $2}')",
    "cpu_pct=$(awk -v l=\"$load1\" -v c=\"$cores\" 'BEGIN{printf \"%.0f\", (l/c)*100}')",
    "load1_pct=$cpu_pct",
    "load5_pct=$(awk -v l=\"$load5\" -v c=\"$cores\" 'BEGIN{printf \"%.0f\", (l/c)*100}')",
    "mem_pct=$(awk '/MemTotal/{t=$2}/MemAvailable/{a=$2} END{if(t>0) printf \"%.0f\", ((t-a)/t)*100; else print 0}' /proc/meminfo)",
    "disk_pct=$(df -P / /data /tmp 2>/dev/null | awk 'NR>1{gsub(/%/,\"\",$5); if($5>m)m=$5} END{print m+0}')",
    "printf 'cpu=%s load1=%s load5=%s memory=%s disk=%s\\n' \"$cpu_pct\" \"$load1_pct\" \"$load5_pct\" \"$mem_pct\" \"$disk_pct\"",
  ].join('; ');
  const result = await executor.execute(server, cmd, { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    return { ok: false, details: `metric verifier failed on ${server.name}: ${result.stderr || result.stdout}` };
  }

  const value = parseMetric(result.stdout, metric);
  if (!Number.isFinite(value)) {
    return { ok: false, details: `could not parse ${metric} from verifier output: ${result.stdout.slice(0, 200)}` };
  }
  const threshold = metric === 'disk' || metric === 'memory' ? 90 : 150;
  return value >= threshold
    ? { ok: false, details: `${server.name} ${metric} still ${value}% (threshold ${threshold}%)` }
    : { ok: true, details: `${server.name} ${metric} now ${value}% (below ${threshold}%)` };
}

async function verifyRemoteService(
  inc: Incident,
  deps: IncidentVerifierDeps,
): Promise<IncidentVerificationResult | null> {
  const service = serviceFromIncident(inc);
  if (!service || !inc.serverId) return null;
  const registry = deps.getServerRegistry?.();
  const executor = deps.getRemoteExecutor?.();
  if (!registry || !executor) return { ok: false, conclusive: false, details: 'service verifier dependencies are unavailable' };
  const server = registry.get(inc.serverId);
  if (!server) return { ok: false, conclusive: false, details: `server not found: ${inc.serverId}` };
  const outcomes: string[] = [];
  let conclusivelyInactive = false;
  for (const candidate of serviceCandidates(service)) {
    const result = executor.executeFile
      ? await executor.executeFile(server, 'systemctl', ['is-active', candidate], { timeoutMs: 10_000 })
      : await executor.execute(server, `systemctl is-active ${candidate}`, { timeoutMs: 10_000 });
    const status = result.stdout.trim().toLowerCase();
    outcomes.push(`${candidate}=${status || `exit-${result.exitCode}`}`);
    if (status === 'active' || status === 'activating') {
      return { ok: true, conclusive: true, details: `${candidate} is ${status} on ${server.name}` };
    }
    if (['inactive', 'failed', 'deactivating'].includes(status) || result.exitCode === 3) conclusivelyInactive = true;
  }
  return conclusivelyInactive
    ? { ok: false, conclusive: true, details: `${service} is inactive on ${server.name} (${outcomes.join(', ')})` }
    : { ok: false, conclusive: false, details: `could not determine ${service} state on ${server.name} (${outcomes.join(', ')})` };
}

async function verifyRemoteContainer(inc: Incident, deps: IncidentVerifierDeps): Promise<IncidentVerificationResult | null> {
  const target = containerFromIncident(inc);
  if (!target || !inc.serverId) return null;
  const registry = deps.getServerRegistry?.();
  const executor = deps.getRemoteExecutor?.();
  if (!registry || !executor?.executeFile) return { ok: false, conclusive: false, details: 'container verifier dependencies are unavailable' };
  const server = registry.get(inc.serverId);
  if (!server) return { ok: false, conclusive: false, details: `server not found: ${inc.serverId}` };
  const result = await executor.executeFile(server, 'docker', [
    'inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.StartedAt}}', target.name,
  ], { timeoutMs: 10_000 });
  if (result.exitCode !== 0) return { ok: false, conclusive: true, details: `container ${target.name} is unavailable on ${server.name}` };
  const [status, health, restartCount, startedAt] = result.stdout.trim().split('|');
  if (target.condition === 'unhealthy') {
    if (status === 'running' && health === 'healthy') return { ok: true, conclusive: true, details: `container ${target.name} is healthy on ${server.name}` };
    if (health === 'none') return { ok: false, conclusive: false, details: `container ${target.name} has no healthcheck on ${server.name}` };
    return { ok: false, conclusive: true, details: `container ${target.name} is ${status}/${health} on ${server.name}` };
  }
  if (target.condition === 'exited') {
    return status === 'running'
      ? { ok: true, conclusive: true, details: `container ${target.name} is running on ${server.name}` }
      : { ok: false, conclusive: true, details: `container ${target.name} is ${status || 'unavailable'} on ${server.name}` };
  }
  const stableForMs = Date.now() - Date.parse(startedAt || '');
  return status === 'running' && Number.isFinite(stableForMs) && stableForMs >= 10 * 60_000
    ? { ok: true, conclusive: true, details: `container ${target.name} has been running ${Math.floor(stableForMs / 60_000)}m (restartCount ${restartCount}) on ${server.name}` }
    : { ok: false, conclusive: true, details: `container ${target.name} has not yet been stable for 10m on ${server.name}` };
}

function kubectlFailure(kind: string, name: string, serverName: string, stderr: string): IncidentVerificationResult {
  const detail = stderr.trim().slice(0, 300);
  const missing = /\bnotfound\b|\bnot found\b/i.test(detail);
  return missing
    ? { ok: false, conclusive: true, details: `${kind} ${name} is absent on ${serverName}` }
    : { ok: false, conclusive: false, details: `could not query ${kind} ${name} on ${serverName}: ${detail || 'kubectl failed'}` };
}

async function verifyKubernetesResource(inc: Incident, deps: IncidentVerifierDeps): Promise<IncidentVerificationResult | null> {
  const target = kubernetesTargetFromIncident(inc);
  if (!target) return null;
  if (!inc.serverId) return { ok: false, conclusive: false, details: 'Kubernetes verifier has no cluster server' };
  const registry = deps.getServerRegistry?.();
  const executor = deps.getRemoteExecutor?.();
  if (!registry || !executor?.executeFile) return { ok: false, conclusive: false, details: 'Kubernetes verifier dependencies are unavailable' };
  const server = registry.get(inc.serverId);
  if (!server) return { ok: false, conclusive: false, details: `server not found: ${inc.serverId}` };
  const result = await executor.executeFile(server, 'kubectl', [
    'get', target.kind, target.name, '--namespace', target.namespace, '--output', 'json',
  ], { timeoutMs: 15_000 });
  if (result.exitCode !== 0) return kubectlFailure(target.kind, target.name, server.name, result.stderr || result.stdout);

  let resource: any;
  try { resource = JSON.parse(result.stdout); }
  catch { return { ok: false, conclusive: false, details: `kubectl returned invalid JSON for ${target.kind} ${target.name} on ${server.name}` }; }

  if (target.kind === 'pod') {
    const phase = String(resource?.status?.phase || 'Unknown');
    const readyCondition = resource?.status?.conditions?.some((item: any) => item?.type === 'Ready' && item?.status === 'True') === true;
    const containers = Array.isArray(resource?.status?.containerStatuses) ? resource.status.containerStatuses : [];
    const containersReady = containers.length > 0 && containers.every((item: any) => item?.ready === true && !item?.state?.waiting);
    const healthy = !resource?.metadata?.deletionTimestamp && phase === 'Running' && readyCondition && containersReady;
    return healthy
      ? { ok: true, conclusive: true, details: `pod ${target.namespace}/${target.name} is Running and Ready on ${server.name}` }
      : { ok: false, conclusive: true, details: `pod ${target.namespace}/${target.name} is ${phase} and ${readyCondition && containersReady ? 'Ready' : 'NotReady'} on ${server.name}` };
  }

  const desired = Number(resource?.spec?.replicas ?? 1);
  const generation = Number(resource?.metadata?.generation ?? 0);
  const observed = Number(resource?.status?.observedGeneration ?? -1);
  const updated = Number(resource?.status?.updatedReplicas ?? 0);
  const available = Number(resource?.status?.availableReplicas ?? 0);
  const unavailable = Number(resource?.status?.unavailableReplicas ?? 0);
  if (![desired, generation, observed, updated, available, unavailable].every(Number.isFinite)) {
    return { ok: false, conclusive: false, details: `deployment ${target.namespace}/${target.name} returned invalid rollout counters on ${server.name}` };
  }
  const healthy = observed >= generation && updated >= desired && available >= desired && unavailable === 0;
  return healthy
    ? { ok: true, conclusive: true, details: `deployment ${target.namespace}/${target.name} is available (${available}/${desired}) on ${server.name}` }
    : { ok: false, conclusive: true, details: `deployment ${target.namespace}/${target.name} rollout is incomplete (observed ${observed}/${generation}, updated ${updated}/${desired}, available ${available}/${desired}, unavailable ${unavailable}) on ${server.name}` };
}

async function verifyNetworkOrEndpoint(inc: Incident, deps: IncidentVerifierDeps): Promise<IncidentVerificationResult | null> {
  const host = networkTargetFromIncident(inc);
  const endpoint = endpointFromIncident(inc);
  if (!host && !endpoint) return null;
  if (!inc.serverId) return { ok: false, conclusive: false, details: 'network verifier has no source server' };
  const registry = deps.getServerRegistry?.();
  const executor = deps.getRemoteExecutor?.();
  if (!registry || !executor?.executeFile) return { ok: false, conclusive: false, details: 'network verifier dependencies are unavailable' };
  const server = registry.get(inc.serverId);
  if (!server) return { ok: false, conclusive: false, details: `server not found: ${inc.serverId}` };
  if (host) {
    const result = await executor.executeFile(server, 'ping', ['-c', '1', '-W', '2', host], { timeoutMs: 8_000 });
    return result.exitCode === 0
      ? { ok: true, conclusive: true, details: `${host} is reachable from ${server.name}` }
      : { ok: false, conclusive: true, details: `${host} remains unreachable from ${server.name}` };
  }
  if (endpoint?.kind === 'port') {
    const result = await executor.executeFile(server, 'nc', ['-z', '-w', '3', endpoint.host, String(endpoint.port)], { timeoutMs: 8_000 });
    return result.exitCode === 0
      ? { ok: true, conclusive: true, details: `${endpoint.host}:${endpoint.port} is reachable from ${server.name}` }
      : { ok: false, conclusive: true, details: `${endpoint.host}:${endpoint.port} remains unreachable from ${server.name}` };
  }
  if (endpoint?.kind === 'http') {
    const result = await executor.executeFile(server, 'curl', ['-fsS', '--max-time', '5', '-o', '/dev/null', '-w', '%{http_code}', endpoint.url], { timeoutMs: 8_000 });
    const status = Number(result.stdout.trim());
    return result.exitCode === 0 && status >= 200 && status < 500
      ? { ok: true, conclusive: true, details: `${endpoint.url} returned HTTP ${status} from ${server.name}` }
      : { ok: false, conclusive: true, details: `${endpoint.url} remains unhealthy from ${server.name} (HTTP ${status || 'unavailable'})` };
  }
  return null;
}

export function createIncidentVerifier(deps: IncidentVerifierDeps): IncidentVerifier {
  return async (inc) => {
    const ref = (inc.sourceRef || '').toLowerCase();
    const title = inc.title.toLowerCase();
    try {
      const remoteService = await verifyRemoteService(inc, deps);
      if (remoteService) return remoteService;
      const remoteContainer = await verifyRemoteContainer(inc, deps);
      if (remoteContainer) return remoteContainer;
      const kubernetesResource = await verifyKubernetesResource(inc, deps);
      if (kubernetesResource) return kubernetesResource;
      const networkOrEndpoint = await verifyNetworkOrEndpoint(inc, deps);
      if (networkOrEndpoint) return networkOrEndpoint;
      const remoteMetric = await verifyRemoteMetric(inc, deps);
      if (remoteMetric) return remoteMetric;
      if (ref.startsWith('health-monitor:disk') || /disk\s*(full|critical|usage)/.test(title)) {
        const out = await deps.skillManager.execute('server.disk', {});
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        const stillFull = /(9[0-9]|100)%/.test(text);
        return stillFull
          ? { ok: false, details: 'disk usage still >=90% on some mount' }
          : { ok: true, details: 'disk usage below 90%' };
      }
      if (ref.startsWith('health-monitor:memory') || /memory\s*(critical|high|usage)/.test(title)) {
        const out = await deps.skillManager.execute('server.memory', {});
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        const stillHigh = /(9[5-9]|100)%/.test(text);
        return stillHigh
          ? { ok: false, details: 'memory usage still >=95%' }
          : { ok: true, details: 'memory usage below 95%' };
      }
    } catch (e) {
      return { ok: false, conclusive: false, details: `verifier threw: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (inc.source !== 'manual') {
      return { ok: false, conclusive: false, details: `no verifier configured for ${inc.source}:${inc.sourceRef ?? 'unknown'}` };
    }
    return { ok: true, details: 'manual incident has no verifier configured' };
  };
}

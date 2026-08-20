import type { AgentRole } from '../types/index.js';

export type RiskTier = 'safe' | 'standard' | 'risky' | 'destructive';
export type SandboxProfile = 'read_only_shell' | 'container_runtime' | 'k8s_admin' | 'deployment_runtime';

export interface SandboxLaunchSpec {
  profile: SandboxProfile;
  runner: 'host_exec' | 'docker_exec';
  network: 'none' | 'restricted' | 'full';
  readOnlyRootFs: boolean;
  user: string;
  noNewPrivileges: boolean;
  dropCapabilities: string[];
  allowedVolumes: string[];
  defaultTimeoutMs: number;
  image?: string;
  notes?: string;
}

export interface ToolPolicy {
  command: string;
  risk: RiskTier;
  sandbox: SandboxProfile;
  requiresApproval: boolean;
  requiresRollback?: boolean;
  allowedRoles: AgentRole[];
  requiredCredentialScopes?: string[];
  maxDurationMs: number;
  notes?: string;
}

const DEFAULT_ALLOWED: AgentRole[] = ['director', 'sysadmin', 'specialist'];

export const SANDBOX_LAUNCH_SPECS: Record<SandboxProfile, SandboxLaunchSpec> = {
  read_only_shell: {
    profile: 'read_only_shell',
    runner: 'docker_exec',
    network: 'restricted',
    readOnlyRootFs: true,
    user: '65534:65534',
    noNewPrivileges: true,
    dropCapabilities: ['ALL'],
    allowedVolumes: ['/tmp:rw'],
    defaultTimeoutMs: 20_000,
    image: 'itops-agents:latest',
    notes: 'Read-only host probes and diagnostics.'
  },
  container_runtime: {
    profile: 'container_runtime',
    runner: 'docker_exec',
    network: 'restricted',
    readOnlyRootFs: true,
    user: '65534:65534',
    noNewPrivileges: true,
    dropCapabilities: ['ALL'],
    allowedVolumes: ['/var/run/docker.sock:rw', '/tmp:rw'],
    defaultTimeoutMs: 30_000,
    image: 'itops-agent-tools:latest',
    notes: 'Container and image operations through controlled runtime.'
  },
  k8s_admin: {
    profile: 'k8s_admin',
    runner: 'docker_exec',
    network: 'full',
    readOnlyRootFs: true,
    user: '65534:65534',
    noNewPrivileges: true,
    dropCapabilities: ['ALL'],
    allowedVolumes: ['/tmp:rw', '/data/itops-agents/kubeconfig:ro'],
    defaultTimeoutMs: 45_000,
    image: 'itops-agent-k8s-tools:latest',
    notes: 'Kubernetes inspection and deployment operations.'
  },
  deployment_runtime: {
    profile: 'deployment_runtime',
    runner: 'docker_exec',
    network: 'full',
    readOnlyRootFs: false,
    user: '1000:1000',
    noNewPrivileges: true,
    dropCapabilities: ['ALL'],
    allowedVolumes: ['/tmp:rw', '/data/itops-agents/workdir:rw'],
    defaultTimeoutMs: 120_000,
    image: 'itops-agent-deploy-tools:latest',
    notes: 'Controlled CI/CD and deployment workflows.'
  }
};

export const TOOL_POLICIES: ToolPolicy[] = [
  { command: 'monitor.cpu', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'monitor.memory', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'monitor.disk', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'monitor.network', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'logs.tail', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'logs.search', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'logs.journalctl', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'alert.create', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 10_000 },
  { command: 'alert.list', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 10_000 },
  { command: 'alert.resolve', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 10_000 },
  { command: 'health.check', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },

  { command: 'docker.list', risk: 'safe', sandbox: 'container_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },
  { command: 'docker.stats', risk: 'safe', sandbox: 'container_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },
  { command: 'docker.logs', risk: 'safe', sandbox: 'container_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },
  { command: 'docker.scan', risk: 'safe', sandbox: 'container_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 90_000 },
  { command: 'server.info', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'server.processes', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'server.disk', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'server.memory', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'k8s.pods', risk: 'safe', sandbox: 'k8s_admin', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },
  { command: 'k8s.deployments', risk: 'safe', sandbox: 'k8s_admin', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },
  { command: 'k8s.rolloutStatus', risk: 'safe', sandbox: 'k8s_admin', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 130_000 },
  { command: 'db.pg.longRunningQueries', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },

  { command: 'deploy.status', risk: 'safe', sandbox: 'deployment_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'deploy.list', risk: 'safe', sandbox: 'deployment_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'deploy.logs', risk: 'safe', sandbox: 'deployment_runtime', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },

  { command: 'security.scan', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },
  { command: 'security.firewall', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'security.users', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'security.ssh', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'security.ports', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'security.logins', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'security.failed', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 20_000 },
  { command: 'security.patch', risk: 'safe', sandbox: 'read_only_shell', requiresApproval: false, allowedRoles: DEFAULT_ALLOWED, maxDurationMs: 30_000 },

  {
    command: 'deploy.start',
    risk: 'risky',
    sandbox: 'deployment_runtime',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['deploy:write'],
    maxDurationMs: 120_000
  },
  {
    command: 'deploy.rollback',
    risk: 'standard',
    sandbox: 'deployment_runtime',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['deploy:write'],
    maxDurationMs: 120_000
  },
  {
    command: 'git.deploy',
    risk: 'risky',
    sandbox: 'deployment_runtime',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['git:read', 'deploy:write'],
    maxDurationMs: 120_000
  },
  {
    command: 'docker.deploy',
    risk: 'risky',
    sandbox: 'container_runtime',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['docker:write'],
    maxDurationMs: 90_000
  },
  {
    command: 'k8s.deploy',
    risk: 'risky',
    sandbox: 'k8s_admin',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['k8s:write'],
    maxDurationMs: 90_000
  },
  {
    command: 'k8s.restart',
    risk: 'standard',
    sandbox: 'k8s_admin',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    maxDurationMs: 60_000
  },
  {
    command: 'k8s.scale',
    risk: 'standard',
    sandbox: 'k8s_admin',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    maxDurationMs: 60_000
  },
  {
    command: 'db.pg.terminateQuery',
    risk: 'standard',
    sandbox: 'read_only_shell',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    maxDurationMs: 15_000,
    notes: 'Kills an in-flight backend; can abort in-progress work, so requires approval.'
  },
  {
    command: 'docker.exec',
    risk: 'destructive',
    sandbox: 'container_runtime',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['docker:exec'],
    maxDurationMs: 60_000
  },
  {
    command: 'security.sudo',
    risk: 'risky',
    sandbox: 'read_only_shell',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['host:sudo'],
    maxDurationMs: 30_000
  },
  {
    command: 'task.rollback.apply',
    risk: 'standard',
    sandbox: 'read_only_shell',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin', 'specialist'],
    maxDurationMs: 30_000,
    notes: 'User-initiated rollback application for task lifecycle safety.'
  },
  {
    command: 'delegation.dispatch',
    risk: 'standard',
    sandbox: 'read_only_shell',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin', 'specialist'],
    maxDurationMs: 15_000,
    notes: 'Approval gate for high-impact delegation transitions (approve/dispatch).'
  },
  {
    command: 'service.restart',
    risk: 'standard',
    sandbox: 'read_only_shell',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['host:service'],
    maxDurationMs: 60_000,
    notes: 'Targeted service restart; approval required because it can cause a brief outage.'
  },
  {
    command: 'docker.restart',
    risk: 'standard',
    sandbox: 'container_runtime',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['docker:write'],
    maxDurationMs: 60_000
  },
  {
    command: 'docker.cleanup',
    risk: 'standard',
    sandbox: 'container_runtime',
    requiresApproval: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['docker:write'],
    maxDurationMs: 90_000
  },
  {
    command: 'config.change',
    risk: 'risky',
    sandbox: 'deployment_runtime',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['host:config'],
    maxDurationMs: 120_000
  },
  {
    command: 'package.upgrade',
    risk: 'risky',
    sandbox: 'deployment_runtime',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['host:packages'],
    maxDurationMs: 300_000
  },
  {
    command: 'firewall.change',
    risk: 'risky',
    sandbox: 'read_only_shell',
    requiresApproval: true,
    requiresRollback: true,
    allowedRoles: ['director', 'sysadmin'],
    requiredCredentialScopes: ['host:firewall'],
    maxDurationMs: 60_000
  },
];

const policyIndex = new Map<string, ToolPolicy>(TOOL_POLICIES.map(p => [p.command, p]));

export function getToolPolicy(command: string): ToolPolicy | undefined {
  return policyIndex.get(command);
}

export function getToolLaunchSpec(command: string): SandboxLaunchSpec | undefined {
  const policy = getToolPolicy(command);
  if (!policy) return undefined;
  return SANDBOX_LAUNCH_SPECS[policy.sandbox];
}

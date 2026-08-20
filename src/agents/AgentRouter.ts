// Smart agent router — picks the best agent for a delegation request.
//
// Used by DelegationSkill when delegate.ask is invoked without a targetAgent
// (or with only a role/skill hint) and the caller wants the system to choose.
// The router takes:
//
//   • the task description
//   • the candidate pool (agents excluding the caller)
//   • optional load + history sources so it can prefer idle, reliable agents
//
// …and produces { agent, score, reason } for the best match (or null if no
// candidate cleared the minimum score). The scoring is deliberately simple
// and explainable — agents see the reason in their delegation observation,
// which feeds the ReAct trace and the memory store.

import type { Agent } from './Agent.js';

export interface AgentRouterScoreSource {
  /** Number of in-flight tasks/delegations the agent is currently handling. */
  getActiveTaskCount?(agentId: string): number;
  /** Aggregated past-delegation stats keyed by agent id. */
  getDelegationStatsByAssignee?(): Map<string, { total: number; completed: number; rejected: number; avgDurationMs: number }>;
}

export interface AgentRouterOptions {
  loadSource?: AgentRouterScoreSource;
  historySource?: AgentRouterScoreSource;
  /** Minimum score required to return a candidate (else null). Default: 0. */
  minimumScore?: number;
  /** If true, every score component is included in the result reason. */
  verbose?: boolean;
}

export interface RoutingPick {
  agent: Agent;
  score: number;
  reason: string;
  breakdown: Record<string, number>;
}

const SKILL_KEYWORDS: Record<string, string[]> = {
  // skill id → keyword phrases that match it. Lowercased; the pickAgent call
  // does its own lowercasing on the task. Keep the lists small + specific.
  network:        ['network', 'firewall', 'vpn', 'dns', 'subnet', 'route', 'tcp', 'udp', 'port'],
  'network-diag': ['network', 'firewall', 'vpn', 'dns', 'subnet', 'route', 'tcp', 'udp', 'port', 'ssl', 'tls'],
  'network-scan': ['scan', 'sweep', 'probe', 'cidr', 'reachable', 'open port'],
  security:       ['security', 'vulnerability', 'cve', 'sudo', 'firewall', 'audit', 'breach', 'suspicious', 'unauthorized'],
  monitoring:     ['monitor', 'cpu', 'memory', 'disk', 'metric', 'alert', 'health', 'load', 'latency'],
  infrastructure: ['docker', 'compose', 'container', 'kubernetes', 'k8s', 'pod', 'deployment', 'cluster'],
  bash:           ['shell', 'bash', 'script', 'execute', 'run command'],
  ssh:            ['ssh', 'remote', 'login', 'host', 'server'],
  files:          ['file', 'directory', 'read file', 'write file', 'log file', 'config file'],
  certificate:    ['certificate', 'ssl', 'tls', 'cert', 'letsencrypt', 'expir'],
  jira:           ['jira', 'ticket', 'issue', 'project', 'sprint'],
  servicedesk:    ['incident', 'service desk', 'ticket', 'on-call', 'sla', 'p1', 'p2'],
  proxmox:        ['proxmox', 'pve', 'vm', 'lxc', 'snapshot'],
  database:       ['database', 'sql', 'postgres', 'pg', 'mysql', 'query', 'table'],
  'docker-mgmt':  ['docker', 'container', 'image', 'compose'],
  kubernetes:     ['kubernetes', 'k8s', 'pod', 'deployment', 'kubectl', 'namespace'],
  'system-update': ['update', 'upgrade', 'patch', 'apt', 'package'],
  'log-aggregator': ['log', 'syslog', 'journal', 'aggregate'],
  alerts:         ['alert', 'notify', 'page', 'slack', 'pagerduty'],
  workflow:       ['workflow', 'pipeline', 'stage', 'orchestration'],
  runbook:        ['runbook', 'playbook', 'procedure'],
  delegation:     ['delegate', 'hand off', 'sub-task'],
};

const ROLE_KEYWORDS: Record<string, string[]> = {
  director:   ['plan', 'coordinate', 'strategic', 'priorit', 'approve', 'decide'],
  sysadmin:   ['server', 'infrastructure', 'production', 'restart', 'service', 'systemd'],
  specialist: ['investigate', 'deep', 'expert', 'analy'],
};

export class AgentRouter {
  private opts: AgentRouterOptions;

  constructor(opts: AgentRouterOptions = {}) {
    this.opts = opts;
  }

  /** DelegationRouter contract: pick the best agent for a sub-task. */
  pickAgent(
    task: { task: string; role?: string; skill?: string },
    candidates: Agent[]
  ): RoutingPick | null {
    const all = this.scoreAll(task, candidates);
    if (all.length === 0) return null;
    const min = this.opts.minimumScore ?? 0;
    const best = all[0];
    if (best.score < min) return null;
    return best;
  }

  /** Score every candidate, sorted descending — useful for surfacing the
   *  ranked list in UI / introspection. */
  scoreAll(
    task: { task: string; role?: string; skill?: string },
    candidates: Agent[]
  ): RoutingPick[] {
    const taskLower = task.task.toLowerCase();
    const ranked: RoutingPick[] = [];

    for (const agent of candidates) {
      // Hard filters first — caller asked for a specific role/skill.
      if (task.role && agent.role !== task.role) continue;
      if (task.skill && !agent.config.skills.includes(task.skill)) continue;

      const breakdown: Record<string, number> = {};
      let score = 0;

      // Skill keyword match — biggest signal. Each agent skill that has at
      // least one keyword present in the task contributes 10; an agent skill
      // explicitly named by the caller contributes another 25.
      let skillMatches = 0;
      for (const skillId of agent.config.skills) {
        const kws = SKILL_KEYWORDS[skillId];
        if (!kws) continue;
        if (kws.some(k => taskLower.includes(k))) skillMatches += 1;
      }
      if (skillMatches > 0) {
        breakdown.skillMatch = skillMatches * 10;
        score += breakdown.skillMatch;
      }
      if (task.skill && agent.config.skills.includes(task.skill)) {
        breakdown.skillRequested = 25;
        score += 25;
      }

      // Role keyword match.
      const roleKws = ROLE_KEYWORDS[agent.role];
      if (roleKws && roleKws.some(k => taskLower.includes(k))) {
        breakdown.roleKeyword = 5;
        score += 5;
      }
      if (task.role && agent.role === task.role) {
        breakdown.roleRequested = 15;
        score += 15;
      }

      // Load penalty — each in-flight task subtracts 5, capped at -25.
      const load = this.opts.loadSource?.getActiveTaskCount?.(agent.id) ?? 0;
      if (load > 0) {
        breakdown.loadPenalty = -Math.min(load * 5, 25);
        score += breakdown.loadPenalty;
      }

      // Past delegation success rate — only counted once the agent has at
      // least 3 historical delegations to filter out noise. Up to ±10.
      const stats = this.opts.historySource?.getDelegationStatsByAssignee?.()?.get(agent.id);
      if (stats && stats.total >= 3) {
        const rate = stats.completed / stats.total;
        breakdown.successRate = Math.round((rate - 0.5) * 20); // 50 % → 0, 100 % → +10, 0 % → -10
        score += breakdown.successRate;
      }

      const reason = this.formatReason(agent, breakdown, this.opts.verbose);
      ranked.push({ agent, score, reason, breakdown });
    }

    return ranked.sort((a, b) => b.score - a.score);
  }

  private formatReason(agent: Agent, breakdown: Record<string, number>, verbose?: boolean): string {
    const wins = Object.entries(breakdown)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => HUMAN[k] ?? k);
    const lossList = Object.entries(breakdown)
      .filter(([, v]) => v < 0)
      .map(([k]) => HUMAN[k] ?? k);

    const head = wins.length > 0
      ? `${agent.name} (${agent.role}) — ${wins.slice(0, 3).join(', ')}`
      : `${agent.name} (${agent.role}) — no positive signal`;
    const tail = lossList.length > 0 ? ` (offset by ${lossList.join(', ')})` : '';
    if (!verbose) return head + tail;
    const detail = Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(' ');
    return `${head}${tail} [${detail}]`;
  }
}

const HUMAN: Record<string, string> = {
  skillMatch:     'matching skills',
  skillRequested: 'caller-requested skill',
  roleKeyword:    'role-relevant keywords',
  roleRequested:  'caller-requested role',
  loadPenalty:    'busy',
  successRate:    'past success rate',
};

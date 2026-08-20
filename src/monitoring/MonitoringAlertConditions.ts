import type { ReconciledAlertInput } from '../alerting/AlertManager.js';

export interface MonitoringServerMetric {
  ip: string;
  name: string;
  reachable: boolean;
  cpu?: number;
  memUsedPct?: number;
  diskUsedPct?: number;
  error?: string;
}

export interface MonitoringAgentMetric {
  agentId: string;
  name: string;
  successRate: number | null;
  executions: {
    error: number;
  };
}

function signals(server: MonitoringServerMetric) {
  return [
    { key: 'cpu', name: 'CPU', value: server.cpu },
    { key: 'memory', name: 'Memory', value: server.memUsedPct },
    { key: 'disk', name: 'Disk', value: server.diskUsedPct }
  ].filter((signal): signal is { key: string; name: string; value: number } =>
    Number.isFinite(signal.value)
  );
}

function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

export function buildMonitoringAlertConditions(
  servers: MonitoringServerMetric[],
  agents: MonitoringAgentMetric[]
): ReconciledAlertInput[] {
  const conditions: ReconciledAlertInput[] = [];

  for (const server of servers) {
    const attentionId = `server-${server.ip}`;
    const serverLabels = {
      attentionId,
      target: server.name,
      serverId: server.ip,
      targetType: 'server'
    };

    if (!server.reachable) {
      conditions.push({
        key: `${attentionId}:unreachable`,
        title: `${server.name} is unreachable`,
        message: server.error
          ? `Host is unreachable: ${server.error}`
          : 'Host is unreachable and is not reporting metrics.',
        severity: 'critical',
        labels: serverLabels,
        annotations: {
          recommendedAction: 'Check network and SSH access, then restore monitoring connectivity.'
        }
      });
      continue;
    }

    const serverSignals = signals(server);
    if (serverSignals.length < 3) {
      conditions.push({
        key: `${attentionId}:telemetry`,
        title: `${server.name} telemetry is incomplete`,
        message: 'Host is reachable, but one or more resource metrics are missing.',
        severity: 'warning',
        labels: serverLabels,
        annotations: {
          recommendedAction: 'Check the remote metrics command and permissions on this host.'
        }
      });
      continue;
    }

    const worst = serverSignals.sort((a, b) => b.value - a.value)[0];
    if (worst.value < 80) continue;

    conditions.push({
      key: `${attentionId}:${worst.key}`,
      title: `${worst.name} pressure on ${server.name}`,
      message: `${worst.name} is at ${formatPercent(worst.value)}, above the 80% operating limit.`,
      severity: worst.value >= 90 ? 'critical' : 'warning',
      labels: {
        ...serverLabels,
        signal: worst.key
      },
      annotations: {
        recommendedAction:
          worst.key === 'disk'
            ? 'Free space or expand the volume before writes slow down.'
            : worst.key === 'memory'
            ? 'Find the top memory process and restart or scale the workload.'
            : 'Move load off this host or inspect the busiest process.'
      }
    });
  }

  for (const agent of agents) {
    const lowSuccessRate = agent.successRate != null && agent.successRate < 70;
    if (!lowSuccessRate && agent.executions.error <= 0) continue;

    const attentionId = `agent-${agent.agentId}`;
    conditions.push({
      key: `${attentionId}:${lowSuccessRate ? 'success-rate' : 'execution-errors'}`,
      title: lowSuccessRate
        ? `${agent.name} reliability is below target`
        : `${agent.name} has execution errors`,
      message: lowSuccessRate
        ? `Success rate is ${formatPercent(agent.successRate!)}, below the 70% reliability floor.`
        : `Recent execution history contains ${agent.executions.error} error${agent.executions.error === 1 ? '' : 's'}.`,
      severity: lowSuccessRate ? 'critical' : 'warning',
      labels: {
        attentionId,
        target: agent.name,
        agentId: agent.agentId,
        targetType: 'agent'
      },
      annotations: {
        recommendedAction: 'Review failed tasks and execution audit entries before assigning more work.'
      }
    });
  }

  return conditions;
}

import { useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, Siren, UserPlus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import Badge from '../components/Badge'
import Button from '../components/Button'
import StatCard from '../components/StatCard'
import { Card, CardHeader, CardBody } from '../components/Card'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { toast } from '../hooks/useToast'
import styles from './MonitoringPage.module.css'

interface ServerMetric {
  ip: string
  name: string
  reachable: boolean
  cpu?: number
  memUsedPct?: number
  diskUsedPct?: number
  uptimeSeconds?: number
  loadAvg?: string
  error?: string
  collectedAt: string
}

interface AgentMetric {
  agentId: string
  name: string
  role: string
  queueDepth: number
  completedTasks: number
  failedTasks: number
  successRate: number | null
  meanTaskDurationMinutes: number | null
  executions: {
    total: number
    allowed: number
    blocked: number
    error: number
    meanDurationMs: number | null
  }
}

interface ServerMetricsResponse {
  servers: ServerMetric[]
  cachedAt: string
}

interface AgentMetricsResponse {
  agents: AgentMetric[]
  generatedAt: string
}

interface DurableAlert {
  id: string
  title: string
  message: string
  severity: Severity
  status: 'firing' | 'acknowledged' | 'resolved'
  source: 'monitoring' | 'operational' | string
  labels: Record<string, string>
  annotations: Record<string, string>
  lastFiredAt: string
  assignedTo?: string
  acknowledgedBy?: string
  incidentId?: string
}

interface AlertsResponse {
  alerts: DurableAlert[]
  count: number
}

type Severity = 'critical' | 'warning' | 'info'
type IncidentState = 'Open' | 'Investigating' | 'Watching'
type AgentState = 'idle' | 'busy' | 'error'

interface AttentionItem {
  id: string
  target: string
  severity: Severity
  state: IncidentState
  finding: string
  action: string
  updated?: string
  alert?: DurableAlert
}

const severityRank: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

function statusBadgeVariant(status: AgentState) {
  if (status === 'idle') return 'success'
  if (status === 'busy') return 'accent'
  return 'danger'
}

function severityBadgeVariant(severity: Severity) {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'accent'
}

function stateBadgeVariant(state: IncidentState) {
  if (state === 'Open') return 'danger'
  if (state === 'Investigating') return 'warning'
  return 'neutral'
}

function metricSignals(server: ServerMetric) {
  return [
    { name: 'CPU', value: server.cpu },
    { name: 'memory', value: server.memUsedPct },
    { name: 'disk', value: server.diskUsedPct },
  ].filter((signal): signal is { name: string; value: number } => Number.isFinite(signal.value))
}

function serverIsHealthy(server: ServerMetric) {
  const signals = metricSignals(server)
  return server.reachable && signals.length === 3 && signals.every(signal => signal.value < 80)
}

function agentState(agent: AgentMetric): AgentState {
  if ((agent.successRate != null && agent.successRate < 70) || agent.executions.error > 0) {
    return 'error'
  }
  return agent.queueDepth > 0 ? 'busy' : 'idle'
}

function buildAttentionItems(servers: ServerMetric[], agents: AgentMetric[]): AttentionItem[] {
  const serverItems = servers
    .filter(server => !serverIsHealthy(server))
    .map(server => {
      if (!server.reachable) {
        return {
          id: `server-${server.ip}`,
          target: server.name,
          severity: 'critical',
          state: 'Open',
          finding: server.error
            ? `Host is unreachable: ${server.error}`
            : 'Host is unreachable and is not reporting metrics.',
          action: 'Check network and SSH access, then restore monitoring connectivity.',
          updated: server.collectedAt,
        } satisfies AttentionItem
      }

      const signals = metricSignals(server).sort((a, b) => b.value - a.value)
      if (signals.length < 3) {
        return {
          id: `server-${server.ip}`,
          target: server.name,
          severity: 'warning',
          state: 'Investigating',
          finding: 'Host is reachable, but one or more resource metrics are missing.',
          action: 'Check the remote metrics command and permissions on this host.',
          updated: server.collectedAt,
        } satisfies AttentionItem
      }

      const signal = signals[0]
      const critical = signal.value >= 90
      return {
        id: `server-${server.ip}`,
        target: server.name,
        severity: critical ? 'critical' : 'warning',
        state: critical ? 'Open' : 'Investigating',
        finding: `${signal.name} is at ${formatPercent(signal.value)}, above the 80% operating limit.`,
        action:
          signal.name === 'disk'
            ? 'Free space or expand the volume before writes slow down.'
            : signal.name === 'memory'
            ? 'Find the top memory process and restart or scale the workload.'
            : 'Move load off this host or inspect the busiest process.',
        updated: server.collectedAt,
      } satisfies AttentionItem
    })

  const agentItems = agents
    .filter(agent => (agent.successRate != null && agent.successRate < 70) || agent.executions.error > 0)
    .map(agent => {
      const successRate = agent.successRate
      const lowSuccessRate = successRate != null && successRate < 70
      return {
        id: `agent-${agent.agentId}`,
        target: agent.name,
        severity: lowSuccessRate ? 'critical' : 'warning',
        state: lowSuccessRate ? 'Open' : 'Watching',
        finding: lowSuccessRate
          ? `Success rate is ${formatPercent(successRate)}, below the 70% reliability floor.`
          : `Recent execution history contains ${agent.executions.error} error${agent.executions.error === 1 ? '' : 's'}.`,
        action: 'Review failed tasks and execution audit entries before assigning more work.',
      } satisfies AttentionItem
    })

  return [...serverItems, ...agentItems].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || a.target.localeCompare(b.target),
  )
}

function clampPercentage(value: number) {
  return Math.min(100, Math.max(0, value))
}

function formatPercent(value: number) {
  return `${Number(value.toFixed(1))}%`
}

function MetricBar({ value }: { value?: number }) {
  if (!Number.isFinite(value)) {
    return <span className={styles.na}>Not reported</span>
  }

  const metric = value as number
  const color =
    metric >= 80 ? 'var(--danger)' : metric >= 60 ? 'var(--warning)' : 'var(--success)'
  return (
    <div className={styles.barWrap}>
      <div className={styles.barTrack}>
        <div
          className={styles.barFill}
          style={{ width: `${clampPercentage(metric)}%`, background: color }}
        />
      </div>
      <span className={styles.barLabel}>{formatPercent(metric)}</span>
    </div>
  )
}

function formatTimestamp(ts?: string) {
  if (!ts) return 'Not available'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'Not available'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(minutes: number | null) {
  if (minutes == null) return 'N/A'
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${Math.round(minutes)}m`
  return `${(minutes / 60).toFixed(1)}h`
}

export default function MonitoringPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [serverMetrics, setServerMetrics] = useState<ServerMetric[]>([])
  const [agentMetrics, setAgentMetrics] = useState<AgentMetric[]>([])
  const [durableAlerts, setDurableAlerts] = useState<DurableAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [dataIssues, setDataIssues] = useState<string[]>([])
  const [lastUpdated, setLastUpdated] = useState<string>()
  const [actionInProgress, setActionInProgress] = useState<string>()

  async function fetchMetrics() {
    const [serversResult, agentsResult] = await Promise.allSettled([
      api.get<ServerMetricsResponse>('/api/servers/metrics'),
      api.get<AgentMetricsResponse>('/api/agents/metrics'),
    ])

    const issues: string[] = []
    const timestamps: string[] = []

    if (serversResult.status === 'fulfilled') {
      setServerMetrics(Array.isArray(serversResult.value?.servers) ? serversResult.value.servers : [])
      if (serversResult.value?.cachedAt) timestamps.push(serversResult.value.cachedAt)
    } else {
      issues.push('Server metrics are temporarily unavailable.')
    }

    if (agentsResult.status === 'fulfilled') {
      setAgentMetrics(Array.isArray(agentsResult.value?.agents) ? agentsResult.value.agents : [])
      if (agentsResult.value?.generatedAt) timestamps.push(agentsResult.value.generatedAt)
    } else {
      issues.push('Agent metrics are temporarily unavailable.')
    }

    try {
      const alertData = await api.get<AlertsResponse>('/api/alerts?source=monitoring&status=active')
      setDurableAlerts(Array.isArray(alertData?.alerts) ? alertData.alerts : [])
    } catch {
      issues.push('Durable alert actions are temporarily unavailable.')
    }

    if (timestamps.length > 0) {
      setLastUpdated(timestamps.sort().at(-1))
    }
    setDataIssues(issues)
    setLoading(false)
  }

  useEffect(() => {
    fetchMetrics()
    const interval = setInterval(fetchMetrics, 15_000)
    return () => clearInterval(interval)
  }, [])

  const healthyServers = serverMetrics.filter(serverIsHealthy).length
  const activeAgents = agentMetrics.filter(agent => agent.queueDepth > 0).length
  const attentionItems = useMemo(
    () => {
      const alertByAttentionId = new Map(
        durableAlerts.map(alert => [alert.labels.attentionId, alert]),
      )
      return buildAttentionItems(serverMetrics, agentMetrics).map(item => {
        const alert = alertByAttentionId.get(item.id)
        if (!alert) return item
        return {
          ...item,
          severity: alert.severity,
          state: alert.status === 'acknowledged' ? 'Investigating' : item.state,
          finding: alert.message,
          action: alert.annotations.recommendedAction || item.action,
          updated: alert.lastFiredAt,
          alert,
        }
      })
    },
    [serverMetrics, agentMetrics, durableAlerts],
  )
  const attentionServers = serverMetrics.filter(server => !serverIsHealthy(server))
  const healthyFleet = serverMetrics.filter(serverIsHealthy)
  const needsAttentionCount = attentionItems.length
  const criticalCount = attentionItems.filter(item => item.severity === 'critical').length
  const allDataUnavailable =
    dataIssues.includes('Server metrics are temporarily unavailable.') &&
    dataIssues.includes('Agent metrics are temporarily unavailable.') &&
    serverMetrics.length === 0 &&
    agentMetrics.length === 0
  const overallStatus = loading
    ? 'Loading current infrastructure state'
    : allDataUnavailable
    ? 'Monitoring data is currently unavailable'
    : criticalCount > 0
    ? `${criticalCount} critical item${criticalCount === 1 ? '' : 's'} need action`
    : needsAttentionCount > 0
    ? `${needsAttentionCount} item${needsAttentionCount === 1 ? '' : 's'} need attention`
    : dataIssues.length > 0
    ? 'Reporting is healthy with partial monitoring data'
    : 'All monitored infrastructure is healthy'

  const statusClass = allDataUnavailable || criticalCount > 0
    ? styles.statusCritical
    : needsAttentionCount > 0 || dataIssues.length > 0
    ? styles.statusWarning
    : styles.statusHealthy
  const canManageAlerts = user?.role === 'superadmin' || user?.role === 'admin' || user?.role === 'operator'

  function replaceAlert(nextAlert: DurableAlert) {
    setDurableAlerts(current => {
      const exists = current.some(alert => alert.id === nextAlert.id)
      return exists
        ? current.map(alert => alert.id === nextAlert.id ? nextAlert : alert)
        : [...current, nextAlert]
    })
  }

  async function runAlertAction(
    alert: DurableAlert,
    action: 'acknowledge' | 'assign' | 'incident',
  ) {
    const actionKey = `${alert.id}:${action}`
    setActionInProgress(actionKey)
    try {
      if (action === 'acknowledge') {
        const result = await api.put<{ alert: DurableAlert }>(`/api/alerts/${alert.id}/acknowledge`, {})
        replaceAlert(result.alert)
        toast.success('Alert acknowledged')
      } else if (action === 'assign') {
        const result = await api.post<{ alert: DurableAlert }>(`/api/alerts/${alert.id}/assign`, {})
        replaceAlert(result.alert)
        toast.success(`Alert assigned to ${result.alert.assignedTo}`)
      } else {
        const result = await api.post<{ alert: DurableAlert; incident: { id: string } }>(
          `/api/alerts/${alert.id}/incident`,
          {},
        )
        replaceAlert(result.alert)
        toast.success(`Incident ${result.incident.id} linked`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Alert action failed')
    } finally {
      setActionInProgress(undefined)
    }
  }

  return (
    <Layout title="Monitoring" subtitle="Action-first infrastructure status">
      <div className={`${styles.statusBanner} ${statusClass}`}>
        <div>
          <div className={styles.statusLabel}>Overall status</div>
          <div className={styles.statusTitle}>{overallStatus}</div>
          {!loading && lastUpdated && (
            <div className={styles.statusMeta}>Last refreshed {formatTimestamp(lastUpdated)}</div>
          )}
        </div>
        <Badge
          variant={
            allDataUnavailable || criticalCount > 0
              ? 'danger'
              : needsAttentionCount > 0 || dataIssues.length > 0
              ? 'warning'
              : 'success'
          }
        >
          {loading
            ? 'Loading'
            : allDataUnavailable
            ? 'Unavailable'
            : criticalCount > 0
            ? 'Action required'
            : needsAttentionCount > 0 || dataIssues.length > 0
            ? 'Review'
            : 'Healthy'}
        </Badge>
      </div>

      {dataIssues.length > 0 && (
        <div className={styles.dataIssues} role="status">
          {dataIssues.join(' ')} Existing data remains visible while monitoring retries automatically.
        </div>
      )}

      <div className={styles.statsRow}>
        <StatCard label="Healthy Servers" value={healthyServers} color="success" />
        <StatCard label="Agents With Work" value={activeAgents} color="accent" />
        <StatCard
          label="Needs Attention"
          value={needsAttentionCount}
          color={needsAttentionCount > 0 ? 'danger' : 'default'}
        />
      </div>

      <Card className={styles.section}>
        <CardHeader title="Needs attention" subtitle="Sorted by severity with the next useful action" />
        <CardBody>
          {loading ? (
            <div className={styles.loadingState}>Loading current findings...</div>
          ) : attentionItems.length === 0 ? (
            <EmptyState
              icon="OK"
              title="No action needed"
              description="Every reporting server and agent is inside its operating limits."
            />
          ) : (
            <div className={styles.attentionList}>
              {attentionItems.map(item => (
                <div className={styles.attentionItem} key={item.id}>
                  <div className={styles.attentionTop}>
                    <div>
                      <div className={styles.attentionTarget}>{item.target}</div>
                      <div className={styles.finding}>{item.finding}</div>
                    </div>
                    <div className={styles.badgeGroup}>
                      <Badge variant={severityBadgeVariant(item.severity)}>{item.severity}</Badge>
                      <Badge variant={stateBadgeVariant(item.state)}>{item.state}</Badge>
                    </div>
                  </div>
                  <div className={styles.actionRow}>
                    <div className={styles.recommendedAction}>
                      <span className={styles.actionLabel}>Recommended action</span>
                      <span className={styles.actionText}>{item.action}</span>
                      {item.updated && (
                        <span className={styles.actionTime}>Updated {formatTimestamp(item.updated)}</span>
                      )}
                    </div>
                    {item.alert && (
                      <div className={styles.alertActions}>
                        <div className={styles.alertOwnership}>
                          {item.alert.assignedTo && <span>Assigned to {item.alert.assignedTo}</span>}
                          {item.alert.acknowledgedBy && <span>Acknowledged by {item.alert.acknowledgedBy}</span>}
                        </div>
                        {canManageAlerts && item.alert.status === 'firing' && (
                          <Button
                            size="xs"
                            onClick={() => runAlertAction(item.alert!, 'acknowledge')}
                            loading={actionInProgress === `${item.alert.id}:acknowledge`}
                          >
                            <Check size={14} />
                            Acknowledge
                          </Button>
                        )}
                        {canManageAlerts && !item.alert.assignedTo && (
                          <Button
                            size="xs"
                            onClick={() => runAlertAction(item.alert!, 'assign')}
                            loading={actionInProgress === `${item.alert.id}:assign`}
                          >
                            <UserPlus size={14} />
                            Assign to me
                          </Button>
                        )}
                        {canManageAlerts && !item.alert.incidentId && (
                          <Button
                            size="xs"
                            variant="primary"
                            onClick={() => runAlertAction(item.alert!, 'incident')}
                            loading={actionInProgress === `${item.alert.id}:incident`}
                          >
                            <Siren size={14} />
                            Create incident
                          </Button>
                        )}
                        {item.alert.incidentId && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => navigate(`/incidents/${item.alert!.incidentId}`)}
                          >
                            <ExternalLink size={14} />
                            {item.alert.incidentId}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card className={styles.section}>
        <CardHeader title="Server metrics needing action" subtitle="Reachability, CPU, memory, and disk utilisation" />
        <CardBody>
          {!loading && attentionServers.length === 0 ? (
            <EmptyState
              icon="OK"
              title="No server metrics need action"
              description="Servers outside limits will appear here."
            />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Reachability</th>
                    <th>CPU</th>
                    <th>Memory</th>
                    <th>Disk</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {attentionServers.map(server => (
                    <tr key={server.ip}>
                      <td className={styles.serverNameCell}>
                        <span>{server.name}</span>
                        <span className={styles.serverId}>{server.ip}</span>
                      </td>
                      <td>
                        <Badge variant={server.reachable ? 'success' : 'danger'}>
                          {server.reachable ? 'Reachable' : 'Unreachable'}
                        </Badge>
                      </td>
                      <td><MetricBar value={server.cpu} /></td>
                      <td><MetricBar value={server.memUsedPct} /></td>
                      <td><MetricBar value={server.diskUsedPct} /></td>
                      <td className={styles.tsCell}>{formatTimestamp(server.collectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {healthyFleet.length > 0 && (
        <details className={styles.healthyFleet}>
          <summary>Healthy fleet ({healthyFleet.length})</summary>
          <div className={styles.healthyGrid}>
            {healthyFleet.map(server => (
              <div className={styles.healthyItem} key={server.ip}>
                <span className={styles.serverNameCell}>{server.name}</span>
                <span>CPU {formatPercent(server.cpu as number)}</span>
                <span>Memory {formatPercent(server.memUsedPct as number)}</span>
                <span>Disk {formatPercent(server.diskUsedPct as number)}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Agent performance</h2>
        <p className={styles.sectionSub}>Work queues, outcomes, and recent execution health</p>
      </div>

      {!loading && agentMetrics.length === 0 ? (
        <EmptyState
          icon="i"
          title="No agent metrics"
          description="Agent performance data will appear here once agents are configured."
        />
      ) : (
        <div className={styles.agentGrid}>
          {agentMetrics.map(agent => {
            const state = agentState(agent)
            return (
              <Card key={agent.agentId} className={styles.agentCard}>
                <CardBody>
                  <div className={styles.agentCardTop}>
                    <div>
                      <div className={styles.agentName}>{agent.name}</div>
                      <div className={styles.agentId}>{agent.role} / {agent.agentId}</div>
                    </div>
                    <Badge variant={statusBadgeVariant(state)}>{state}</Badge>
                  </div>

                  <div className={styles.agentStats}>
                    <div className={styles.agentStat}>
                      <span className={styles.agentStatLabel}>Queue</span>
                      <span className={styles.agentStatValue}>{agent.queueDepth}</span>
                    </div>
                    <div className={styles.agentStat}>
                      <span className={styles.agentStatLabel}>Completed</span>
                      <span className={styles.agentStatValue}>{agent.completedTasks}</span>
                    </div>
                    <div className={styles.agentStat}>
                      <span className={styles.agentStatLabel}>Mean task</span>
                      <span className={styles.agentStatValue}>{formatDuration(agent.meanTaskDurationMinutes)}</span>
                    </div>
                  </div>

                  <div className={styles.agentOutcomeRow}>
                    <span>
                      Success <strong>{agent.successRate == null ? 'N/A' : formatPercent(agent.successRate)}</strong>
                    </span>
                    <span>
                      Failed <strong>{agent.failedTasks}</strong>
                    </span>
                    <span>
                      Exec errors <strong>{agent.executions.error}</strong>
                    </span>
                  </div>

                  {agent.successRate != null && (
                    <div className={styles.successBarWrap}>
                      <div className={styles.barTrack}>
                        <div
                          className={styles.barFill}
                          style={{
                            width: `${clampPercentage(agent.successRate)}%`,
                            background:
                              agent.successRate >= 90
                                ? 'var(--success)'
                                : agent.successRate >= 70
                                ? 'var(--warning)'
                                : 'var(--danger)',
                          }}
                        />
                      </div>
                    </div>
                  )}
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}
    </Layout>
  )
}

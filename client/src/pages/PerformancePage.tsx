import { useState, useEffect, useCallback, useRef } from 'react'
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import Layout from '../components/Layout'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import { Card, CardBody } from '../components/Card'
import { api } from '../lib/api'
import styles from './PerformancePage.module.css'

// ── Palette ───────────────────────────────────────────────────────────────────

const CHART_COLORS = ['#306EF0', '#06B6D4', '#F59E0B', '#EF4444', '#22C55E']

// ── Types ─────────────────────────────────────────────────────────────────────

interface PerformanceData {
  system?: {
    cpu?: { usage?: number; cores?: number }
    memory?: { percentage?: number; used?: number; total?: number }
  }
  agents?: { active?: number; total?: number; messagesPerMinute?: number }
  api?: { requestsPerMinute?: number; avgResponseTime?: number }
}

interface HistoryEntry {
  timestamp: string
  cpu: number
  memory: number
  tasks?: number
  errors?: number
}

interface AgentInfo {
  id: string
  name?: string
  role?: string
  config?: { name?: string }
}

interface TimeSeriesEntry {
  date: string
  completed: number
  failed: number
  avgDuration: number
}

interface TaskTypeEntry {
  type: string
  count: number
  successRate: number
}

interface SlowestTask {
  taskId: string
  type: string
  durationMs: number
  status: string
  createdAt: string
}

interface AnalyticsData {
  agentId: string
  period: number
  summary: {
    totalTasks: number
    completedTasks: number
    failedTasks: number
    successRate: number
    avgDurationMs: number
  }
  timeSeries: TimeSeriesEntry[]
  taskTypes: TaskTypeEntry[]
  slowestTasks: SlowestTask[]
}

interface AgentCompareEntry {
  agentId: string
  agentName: string
  role: string
  totalTasks: number
  completedTasks: number
  failedTasks: number
  successRate: number
  avgDurationMs: number
}

interface CompareData {
  period: number
  agents: AgentCompareEntry[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PerformancePage() {
  const [perf, setPerf] = useState<PerformanceData>({})
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [dateFilter, setDateFilter] = useState('')

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')
  const [period] = useState(7)
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null)
  const [compareData, setCompareData] = useState<CompareData | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(true)

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSystemPerf = useCallback(async () => {
    try {
      const [perfData, histData] = await Promise.all([
        api.get<PerformanceData>('/api/performance'),
        api.get<{ history: HistoryEntry[] }>('/api/performance/history'),
      ])
      setPerf(perfData)
      setHistory(Array.isArray(histData?.history) ? histData.history : [])
    } catch {
      // silent on poll failures
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchAnalytics = useCallback(async (agentId: string) => {
    setAnalyticsLoading(true)
    try {
      const params = new URLSearchParams({ period: String(period) })
      if (agentId) params.set('agentId', agentId)
      const [analyticsRes, compareRes] = await Promise.all([
        api.get<AnalyticsData>(`/api/agents/analytics?${params}`),
        api.get<CompareData>(`/api/agents/compare?period=${period}`),
      ])
      setAnalytics(analyticsRes)
      setCompareData(compareRes)
    } catch {
      // silent
    } finally {
      setAnalyticsLoading(false)
    }
  }, [period])

  useEffect(() => {
    api.get<{ agents?: AgentInfo[]; children?: AgentInfo[] }>('/api/agents')
      .then(data => {
        const list: AgentInfo[] = Array.isArray(data)
          ? data
          : (data.agents ?? data.children ?? [])
        setAgents(list)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchSystemPerf()
    pollingRef.current = setInterval(fetchSystemPerf, 15_000)
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [fetchSystemPerf])

  useEffect(() => {
    fetchAnalytics(selectedAgent)
  }, [selectedAgent, fetchAnalytics])

  const cpu = perf.system?.cpu?.usage ?? 0
  const mem = perf.system?.memory?.percentage ?? 0
  const activeAgents = perf.agents?.active ?? 0
  const avgResponse = perf.api?.avgResponseTime ?? 0

  const visibleHistory = history.filter(h => {
    if (!dateFilter) return true
    return h.timestamp.toLowerCase().includes(dateFilter.toLowerCase())
  })

  const summary = analytics?.summary
  const compareAgents = (compareData?.agents ?? []).filter(a => a.totalTasks > 0)

  return (
    <Layout title="Performance" subtitle="System performance metrics and trends">

      <div className={styles.statsRow}>
        <StatCard label="CPU Usage" value={`${cpu.toFixed(1)}%`} color="accent" />
        <StatCard label="Memory Usage" value={`${mem.toFixed(1)}%`} color="warning" />
        <StatCard label="Active Agents" value={activeAgents} color="success" />
        <StatCard label="Avg Response" value={`${avgResponse.toFixed(0)}ms`} color="neutral" />
      </div>

      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Agent Task Analytics</h2>
        <select
          className={styles.select}
          value={selectedAgent}
          onChange={e => setSelectedAgent(e.target.value)}
        >
          <option value="">All Agents</option>
          {agents.map(a => (
            <option key={a.id} value={a.id}>
              {a.config?.name ?? a.name ?? a.id}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.statsRow}>
        <div className={styles.analyticsCard}>
          <div className={styles.analyticsCardLabel}>Total Tasks</div>
          <div className={styles.analyticsCardValue}>{analyticsLoading ? '—' : (summary?.totalTasks ?? 0)}</div>
        </div>
        <div className={styles.analyticsCard}>
          <div className={styles.analyticsCardLabel}>Success Rate</div>
          <div className={styles.analyticsCardValue} style={{ color: 'var(--success)' }}>
            {analyticsLoading ? '—' : fmtPct(summary?.successRate ?? 0)}
          </div>
        </div>
        <div className={styles.analyticsCard}>
          <div className={styles.analyticsCardLabel}>Avg Duration</div>
          <div className={styles.analyticsCardValue} style={{ color: 'var(--accent)' }}>
            {analyticsLoading ? '—' : fmtDuration(summary?.avgDurationMs ?? 0)}
          </div>
        </div>
        <div className={styles.analyticsCard}>
          <div className={styles.analyticsCardLabel}>Failed Tasks</div>
          <div className={styles.analyticsCardValue} style={{ color: 'var(--danger)' }}>
            {analyticsLoading ? '—' : (summary?.failedTasks ?? 0)}
          </div>
        </div>
      </div>

      <div className={styles.chartsRow}>
        <div style={{ flex: 2, minWidth: 0 }}>
          <Card>
            <CardBody>
              <div className={styles.chartTitle}>Task Completion Trend ({period}d)</div>
              {analyticsLoading ? (
                <div className={styles.loading}>Loading…</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={analytics?.timeSeries ?? []} margin={{ top: 4, right: 16, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text2)' }} />
                    <YAxis tick={{ fontSize: 11, fill: 'var(--text2)' }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: 'var(--text)' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="completed" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} name="Completed" />
                    <Line type="monotone" dataKey="failed" stroke={CHART_COLORS[3]} strokeWidth={2} dot={false} name="Failed" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardBody>
          </Card>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <CardBody>
              <div className={styles.chartTitle}>Task Type Breakdown</div>
              {analyticsLoading || !analytics?.taskTypes.length ? (
                <div className={styles.loading}>{analyticsLoading ? 'Loading…' : 'No data'}</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={analytics.taskTypes}
                      dataKey="count"
                      nameKey="type"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                      labelLine={false}
                    >
                      {analytics.taskTypes.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {compareAgents.length > 0 && (
        <Card>
          <CardBody>
            <div className={styles.chartTitle}>Agent Comparison — Success Rate %</div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={compareAgents.map(a => ({
                  name: a.agentName,
                  successRate: Math.round(a.successRate * 100),
                  totalTasks: a.totalTasks,
                }))}
                margin={{ top: 4, right: 16, left: -16, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--text2)' }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text2)' }} unit="%" />
                <Tooltip
                  contentStyle={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                  formatter={(v: unknown) => [`${v}%`, 'Success Rate']}
                />
                <Bar dataKey="successRate" name="Success Rate" radius={[4, 4, 0, 0]}>
                  {compareAgents.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <div className={styles.chartTitle}>Slowest Tasks (Top 5)</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.th}>Task Type</th>
                <th className={styles.th}>Duration</th>
                <th className={styles.th}>Status</th>
                <th className={styles.th}>Date</th>
              </tr>
            </thead>
            <tbody>
              {!analyticsLoading && (analytics?.slowestTasks ?? []).length === 0 ? (
                <tr>
                  <td className={styles.td} colSpan={4} style={{ textAlign: 'center', color: 'var(--text2)' }}>
                    No task data available
                  </td>
                </tr>
              ) : (
                (analytics?.slowestTasks ?? []).map(t => (
                  <tr key={t.taskId} className={styles.tr}>
                    <td className={styles.td}><span className={styles.mono}>{t.type}</span></td>
                    <td className={styles.td}>{fmtDuration(t.durationMs)}</td>
                    <td className={styles.td}>
                      <Badge variant={t.status === 'completed' ? 'success' : t.status === 'failed' ? 'danger' : 'neutral'}>
                        {t.status}
                      </Badge>
                    </td>
                    <td className={styles.td}>
                      <span className={styles.mono}>{new Date(t.createdAt).toLocaleString()}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className={styles.toolbar}>
            <div className={styles.chartTitle} style={{ marginBottom: 0 }}>System Performance History</div>
            <input
              className={styles.search}
              placeholder="Filter by date…"
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value)}
            />
          </div>

          {loading ? (
            <div className={styles.loading}>Loading performance history…</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Timestamp</th>
                  <th className={styles.th}>CPU %</th>
                  <th className={styles.th}>Memory %</th>
                  <th className={styles.th}>Tasks</th>
                  <th className={styles.th}>Errors</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistory.length === 0 ? (
                  <tr>
                    <td className={styles.td} colSpan={5} style={{ textAlign: 'center', color: 'var(--text2)' }}>
                      {dateFilter ? 'No entries match your filter' : 'No history available'}
                    </td>
                  </tr>
                ) : (
                  visibleHistory.map((h, i) => (
                    <tr key={h.timestamp + i} className={styles.tr}>
                      <td className={styles.td}>
                        <span className={styles.mono}>
                          {new Date(h.timestamp).toLocaleString()}
                        </span>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={h.cpu > 80 ? 'danger' : h.cpu > 50 ? 'warning' : 'success'}>
                          {h.cpu.toFixed(1)}%
                        </Badge>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={h.memory > 80 ? 'danger' : h.memory > 50 ? 'warning' : 'success'}>
                          {h.memory.toFixed(1)}%
                        </Badge>
                      </td>
                      <td className={styles.td}>{h.tasks ?? '—'}</td>
                      <td className={styles.td}>
                        {h.errors != null
                          ? <Badge variant={h.errors > 0 ? 'danger' : 'neutral'}>{h.errors}</Badge>
                          : '—'
                        }
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </Layout>
  )
}

import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import Badge from '../components/Badge'
import StatCard from '../components/StatCard'
import { Card, CardBody, CardHeader } from '../components/Card'
import { api } from '../lib/api'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './DashboardPage.module.css'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
  BarChart, Bar,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type IncidentStatus = 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed'
type AgentStatus = 'active' | 'idle' | 'busy' | 'error' | 'offline'

interface Incident {
  id: string
  title: string
  severity: Severity
  status: IncidentStatus
  createdAt: string
  resolvedAt?: string | null
  escalationLevel?: number
  escalatedAt?: string | null
  serverId?: string | null
}

interface ActivityItem {
  id: string
  timestamp: string
  kind:
    | 'incident_opened' | 'incident_escalated' | 'incident_resolved' | 'incident_closed'
    | 'agent_note' | 'agent_action' | 'escalation_level' | 'remediation_step'
  message: string
  actor: string
  actorName?: string
  incidentId?: string
  incidentTitle?: string
  level?: number
}

interface Agent {
  id: string
  name: string
  status?: AgentStatus
  type?: string
  role?: string
  currentTask?: string
  currentTaskId?: string
  currentTaskStartedAt?: string
}

/** /api/agents currently returns an org-chart shape:
 *   { director: Agent, sysadmins: Agent[], specialists: Agent[] }
 *  but a flat {agents: Agent[]} is also possible (and is the shape
 *  the rest of the dashboard wants). The flatten helper handles both. */
interface AgentsResponse {
  agents?: Agent[]
  director?: Agent
  sysadmins?: Agent[]
  specialists?: Agent[]
}

function flattenAgents(res: AgentsResponse | null | undefined): Agent[] {
  if (!res) return []
  if (Array.isArray(res.agents)) return res.agents
  const out: Agent[] = []
  if (res.director) out.push(res.director)
  if (Array.isArray(res.sysadmins))   out.push(...res.sysadmins)
  if (Array.isArray(res.specialists)) out.push(...res.specialists)
  return out
}

interface Task {
  id: string
  title: string
  status: string
  createdAt: string
  updatedAt?: string
  assignedTo?: string
  ownerId?: string
}

/** /api/performance returns a nested system-resource shape:
 *   { system: { cpu: { usage }, memory: { percentage }, disk: { ... } } }
 *  Every property is optional so the dashboard can still render
 *  partial data — the cpuPct() helper below extracts a numeric usage
 *  with a safe default so .toFixed() can never see undefined. */
interface Performance {
  system?: {
    cpu?: { usage?: number; cores?: number }
    memory?: { used?: number; total?: number; percentage?: number }
    disk?: { used?: number; total?: number; percentage?: number }
  }
  uptime?: number
  requestsPerMinute?: number
}

function cpuPct(p: Performance | null): number | null {
  if (!p?.system?.cpu) return null
  const v = p.system.cpu.usage
  return typeof v === 'number' ? v : null
}

interface FeedEvent {
  type: string
  message: string
  ts: number
}

/** Trimmed shape of /api/servers — we only need the fields used in the
 *  Dashboard "Server Health" card. The full Server type lives in
 *  lib/types.ts; redeclared locally to keep the import surface small. */
interface ServerRecord {
  id: string
  name: string
  host: string | null
  isLocal: boolean
  enabled: boolean
  lastCheckStatus: 'ok' | 'error' | 'unknown'
  lastSeen: string | null
}

// ── Widget config ─────────────────────────────────────────────────────────────

const WIDGETS = [
  { id: 'stat-cards',          label: 'Stat Cards',              icon: '📊', defaultVisible: true  },
  { id: 'incident-trend-24h',  label: 'Created vs Resolved (24h)', icon: '📈', defaultVisible: true  },
  { id: 'severity-pie',        label: 'Severity Distribution',   icon: '🥧', defaultVisible: true  },
  { id: 'status-bar',          label: 'Incident Status Bar',     icon: '📉', defaultVisible: false },
  { id: 'active-escalations',  label: 'Active Escalations',      icon: '🆘', defaultVisible: true  },
  { id: 'activity-feed',       label: 'Recent Agent Activity',   icon: '⚡', defaultVisible: true  },
  { id: 'active-agents',       label: 'Active Agents',           icon: '🤖', defaultVisible: true  },
  { id: 'recent-incidents',    label: 'Recent Incidents',        icon: '🚨', defaultVisible: true  },
  { id: 'server-health',       label: 'Server Health',           icon: '🖥️', defaultVisible: true  },
  { id: 'recurring-problems',  label: 'Recurring Problems',      icon: '↻',  defaultVisible: true  },
] as const

type WidgetId = typeof WIDGETS[number]['id']

const LS_KEY = 'beacon-dashboard-widgets'

function loadVisibleWidgets(): WidgetId[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw) as WidgetId[]
  } catch {}
  return WIDGETS.filter(w => w.defaultVisible).map(w => w.id)
}

function saveVisibleWidgets(ids: WidgetId[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(ids))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const age = (d: string) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000
  if (s < 60) return '<1m'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Human-readable duration since `start`. Returns null on missing/invalid. */
const since = (start?: string): string | null => {
  if (!start) return null
  const t = new Date(start).getTime()
  if (!Number.isFinite(t)) return null
  return age(start)
}

const severityVariant = (s: Severity): 'danger' | 'warning' | 'accent' => {
  if (s === 'critical' || s === 'high') return 'danger'
  if (s === 'medium') return 'warning'
  return 'accent'
}

const statusVariant = (s: IncidentStatus): 'danger' | 'warning' | 'success' | 'neutral' => {
  if (s === 'open') return 'danger'
  if (s === 'investigating' || s === 'mitigating') return 'warning'
  if (s === 'resolved') return 'success'
  return 'neutral'
}

const eventColor: Record<string, string> = {
  task_completed: 'var(--success)',
  task_failed: 'var(--danger)',
  critical_incident: 'var(--danger)',
  workflow_started: 'var(--accent)',
  agent_bus_message: 'var(--text3)',
}

const eventLabel: Record<string, string> = {
  task_completed: 'Task Completed',
  task_failed: 'Task Failed',
  critical_incident: 'Critical Incident',
  workflow_started: 'Workflow Started',
  agent_bus_message: 'Agent Message',
}

const formatEventMessage = (event: { type: string; data?: unknown }): string => {
  if (typeof event.data === 'object' && event.data !== null) {
    const d = event.data as Record<string, unknown>
    return String(d.message ?? d.title ?? d.name ?? event.type)
  }
  if (typeof event.data === 'string') return event.data
  return event.type
}

// ── Customize Modal ───────────────────────────────────────────────────────────

function CustomizeModal({
  open, onClose, visible, onChange,
}: {
  open: boolean
  onClose: () => void
  visible: WidgetId[]
  onChange: (ids: WidgetId[]) => void
}) {
  if (!open) return null

  const toggle = (id: WidgetId) => {
    const next = visible.includes(id)
      ? visible.filter(v => v !== id)
      : [...visible, id]
    onChange(next)
  }

  const resetDefaults = () => {
    onChange(WIDGETS.filter(w => w.defaultVisible).map(w => w.id))
  }

  return (
    <div className={styles.modalOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>⚙️ Customize Dashboard</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>
        <div className={styles.modalBody}>
          <p className={styles.modalDesc}>Toggle widgets to show or hide them on the dashboard.</p>
          <ul className={styles.widgetList}>
            {WIDGETS.map(w => {
              const isOn = visible.includes(w.id)
              return (
                <li key={w.id} className={styles.widgetRow}>
                  <span className={styles.widgetIcon}>{w.icon}</span>
                  <span className={styles.widgetLabel}>{w.label}</span>
                  <button
                    role="switch"
                    aria-checked={isOn}
                    className={`${styles.toggle} ${isOn ? styles.toggleOn : ''}`}
                    onClick={() => toggle(w.id)}
                    title={isOn ? 'Hide widget' : 'Show widget'}
                  >
                    <span className={styles.toggleThumb} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.resetBtn} onClick={resetDefaults}>Reset to defaults</button>
          <button className={styles.doneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [perf, setPerf] = useState<Performance | null>(null)
  const [servers, setServers] = useState<ServerRecord[]>([])
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([])
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [visibleWidgets, setVisibleWidgets] = useState<WidgetId[]>(loadVisibleWidgets)

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { connected, lastEvent } = useWebSocket()
  const navigate = useNavigate()

  const fetchAll = useCallback(async () => {
    // Each endpoint is fetched independently with .catch() returning an
    // empty shape — so one 403/500 (e.g. /api/incidents before login)
    // doesn't blank out the whole dashboard. Every state setter falls
    // back to [] / null when the response shape is missing the
    // expected key, which prevents .filter()-on-undefined crashes if
    // an endpoint changes shape on the server side.
    try {
      const [incRes, agentRes, taskRes, perfRes, srvRes, actRes] = await Promise.all([
        api.get<{ incidents?: Incident[] }>('/api/incidents').catch(() => ({ incidents: [] })),
        api.get<AgentsResponse>('/api/agents').catch(() => ({} as AgentsResponse)),
        api.get<{ tasks?: Task[] }>('/api/task-queue').catch(() => ({ tasks: [] })),
        api.get<Performance>('/api/performance').catch(() => null),
        api.get<{ servers?: ServerRecord[] }>('/api/servers').catch(() => ({ servers: [] })),
        api.get<{ items?: ActivityItem[] }>('/api/activity/recent?limit=15').catch(() => ({ items: [] })),
      ])
      setIncidents(Array.isArray(incRes?.incidents) ? incRes.incidents : [])
      setAgents(flattenAgents(agentRes))
      setTasks(Array.isArray(taskRes?.tasks) ? taskRes.tasks : [])
      setPerf(perfRes)
      setServers(Array.isArray(srvRes?.servers) ? srvRes.servers : [])
      setActivity(Array.isArray(actRes?.items) ? actRes.items : [])
    } catch {
      // silent on poll failures — defaults above keep the dashboard rendering
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
    pollingRef.current = setInterval(fetchAll, 30_000)
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [fetchAll])

  // Append WebSocket events to activity feed
  useEffect(() => {
    if (!lastEvent) return
    const knownTypes = ['task_completed', 'task_failed', 'critical_incident', 'workflow_started', 'agent_bus_message']
    if (!knownTypes.includes(lastEvent.type)) return
    setFeedEvents(prev => [
      { type: lastEvent.type, message: formatEventMessage(lastEvent), ts: Date.now() },
      ...prev,
    ].slice(0, 10))
  }, [lastEvent])

  const handleWidgetChange = (ids: WidgetId[]) => {
    setVisibleWidgets(ids)
    saveVisibleWidgets(ids)
  }

  const isVisible = (id: WidgetId) => visibleWidgets.includes(id)

  // ── Derived stats ────────────────────────────────────────────────────────
  const openIncidents = incidents.filter(i => i.status !== 'resolved' && i.status !== 'closed').length
  // "Active" here means deployed-and-reachable, not workload. Idle agents
  // are still active (ready to take work); busy means currently on an
  // incident. Offline/error are excluded.
  const activeAgents = agents.filter(a => a.status !== 'offline' && a.status !== 'error').length
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length
  const cpu = cpuPct(perf)
  const healthGood = cpu !== null ? cpu < 80 : null

  const recentIncidents = incidents.slice(0, 5)

  // ── Chart data ───────────────────────────────────────────────────────────
  // Created vs resolved over the last 24h, bucketed into 2-hour buckets.
  // Bucket size is a balance: too coarse and you lose intra-day patterns,
  // too fine (e.g. 15min) and the chart gets noisy.
  const trend24hData = (() => {
    const buckets = 12 // 12 × 2h = 24h
    const bucketMs = 2 * 3600 * 1000
    const now = Date.now()
    const out: Array<{ label: string; created: number; resolved: number }> = []
    for (let i = buckets - 1; i >= 0; i--) {
      const start = now - (i + 1) * bucketMs
      const end   = now - i * bucketMs
      const label = new Date(end).toLocaleTimeString([], { hour: '2-digit' })
      let created = 0, resolved = 0
      for (const inc of incidents) {
        const c = Date.parse(inc.createdAt)
        if (Number.isFinite(c) && c >= start && c < end) created++
        if (inc.resolvedAt) {
          const r = Date.parse(inc.resolvedAt)
          if (Number.isFinite(r) && r >= start && r < end) resolved++
        }
      }
      out.push({ label, created, resolved })
    }
    return out
  })()

  // Active escalations grouped by level. Filters out closed/resolved.
  const activeEscalations = incidents.filter(i =>
    (i.escalationLevel ?? 0) >= 1
    && i.status !== 'resolved' && i.status !== 'closed',
  )
  const escByLevel = [1, 2, 3, 4].map(level => ({
    level,
    items: activeEscalations.filter(i => (i.escalationLevel ?? 0) === level),
  }))

  const severityColors: Record<string, string> = {
    critical: '#EF4444', high: '#F59E0B', medium: '#306EF0', low: '#22C55E',
  }
  const severityData = (['critical', 'high', 'medium', 'low'] as const).map(sev => ({
    name: sev,
    value: incidents.filter(inc => inc.severity === sev).length,
  })).filter(d => d.value > 0)

  const statusColors: Record<string, string> = {
    open: '#EF4444', in_progress: '#F59E0B', resolved: '#22C55E',
  }
  const statusData = [
    { name: 'open', value: incidents.filter(i => i.status === 'open').length },
    { name: 'in_progress', value: incidents.filter(i => i.status === 'investigating' || i.status === 'mitigating').length },
    { name: 'resolved', value: incidents.filter(i => i.status === 'resolved' || i.status === 'closed').length },
  ]

  // ── Server health summary ─────────────────────────────────────────────────
  // ServerRegistry uses lastCheckStatus ('ok'|'error'|'unknown') and a
  // separate `enabled` flag. Roll both into a single dashboard bucket.
  const serverStatusCounts = servers.reduce<Record<string, number>>((acc, srv) => {
    const bucket = !srv.enabled ? 'disabled' : srv.lastCheckStatus
    acc[bucket] = (acc[bucket] ?? 0) + 1
    return acc
  }, {})

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Layout title="Dashboard" subtitle="System overview and real-time activity">
      {/* Top bar: WS indicator + Customize button */}
      <div className={styles.topBar}>
        <div className={styles.wsIndicator}>
          <span className={`${styles.wsDot} ${connected ? styles.wsDotConnected : styles.wsDotDisconnected}`} />
          <span className={styles.wsLabel}>{connected ? 'Live' : 'Reconnecting…'}</span>
        </div>
        <button className={styles.customizeBtn} onClick={() => setCustomizeOpen(true)}>
          ⚙️ Customize
        </button>
      </div>

      {/* Widget: Stat Cards */}
      {isVisible('stat-cards') && (
        <div className={styles.statsRow}>
          <StatCard
            label="Open Incidents"
            value={loading ? '—' : openIncidents}
            color={openIncidents > 0 ? 'danger' : 'success'}
          />
          <StatCard
            label="Active Agents"
            value={loading ? '—' : activeAgents}
            color={activeAgents > 0 ? 'success' : 'neutral'}
          />
          <StatCard
            label="Pending Tasks"
            value={loading ? '—' : pendingTasks}
            color={pendingTasks > 0 ? 'warning' : 'success'}
          />
          <StatCard
            label="System Health"
            value={healthGood === null ? '—' : healthGood ? 'Good' : 'Warning'}
            sub={cpu !== null ? `CPU ${cpu.toFixed(0)}%` : undefined}
            color={healthGood === null ? 'neutral' : healthGood ? 'success' : 'warning'}
          />
        </div>
      )}

      {/* Charts Row — only render row if at least one chart widget is visible */}
      {(isVisible('incident-trend-24h') || isVisible('severity-pie') || isVisible('status-bar')) && (
        <div className={styles.chartsRow}>
          {isVisible('incident-trend-24h') && (
            <div className={styles.chartCard}>
              <div className={styles.chartTitle}>Incidents — Created vs Resolved (24h)</div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trend24hData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fill: 'var(--text2)', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fill: 'var(--text2)', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text)' }}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 11, color: 'var(--text2)' }} />
                  <Line type="monotone" dataKey="created"  name="created"  stroke="#EF4444" strokeWidth={2} dot={{ r: 2 }} />
                  <Line type="monotone" dataKey="resolved" name="resolved" stroke="#22C55E" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {isVisible('severity-pie') && (
            <div className={styles.chartCard}>
              <div className={styles.chartTitle}>By Severity</div>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={severityData} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={60} strokeWidth={0}>
                    {severityData.map(entry => (
                      <Cell key={entry.name} fill={severityColors[entry.name] ?? '#306EF0'} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    itemStyle={{ color: 'var(--text)' }}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 11, color: 'var(--text2)' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}

          {isVisible('status-bar') && (
            <div className={styles.chartCard}>
              <div className={styles.chartTitle}>By Status</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={statusData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fill: 'var(--text2)', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fill: 'var(--text2)', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: 'var(--text)' }}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {statusData.map(entry => (
                      <Cell key={entry.name} fill={statusColors[entry.name] ?? '#306EF0'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* Two-column grid: Recent Incidents + Server Health */}
      {(isVisible('recent-incidents') || isVisible('server-health')) && (
        <div className={`${styles.twoCol} ${
          isVisible('recent-incidents') && isVisible('server-health') ? '' : styles.twoColSingle
        }`}>
          {isVisible('recent-incidents') && (
            <Card>
              <CardHeader
                title="Recent Incidents"
                actions={<Link to="/incidents" className={styles.viewAll}>View all →</Link>}
              />
              <CardBody>
                {loading ? (
                  <div className={styles.loading}>Loading…</div>
                ) : recentIncidents.length === 0 ? (
                  <div className={styles.empty}>No incidents found.</div>
                ) : (
                  <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.th}>Severity</th>
                        <th className={styles.th}>Title</th>
                        <th className={styles.th}>Status</th>
                        <th className={styles.th}>Age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentIncidents.map(inc => (
                        <tr
                          key={inc.id}
                          className={`${styles.tr} ${styles.trClickable}`}
                          onClick={() => navigate(`/incidents/${inc.id}`)}
                          role="link"
                          tabIndex={0}
                          onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              navigate(`/incidents/${inc.id}`)
                            }
                          }}
                          title="View incident details"
                        >
                          <td className={styles.td}>
                            <Badge variant={severityVariant(inc.severity)}>{inc.severity}</Badge>
                          </td>
                          <td className={`${styles.td} ${styles.tdTitle}`}>{inc.title}</td>
                          <td className={styles.td}>
                            <Badge variant={statusVariant(inc.status)}>{inc.status}</Badge>
                          </td>
                          <td className={`${styles.td} ${styles.tdMono}`}>{age(inc.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {isVisible('server-health') && (
            <Card>
              <CardHeader
                title="Server Health"
                actions={<Link to="/servers" className={styles.viewAll}>View all →</Link>}
              />
              <CardBody>
                {loading ? (
                  <div className={styles.loading}>Loading…</div>
                ) : servers.length === 0 ? (
                  <div className={styles.empty}>No servers registered.</div>
                ) : (
                  // Per-server rows here (vs just bucket counts) — operators
                  // need to see WHICH host is having a problem, not just "1
                  // error somewhere". Each row links into ServersPage where
                  // they can drill into per-server metrics.
                  <ul className={styles.serverHealthList}>
                    {servers.map(srv => {
                      const stateClass = !srv.enabled
                        ? 'serverDot_disabled'
                        : srv.lastCheckStatus === 'ok' ? 'serverDot_ok'
                        : srv.lastCheckStatus === 'error' ? 'serverDot_error'
                        : 'serverDot_unknown'
                      return (
                        <li key={srv.id} className={styles.serverHealthItem}>
                          <span className={`${styles.serverDot} ${styles[stateClass]}`} title={srv.lastCheckStatus} />
                          <Link to={`/servers`} className={styles.serverNameLink}>
                            {srv.name}{srv.isLocal ? ' 🏠' : ''}
                          </Link>
                          <span className={styles.serverStatus}>
                            {!srv.enabled ? 'disabled' : srv.lastCheckStatus}
                          </span>
                          <span className={styles.serverCount} style={{ fontFamily: 'monospace', fontSize: '.72rem', color: 'var(--text3)' }}>
                            {srv.host ?? 'nsenter'}
                          </span>
                        </li>
                      )
                    })}
                    <li className={styles.serverHealthItem} style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)' }}>
                      <span className={styles.serverStatus} style={{ color: 'var(--text3)' }}>
                        {Object.entries(serverStatusCounts).map(([k, v]) => `${k}:${v}`).join(' · ')}
                      </span>
                      <span className={styles.serverCount}>{servers.length}</span>
                    </li>
                  </ul>
                )}
              </CardBody>
            </Card>
          )}
        </div>
      )}

      {/* Widget: Active Agents */}
      {isVisible('active-agents') && (
        <Card>
          <CardHeader
            title="Active Agents"
            subtitle="Agents currently working on tasks or incidents"
            actions={<Link to="/agents" className={styles.viewAll}>View all →</Link>}
          />
          <CardBody>
            {loading ? (
              <div className={styles.loading}>Loading…</div>
            ) : (() => {
              // An "active" agent here is one the UI considers to be doing work:
              //   - status === 'busy' (running a task), or
              //   - status === 'active' (legacy synonym some agents emit), or
              //   - has an in-flight task assigned to it.
              // Idle/offline/error agents are excluded so the list focuses on
              // real activity. The lookup is by id and falls back to ownerId.
              const activeTasks = tasks.filter(
                t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'assigned'
              )
              const taskByAgent = new Map<string, Task>()
              for (const t of activeTasks) {
                const agentId = t.assignedTo ?? t.ownerId
                if (!agentId) continue
                // Keep the most recently updated task per agent
                const prev = taskByAgent.get(agentId)
                if (!prev || (t.updatedAt ?? t.createdAt) > (prev.updatedAt ?? prev.createdAt)) {
                  taskByAgent.set(agentId, t)
                }
              }
              const activeAgentList = agents.filter(a => {
                if (a.status === 'busy' || a.status === 'active') return true
                if (taskByAgent.has(a.id)) return true
                return false
              })
              if (activeAgentList.length === 0) {
                return <div className={styles.empty}>No agents currently working.</div>
              }
              return (
                <ul className={styles.activeAgentList}>
                  {activeAgentList.map(a => {
                    const task = taskByAgent.get(a.id)
                    const startedAt =
                      a.currentTaskStartedAt ??
                      task?.updatedAt ??
                      task?.createdAt
                    const working = since(startedAt)
                    const taskTitle = a.currentTask ?? task?.title ?? '—'
                    const isBusy = a.status === 'busy' || a.status === 'active' || !!task
                    return (
                      <li key={a.id} className={styles.activeAgentItem}>
                        <span
                          className={`${styles.agentDot} ${isBusy ? styles.agentDot_active : styles.agentDot_idle}`}
                          aria-hidden
                        />
                        <span className={styles.activeAgentName}>{a.name}</span>
                        <span className={styles.activeAgentTask} title={taskTitle}>
                          {taskTitle}
                        </span>
                        <Badge variant={isBusy ? 'warning' : 'neutral'}>
                          {isBusy ? 'busy' : (a.status ?? 'idle')}
                        </Badge>
                        <span className={styles.activeAgentTime}>
                          {working ? `${working} ago` : '—'}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )
            })()}
          </CardBody>
        </Card>
      )}

      {/* Widget: Active Escalations — grouped by pipeline level */}
      {isVisible('active-escalations') && (
        <Card>
          <CardHeader
            title="Active Escalations"
            subtitle="Incidents currently in the escalation pipeline (L1+)"
          />
          <CardBody>
            {loading ? (
              <div className={styles.loading}>Loading…</div>
            ) : activeEscalations.length === 0 ? (
              <div className={styles.empty}>No active escalations — all incidents are either new (L0) or resolved.</div>
            ) : (
              <div className={styles.escGrid}>
                {escByLevel.map(({ level, items }) => (
                  <div key={level} className={`${styles.escCol} ${styles[`escCol_L${level}`]}`}>
                    <div className={styles.escColHead}>
                      <span className={styles.escLevel}>L{level}</span>
                      <span className={styles.escLevelName}>
                        {level === 1 && 'Agent'}
                        {level === 2 && 'Auto-remediator'}
                        {level === 3 && 'Human paged'}
                        {level === 4 && 'Critical'}
                      </span>
                      <span className={styles.escCount}>{items.length}</span>
                    </div>
                    {items.length === 0 ? (
                      <div className={styles.escEmpty}>—</div>
                    ) : (
                      <ul className={styles.escList}>
                        {items.slice(0, 4).map(inc => (
                          <li key={inc.id} className={styles.escItem}>
                            <Link to={`/incidents/${inc.id}`} className={styles.escTitle}>
                              {inc.title}
                            </Link>
                            <span className={styles.escMeta}>
                              <Badge variant={severityVariant(inc.severity)}>{inc.severity}</Badge>
                              <span className={styles.escAge}>{age(inc.escalatedAt ?? inc.createdAt)}</span>
                            </span>
                          </li>
                        ))}
                        {items.length > 4 && (
                          <li className={styles.escMore}>+ {items.length - 4} more</li>
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Widget: Recent Agent Activity — uses /api/activity, falls back to WS events */}
      {isVisible('activity-feed') && (
        <Card>
          <CardHeader
            title="Recent Agent Activity"
            subtitle="Latest agent + escalation pipeline events across all incidents"
          />
          <CardBody>
            {loading && activity.length === 0 ? (
              <div className={styles.loading}>Loading…</div>
            ) : activity.length === 0 && feedEvents.length === 0 ? (
              <div className={styles.empty}>No recent activity in the last 24h.</div>
            ) : (
              <ul className={styles.feedList}>
                {activity.slice(0, 10).map(item => {
                  const dotColor =
                    item.kind === 'incident_opened'    ? 'var(--danger)' :
                    item.kind === 'incident_escalated' ? 'var(--warning)' :
                    item.kind === 'incident_resolved'  ? 'var(--success)' :
                    item.kind === 'incident_closed'    ? 'var(--text3)' :
                    item.kind === 'escalation_level'   ? 'var(--warm)' :
                    item.kind === 'remediation_step'   ? 'var(--info)' :
                                                          'var(--accent)'
                  const who = item.actorName ?? item.actor
                  return (
                    <li key={item.id} className={styles.feedItem}>
                      <span className={styles.feedDot} style={{ background: dotColor }} />
                      <span className={styles.feedType}>{who}</span>
                      <span className={styles.feedMessage} title={item.message}>
                        {item.incidentId && item.incidentTitle && (
                          <Link to={`/incidents/${item.incidentId}`} className={styles.feedIncident}>
                            {item.incidentId.slice(-8)}
                          </Link>
                        )} {item.message}
                      </span>
                      <span className={styles.feedTs}>{age(item.timestamp)} ago</span>
                    </li>
                  )
                })}
                {/* Append the live WS-event stream below so operators see
                    things happen in real time, not just on the 30s poll. */}
                {feedEvents.slice(0, 3).map((ev, i) => (
                  <li key={`ws-${i}`} className={styles.feedItem}>
                    <span
                      className={styles.feedDot}
                      style={{ background: eventColor[ev.type] ?? 'var(--text3)' }}
                    />
                    <span className={styles.feedType}>{eventLabel[ev.type] ?? ev.type}</span>
                    <span className={styles.feedMessage}>{ev.message}</span>
                    <span className={styles.feedTs}>{new Date(ev.ts).toLocaleTimeString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {/* Customize modal */}
      <CustomizeModal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        visible={visibleWidgets}
        onChange={handleWidgetChange}
      />

      {isVisible('recurring-problems') && <RecurringProblemsWidget />}
    </Layout>
  )
}

// ── Recurring Problems widget ─────────────────────────────────────────
// Surfaces the open-problem count + the top 3 recurring problems by
// occurrence. Refreshes on `problem_created` WebSocket events.

interface ProblemView {
  id: string
  title: string
  status: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  serverId: string | null
  sourceRefPattern: string | null
  lastSeenAt: string
}

function RecurringProblemsWidget() {
  const [topRecurring, setTopRecurring] = useState<Array<{ problem: ProblemView; occurrences: number }>>([])
  const [stats, setStats] = useState<{ open: number; investigating: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const { lastEvent } = useWebSocket()

  const reload = useCallback(async () => {
    try {
      const [list, top] = await Promise.all([
        api.get<{ stats: { open: number; investigating: number } }>('/api/problems?status=open'),
        api.get<{ top: Array<{ problem: ProblemView; occurrences: number }> }>('/api/problems/top-recurring?limit=3'),
      ])
      setStats(list?.stats ?? null)
      setTopRecurring(Array.isArray(top?.top) ? top.top : [])
    } catch {
      // Silent — widget is best-effort.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (!lastEvent) return
    const t = String((lastEvent as { type?: string }).type ?? '')
    if (t === 'problem_created' || t === 'problem_updated') reload()
  }, [lastEvent, reload])

  return (
    <Card>
      <CardHeader
        title="Recurring Problems"
        subtitle="Incidents that keep happening — surfaced for root-cause review"
        actions={<Link to="/problems" className={styles.viewAll}>View all →</Link>}
      />
      <CardBody>
        {loading ? (
          <div className={styles.loading}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)' }}>{stats?.open ?? 0}</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Open problems</div>
              </div>
              <div>
                <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)' }}>{stats?.investigating ?? 0}</div>
                <div style={{ fontSize: '.7rem', color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Investigating</div>
              </div>
            </div>
            {topRecurring.length === 0 ? (
              <div className={styles.empty}>No recurring problems detected.</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {topRecurring.map(({ problem, occurrences }) => (
                  <li key={problem.id} style={{ padding: '6px 10px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <Link to={`/problems/${problem.id}`} style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono, monospace)', fontSize: '.78rem', fontWeight: 600 }}>
                      {problem.id}
                    </Link>
                    <span style={{ marginLeft: 8, color: 'var(--text)', fontWeight: 500 }}>{problem.title}</span>
                    <span style={{ marginLeft: 8, color: 'var(--danger)', fontSize: '.75rem' }}>×{occurrences}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

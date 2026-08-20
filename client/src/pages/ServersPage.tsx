import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import StatCard from '../components/StatCard'
import { Card, CardBody, CardHeader } from '../components/Card'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { toast } from '../hooks/useToast'
import type { Server, MetricSeries, MetricSample, Incident } from '../lib/types'
import styles from './ServersPage.module.css'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

interface AddServerForm {
  name: string
  host: string
  sshUser: string
  sshPort: string
  sshKeyPath: string
}

const EMPTY_FORM: AddServerForm = { name: '', host: '', sshUser: '', sshPort: '22', sshKeyPath: '' }

/** Map the registry's `lastCheckStatus` to a UI badge variant. The
 *  registry doesn't track "online/offline" explicitly — instead, every
 *  successful command (probe or test) stamps `ok`, every failed exec
 *  stamps `error`, and a never-tested row stays `unknown`. */
function statusBadgeVariant(status: Server['lastCheckStatus']): 'success' | 'danger' | 'neutral' {
  if (status === 'ok') return 'success'
  if (status === 'error') return 'danger'
  return 'neutral'
}

function metricVariant(pct?: number): 'danger' | 'warning' | 'success' | 'neutral' {
  if (pct == null || !Number.isFinite(pct)) return 'neutral'
  if (pct > 90) return 'danger'
  if (pct > 75) return 'warning'
  return 'success'
}

function ageOf(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60)    return `${Math.floor(s)}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Find latest sample matching (metricType, dimension?). For disk we
 *  return the max across mounts so the table shows "worst" disk %. */
function latestPct(samples: MetricSample[], type: MetricSample['metricType']): number | undefined {
  const filtered = samples.filter(s => s.metricType === type)
  if (filtered.length === 0) return undefined
  if (type === 'disk') return Math.max(...filtered.map(s => s.value))
  return filtered[0].value
}

/** Format `[L3] notifying human channels — agent gave up` style notes
 *  into a friendly chip. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

// ─── Mini chart ───────────────────────────────────────────────────────────────

const CHART_COLORS = {
  cpu: '#306EF0',
  memory: '#22C55E',
  disk: '#E8734A',
}

function MetricChart({ title, color, series }: {
  title: string
  color: string
  series: MetricSeries | null
}) {
  const data = series?.points.map(p => ({
    t: p.ts,
    label: new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    value: Math.round(p.value * 10) / 10,
  })) ?? []
  return (
    <div className={styles.chartCard}>
      <div className={styles.chartTitle}>{title}</div>
      {data.length === 0 ? (
        <div className={styles.chartEmpty}>No samples yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fill: 'var(--text2)', fontSize: 10 }} />
            <YAxis tick={{ fill: 'var(--text2)', fontSize: 10 }} domain={[0, 'auto']} />
            <Tooltip
              contentStyle={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: 'var(--text)' }}
              itemStyle={{ color }}
            />
            <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function ServerDetailModal({
  server, open, onClose, incidents,
}: {
  server: Server | null
  open: boolean
  onClose: () => void
  incidents: Incident[]
}) {
  const [latest, setLatest] = useState<MetricSample[]>([])
  const [cpuSeries, setCpuSeries]       = useState<MetricSeries | null>(null)
  const [memSeries, setMemSeries]       = useState<MetricSeries | null>(null)
  const [diskSeries, setDiskSeries]     = useState<MetricSeries | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const fetchSeries = useCallback(async () => {
    if (!server) return
    const windowMs = 6 * 3600 * 1000   // last 6h on detail view
    const q = (mt: string) => `/api/metrics-history/series?serverId=${encodeURIComponent(server.id)}&metricType=${mt}&windowMs=${windowMs}&limit=400`
    try {
      const [latestRes, cpu, mem, disk] = await Promise.all([
        api.get<{ samples: MetricSample[] }>(`/api/metrics-history/latest?serverId=${encodeURIComponent(server.id)}`).catch(() => ({ samples: [] })),
        api.get<MetricSeries>(q('cpu')).catch(() => null),
        api.get<MetricSeries>(q('memory')).catch(() => null),
        api.get<MetricSeries>(q('disk')).catch(() => null),
      ])
      setLatest(Array.isArray(latestRes?.samples) ? latestRes.samples : [])
      setCpuSeries(cpu)
      setMemSeries(mem)
      setDiskSeries(disk)
    } catch { /* swallow — chart shows "no samples" */ }
  }, [server])

  useEffect(() => {
    if (open) fetchSeries()
  }, [open, fetchSeries])

  async function runTest() {
    if (!server) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.post<{ ok: boolean; detail: string; durationMs: number }>(`/api/servers/${server.id}/test`, {})
      setTestResult(r.ok ? `✅ ${r.detail}` : `❌ ${r.detail}`)
      if (r.ok) toast.success(`Reachable in ${r.durationMs}ms`)
      else toast.error('Connectivity test failed')
    } catch {
      setTestResult('❌ test request failed')
      toast.error('Test request failed')
    } finally {
      setTesting(false)
    }
  }

  if (!server) return null

  const incidentsForServer = incidents.filter(i =>
    (i as Incident & { serverId?: string | null }).serverId === server.id
    && i.status !== 'resolved' && i.status !== 'closed',
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${server.name} ${server.isLocal ? '(local)' : ''}`}
      width={900}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          <Button variant="primary" size="sm" loading={testing} onClick={runTest}>
            🔌 Test connectivity
          </Button>
        </>
      }
    >
      <div className={styles.detailGrid}>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Host</span>
          <span className={styles.detailVal}>{server.isLocal ? 'nsenter (this host)' : server.host}</span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>SSH</span>
          <span className={styles.detailVal}>
            {server.isLocal ? '—' : `${server.sshUser}@${server.host}:${server.sshPort}`}
          </span>
        </div>
        <div className={styles.detailRow}>
          <span className={styles.detailLabel}>Status</span>
          <span className={styles.detailVal}>
            <Badge variant={statusBadgeVariant(server.lastCheckStatus)}>{server.lastCheckStatus}</Badge>
            <span className={styles.detailSub}> &nbsp; last check {ageOf(server.lastCheckAt)} · last seen {ageOf(server.lastSeen)}</span>
          </span>
        </div>
        {server.tags.length > 0 && (
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Tags</span>
            <span className={styles.detailVal}>
              {server.tags.map(t => <Badge key={t} variant="neutral">{t}</Badge>)}
            </span>
          </div>
        )}
        {testResult && (
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Probe</span>
            <span className={styles.detailVal}><code className={styles.code}>{testResult}</code></span>
          </div>
        )}
      </div>

      <div className={styles.chartsGrid}>
        <MetricChart title="CPU % (6h)"    color={CHART_COLORS.cpu}    series={cpuSeries} />
        <MetricChart title="Memory % (6h)" color={CHART_COLORS.memory} series={memSeries} />
        <MetricChart title="Disk % (6h)"   color={CHART_COLORS.disk}   series={diskSeries} />
      </div>

      <Card>
        <CardHeader title={`Active incidents (${incidentsForServer.length})`} />
        <CardBody>
          {incidentsForServer.length === 0 ? (
            <div className={styles.empty}>No active incidents for this server.</div>
          ) : (
            <ul className={styles.incidentList}>
              {incidentsForServer.slice(0, 8).map(i => (
                <li key={i.id} className={styles.incidentListItem}>
                  <Badge variant={i.severity === 'critical' || i.severity === 'high' ? 'danger' : 'warning'}>
                    {i.severity}
                  </Badge>
                  <Link to={`/incidents/${i.id}`} className={styles.incidentLink}>{i.title}</Link>
                  <span className={styles.incidentMeta}>{i.status}</span>
                  <span className={styles.incidentMeta}>{ageOf(i.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </Modal>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ServersPage() {
  const [servers, setServers] = useState<Server[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  /** Map of serverId → latest sample list (one row each for cpu, memory,
   *  disk:*, load1, load5). Driven by /api/metrics-history/latest so the
   *  table can show current % without firing N round-trips per row. */
  const [latestByServer, setLatestByServer] = useState<Record<string, MetricSample[]>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<AddServerForm>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [detailServer, setDetailServer] = useState<Server | null>(null)

  const fetchServers = useCallback(async () => {
    try {
      const data = await api.get<{ servers?: Server[] } | Server[]>('/api/servers')
      const list = Array.isArray(data) ? data : data?.servers
      const arr = Array.isArray(list) ? list : []
      setServers(arr)
      // Fan-out latest-sample fetch — small payload, gives us live %
      // for the table without a per-server SSH probe.
      const latestMap: Record<string, MetricSample[]> = {}
      await Promise.all(arr.map(async s => {
        try {
          const r = await api.get<{ samples?: MetricSample[] }>(`/api/metrics-history/latest?serverId=${encodeURIComponent(s.id)}`)
          latestMap[s.id] = Array.isArray(r?.samples) ? r.samples : []
        } catch {
          latestMap[s.id] = []
        }
      }))
      setLatestByServer(latestMap)
    } catch {
      toast.error('Failed to load servers')
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchIncidents = useCallback(async () => {
    try {
      const r = await api.get<{ incidents?: Incident[] }>('/api/incidents')
      setIncidents(Array.isArray(r?.incidents) ? r.incidents : [])
    } catch { /* non-fatal; modal renders empty */ }
  }, [])

  useEffect(() => {
    fetchServers()
    fetchIncidents()
    const interval = setInterval(() => { fetchServers(); fetchIncidents() }, 30_000)
    return () => clearInterval(interval)
  }, [fetchServers, fetchIncidents])

  async function handleAddServer() {
    if (!form.name.trim() || !form.host.trim() || !form.sshUser.trim()) {
      toast.error('Name, host, and SSH user are required')
      return
    }
    setSubmitting(true)
    try {
      await api.post('/api/servers', {
        name: form.name.trim(),
        host: form.host.trim(),
        sshUser: form.sshUser.trim(),
        sshPort: form.sshPort ? Number(form.sshPort) : 22,
        sshKeyPath: form.sshKeyPath.trim() || undefined,
      })
      toast.success('Server added')
      setShowAdd(false)
      setForm(EMPTY_FORM)
      fetchServers()
    } catch {
      toast.error('Failed to add server')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id: string, name: string, isLocal: boolean) {
    if (isLocal) {
      toast.error('The local server cannot be removed')
      return
    }
    if (!window.confirm(`Remove server "${name}"? Incidents stay; just stops monitoring.`)) return
    try {
      await api.delete(`/api/servers/${id}`)
      toast.success('Server removed')
      setServers(prev => prev.filter(s => s.id !== id))
    } catch {
      toast.error('Failed to remove server')
    }
  }

  async function handleTest(id: string) {
    try {
      const r = await api.post<{ ok: boolean; detail: string; durationMs: number }>(`/api/servers/${id}/test`, {})
      if (r.ok) toast.success(`Reachable (${r.durationMs}ms)`)
      else toast.error(`Failed: ${r.detail.slice(0, 100)}`)
      // Re-fetch so the row's lastCheckStatus + ageOf(lastCheckAt) refresh.
      fetchServers()
    } catch {
      toast.error('Test request failed')
    }
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  const okCount    = servers.filter(s => s.lastCheckStatus === 'ok').length
  const errCount   = servers.filter(s => s.lastCheckStatus === 'error').length
  const offCount   = servers.filter(s => !s.enabled).length
  const incidentsByServer = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of incidents) {
      if (i.status === 'resolved' || i.status === 'closed') continue
      const sid = (i as Incident & { serverId?: string | null }).serverId
      if (!sid) continue
      m.set(sid, (m.get(sid) ?? 0) + 1)
    }
    return m
  }, [incidents])

  const visible = servers.filter(s =>
    !search
      ? true
      : s.name.toLowerCase().includes(search.toLowerCase())
        || (s.host ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <Layout
      title="Servers"
      subtitle="Monitored hosts — local + remote (SSH)"
      actions={
        <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
          + Add Server
        </Button>
      }
    >
      <div className={styles.statsRow}>
        <StatCard label="Total" value={servers.length} />
        <StatCard label="Reachable" value={okCount} color="success" />
        <StatCard label="Errors" value={errCount} color={errCount > 0 ? 'danger' : 'neutral'} />
        <StatCard label="Disabled" value={offCount} color="neutral" />
      </div>

      <Card>
        <CardBody>
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              placeholder="Search by name or host…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          {loading ? (
            <div className={styles.loading}>Loading servers…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon="🖥️"
              title="No servers found"
              description={servers.length === 0 ? 'Add your first remote server to start monitoring.' : 'No servers match your search.'}
              action={servers.length === 0 ? { label: '+ Add Server', onClick: () => setShowAdd(true) } : undefined}
            />
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Host / SSH</th>
                  <th className={styles.th}>Status</th>
                  <th className={styles.th}>CPU%</th>
                  <th className={styles.th}>Memory%</th>
                  <th className={styles.th}>Disk%</th>
                  <th className={styles.th}>Last seen</th>
                  <th className={styles.th}>Incidents</th>
                  <th className={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(server => {
                  const latest = latestByServer[server.id] ?? []
                  const cpu = latestPct(latest, 'cpu')
                  const mem = latestPct(latest, 'memory')
                  const disk = latestPct(latest, 'disk')
                  const incCount = incidentsByServer.get(server.id) ?? 0
                  return (
                    <tr key={server.id} className={styles.tr}>
                      <td className={styles.td}>
                        <button
                          className={styles.linkLike}
                          onClick={() => setDetailServer(server)}
                          title="Show details"
                        >
                          {server.name}{server.isLocal ? ' 🏠' : ''}
                        </button>
                      </td>
                      <td className={styles.td} style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>
                        {server.isLocal ? <span style={{ color: 'var(--text3)' }}>nsenter</span>
                          : <>{server.sshUser}@{server.host}{server.sshPort !== 22 ? `:${server.sshPort}` : ''}</>}
                      </td>
                      <td className={styles.td}>
                        <Badge variant={statusBadgeVariant(server.lastCheckStatus)}>
                          {server.lastCheckStatus}
                        </Badge>
                        {!server.enabled && <Badge variant="neutral">&nbsp;disabled</Badge>}
                      </td>
                      <td className={styles.td}>
                        {cpu != null ? <Badge variant={metricVariant(cpu)}>{Math.round(cpu)}%</Badge> : '—'}
                      </td>
                      <td className={styles.td}>
                        {mem != null ? <Badge variant={metricVariant(mem)}>{Math.round(mem)}%</Badge> : '—'}
                      </td>
                      <td className={styles.td}>
                        {disk != null ? <Badge variant={metricVariant(disk)}>{Math.round(disk)}%</Badge> : '—'}
                      </td>
                      <td className={styles.td} style={{ color: 'var(--text3)', fontSize: '.8rem' }}>
                        {ageOf(server.lastSeen)}
                      </td>
                      <td className={styles.td}>
                        {incCount > 0 ? (
                          <Badge variant="danger">{incCount}</Badge>
                        ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                      </td>
                      <td className={styles.td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Button variant="ghost" size="xs" onClick={() => handleTest(server.id)}>
                            Test
                          </Button>
                          {!server.isLocal && (
                            <Button variant="danger" size="xs" onClick={() => handleDelete(server.id, server.name, server.isLocal)}>
                              Remove
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {/* Add modal */}
      <Modal
        open={showAdd}
        onClose={() => { setShowAdd(false); setForm(EMPTY_FORM) }}
        title="Add Server"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => { setShowAdd(false); setForm(EMPTY_FORM) }}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" loading={submitting} onClick={handleAddServer}>
              Add Server
            </Button>
          </>
        }
      >
        <div className={styles.field}>
          <label className={styles.label}>Name *</label>
          <input className={styles.input} value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="vps3" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Host / IP *</label>
          <input className={styles.input} value={form.host}
            onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
            placeholder="server.example.internal" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>SSH User *</label>
          <input className={styles.input} value={form.sshUser}
            onChange={e => setForm(f => ({ ...f, sshUser: e.target.value }))}
            placeholder="root" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>SSH Port</label>
          <input className={styles.input} type="number" value={form.sshPort}
            onChange={e => setForm(f => ({ ...f, sshPort: e.target.value }))}
            placeholder="22" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>SSH Key Path (optional)</label>
          <input className={styles.input} value={form.sshKeyPath}
            onChange={e => setForm(f => ({ ...f, sshKeyPath: e.target.value }))}
            placeholder="/root/.ssh/id_rsa" />
        </div>
        <p style={{ fontSize: '.78rem', color: 'var(--text3)', marginTop: 8 }}>
          The server runs <code>ssh -o StrictHostKeyChecking=accept-new</code> with
          <code>KexAlgorithms=curve25519-sha256</code> and <code>HostKeyAlgorithms=ssh-ed25519</code>.
          Hosts that need different algorithm sets can override via the SSH options field on the
          row after creation.
        </p>
      </Modal>

      {/* Detail / drill-down */}
      <ServerDetailModal
        server={detailServer}
        open={!!detailServer}
        onClose={() => setDetailServer(null)}
        incidents={incidents}
      />
    </Layout>
  )
}

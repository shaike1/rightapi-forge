import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { Card, CardBody, CardHeader } from '../components/Card'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import styles from './ReportsPage.module.css'

type ReportType = 'daily_summary' | 'weekly_report' | 'monthly_report'
type ReportFormat = 'html' | 'markdown' | 'json'
type ChannelKind = 'chat' | 'telegram' | 'webhook' | 'email'

interface DeliveryChannel {
  type: ChannelKind
  config: Record<string, unknown>
}

interface ReportSchedule {
  id: string
  name: string
  reportType: ReportType
  cronExpression: string
  channels: DeliveryChannel[]
  enabled: boolean
  lastRun: string | null
  nextRun: string | null
  lastError: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

interface HistoryEntry {
  id: string
  reportType: ReportType
  generatedAt: string
  triggeredBy: string
  scheduleId: string | null
  summary: string
  deliveries: Array<{ channel: ChannelKind; ok: boolean; detail?: string }>
}

const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: 'daily_summary', label: 'Daily summary' },
  { value: 'weekly_report', label: 'Weekly report' },
  { value: 'monthly_report', label: 'Monthly report' },
]

export default function ReportsPage() {
  const { user } = useAuth()
  const { show } = useToast()
  const navigate = useNavigate()

  const [schedules, setSchedules] = useState<ReportSchedule[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<ReportSchedule | null>(null)
  const [generating, setGenerating] = useState<ReportType | null>(null)
  const [preview, setPreview] = useState<{ type: ReportType; rendered: string } | null>(null)
  const [viewHistory, setViewHistory] = useState<HistoryEntry | null>(null)

  const isAdmin = user?.role === 'admin'

  const reload = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        api.get<{ schedules: ReportSchedule[] }>('/api/reports/schedules'),
        api.get<{ history: HistoryEntry[] }>('/api/reports/history?limit=20'),
      ])
      setSchedules(Array.isArray(s?.schedules) ? s.schedules : [])
      setHistory(Array.isArray(h?.history) ? h.history : [])
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load reports', 'error')
    } finally {
      setLoading(false)
    }
  }, [show])

  useEffect(() => { reload() }, [reload])

  const toggleEnabled = async (s: ReportSchedule) => {
    try {
      await api.put(`/api/reports/schedules/${s.id}`, { enabled: !s.enabled })
      reload()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Toggle failed', 'error')
    }
  }

  const deleteSchedule = async (s: ReportSchedule) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return
    try {
      await api.delete(`/api/reports/schedules/${s.id}`)
      reload()
      show('Schedule deleted', 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Delete failed', 'error')
    }
  }

  const generateNow = async (type: ReportType) => {
    setGenerating(type)
    try {
      const r = await api.post<{ rendered: string }>('/api/reports/generate', { type, format: 'markdown' })
      setPreview({ type, rendered: r.rendered })
      reload()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Generation failed', 'error')
    } finally {
      setGenerating(null)
    }
  }

  if (loading) {
    return <Layout title="Reports"><div className={styles.empty}>Loading…</div></Layout>
  }

  return (
    <Layout
      title="Reports"
      subtitle="Scheduled reports for daily / weekly / monthly summaries — and on-demand previews"
      actions={isAdmin ? <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>+ New Schedule</Button> : undefined}
    >
      <Card>
        <CardHeader title="Generate now" subtitle="Preview a report without scheduling it. Anyone can generate; results are recorded in the audit log." />
        <CardBody>
          <div className={styles.onDemandRow}>
            {REPORT_TYPES.map(rt => (
              <Button
                key={rt.value}
                variant="ghost"
                size="sm"
                loading={generating === rt.value}
                onClick={() => generateNow(rt.value)}
              >{rt.label}</Button>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Schedules" subtitle={`${schedules.length} configured`} />
        <CardBody>
          {schedules.length === 0 ? (
            <div className={styles.empty}>No schedules yet.{isAdmin ? <> Click <strong>+ New Schedule</strong> to add one.</> : null}</div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th><th>Type</th><th>Cron</th><th>Channels</th><th>Next run</th><th>Last run</th>
                    {isAdmin && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {schedules.map(s => (
                    <tr key={s.id}>
                      <td>
                        <div className={styles.scheduleName}>{s.name}</div>
                        {s.lastError && <div className={styles.errLine}>{s.lastError}</div>}
                      </td>
                      <td>{s.reportType}</td>
                      <td className={styles.cron}>{s.cronExpression}</td>
                      <td>
                        {s.channels.map((c, i) => (
                          <Badge key={i} variant="neutral">{c.type}</Badge>
                        ))}
                      </td>
                      <td>{s.nextRun ? new Date(s.nextRun).toLocaleString() : '—'}</td>
                      <td>{s.lastRun ? new Date(s.lastRun).toLocaleString() : 'never'}</td>
                      {isAdmin && (
                        <td className={styles.rowActions}>
                          <button type="button" className={styles.linkBtn} onClick={() => toggleEnabled(s)}>
                            {s.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button type="button" className={styles.linkBtn} onClick={() => setEditing(s)}>Edit</button>
                          <button type="button" className={`${styles.linkBtn} ${styles.danger}`} onClick={() => deleteSchedule(s)}>Delete</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="History" subtitle={`Most recent ${history.length} runs`} />
        <CardBody>
          {history.length === 0 ? (
            <div className={styles.empty}>No reports generated yet.</div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr><th>Generated</th><th>Type</th><th>Triggered by</th><th>Deliveries</th><th></th></tr>
                </thead>
                <tbody>
                  {history.map(h => (
                    <tr key={h.id}>
                      <td>{new Date(h.generatedAt).toLocaleString()}</td>
                      <td>{h.reportType}</td>
                      <td>{h.triggeredBy}</td>
                      <td>
                        {h.deliveries.length === 0
                          ? <Badge variant="neutral">none</Badge>
                          : h.deliveries.map((d, i) => (
                              <Badge key={i} variant={d.ok ? 'success' : 'danger'}>{d.channel}</Badge>
                            ))
                        }
                      </td>
                      <td>
                        <button type="button" className={styles.linkBtn} onClick={() => setViewHistory(h)}>View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {(showAdd || editing) && (
        <ScheduleModal
          initial={editing}
          onClose={() => { setShowAdd(false); setEditing(null) }}
          onSaved={() => { setShowAdd(false); setEditing(null); reload() }}
        />
      )}

      {preview && (
        <Modal
          open={!!preview}
          onClose={() => setPreview(null)}
          title={`Preview: ${preview.type}`}
          footer={<Button variant="primary" onClick={() => setPreview(null)}>Close</Button>}
        >
          <pre className={styles.previewBody}>{preview.rendered}</pre>
        </Modal>
      )}

      {viewHistory && (
        <Modal
          open={!!viewHistory}
          onClose={() => setViewHistory(null)}
          title={`${viewHistory.reportType} — ${new Date(viewHistory.generatedAt).toLocaleString()}`}
          footer={<Button variant="primary" onClick={() => setViewHistory(null)}>Close</Button>}
        >
          <div className={styles.deliveriesRow}>
            {viewHistory.deliveries.map((d, i) => (
              <Badge key={i} variant={d.ok ? 'success' : 'danger'}>
                {d.channel}{d.detail ? ` — ${d.detail}` : ''}
              </Badge>
            ))}
          </div>
          <pre className={styles.previewBody}>{viewHistory.summary}</pre>
        </Modal>
      )}

      {!isAdmin && (
        <div className={styles.viewerNote}>
          You can view + generate reports as an operator. Schedule management requires the admin role.
          <button type="button" className={styles.linkBtn} onClick={() => navigate('/sla')}>Open SLA page</button>
        </div>
      )}
    </Layout>
  )
}

// ── Add / edit modal ──────────────────────────────────────────────────

function ScheduleModal({ initial, onClose, onSaved }: {
  initial: ReportSchedule | null
  onClose: () => void
  onSaved: () => void
}) {
  const { show } = useToast()
  const [name, setName] = useState(initial?.name ?? '')
  const [reportType, setReportType] = useState<ReportType>(initial?.reportType ?? 'daily_summary')
  const [cronExpression, setCronExpression] = useState(initial?.cronExpression ?? '0 8 * * *')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [channels, setChannels] = useState<DeliveryChannel[]>(initial?.channels ?? [{ type: 'chat', config: {} }])
  const [saving, setSaving] = useState(false)

  const addChannel = (kind: ChannelKind) => {
    const cfg: Record<string, unknown> = kind === 'webhook' ? { url: '' } : {}
    setChannels(prev => [...prev, { type: kind, config: cfg }])
  }
  const removeChannel = (i: number) => setChannels(prev => prev.filter((_, idx) => idx !== i))
  const updateChannel = (i: number, patch: Partial<DeliveryChannel>) =>
    setChannels(prev => prev.map((c, idx) => idx === i ? { ...c, ...patch, config: { ...c.config, ...(patch.config ?? {}) } } : c))

  const save = async () => {
    setSaving(true)
    try {
      const body = { name, reportType, cronExpression, channels, enabled }
      if (initial) {
        await api.put(`/api/reports/schedules/${initial.id}`, body)
        show('Schedule updated', 'success')
      } else {
        await api.post('/api/reports/schedules', body)
        show('Schedule created', 'success')
      }
      onSaved()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={initial ? `Edit: ${initial.name}` : 'New report schedule'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>{initial ? 'Save' : 'Create'}</Button>
        </>
      }
    >
      <div className={styles.field}>
        <label className={styles.label}>Name</label>
        <input className={styles.input} value={name} onChange={e => setName(e.target.value)} placeholder="Daily summary"/>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Report type</label>
        <select className={styles.input} value={reportType} onChange={e => setReportType(e.target.value as ReportType)}>
          {REPORT_TYPES.map(rt => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Cron expression</label>
        <input className={styles.input} value={cronExpression} onChange={e => setCronExpression(e.target.value)} placeholder="0 8 * * *"/>
        <div className={styles.help}>
          5-field cron: <code>min hour dom mon dow</code>. Examples:&nbsp;
          <code>0 8 * * *</code> daily 8am · <code>0 9 * * 0</code> Sunday 9am · <code>*/15 * * * *</code> every 15 min
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>Delivery channels</label>
        {channels.map((c, i) => (
          <div key={i} className={styles.channelRow}>
            <select
              className={styles.input}
              value={c.type}
              onChange={e => updateChannel(i, { type: e.target.value as ChannelKind, config: e.target.value === 'webhook' ? { url: '' } : {} })}
              style={{ maxWidth: 140 }}
            >
              <option value="chat">chat</option>
              <option value="telegram">telegram</option>
              <option value="webhook">webhook</option>
              <option value="email">email</option>
            </select>
            {c.type === 'webhook' && (
              <input
                className={styles.input}
                placeholder="https://example/webhook"
                value={String((c.config as { url?: string }).url ?? '')}
                onChange={e => updateChannel(i, { config: { url: e.target.value } })}
              />
            )}
            {c.type === 'email' && (
              <input
                className={styles.input}
                placeholder="comma-separated recipients (leave empty for SMTP defaults)"
                value={Array.isArray((c.config as { to?: string[] }).to) ? ((c.config as { to: string[] }).to.join(', ')) : ''}
                onChange={e => updateChannel(i, { config: { to: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })}
              />
            )}
            <button type="button" className={styles.linkBtn} onClick={() => removeChannel(i)}>Remove</button>
          </div>
        ))}
        <div className={styles.channelRow}>
          <button type="button" className={styles.linkBtn} onClick={() => addChannel('chat')}>+ chat</button>
          <button type="button" className={styles.linkBtn} onClick={() => addChannel('telegram')}>+ telegram</button>
          <button type="button" className={styles.linkBtn} onClick={() => addChannel('webhook')}>+ webhook</button>
          <button type="button" className={styles.linkBtn} onClick={() => addChannel('email')}>+ email</button>
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.toggle}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/>
          <span>{enabled ? 'enabled' : 'disabled'}</span>
        </label>
      </div>
    </Modal>
  )
}

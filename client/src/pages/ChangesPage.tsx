// Change Management — operator-facing change log + timeline.
//
// Layout:
//   • Filter row (status / type / search)
//   • Stat tiles (totals + by-status)
//   • Two-pane: list (left) + detail with timeline (right)
//   • Create modal (operator+)
//
// Auto-logged runbook executions land here too — they're filtered by
// `source` when needed but render in the same list.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  GitBranch, Plus, RefreshCw, X, Save, ChevronRight, Trash2,
  CheckCircle2, AlertTriangle, RotateCcw, Hourglass, Clock,
} from 'lucide-react'
import Layout from '../components/Layout'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import styles from './ChangesPage.module.css'

type ChangeType = 'deployment' | 'config' | 'maintenance' | 'emergency' | 'auto-remediation'
type ChangeStatus = 'planned' | 'in_progress' | 'completed' | 'failed' | 'rolled_back'
type ChangeRisk = 'low' | 'medium' | 'high'
type ChangeSource = 'manual' | 'runbook' | 'remediation' | 'workflow' | 'external'

interface Change {
  id: string
  type: ChangeType
  status: ChangeStatus
  riskLevel: ChangeRisk
  assetId: string | null
  serverId: string | null
  title: string
  description: string | null
  createdBy: string | null
  scheduledAt: string | null
  startedAt: string | null
  completedAt: string | null
  source: ChangeSource
  relatedRunbookRunId: string | null
  relatedIncidentId: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

const STATUS_COLOR: Record<ChangeStatus, string> = {
  planned:     '#9CA3AF',
  in_progress: '#F59E0B',
  completed:   '#22C55E',
  failed:      '#EF4444',
  rolled_back: '#E8734A',
}
const STATUS_ICON: Record<ChangeStatus, React.ElementType> = {
  planned:     Clock,
  in_progress: Hourglass,
  completed:   CheckCircle2,
  failed:      AlertTriangle,
  rolled_back: RotateCcw,
}
const TYPES: ChangeType[] = ['deployment', 'config', 'maintenance', 'emergency', 'auto-remediation']
const STATUSES: ChangeStatus[] = ['planned', 'in_progress', 'completed', 'failed', 'rolled_back']

function fmt(iso: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) } catch { return iso }
}

export default function ChangesPage() {
  const { id: routeId } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const isOperator = isAdmin || user?.role === 'operator'

  const [changes, setChanges] = useState<Change[]>([])
  const [stats, setStats] = useState<{ total: number; byStatus: Record<string, number>; byType: Record<string, number> } | null>(null)
  const [statusFilter, setStatusFilter] = useState<ChangeStatus | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<ChangeType | 'all'>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(routeId ?? null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (typeFilter !== 'all') params.set('type', typeFilter)
      const data = await api.get<{ changes: Change[]; stats: any }>(`/api/changes?${params.toString()}`)
      const list = Array.isArray(data?.changes) ? data.changes : []
      setChanges(search.trim()
        ? list.filter(c => c.title.toLowerCase().includes(search.toLowerCase()) || c.id.toLowerCase().includes(search.toLowerCase()))
        : list)
      setStats(data?.stats ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load changes')
      setChanges([])
    } finally { setLoading(false) }
  }, [statusFilter, typeFilter, search])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { if (routeId && routeId !== selectedId) setSelectedId(routeId) }, [routeId, selectedId])

  const selected = useMemo(() => changes.find(c => c.id === selectedId) ?? null, [changes, selectedId])

  return (
    <Layout title="Changes" subtitle="Every deployment, config edit, maintenance window, and auto-remediation logged for the fleet.">
      {error && <div className={styles.error}>{error}</div>}
      {stats && (
        <div className={styles.statRow}>
          <StatTile label="Total" value={stats.total} color="var(--accent)" />
          {STATUSES.map(s => <StatTile key={s} label={s.replace('_', ' ')} value={stats.byStatus?.[s] ?? 0} color={STATUS_COLOR[s]} icon={STATUS_ICON[s]} />)}
        </div>
      )}

      <div className={styles.shell}>
        <div className={styles.listPane}>
          <div className={styles.filterRow}>
            <input
              type="text"
              placeholder="Search title or id…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={styles.searchInput}
            />
            <button type="button" className={styles.iconBtn} onClick={refresh} title="Refresh"><RefreshCw size={14} /></button>
            {isOperator && (
              <button type="button" className={styles.primaryBtn} onClick={() => setCreating(true)}><Plus size={14} /> New</button>
            )}
          </div>

          <div className={styles.chipRow}>
            <button type="button" className={`${styles.chip} ${statusFilter === 'all' ? styles.chipActive : ''}`} onClick={() => setStatusFilter('all')}>All</button>
            {STATUSES.map(s => (
              <button
                key={s}
                type="button"
                className={`${styles.chip} ${statusFilter === s ? styles.chipActive : ''}`}
                style={statusFilter === s ? { borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] } : undefined}
                onClick={() => setStatusFilter(s)}
              >
                {s.replace('_', ' ')}
              </button>
            ))}
          </div>
          <div className={styles.chipRow}>
            <button type="button" className={`${styles.chip} ${typeFilter === 'all' ? styles.chipActive : ''}`} onClick={() => setTypeFilter('all')}>All types</button>
            {TYPES.map(t => (
              <button key={t} type="button" className={`${styles.chip} ${typeFilter === t ? styles.chipActive : ''}`} onClick={() => setTypeFilter(t)}>{t}</button>
            ))}
          </div>

          {loading && <div className={styles.empty}>Loading…</div>}
          {!loading && changes.length === 0 && <div className={styles.empty}>No changes match.</div>}
          {!loading && changes.length > 0 && (
            <ul className={styles.changeList}>
              {changes.map(c => {
                const Icon = STATUS_ICON[c.status]
                return (
                  <li
                    key={c.id}
                    className={`${styles.item} ${selectedId === c.id ? styles.itemActive : ''}`}
                    onClick={() => { setSelectedId(c.id); navigate(`/changes/${c.id}`) }}
                  >
                    <span className={styles.itemStatus} style={{ color: STATUS_COLOR[c.status] }} title={c.status}><Icon size={14} /></span>
                    <span className={styles.itemMain}>
                      <span className={styles.itemTitle}>{c.title}</span>
                      <span className={styles.itemMeta}>
                        <code>{c.id}</code> · {c.type} · {c.source !== 'manual' && <em>{c.source}</em>}
                        {c.relatedIncidentId && <> · ↪ <code>{c.relatedIncidentId}</code></>}
                      </span>
                    </span>
                    <ChevronRight size={14} />
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className={styles.detailPane}>
          {!selected && <div className={styles.empty}>Pick a change on the left to see the timeline + metadata.</div>}
          {selected && <ChangeDetail change={selected} isAdmin={isAdmin} isOperator={isOperator} onChanged={refresh} />}
        </div>
      </div>

      {creating && (
        <CreateChangeModal
          onClose={() => setCreating(false)}
          onCreated={(c) => { setCreating(false); refresh(); setSelectedId(c.id); navigate(`/changes/${c.id}`) }}
        />
      )}
    </Layout>
  )
}

function StatTile({ label, value, color, icon: Icon }: { label: string; value: number; color: string; icon?: React.ElementType }) {
  return (
    <div className={styles.stat} style={{ borderLeftColor: color }}>
      <span className={styles.statLabel}>{Icon && <Icon size={11} />} {label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  )
}

function ChangeDetail({ change, isAdmin, isOperator, onChanged }: { change: Change; isAdmin: boolean; isOperator: boolean; onChanged: () => void }) {
  const Icon = STATUS_ICON[change.status]
  const color = STATUS_COLOR[change.status]

  const transition = async (next: ChangeStatus) => {
    try {
      await api.put(`/api/changes/${change.id}`, { status: next })
      onChanged()
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete ${change.id}? This cannot be undone.`)) return
    try { await api.delete(`/api/changes/${change.id}`); onChanged() }
    catch (e) { alert(`Failed: ${e instanceof Error ? e.message : 'unknown'}`) }
  }

  const allowedTransitions: ChangeStatus[] = (() => {
    switch (change.status) {
      case 'planned':     return ['in_progress']
      case 'in_progress': return ['completed', 'failed', 'rolled_back']
      case 'completed':   return ['rolled_back']
      default:            return []
    }
  })()

  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <span className={styles.detailIcon} style={{ background: color + '22', color }}><Icon size={20} /></span>
        <div className={styles.detailHeadText}>
          <h2 className={styles.detailTitle}>{change.title}</h2>
          <div className={styles.detailMeta}>
            <code>{change.id}</code>
            <span className={styles.detailType}>{change.type}</span>
            <span className={styles.detailRisk} data-risk={change.riskLevel}>risk: {change.riskLevel}</span>
            <span style={{ color }}>{change.status.replace('_', ' ')}</span>
          </div>
        </div>
        {isAdmin && <button type="button" className={styles.dangerBtn} onClick={remove}><Trash2 size={14} /></button>}
      </div>

      {change.description && <p className={styles.desc}>{change.description}</p>}

      <table className={styles.kvTable}>
        <tbody>
          <tr><td>Created</td><td>{fmt(change.createdAt)} by <strong>{change.createdBy || 'system'}</strong></td></tr>
          {change.scheduledAt && <tr><td>Scheduled</td><td>{fmt(change.scheduledAt)}</td></tr>}
          {change.startedAt   && <tr><td>Started</td><td>{fmt(change.startedAt)}</td></tr>}
          {change.completedAt && <tr><td>Completed</td><td>{fmt(change.completedAt)}</td></tr>}
          {change.assetId    && <tr><td>Asset</td><td><a href={`/app/assets/${change.assetId}`} className={styles.link}><code>{change.assetId}</code></a></td></tr>}
          {change.serverId   && <tr><td>Server</td><td><code>{change.serverId}</code></td></tr>}
          {change.source !== 'manual' && <tr><td>Source</td><td><em>{change.source}</em></td></tr>}
          {change.relatedRunbookRunId && <tr><td>Runbook run</td><td><a href={`/app/runbooks/runs/${change.relatedRunbookRunId}`} className={styles.link}><code>{change.relatedRunbookRunId}</code></a></td></tr>}
          {change.relatedIncidentId   && <tr><td>Incident</td><td><a href={`/app/incidents/${change.relatedIncidentId}`} className={styles.link}><code>{change.relatedIncidentId}</code></a></td></tr>}
        </tbody>
      </table>

      {Object.keys(change.metadata || {}).length > 0 && (
        <details className={styles.section}>
          <summary>Metadata</summary>
          <table className={styles.kvTable}>
            <tbody>
              {Object.entries(change.metadata).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td><code>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {isOperator && allowedTransitions.length > 0 && (
        <div className={styles.actionsRow}>
          <span className={styles.actionsLabel}>Transition →</span>
          {allowedTransitions.map(s => (
            <button
              key={s}
              type="button"
              className={styles.smallBtn}
              style={{ borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}
              onClick={() => transition(s)}
            >
              Mark {s.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateChangeModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Change) => void }) {
  const [type, setType] = useState<ChangeType>('deployment')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [riskLevel, setRiskLevel] = useState<ChangeRisk>('medium')
  const [status, setStatus] = useState<ChangeStatus>('planned')
  const [assetId, setAssetId] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { setErr('title required'); return }
    setSubmitting(true); setErr(null)
    try {
      const { change } = await api.post<{ change: Change }>('/api/changes', {
        type, title: title.trim(), description: description.trim() || null,
        riskLevel, status,
        assetId: assetId.trim() || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
      })
      onCreated(change)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'create failed')
    } finally { setSubmitting(false) }
  }

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className={styles.modalHead}>
          <h3>New change</h3>
          <button type="button" className={styles.iconBtn} onClick={onClose}><X size={14} /></button>
        </header>
        <label className={styles.field}><span>Type</span>
          <select value={type} onChange={e => setType(e.target.value as ChangeType)} disabled={submitting}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className={styles.field}><span>Title</span>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} disabled={submitting} required />
        </label>
        <label className={styles.field}><span>Description</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} disabled={submitting} />
        </label>
        <div className={styles.row2}>
          <label className={styles.field}><span>Risk</span>
            <select value={riskLevel} onChange={e => setRiskLevel(e.target.value as ChangeRisk)} disabled={submitting}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
          </label>
          <label className={styles.field}><span>Status</span>
            <select value={status} onChange={e => setStatus(e.target.value as ChangeStatus)} disabled={submitting}>
              <option value="planned">planned</option><option value="in_progress">in_progress</option><option value="completed">completed</option>
            </select>
          </label>
        </div>
        <label className={styles.field}><span>Asset (AST-…, optional)</span>
          <input type="text" value={assetId} onChange={e => setAssetId(e.target.value)} disabled={submitting} />
        </label>
        <label className={styles.field}><span>Scheduled (optional)</span>
          <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} disabled={submitting} />
        </label>
        {err && <div className={styles.error}>{err}</div>}
        <div className={styles.modalFoot}>
          <button type="button" onClick={onClose} className={styles.smallBtn}>Cancel</button>
          <button type="submit" disabled={submitting || !title.trim()} className={styles.primaryBtn}>{submitting ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import StatCard from '../components/StatCard'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { Card, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './IncidentsPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type IncidentStatus = 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed'

interface Incident {
  id: string
  title: string
  severity: Severity
  status: IncidentStatus
  assignedTo?: string
  source?: string
  createdAt: string
  updatedAt: string
  slaBreached?: boolean
  aiAnalysis?: string
}

interface IncidentAnalysis {
  rootCauseLikely: string
  confidence: 'high' | 'medium' | 'low'
  remediationSteps: string[]
  preventionTips: string[]
  estimatedImpact: string
  relatedSystems: string[]
  priority: 'immediate' | 'soon' | 'monitor'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const age = (d: string) => {
  const s = (Date.now() - new Date(d).getTime()) / 1000
  if (s < 60) return '<1m'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
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

// ── AI Analysis Panel ─────────────────────────────────────────────────────────

interface AIAnalysisPanelProps {
  incident: Incident
  analysis: IncidentAnalysis | null
  analyzing: boolean
  onAnalyze: () => void
}

/* Hex literals match design tokens in index.css (--success, --warning, --danger,
 * --warm, --accent). Kept as hex so callers can append alpha (e.g. + '22') for
 * tinted backgrounds in inline styles. */
const confidenceColor = (c: IncidentAnalysis['confidence']) =>
  c === 'high' ? '#22C55E' : c === 'medium' ? '#F59E0B' : '#EF4444'

const priorityColor = (p: IncidentAnalysis['priority']) =>
  p === 'immediate' ? '#EF4444' : p === 'soon' ? '#E8734A' : '#306EF0'

function AIAnalysisPanel({ analysis, analyzing, onAnalyze }: AIAnalysisPanelProps) {
  return (
    <div style={{
      background: 'var(--bg2)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      padding: '14px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontWeight: 600, color: 'var(--accent)', fontSize: '0.9rem' }}>🤖 AI Analysis</span>
        <Button variant="ghost" size="xs" loading={analyzing} onClick={onAnalyze}>
          {analyzing ? 'Analyzing…' : analysis ? '↻ Re-analyze' : 'Analyze'}
        </Button>
      </div>
      {analyzing && !analysis && (
        <div style={{ color: 'var(--text2)', fontSize: '0.85rem' }}>Analyzing incident…</div>
      )}
      {!analyzing && !analysis && (
        <div style={{ color: 'var(--text2)', fontSize: '0.85rem' }}>Click Analyze to get AI insights</div>
      )}
      {analysis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Root cause + badges */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text)', flex: 1, minWidth: '200px' }}>
              <strong>Root Cause:</strong> {analysis.rootCauseLikely}
            </span>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', background: confidenceColor(analysis.confidence) + '22', color: confidenceColor(analysis.confidence), border: `1px solid ${confidenceColor(analysis.confidence)}` }}>
              {analysis.confidence} confidence
            </span>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', background: priorityColor(analysis.priority) + '22', color: priorityColor(analysis.priority), border: `1px solid ${priorityColor(analysis.priority)}` }}>
              {analysis.priority}
            </span>
          </div>
          {analysis.estimatedImpact && (
            <div style={{ fontSize: '0.82rem', color: 'var(--text2)' }}>
              <strong style={{ color: 'var(--text)' }}>Impact:</strong> {analysis.estimatedImpact}
            </div>
          )}
          {analysis.remediationSteps.length > 0 && (
            <div>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>Remediation Steps</div>
              <ol style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {analysis.remediationSteps.map((s, i) => (
                  <li key={i} style={{ fontSize: '0.82rem', color: 'var(--text2)' }}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          {analysis.preventionTips.length > 0 && (
            <div>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>Prevention Tips</div>
              <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {analysis.preventionTips.map((t, i) => (
                  <li key={i} style={{ fontSize: '0.82rem', color: 'var(--text2)' }}>{t}</li>
                ))}
              </ul>
            </div>
          )}
          {analysis.relatedSystems.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.78rem', color: 'var(--text2)' }}>Related:</span>
              {analysis.relatedSystems.map(s => (
                <span key={s} style={{ fontSize: '0.75rem', padding: '1px 8px', borderRadius: '999px', background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)' }}>{s}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IncidentsPage() {
  const { show } = useToast()

  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<IncidentStatus | 'all'>('all')
  const [filterSeverity, setFilterSeverity] = useState<Severity | 'all'>('all')
  const [search, setSearch] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ title: '', severity: 'medium' as Severity, description: '', assignedTo: '' })
  const [submitting, setSubmitting] = useState(false)

  const [actionLoading, setActionLoading] = useState<Record<string, string>>({})

  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null)
  const [analysisOpen, setAnalysisOpen] = useState<Record<string, boolean>>({})
  const [analyzing, setAnalyzing] = useState<Record<string, boolean>>({})

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchIncidents = useCallback(async () => {
    try {
      const data = await api.get<{ incidents: Incident[]; total: number } | Incident[]>('/api/incidents')
      const list = Array.isArray(data) ? data : data?.incidents
      setIncidents(Array.isArray(list) ? list : [])
    } catch {
      // silent on poll failures
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchIncidents()
    pollingRef.current = setInterval(fetchIncidents, 30_000)
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [fetchIncidents])

  // ── Actions ──────────────────────────────────────────────────────────────────

  const escalate = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setActionLoading(p => ({ ...p, [id]: 'escalate' }))
    try {
      await api.post(`/api/incidents/${id}/escalate`)
      show('Incident escalated', 'warning')
      fetchIncidents()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Escalation failed', 'error')
    } finally {
      setActionLoading(p => { const n = { ...p }; delete n[id]; return n })
    }
  }

  const resolve = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setActionLoading(p => ({ ...p, [id]: 'resolve' }))
    try {
      await api.post(`/api/incidents/${id}/resolve`)
      show('Incident resolved', 'success')
      fetchIncidents()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Resolve failed', 'error')
    } finally {
      setActionLoading(p => { const n = { ...p }; delete n[id]; return n })
    }
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  const analyzeIncident = async (inc: Incident) => {
    setAnalyzing(p => ({ ...p, [inc.id]: true }))
    try {
      const data = await api.post<{ analysis: IncidentAnalysis }>(`/api/incidents/${inc.id}/analyze`)
      setIncidents(prev => prev.map(i => i.id === inc.id ? { ...i, aiAnalysis: JSON.stringify(data.analysis) } : i))
      if (selectedIncident?.id === inc.id) setSelectedIncident(p => p ? { ...p, aiAnalysis: JSON.stringify(data.analysis) } : p)
      show('AI analysis complete', 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Analysis failed', 'error')
    } finally {
      setAnalyzing(p => { const n = { ...p }; delete n[inc.id]; return n })
    }
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  const createIncident = async () => {
    if (!form.title.trim()) { show('Title is required', 'error'); return }
    setSubmitting(true)
    try {
      await api.post('/api/incidents', {
        title: form.title.trim(),
        severity: form.severity,
        description: form.description || undefined,
        assignedTo: form.assignedTo || undefined,
      })
      show('Incident created', 'success')
      setShowModal(false)
      setForm({ title: '', severity: 'medium', description: '', assignedTo: '' })
      fetchIncidents()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Create failed', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Derived stats ─────────────────────────────────────────────────────────────

  const today = new Date().toDateString()
  const stats = {
    open: incidents.filter(i => i.status === 'open').length,
    critical: incidents.filter(i => i.severity === 'critical').length,
    investigating: incidents.filter(i => i.status === 'investigating').length,
    resolvedToday: incidents.filter(i => i.status === 'resolved' && new Date(i.updatedAt).toDateString() === today).length,
    slaBreached: incidents.filter(i => i.slaBreached).length,
  }

  // ── Filtered list ─────────────────────────────────────────────────────────────

  const visible = incidents.filter(i => {
    if (filterStatus !== 'all' && i.status !== filterStatus) return false
    if (filterSeverity !== 'all' && i.severity !== filterSeverity) return false
    if (search && !i.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Layout
      title="Incidents"
      subtitle="Monitor and manage operational incidents"
      actions={
        <Button variant="primary" size="sm" onClick={() => setShowModal(true)}>
          + New Incident
        </Button>
      }
    >
      {/* 1. Stats row */}
      <div className={styles.statsRow}>
        <StatCard label="Open" value={stats.open} color="danger" />
        <StatCard label="Critical" value={stats.critical} color="danger" />
        <StatCard label="Investigating" value={stats.investigating} color="warning" />
        <StatCard label="Resolved Today" value={stats.resolvedToday} color="success" />
        <StatCard label="SLA Breached" value={stats.slaBreached} color="danger" />
      </div>

      {/* 2. Main card with toolbar inside */}
      <Card>
        <CardBody>
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              placeholder="Search incidents…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select
              className={styles.select}
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value as IncidentStatus | 'all')}
            >
              <option value="all">All Statuses</option>
              <option value="open">Open</option>
              <option value="investigating">Investigating</option>
              <option value="mitigating">Mitigating</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
            <select
              className={styles.select}
              value={filterSeverity}
              onChange={e => setFilterSeverity(e.target.value as Severity | 'all')}
            >
              <option value="all">All Severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <Button variant="ghost" size="sm" onClick={() => {
              const token = localStorage.getItem('itops_token') || sessionStorage.getItem('itops_token');
              window.open(`/api/incidents/export.csv?token=${token}`, '_blank');
            }}>
              ⬇ Export CSV
            </Button>
          </div>
          {loading ? (
            <div className={styles.loading}>Loading incidents…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon="🎉"
              title="No incidents"
              description="System is running normally"
              action={{ label: '+ New Incident', onClick: () => setShowModal(true) }}
            />
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>ID</th>
                  <th className={styles.th}>Title</th>
                  <th className={styles.th}>Severity</th>
                  <th className={styles.th}>Status</th>
                  <th className={styles.th}>Assigned</th>
                  <th className={styles.th}>Age</th>
                  <th className={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(inc => {
                  const analysis: IncidentAnalysis | null = (() => {
                    try { return inc.aiAnalysis ? JSON.parse(inc.aiAnalysis) : null } catch { return null }
                  })()
                  const isOpen = analysisOpen[inc.id] ?? false
                  return (
                    <React.Fragment key={inc.id}>
                    <tr className={styles.tr}>
                      <td className={styles.td}>
                        <Link
                          to={`/incidents/${inc.id}`}
                          style={{
                            fontFamily: 'monospace',
                            fontSize: '.8rem',
                            background: 'var(--bg3)',
                            borderRadius: '4px',
                            padding: '2px 6px',
                            color: 'var(--accent)',
                            fontWeight: 600,
                            textDecoration: 'none',
                            border: '1px solid var(--border)',
                          }}
                          title="Open incident details"
                        >
                          #{inc.id.slice(-6).toUpperCase()}
                        </Link>
                      </td>
                      <td className={styles.td}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Link
                            to={`/incidents/${inc.id}`}
                            style={{ color: 'var(--text)', textDecoration: 'none', fontWeight: 500 }}
                          >
                            {inc.title}
                          </Link>
                          {inc.slaBreached && <Badge variant="danger">SLA</Badge>}
                          {analysis && <span style={{ fontSize: '0.7rem', color: 'var(--accent)' }}>🤖</span>}
                        </span>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={severityVariant(inc.severity)}>{inc.severity}</Badge>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={statusVariant(inc.status)}>{inc.status}</Badge>
                      </td>
                      <td className={styles.td}>{inc.assignedTo ?? '—'}</td>
                      <td className={styles.td}>{age(inc.createdAt)}</td>
                      <td className={styles.td}>
                        <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {inc.status !== 'resolved' && inc.status !== 'closed' && (
                            <>
                              <Button
                                variant="ghost"
                                size="xs"
                                loading={actionLoading[inc.id] === 'escalate'}
                                onClick={e => escalate(inc.id, e)}
                                style={{ color: 'var(--warning)' }}
                              >
                                ↑ Escalate
                              </Button>
                              <Button
                                variant="success"
                                size="xs"
                                loading={actionLoading[inc.id] === 'resolve'}
                                onClick={e => resolve(inc.id, e)}
                              >
                                ✓ Resolve
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setAnalysisOpen(p => ({ ...p, [inc.id]: !p[inc.id] }))}
                            style={{ color: 'var(--accent)' }}
                          >
                            🤖 AI
                          </Button>
                        </span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className={styles.tr}>
                        <td colSpan={7} style={{ padding: '0 12px 12px' }}>
                          <AIAnalysisPanel
                            incident={inc}
                            analysis={analysis}
                            analyzing={!!analyzing[inc.id]}
                            onAnalyze={() => analyzeIncident(inc)}
                          />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* 3. Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title="New Incident"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={submitting} onClick={createIncident}>
              Create Incident
            </Button>
          </>
        }
      >
        <div className={styles.field}>
          <label className={styles.label}>Title *</label>
          <input
            className={styles.input}
            placeholder="Brief incident description"
            value={form.title}
            onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && createIncident()}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Severity</label>
          <select
            className={styles.select}
            value={form.severity}
            onChange={e => setForm(p => ({ ...p, severity: e.target.value as Severity }))}
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Description</label>
          <textarea
            className={styles.textarea}
            placeholder="What happened? (optional)"
            rows={3}
            value={form.description}
            onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Assigned To</label>
          <input
            className={styles.input}
            placeholder="Username or team (optional)"
            value={form.assignedTo}
            onChange={e => setForm(p => ({ ...p, assignedTo: e.target.value }))}
          />
        </div>
      </Modal>
    </Layout>
  )
}

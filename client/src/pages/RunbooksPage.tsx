import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { Card, CardHeader, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import styles from './RunbooksPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunbookStep {
  id: string
  name: string
  type: string // 'command' | 'approval' | 'notification' | 'condition'
  command?: string
  requiresApproval?: boolean
  description?: string
}

interface RunbookTemplate {
  id: string
  name: string
  description?: string
  category?: string
  tags?: string[]
  steps: RunbookStep[]
  createdAt?: string
}

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval'

interface RunStep {
  id: string
  name: string
  status: string
  startedAt?: string
  completedAt?: string
  output?: string
  error?: string
}

interface RunbookRun {
  id: string
  templateId: string
  templateName: string
  status: RunStatus
  currentStep: number
  totalSteps: number
  startedAt: string
  completedAt?: string
  triggeredBy: string
  steps?: RunStep[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const runStatusVariant = (s: RunStatus): 'info' | 'success' | 'danger' | 'warning' => {
  if (s === 'running') return 'info'
  if (s === 'completed') return 'success'
  if (s === 'failed' || s === 'cancelled') return 'danger'
  return 'warning'
}

const stepStatusIcon = (status: string): string => {
  if (status === 'completed') return '✅'
  if (status === 'failed') return '❌'
  if (status === 'running') return '🔄'
  return '⏳'
}

const formatDuration = (startedAt: string, completedAt?: string): string => {
  if (!completedAt) return '—'
  const diffMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  const totalSec = Math.max(0, Math.floor(diffMs / 1000))
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

const toSlug = (name: string): string =>
  name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

const ACTIVE_STATUSES: RunStatus[] = ['pending', 'running', 'waiting_approval']

// ── Component ─────────────────────────────────────────────────────────────────

export default function RunbooksPage() {
  const { show } = useToast()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [templates, setTemplates] = useState<RunbookTemplate[]>([])
  const [activeRuns, setActiveRuns] = useState<RunbookRun[]>([])
  const [historyRuns, setHistoryRuns] = useState<RunbookRun[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [loadingActive, setLoadingActive] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(false)

  // Tab state for the right panel
  const [activeTab, setActiveTab] = useState<'active' | 'history'>('active')

  // Expanded run rows (step detail)
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({})

  // New runbook modal
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [submitting, setSubmitting] = useState(false)

  // Per-template run loading
  const [runLoading, setRunLoading] = useState<Record<string, boolean>>({})
  // Per-run approve loading
  const [approveLoading, setApproveLoading] = useState<Record<string, boolean>>({})
  // Per-run cancel loading
  const [cancelLoading, setCancelLoading] = useState<Record<string, boolean>>({})

  // AI Generate modal
  const [showGenModal, setShowGenModal] = useState(false)
  const [genDescription, setGenDescription] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generatedRunbook, setGeneratedRunbook] = useState<any>(null)
  const [saving, setSaving] = useState(false)

  const fetchTemplates = useCallback(async () => {
    try {
      const data = await api.get<{ runbooks: RunbookTemplate[] } | RunbookTemplate[]>('/api/runbooks/templates')
      const list = Array.isArray(data) ? data : data?.runbooks
      setTemplates(Array.isArray(list) ? list : [])
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load runbooks', 'error')
    } finally {
      setLoadingTemplates(false)
    }
  }, [show])

  const fetchActiveRuns = useCallback(async () => {
    try {
      const data = await api.get<{ runs: RunbookRun[] } | RunbookRun[]>('/api/runbooks/runs')
      const list = Array.isArray(data) ? data : data?.runs
      const safe = Array.isArray(list) ? list : []
      setActiveRuns(safe.filter(r => (ACTIVE_STATUSES as string[]).includes(r.status)))
    } catch {
      // silent
    } finally {
      setLoadingActive(false)
    }
  }, [])

  const fetchHistoryRuns = useCallback(async () => {
    setLoadingHistory(true)
    try {
      const data = await api.get<{ runs: RunbookRun[] } | RunbookRun[]>('/api/runbooks/runs?status=completed')
      const list = Array.isArray(data) ? data : data?.runs
      setHistoryRuns(Array.isArray(list) ? list : [])
    } catch {
      // silent
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
    fetchActiveRuns()
  }, [fetchTemplates, fetchActiveRuns])

  // Fetch history when tab is first opened
  useEffect(() => {
    if (activeTab === 'history' && historyRuns.length === 0 && !loadingHistory) {
      fetchHistoryRuns()
    }
  }, [activeTab, historyRuns.length, loadingHistory, fetchHistoryRuns])

  // ── Run template ──────────────────────────────────────────────────────────────

  const runTemplate = async (tmpl: RunbookTemplate) => {
    setRunLoading(p => ({ ...p, [tmpl.id]: true }))
    try {
      const res = await api.post<{ run: RunbookRun }>('/api/runbooks/runs', {
        templateId: tmpl.id,
        triggeredBy: 'user',
      })
      show(`Runbook "${tmpl.name}" started (run: ${res.run?.id ?? '…'})`, 'success')
      fetchActiveRuns()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Run failed', 'error')
    } finally {
      setRunLoading(p => { const n = { ...p }; delete n[tmpl.id]; return n })
    }
  }

  // ── Approve step ──────────────────────────────────────────────────────────────

  const approveStep = async (run: RunbookRun) => {
    setApproveLoading(p => ({ ...p, [run.id]: true }))
    try {
      await api.post(`/api/runbooks/runs/${run.id}/approve`)
      show('Step approved', 'success')
      fetchActiveRuns()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Approve failed', 'error')
    } finally {
      setApproveLoading(p => { const n = { ...p }; delete n[run.id]; return n })
    }
  }

  // ── Cancel run ────────────────────────────────────────────────────────────────

  const cancelRun = async (run: RunbookRun) => {
    setCancelLoading(p => ({ ...p, [run.id]: true }))
    try {
      await api.post(`/api/runbooks/runs/${run.id}/cancel`)
      show(`Run cancelled`, 'success')
      fetchActiveRuns()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Cancel failed', 'error')
    } finally {
      setCancelLoading(p => { const n = { ...p }; delete n[run.id]; return n })
    }
  }

  // ── Create template ───────────────────────────────────────────────────────────

  const createTemplate = async () => {
    if (!form.name.trim()) { show('Name is required', 'error'); return }
    setSubmitting(true)
    try {
      const name = form.name.trim()
      await api.post('/api/runbooks/templates', {
        id: toSlug(name),
        name,
        description: form.description || undefined,
        category: 'custom',
        steps: [],
        tags: [],
      })
      show('Runbook created', 'success')
      setShowModal(false)
      setForm({ name: '', description: '' })
      fetchTemplates()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Create failed', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Toggle expand ─────────────────────────────────────────────────────────────

  const toggleExpand = (id: string) =>
    setExpandedRuns(p => ({ ...p, [id]: !p[id] }))

  // ── AI Generate runbook ───────────────────────────────────────────────────────

  const generateRunbook = async () => {
    if (!genDescription.trim()) { show('Description is required', 'error'); return }
    setGenerating(true)
    setGeneratedRunbook(null)
    try {
      const data = await api.post<{ runbook: any }>('/api/runbooks/generate', { description: genDescription.trim() })
      setGeneratedRunbook(data.runbook)
    } catch (err) {
      show(err instanceof Error ? err.message : 'Generation failed', 'error')
    } finally {
      setGenerating(false)
    }
  }

  const saveGeneratedRunbook = async () => {
    if (!generatedRunbook) return
    setSaving(true)
    try {
      const rb = generatedRunbook
      await api.post('/api/runbooks/templates', {
        id: rb.name ? toSlug(rb.name) + '-' + Date.now().toString(36) : 'ai-runbook-' + Date.now().toString(36),
        name: rb.name || 'AI Generated Runbook',
        description: rb.description || genDescription,
        category: rb.category || 'custom',
        steps: rb.steps || [],
        tags: rb.tags || ['ai-generated'],
      })
      show('Runbook saved!', 'success')
      setShowGenModal(false)
      setGenDescription('')
      setGeneratedRunbook(null)
      fetchTemplates()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }


  // ── Render run item (shared between active and history) ───────────────────────

  const renderRunItem = (run: RunbookRun, showDuration = false) => {
    const pct = run.totalSteps > 0
      ? Math.round((run.currentStep / run.totalSteps) * 100)
      : 0
    const expanded = expandedRuns[run.id] ?? false
    const canExpand = Array.isArray(run.steps) && run.steps.length > 0

    return (
      <li key={run.id} className={styles.execItem}>
        <div className={styles.execHeader}>
          <div className={styles.execHeaderLeft}>
            {canExpand && (
              <button
                className={styles.expandBtn}
                onClick={() => toggleExpand(run.id)}
                aria-label={expanded ? 'Collapse steps' : 'Expand steps'}
              >
                {expanded ? '▼' : '▶'}
              </button>
            )}
            <Link to={`/runbooks/runs/${run.id}`} className={styles.execName}>
              {run.templateName ?? `Run ${run.id.slice(-6)}`}
            </Link>
          </div>
          <Badge variant={runStatusVariant(run.status)}>
            {run.status.replace('_', ' ')}
          </Badge>
        </div>

        <div className={styles.progressRow}>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{
                width: `${pct}%`,
                backgroundColor: run.status === 'failed' || run.status === 'cancelled'
                  ? 'var(--danger)'
                  : run.status === 'completed'
                  ? 'var(--success)'
                  : 'var(--accent)',
              }}
            />
          </div>
          <span className={styles.progressLabel}>
            {run.currentStep}/{run.totalSteps}
          </span>
        </div>

        {/* Step detail */}
        {expanded && canExpand && (
          <ul className={styles.stepList}>
            {run.steps!.map(step => (
              <li key={step.id} className={styles.stepItem}>
                <span className={styles.stepIcon}>{stepStatusIcon(step.status)}</span>
                <span className={styles.stepName}>{step.name}</span>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.execActions}>
          {run.status === 'waiting_approval' && (
            <Button
              variant="success"
              size="xs"
              loading={approveLoading[run.id]}
              onClick={() => approveStep(run)}
            >
              ✓ Approve Step
            </Button>
          )}
          {(run.status === 'running' || run.status === 'pending') && (
            <Button
              variant="danger"
              size="xs"
              loading={cancelLoading[run.id]}
              onClick={() => cancelRun(run)}
            >
              ✕ Cancel
            </Button>
          )}
        </div>

        <div className={styles.execMeta}>
          {showDuration
            ? <>Started {new Date(run.startedAt).toLocaleString()} · Duration: {formatDuration(run.startedAt, run.completedAt)} · By: {run.triggeredBy}</>
            : <>Started {new Date(run.startedAt).toLocaleTimeString()} · By: {run.triggeredBy}</>
          }
        </div>
      </li>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Layout
      title="Runbooks"
      subtitle="Execute operational runbooks and track live runs"
      actions={
        <span style={{ display: 'flex', gap: '8px' }}>
          <Button variant="ghost" size="sm" onClick={() => { setShowGenModal(true); setGeneratedRunbook(null); setGenDescription('') }}>
            ✨ Generate with AI
          </Button>
          {isAdmin && (
            <Link to="/runbooks/new" className={styles.toolbarLink}>
              + Open Editor
            </Link>
          )}
          <Button variant="primary" size="sm" onClick={() => setShowModal(true)}>
            + New Runbook
          </Button>
        </span>
      }
    >
      <div className={styles.columns}>

        {/* ── Left: Templates ─────────────────────────────────────────────────── */}
        <div className={styles.column}>
          <Card>
            <CardHeader
              title="Templates"
              subtitle={`${templates.length} runbook${templates.length !== 1 ? 's' : ''}`}
            />
            <CardBody>
              {loadingTemplates ? (
                <div className={styles.loading}>Loading runbooks…</div>
              ) : templates.length === 0 ? (
                <EmptyState
                  icon="📖"
                  title="No runbooks yet"
                  description="Create your first runbook template"
                  action={{ label: '+ New Runbook', onClick: () => setShowModal(true) }}
                />
              ) : (
                <ul className={styles.list}>
                  {templates.map(tmpl => (
                    <li key={tmpl.id} className={styles.rbItem}>
                      <div className={styles.rbInfo}>
                        <div className={styles.rbName}>{tmpl.name}</div>
                        {tmpl.description && (
                          <div className={styles.rbDesc}>{tmpl.description}</div>
                        )}
                        <div className={styles.rbMeta}>
                          {tmpl.steps.length} step{tmpl.steps.length !== 1 ? 's' : ''}
                          {tmpl.category ? ` · ${tmpl.category}` : ''}
                        </div>
                      </div>
                      <div className={styles.rbActions}>
                        {isAdmin && (
                          <Link to={`/runbooks/edit/${tmpl.id}`} className={styles.rbLink}>
                            Edit
                          </Link>
                        )}
                        <Button
                          variant="primary"
                          size="sm"
                          loading={runLoading[tmpl.id]}
                          onClick={() => runTemplate(tmpl)}
                        >
                          ▶ Run
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        {/* ── Right: Runs panel ────────────────────────────────────────────────── */}
        <div className={styles.column}>
          <Card>
            <CardHeader
              title="Runs"
              subtitle={
                activeTab === 'active'
                  ? `${activeRuns.length} active`
                  : `${historyRuns.length} completed`
              }
            />
            <CardBody>
              {/* Tab bar */}
              <div className={styles.tabs}>
                <button
                  className={`${styles.tab} ${activeTab === 'active' ? styles.tabActive : ''}`}
                  onClick={() => setActiveTab('active')}
                >
                  Active
                  {activeRuns.length > 0 && (
                    <span className={styles.tabBadge}>{activeRuns.length}</span>
                  )}
                </button>
                <button
                  className={`${styles.tab} ${activeTab === 'history' ? styles.tabActive : ''}`}
                  onClick={() => setActiveTab('history')}
                >
                  History
                </button>
              </div>

              {/* Active tab */}
              {activeTab === 'active' && (
                loadingActive ? (
                  <div className={styles.loading}>Loading runs…</div>
                ) : activeRuns.length === 0 ? (
                  <EmptyState
                    icon="🚀"
                    title="No active runs"
                    description="Run a runbook to see live progress here"
                  />
                ) : (
                  <ul className={styles.list}>
                    {activeRuns.map(run => renderRunItem(run, false))}
                  </ul>
                )
              )}

              {/* History tab */}
              {activeTab === 'history' && (
                loadingHistory ? (
                  <div className={styles.loading}>Loading history…</div>
                ) : historyRuns.length === 0 ? (
                  <EmptyState
                    icon="📋"
                    title="No history yet"
                    description="Completed and failed runs will appear here"
                  />
                ) : (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                      <Button variant="ghost" size="sm" onClick={() => {
                        const token = localStorage.getItem('itops_token') || sessionStorage.getItem('itops_token');
                        window.open(`/api/runbooks/runs/export.csv?token=${token}`, '_blank');
                      }}>
                        ⬇ Export CSV
                      </Button>
                    </div>
                    <div className={styles.historyTable}>
                    <div className={styles.historyHeader}>
                      <span>Runbook</span>
                      <span>Status</span>
                      <span>Steps</span>
                      <span>Started</span>
                      <span>Duration</span>
                      <span>By</span>
                    </div>
                    {historyRuns.map(run => (
                      <div key={run.id} className={styles.historyRow}>
                        <span className={styles.historyName}>{run.templateName}</span>
                        <span>
                          <Badge variant={runStatusVariant(run.status)}>
                            {run.status}
                          </Badge>
                        </span>
                        <span className={styles.historyMeta}>
                          {run.currentStep}/{run.totalSteps}
                        </span>
                        <span className={styles.historyMeta}>
                          {new Date(run.startedAt).toLocaleString()}
                        </span>
                        <span className={styles.historyMeta}>
                          {formatDuration(run.startedAt, run.completedAt)}
                        </span>
                        <span className={styles.historyMeta}>{run.triggeredBy}</span>
                      </div>
                    ))}
                  </div>
                  </>
                )
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* New Runbook Modal */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title="New Runbook"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={submitting} onClick={createTemplate}>
              Create Runbook
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <label className={styles.label}>
            Name <span className={styles.required}>*</span>
          </label>
          <input
            className={styles.input}
            placeholder="Runbook name"
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && createTemplate()}
          />

          <label className={styles.label}>Description</label>
          <textarea
            className={styles.textarea}
            placeholder="Describe this runbook's purpose (optional)"
            rows={3}
            value={form.description}
            onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
          />
        </div>
      </Modal>

      {/* AI Generate Modal */}
      <Modal
        open={showGenModal}
        onClose={() => setShowGenModal(false)}
        title="✨ Generate Runbook with AI"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowGenModal(false)}>Close</Button>
            {generatedRunbook && (
              <>
                <Button variant="ghost" size="sm" loading={generating} onClick={generateRunbook}>↻ Regenerate</Button>
                <Button variant="primary" size="sm" loading={saving} onClick={saveGeneratedRunbook}>💾 Save Runbook</Button>
              </>
            )}
            {!generatedRunbook && (
              <Button variant="primary" size="sm" loading={generating} onClick={generateRunbook}>
                {generating ? '🤖 Generating…' : 'Generate'}
              </Button>
            )}
          </>
        }
      >
        <div className={styles.form}>
          <label className={styles.label}>Describe what this runbook should do</label>
          <textarea
            className={styles.textarea}
            placeholder="e.g. Restart nginx when memory is above 80%"
            rows={3}
            value={genDescription}
            onChange={e => setGenDescription(e.target.value)}
          />
          <div style={{ fontSize: '0.78rem', color: 'var(--text2)', marginTop: '4px' }}>
            Examples: "Restart nginx when memory is above 80%", "Check SSL cert and alert if expiring in 7 days"
          </div>

          {generating && (
            <div style={{ marginTop: '12px', color: 'var(--accent)', fontSize: '0.85rem' }}>
              🤖 Generating runbook…
            </div>
          )}

          {generatedRunbook && !generating && (
            <div style={{ marginTop: '14px' }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', marginBottom: '6px' }}>Preview</div>
              <pre style={{
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontSize: '0.75rem',
                color: 'var(--text2)',
                overflowX: 'auto',
                maxHeight: '280px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {JSON.stringify(generatedRunbook, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </Modal>
    </Layout>
  )
}

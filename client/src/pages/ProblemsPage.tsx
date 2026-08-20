import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Sparkles, Loader2, ShieldAlert, BookOpen } from 'lucide-react'
import Layout from '../components/Layout'
import Badge from '../components/Badge'
import Button from '../components/Button'
import { Card, CardBody, CardHeader } from '../components/Card'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './ProblemsPage.module.css'

// ── Types mirror server-side ──────────────────────────────────────────

type ProblemStatus = 'open' | 'investigating' | 'resolved'
type ProblemSeverity = 'low' | 'medium' | 'high' | 'critical'
type AiConfidence = 'high' | 'medium' | 'low'

interface Problem {
  id: string
  title: string
  description: string
  status: ProblemStatus
  severity: ProblemSeverity
  sourceRefPattern: string | null
  serverId: string | null
  rootCause: string | null
  suggestedFix: string | null
  aiConfidence: AiConfidence | null
  aiRaw: string | null
  resolution: string | null
  resolvedBy: string | null
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

interface ProblemWithIncidents extends Problem {
  incidentIds: string[]
  occurrences: number
}

interface IncidentLite {
  id: string
  title: string
  severity: string
  status: string
  createdAt: string
  serverId: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────

const SEVERITY_VARIANT: Record<ProblemSeverity, 'danger' | 'warning' | 'accent' | 'neutral'> = {
  critical: 'danger',
  high:     'danger',
  medium:   'warning',
  low:      'accent',
}

const STATUS_VARIANT: Record<ProblemStatus, 'danger' | 'warning' | 'success'> = {
  open:          'danger',
  investigating: 'warning',
  resolved:      'success',
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = ms / 1000
  if (s < 60) return `${Math.round(s)}s ago`
  const m = s / 60
  if (m < 60) return `${Math.round(m)}m ago`
  const h = m / 60
  if (h < 24) return `${h.toFixed(1)}h ago`
  return `${(h / 24).toFixed(1)}d ago`
}

function parseAiPayload(raw: string | null): { rootCause?: string; suggestedFix?: string; preventionRunbook?: Array<Record<string, unknown>>; confidence?: AiConfidence; error?: string; skipped?: boolean; reason?: string } | null {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// ── Page ──────────────────────────────────────────────────────────────

export default function ProblemsPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { show } = useToast()
  const { lastEvent } = useWebSocket()
  const { id: routeId } = useParams<{ id?: string }>()

  const [problems, setProblems] = useState<Problem[]>([])
  const [stats, setStats] = useState<{ open: number; investigating: number; resolved: number; total: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<ProblemStatus | 'all'>('all')

  const isAdmin = user?.role === 'admin'

  const reload = useCallback(async () => {
    try {
      const path = statusFilter === 'all' ? '/api/problems' : `/api/problems?status=${statusFilter}`
      const r = await api.get<{ problems: Problem[]; stats: typeof stats }>(path)
      setProblems(Array.isArray(r?.problems) ? r.problems : [])
      setStats(r?.stats ?? null)
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load problems', 'error')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, show])

  useEffect(() => { reload() }, [reload])

  // Live refresh on WS problem_created events.
  useEffect(() => {
    if (!lastEvent) return
    const t = String((lastEvent as { type?: string }).type ?? '')
    if (t === 'problem_created' || t === 'problem_updated') reload()
  }, [lastEvent, reload])

  if (routeId) {
    return <ProblemDetail id={routeId} onBack={() => navigate('/problems')} onChange={reload} canAdmin={isAdmin} />
  }

  if (loading) {
    return <Layout title="Problems"><div className={styles.empty}>Loading…</div></Layout>
  }

  return (
    <Layout
      title="Problems"
      subtitle="Incidents that keep happening — grouped automatically by the recurring-incident detector"
      actions={
        <div className={styles.filterRow}>
          {(['all', 'open', 'investigating', 'resolved'] as const).map(f => (
            <button
              key={f}
              type="button"
              className={`${styles.filterBtn} ${statusFilter === f ? styles.filterBtnActive : ''}`}
              onClick={() => setStatusFilter(f)}
            >{f}</button>
          ))}
        </div>
      }
    >
      {stats && (
        <div className={styles.statsRow}>
          <StatTile label="Open"          value={stats.open}          tone="danger" />
          <StatTile label="Investigating" value={stats.investigating} tone="warning" />
          <StatTile label="Resolved"      value={stats.resolved}      tone="success" />
          <StatTile label="Total"         value={stats.total}         tone="neutral" />
        </div>
      )}

      <Card>
        <CardHeader title={statusFilter === 'all' ? 'All problems' : `${statusFilter[0].toUpperCase()}${statusFilter.slice(1)} problems`} />
        <CardBody>
          {problems.length === 0 ? (
            <div className={styles.empty}>No problems match this filter.</div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Problem</th>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Scope</th>
                    <th>First seen</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {problems.map(p => (
                    <tr key={p.id} className={styles.row}>
                      <td>
                        <Link to={`/problems/${p.id}`} className={styles.titleLink}>{p.id}</Link>
                        <div className={styles.titleText}>{p.title}</div>
                      </td>
                      <td><Badge variant={SEVERITY_VARIANT[p.severity]}>{p.severity}</Badge></td>
                      <td><Badge variant={STATUS_VARIANT[p.status]}>{p.status}</Badge></td>
                      <td>
                        {p.sourceRefPattern && <span className={styles.scope}>{p.sourceRefPattern}</span>}
                        {p.serverId && <span className={styles.scope}>{p.serverId}</span>}
                        {!p.sourceRefPattern && !p.serverId && '—'}
                      </td>
                      <td title={p.firstSeenAt}>{formatRelative(p.firstSeenAt)}</td>
                      <td title={p.lastSeenAt}>{formatRelative(p.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </Layout>
  )
}

// ── Stat tile ─────────────────────────────────────────────────────────

function StatTile({ label, value, tone }: { label: string; value: number; tone: 'danger' | 'warning' | 'success' | 'neutral' }) {
  return (
    <div className={`${styles.statTile} ${styles[`statTone_${tone}`]}`}>
      <div className={styles.statNum}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

// ── Detail view ───────────────────────────────────────────────────────

interface ProblemDetailProps {
  id: string
  onBack: () => void
  onChange: () => void
  canAdmin: boolean
}

function ProblemDetail({ id, onBack, onChange, canAdmin }: ProblemDetailProps) {
  const { show } = useToast()
  const { lastEvent } = useWebSocket()
  const [problem, setProblem] = useState<ProblemWithIncidents | null>(null)
  const [incidents, setIncidents] = useState<IncidentLite[]>([])
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [creatingRunbook, setCreatingRunbook] = useState(false)
  const [resolution, setResolution] = useState('')

  const reload = useCallback(async () => {
    try {
      const r = await api.get<{ problem: ProblemWithIncidents }>(`/api/problems/${id}`)
      setProblem(r.problem)
      setResolution(r.problem.resolution ?? '')
      // Best-effort fetch of incident summaries — failures are silent.
      const fetched = await Promise.all(
        (r.problem.incidentIds ?? []).map(iid =>
          api.get<{ incident?: IncidentLite }>(`/api/incidents/${iid}`)
            .then(x => x.incident).catch(() => null),
        ),
      )
      setIncidents(fetched.filter((x): x is IncidentLite => !!x))
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load problem', 'error')
    } finally {
      setLoading(false)
    }
  }, [id, show])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (!lastEvent) return
    const t = String((lastEvent as { type?: string }).type ?? '')
    if (t === 'problem_created' || t === 'problem_updated') reload()
  }, [lastEvent, reload])

  const setStatus = async (status: ProblemStatus) => {
    try {
      const body: Record<string, unknown> = { status }
      if (status === 'resolved') body.resolution = resolution.trim() || 'Resolved'
      await api.put(`/api/problems/${id}`, body)
      show(`Status set to ${status}`, 'success')
      reload(); onChange()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Update failed', 'error')
    }
  }

  const reanalyze = async () => {
    setAnalyzing(true)
    try {
      await api.post(`/api/problems/${id}/analyze`, {})
      show('Re-analysis complete', 'success')
      reload()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Analyze failed', 'error')
    } finally {
      setAnalyzing(false)
    }
  }

  const createRunbook = async () => {
    setCreatingRunbook(true)
    try {
      const r = await api.post<{ template: { id: string } }>(`/api/problems/${id}/create-runbook`, {})
      show(`Runbook created: ${r.template.id}`, 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Create runbook failed', 'error')
    } finally {
      setCreatingRunbook(false)
    }
  }

  const aiPayload = useMemo(() => parseAiPayload(problem?.aiRaw ?? null), [problem?.aiRaw])
  const aiError = aiPayload?.error
  const aiSkipped = aiPayload?.skipped

  if (loading || !problem) {
    return <Layout title="Problem"><div className={styles.empty}>Loading…</div></Layout>
  }

  // Visual timeline — group incidents by day so the operator can see
  // the recurrence pattern at a glance.
  const buckets = bucketByDay(incidents)

  return (
    <Layout
      title={problem.title}
      subtitle={`${problem.id} · ${problem.occurrences} occurrence${problem.occurrences === 1 ? '' : 's'} since ${formatRelative(problem.firstSeenAt)}`}
      actions={
        <div className={styles.detailActions}>
          <Button variant="ghost" onClick={onBack}>← Back</Button>
          {problem.status !== 'investigating' && problem.status !== 'resolved' && (
            <Button variant="secondary" onClick={() => setStatus('investigating')}>Mark investigating</Button>
          )}
          {problem.status !== 'resolved' && (
            <Button variant="success" onClick={() => setStatus('resolved')}>Resolve</Button>
          )}
          {problem.status === 'resolved' && (
            <Button variant="ghost" onClick={() => setStatus('open')}>Reopen</Button>
          )}
        </div>
      }
    >
      <div className={styles.detailMeta}>
        <Badge variant={SEVERITY_VARIANT[problem.severity]}>{problem.severity}</Badge>
        <Badge variant={STATUS_VARIANT[problem.status]}>{problem.status}</Badge>
        {problem.sourceRefPattern && <span className={styles.scope}>pattern: {problem.sourceRefPattern}</span>}
        {problem.serverId && <span className={styles.scope}>server: {problem.serverId}</span>}
      </div>

      <Card>
        <CardHeader
          title={<span className={styles.aiTitle}><Sparkles size={14} /> AI root-cause analysis</span> as unknown as string}
          actions={
            <div className={styles.aiActions}>
              {problem.aiConfidence && (
                <Badge variant={problem.aiConfidence === 'high' ? 'success' : problem.aiConfidence === 'low' ? 'danger' : 'warning'}>
                  confidence: {problem.aiConfidence}
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={reanalyze} loading={analyzing}>
                Re-analyze
              </Button>
              {canAdmin && aiPayload?.preventionRunbook && aiPayload.preventionRunbook.length > 0 && (
                <Button variant="primary" size="sm" onClick={createRunbook} loading={creatingRunbook}>
                  <BookOpen size={12} style={{ marginRight: 4 }} /> Create runbook
                </Button>
              )}
            </div>
          }
        />
        <CardBody>
          {aiSkipped && (
            <div className={styles.aiNote}>AI analysis was skipped: {aiPayload?.reason ?? 'configuration missing'}. Configure the Anthropic API key to enable.</div>
          )}
          {aiError && (
            <div className={styles.aiNote}>AI analysis failed: {aiError}. Click <strong>Re-analyze</strong> to retry.</div>
          )}
          {!aiSkipped && !aiError && problem.rootCause && (
            <>
              <div className={styles.aiSection}>
                <div className={styles.aiHeading}>Root cause</div>
                <div className={styles.aiBody}>{problem.rootCause}</div>
              </div>
              {problem.suggestedFix && (
                <div className={styles.aiSection}>
                  <div className={styles.aiHeading}>Permanent fix (suggested)</div>
                  <div className={styles.aiBody}>{problem.suggestedFix}</div>
                </div>
              )}
              {aiPayload?.preventionRunbook && aiPayload.preventionRunbook.length > 0 && (
                <div className={styles.aiSection}>
                  <div className={styles.aiHeading}>Prevention runbook (draft)</div>
                  <ol className={styles.aiList}>
                    {aiPayload.preventionRunbook.map((step, i) => (
                      <li key={i}>
                        <code className={styles.stepType}>{String((step as { type?: string }).type ?? 'step')}</code>{' '}
                        {String((step as { description?: string }).description ?? 'unnamed step')}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
          {!aiSkipped && !aiError && !problem.rootCause && (
            <div className={styles.aiNote}>
              <Loader2 size={14} className={styles.spin} /> Analysis pending. The detector kicks off the AI call on problem creation; click <strong>Re-analyze</strong> if it hasn't completed.
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recurrence timeline" subtitle={`${incidents.length} linked incidents`} />
        <CardBody>
          {buckets.length === 0 ? (
            <div className={styles.empty}>No linked incidents.</div>
          ) : (
            <div className={styles.timeline}>
              {buckets.map(b => (
                <div key={b.day} className={styles.timelineDay}>
                  <div className={styles.timelineDayLabel}>{b.day}</div>
                  <div className={styles.timelineDots}>
                    {b.incidents.map(inc => (
                      <Link
                        key={inc.id}
                        to={`/incidents/${inc.id}`}
                        className={`${styles.timelineDot} ${styles[`dot_${inc.severity}`] ?? ''}`}
                        title={`${inc.id}: ${inc.title}`}
                      >
                        <span>{inc.id.slice(-4)}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Linked incidents" />
        <CardBody>
          {incidents.length === 0 ? (
            <div className={styles.empty}>No linked incidents found.</div>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr><th>ID</th><th>Title</th><th>Severity</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {incidents.map(inc => (
                  <tr key={inc.id}>
                    <td><Link to={`/incidents/${inc.id}`} className={styles.titleLink}>{inc.id}</Link></td>
                    <td>{inc.title}</td>
                    <td>{inc.severity}</td>
                    <td>{inc.status}</td>
                    <td title={inc.createdAt}>{formatRelative(inc.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>

      {problem.status !== 'resolved' && (
        <Card>
          <CardHeader title="Resolution notes" subtitle="Capture what fixed it permanently — kept on the problem record" />
          <CardBody>
            <textarea
              className={styles.textarea}
              value={resolution}
              onChange={e => setResolution(e.target.value)}
              placeholder="e.g. Increased /data partition to 100GB; root cause was journald retention misconfigured"
              rows={4}
            />
          </CardBody>
        </Card>
      )}

      {problem.status === 'resolved' && problem.resolution && (
        <Card>
          <CardHeader
            title={<span className={styles.resolvedTitle}><ShieldAlert size={14} /> Resolved</span> as unknown as string}
            subtitle={problem.resolvedAt ? `at ${problem.resolvedAt}${problem.resolvedBy ? ` by ${problem.resolvedBy}` : ''}` : undefined}
          />
          <CardBody>
            <div className={styles.aiBody}>{problem.resolution}</div>
          </CardBody>
        </Card>
      )}
    </Layout>
  )
}

function bucketByDay(incidents: IncidentLite[]): Array<{ day: string; incidents: IncidentLite[] }> {
  const map = new Map<string, IncidentLite[]>()
  for (const inc of incidents) {
    const day = inc.createdAt.slice(0, 10)
    const arr = map.get(day) ?? []
    arr.push(inc)
    map.set(day, arr)
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, arr]) => ({ day, incidents: arr }))
}

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import { Card, CardHeader, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './IncidentDetailPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type IncidentStatus = 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed'
type TimelineEventType = 'opened' | 'escalated' | 'note' | 'resolved' | 'closed' | 'updated' | string

interface TimelineEntry {
  id: string
  incidentId: string
  timestamp: string
  actor: string
  type: TimelineEventType
  message: string
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

interface Incident {
  id: string
  title: string
  description?: string
  severity: Severity
  status: IncidentStatus
  assignedTo?: string | null
  assignedAgent?: string | null
  source?: string
  sourceRef?: string | null
  serverId?: string | null
  createdAt: string
  updatedAt: string
  resolvedAt?: string | null
  slaMinutes?: number
  slaBreached?: boolean
  jiraKey?: string
  jiraUrl?: string
  aiAnalysis?: string
  /** Escalation pipeline state. Level 0 means "not (yet) escalated".
   *  1=agent ReAct, 2=auto-remediator, 3=human notified, 4=critical urgency. */
  escalationLevel?: number
  escalatedAt?: string | null
  timeline?: TimelineEntry[]
}

interface Agent {
  id: string
  name: string
  role?: string
  type?: string
}

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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Hex literals match design tokens in index.css. Kept as hex so callers can
// append alpha (e.g. + '22') for tinted backgrounds in inline styles.
const confidenceColor = (c: IncidentAnalysis['confidence']) =>
  c === 'high' ? '#22C55E' : c === 'medium' ? '#F59E0B' : '#EF4444'

const priorityColor = (p: IncidentAnalysis['priority']) =>
  p === 'immediate' ? '#EF4444' : p === 'soon' ? '#E8734A' : '#306EF0'

const timelineDot: Record<string, string> = {
  opened: 'var(--danger)',
  escalated: 'var(--warning)',
  resolved: 'var(--success)',
  closed: 'var(--text3)',
  note: 'var(--accent)',
  updated: 'var(--text2)',
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

// ── Escalation pipeline rendering ───────────────────────────────────────────

interface LevelStep {
  level: 0 | 1 | 2 | 3 | 4
  label: string
  description: string
}

const ESCALATION_STEPS: LevelStep[] = [
  { level: 0, label: 'New',            description: 'Incident opened, automation not yet engaged.' },
  { level: 1, label: 'Agent',          description: 'Assigned agent running the ReAct diagnosis loop.' },
  { level: 2, label: 'Auto-remediate', description: 'Pre-baked recipe (disk cleanup, docker prune, …) in flight.' },
  { level: 3, label: 'Human paged',    description: 'Automation exhausted — OpenClaw alert sent to a human channel.' },
  { level: 4, label: 'Critical',       description: 'Still open past the L4 timeout — severity bumped, urgent follow-up.' },
]

/** Pull the L<n> level prefix out of `[L3] Notifying human channels — …`
 *  style timeline notes that EscalationPipeline writes. */
function parseLevelFromNote(message: string): number | null {
  const m = /^\[L(\d)\]/.exec(message)
  return m ? Number(m[1]) : null
}

/** Find when each level was first reached. We walk the timeline newest-
 *  to-oldest; the FIRST entry we see for a given level is the most
 *  recent transition, but we want the FIRST in chronological order, so
 *  use a Map and only set on miss. */
function buildLevelHistory(timeline: TimelineEntry[]): Map<number, TimelineEntry> {
  const m = new Map<number, TimelineEntry>()
  // Chronological order (oldest first) so the first match per level wins.
  const sorted = [...timeline].sort((a, b) =>
    Date.parse(a.timestamp) - Date.parse(b.timestamp),
  )
  for (const t of sorted) {
    const lvl = parseLevelFromNote(t.message)
    if (lvl != null && !m.has(lvl)) m.set(lvl, t)
  }
  return m
}

function EscalationStepper({ incident, timeline }: {
  incident: Incident
  timeline: TimelineEntry[]
}) {
  const currentLevel = Math.max(0, Math.min(4, incident.escalationLevel ?? 0))
  const resolved = incident.status === 'resolved' || incident.status === 'closed'
  const history = buildLevelHistory(timeline)

  // Stepper colour logic:
  //  - Resolved incidents render every reached step in green.
  //  - For active incidents:
  //      reached but not current → green-ish (done)
  //      current level            → amber (in progress)
  //      future levels            → muted (not yet)
  //      L4 reached + active      → red (critical)
  const stateFor = (step: LevelStep): 'done' | 'active' | 'critical' | 'pending' => {
    if (resolved) return step.level <= currentLevel ? 'done' : 'pending'
    if (step.level < currentLevel) return 'done'
    if (step.level === currentLevel) {
      return currentLevel >= 4 ? 'critical' : 'active'
    }
    return 'pending'
  }

  return (
    <Card>
      <CardHeader
        title="Escalation Pipeline"
        subtitle={resolved
          ? `Resolved — reached level ${currentLevel}`
          : `Current level: L${currentLevel}`}
      />
      <CardBody>
        <ol className={styles.stepper}>
          {ESCALATION_STEPS.map((step, idx) => {
            const state = stateFor(step)
            const entry = history.get(step.level)
            const reachedAt = entry?.timestamp
            return (
              <li key={step.level} className={`${styles.step} ${styles[`step_${state}`]}`}>
                <div className={styles.stepHead}>
                  <span className={styles.stepDot} aria-hidden>{step.level}</span>
                  <span className={styles.stepLabel}>L{step.level} {step.label}</span>
                  {reachedAt && (
                    <span className={styles.stepWhen}>{formatDate(reachedAt)}</span>
                  )}
                </div>
                <div className={styles.stepDesc}>{step.description}</div>
                {entry && (
                  <div className={styles.stepNote}>
                    {entry.message.replace(/^\[L\d\]\s*/, '')}
                  </div>
                )}
                {idx < ESCALATION_STEPS.length - 1 && (
                  <span className={`${styles.stepConnector} ${styles[`connector_${state}`]}`} />
                )}
              </li>
            )
          })}
        </ol>
      </CardBody>
    </Card>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IncidentDetailPage() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { show } = useToast()
  const { lastEvent } = useWebSocket()

  const [incident, setIncident] = useState<Incident | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)

  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [postingNote, setPostingNote] = useState(false)

  const [assignOpen, setAssignOpen] = useState(false)
  const [assignTo, setAssignTo] = useState('')
  const [assignSubmitting, setAssignSubmitting] = useState(false)

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchIncident = useCallback(async () => {
    if (!id) return
    try {
      const data = await api.get<Incident>(`/api/incidents/${id}`)
      setIncident(data)
      setNotFound(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.includes('404') || /not found/i.test(msg)) {
        setNotFound(true)
      } else {
        show(msg || 'Failed to load incident', 'error')
      }
    } finally {
      setLoading(false)
    }
  }, [id, show])

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.get<AgentsResponse>('/api/agents')
      setAgents(flattenAgents(data))
    } catch {
      // non-fatal: agent name lookup is just a nicety
    }
  }, [])

  useEffect(() => {
    fetchIncident()
    fetchAgents()
    pollingRef.current = setInterval(fetchIncident, 30_000)
    return () => { if (pollingRef.current) clearInterval(pollingRef.current) }
  }, [fetchIncident, fetchAgents])

  // Refetch on websocket updates for this specific incident
  useEffect(() => {
    if (!lastEvent) return
    if (lastEvent.type !== 'incident_updated') return
    const data = lastEvent.data as { id?: string } | undefined
    if (data?.id && data.id !== id) return
    fetchIncident()
  }, [lastEvent, id, fetchIncident])

  const agentName = (idOrName?: string | null): string => {
    if (!idOrName) return '—'
    const found = agents.find(a => a.id === idOrName)
    return found?.name ?? idOrName
  }

  const analysis: IncidentAnalysis | null = (() => {
    if (!incident?.aiAnalysis) return null
    try { return JSON.parse(incident.aiAnalysis) as IncidentAnalysis } catch { return null }
  })()

  // ── Actions ─────────────────────────────────────────────────────────────────

  const escalate = async () => {
    if (!incident) return
    setActionLoading('escalate')
    try {
      await api.post(`/api/incidents/${incident.id}/escalate`)
      show('Incident escalated', 'warning')
      fetchIncident()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Escalation failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  const resolve = async () => {
    if (!incident) return
    setActionLoading('resolve')
    try {
      await api.post(`/api/incidents/${incident.id}/resolve`)
      show('Incident resolved', 'success')
      fetchIncident()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Resolve failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  const closeIncident = async () => {
    if (!incident) return
    if (!confirm('Close this incident?')) return
    setActionLoading('close')
    try {
      await api.post(`/api/incidents/${incident.id}/close`)
      show('Incident closed', 'success')
      fetchIncident()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Close failed', 'error')
    } finally {
      setActionLoading(null)
    }
  }

  const submitAssign = async () => {
    if (!incident) return
    const value = assignTo.trim()
    if (!value) { show('Pick an agent or enter a name', 'error'); return }
    setAssignSubmitting(true)
    try {
      await api.patch(`/api/incidents/${incident.id}`, { assignedTo: value })
      show('Assignment updated', 'success')
      setAssignOpen(false)
      setAssignTo('')
      fetchIncident()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Assign failed', 'error')
    } finally {
      setAssignSubmitting(false)
    }
  }

  const analyze = async () => {
    if (!incident) return
    setAnalyzing(true)
    try {
      const data = await api.post<{ analysis: IncidentAnalysis }>(`/api/incidents/${incident.id}/analyze`)
      setIncident(prev => prev ? { ...prev, aiAnalysis: JSON.stringify(data.analysis) } : prev)
      show('AI analysis complete', 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Analysis failed', 'error')
    } finally {
      setAnalyzing(false)
    }
  }

  const addNote = async () => {
    if (!incident || !noteText.trim()) return
    setPostingNote(true)
    try {
      await api.post(`/api/incidents/${incident.id}/note`, { message: noteText.trim() })
      setNoteText('')
      fetchIncident()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to add note', 'error')
    } finally {
      setPostingNote(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading && !incident) {
    return (
      <Layout title="Incident" subtitle="Loading…">
        <div className={styles.loading}>Loading incident…</div>
      </Layout>
    )
  }

  if (notFound || !incident) {
    return (
      <Layout title="Incident not found" subtitle={id ? `#${id}` : ''}>
        <Card>
          <CardBody>
            <div className={styles.notFound}>
              <p>This incident doesn’t exist or you don’t have access to it.</p>
              <div className={styles.notFoundActions}>
                <Button variant="primary" size="sm" onClick={() => navigate('/incidents')}>
                  ← Back to Incidents
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </Layout>
    )
  }

  const isOpen = incident.status !== 'resolved' && incident.status !== 'closed'
  const timeline = Array.isArray(incident.timeline) ? incident.timeline : []
  // Newest first
  const sortedTimeline = [...timeline].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  // Remediation status: derived from the latest 'updated' or status-change
  // timeline entry, plus the incident status itself. The /resolve endpoint
  // appends a 'resolved' timeline entry whose message is the resolution.
  const remediationEntry = [...timeline].reverse().find(t =>
    t.type === 'resolved' || /remediat/i.test(t.message)
  )

  return (
    <Layout
      title={incident.title}
      subtitle={`Incident #${incident.id.slice(-6).toUpperCase()}`}
      actions={
        <div className={styles.headerActions}>
          {isOpen && (
            <>
              <Button
                variant="ghost"
                size="sm"
                loading={actionLoading === 'escalate'}
                onClick={escalate}
                style={{ color: 'var(--warning)' }}
              >
                ↑ Escalate
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setAssignTo(incident.assignedTo ?? ''); setAssignOpen(true) }}
              >
                Assign
              </Button>
              <Button
                variant="success"
                size="sm"
                loading={actionLoading === 'resolve'}
                onClick={resolve}
              >
                ✓ Resolve
              </Button>
            </>
          )}
          {incident.status === 'resolved' && (
            <Button
              variant="ghost"
              size="sm"
              loading={actionLoading === 'close'}
              onClick={closeIncident}
            >
              Close
            </Button>
          )}
          <Link to="/incidents" className={styles.backLink}>← Incidents</Link>
        </div>
      }
    >
      {/* Top metadata strip */}
      <div className={styles.metaStrip}>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Severity</span>
          <Badge variant={severityVariant(incident.severity)}>{incident.severity}</Badge>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Status</span>
          <Badge variant={statusVariant(incident.status)}>{incident.status}</Badge>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Assigned</span>
          <span className={styles.metaVal}>{agentName(incident.assignedTo)}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Source</span>
          <span className={styles.metaVal}>{incident.source ?? '—'}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Created</span>
          <span className={styles.metaVal}>{formatDate(incident.createdAt)}</span>
        </div>
        <div className={styles.metaItem}>
          <span className={styles.metaLabel}>Updated</span>
          <span className={styles.metaVal}>{formatDate(incident.updatedAt)}</span>
        </div>
        {incident.resolvedAt && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Resolved</span>
            <span className={styles.metaVal}>{formatDate(incident.resolvedAt)}</span>
          </div>
        )}
        {incident.slaBreached && (
          <div className={styles.metaItem}>
            <Badge variant="danger">SLA Breached</Badge>
          </div>
        )}
        {incident.jiraKey && (
          <div className={styles.metaItem}>
            <span className={styles.metaLabel}>Jira</span>
            {incident.jiraUrl ? (
              <a href={incident.jiraUrl} target="_blank" rel="noreferrer" className={styles.jiraLink}>
                {incident.jiraKey}
              </a>
            ) : (
              <span className={styles.metaVal}>{incident.jiraKey}</span>
            )}
          </div>
        )}
      </div>

      {/* Escalation pipeline state — visual stepper before the deeper detail */}
      <EscalationStepper incident={incident} timeline={timeline} />

      <div className={styles.grid}>
        {/* Left column: description + timeline */}
        <div className={styles.colMain}>
          <ProblemBanner incidentId={incident.id} />
          <AssetBanner incidentId={incident.id} />
          <ChangeCorrelationBanner incidentId={incident.id} />
          <Card>
            <CardHeader title="Description" />
            <CardBody>
              {incident.description ? (
                <p className={styles.description}>{incident.description}</p>
              ) : (
                <p className={styles.descriptionEmpty}>No description provided.</p>
              )}
            </CardBody>
          </Card>

          {incident.status === 'resolved' || incident.status === 'closed' ? (
            <ResolutionCard incident={incident} timeline={timeline} />
          ) : (
            <Card>
              <CardHeader
                title="Remediation Status"
                subtitle="Latest remediation activity for this incident"
              />
              <CardBody>
                {remediationEntry ? (
                  <div className={styles.remediationOk}>
                    <Badge variant="warning">in progress</Badge>
                    <span className={styles.remediationMsg}>{remediationEntry.message}</span>
                  </div>
                ) : (
                  <div className={styles.remediationEmpty}>
                    No remediation activity yet. Use the action buttons above to escalate, assign, or resolve.
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Timeline" subtitle="Most recent first" />
            <CardBody>
              {sortedTimeline.length === 0 ? (
                <div className={styles.timelineEmpty}>No timeline entries yet.</div>
              ) : (
                <ul className={styles.timeline}>
                  {sortedTimeline.map(t => (
                    <li key={t.id} className={styles.timelineItem}>
                      <span
                        className={styles.timelineDot}
                        style={{ background: timelineDot[t.type] ?? 'var(--text3)' }}
                        aria-hidden
                      />
                      <div className={styles.timelineBody}>
                        <div className={styles.timelineHeader}>
                          <span className={styles.timelineType}>{t.type}</span>
                          <span className={styles.timelineActor}>{t.actor}</span>
                          <span className={styles.timelineTime}>{formatDate(t.timestamp)}</span>
                        </div>
                        <div className={styles.timelineMessage}>{t.message}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className={styles.noteRow}>
                <input
                  className={styles.noteInput}
                  placeholder="Add a note to the timeline…"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && noteText.trim() && addNote()}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={postingNote}
                  onClick={addNote}
                  disabled={!noteText.trim()}
                >
                  Post
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Right column: AI analysis */}
        <div className={styles.colSide}>
          <SlaWidget incidentId={incident.id} />
          <Card>
            <CardHeader
              title="🤖 AI Analysis"
              actions={
                <Button variant="ghost" size="xs" loading={analyzing} onClick={analyze}>
                  {analyzing ? 'Analyzing…' : analysis ? '↻ Re-analyze' : 'Analyze'}
                </Button>
              }
            />
            <CardBody>
              {!analysis && !analyzing && (
                <div className={styles.aiEmpty}>
                  No analysis yet. Click <strong>Analyze</strong> to run the LLM root-cause assistant.
                </div>
              )}
              {analyzing && !analysis && (
                <div className={styles.aiEmpty}>Analyzing incident…</div>
              )}
              {analysis && (
                <div className={styles.aiBody}>
                  <div className={styles.aiBadges}>
                    <span style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: confidenceColor(analysis.confidence) + '22',
                      color: confidenceColor(analysis.confidence),
                      border: `1px solid ${confidenceColor(analysis.confidence)}`,
                    }}>
                      {analysis.confidence} confidence
                    </span>
                    <span style={{
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: priorityColor(analysis.priority) + '22',
                      color: priorityColor(analysis.priority),
                      border: `1px solid ${priorityColor(analysis.priority)}`,
                    }}>
                      {analysis.priority}
                    </span>
                  </div>

                  <div className={styles.aiSection}>
                    <div className={styles.aiSectionTitle}>Root Cause</div>
                    <div className={styles.aiText}>{analysis.rootCauseLikely}</div>
                  </div>

                  {analysis.estimatedImpact && (
                    <div className={styles.aiSection}>
                      <div className={styles.aiSectionTitle}>Estimated Impact</div>
                      <div className={styles.aiText}>{analysis.estimatedImpact}</div>
                    </div>
                  )}

                  {analysis.remediationSteps?.length > 0 && (
                    <div className={styles.aiSection}>
                      <div className={styles.aiSectionTitle}>Remediation Steps</div>
                      <ol className={styles.aiList}>
                        {analysis.remediationSteps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {analysis.preventionTips?.length > 0 && (
                    <div className={styles.aiSection}>
                      <div className={styles.aiSectionTitle}>Prevention Tips</div>
                      <ul className={styles.aiList}>
                        {analysis.preventionTips.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {analysis.relatedSystems?.length > 0 && (
                    <div className={styles.aiSection}>
                      <div className={styles.aiSectionTitle}>Related Systems</div>
                      <div className={styles.aiTags}>
                        {analysis.relatedSystems.map(s => (
                          <span key={s} className={styles.aiTag}>{s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Assign Modal */}
      <Modal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title="Assign Incident"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={assignSubmitting} onClick={submitAssign}>
              Assign
            </Button>
          </>
        }
      >
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Agent</label>
          {agents.length > 0 && (
            <select
              className={styles.select}
              value={agents.some(a => a.id === assignTo) ? assignTo : ''}
              onChange={e => setAssignTo(e.target.value)}
            >
              <option value="">— Select an agent —</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.role ? ` (${a.role})` : ''}</option>
              ))}
            </select>
          )}
          <input
            className={styles.input}
            placeholder="…or type a custom username/team"
            value={assignTo}
            onChange={e => setAssignTo(e.target.value)}
            style={{ marginTop: agents.length > 0 ? 8 : 0 }}
          />
          <div className={styles.fieldHint}>
            Pick a registered agent above, or type any free-form name.
          </div>
        </div>
      </Modal>
    </Layout>
  )
}

// ── SLA widget ────────────────────────────────────────────────────────
// Renders response + resolution deadlines for an incident, with a
// countdown and breach state. Fetches /api/sla/tracking/:incidentId.

interface SlaTrackingView {
  responseDeadline: string
  resolutionDeadline: string
  responseMet: boolean | null
  resolutionMet: boolean | null
  respondedAt: string | null
  resolvedAt: string | null
  breached: boolean
  warningEmitted: boolean
}

function SlaWidget({ incidentId }: { incidentId: string }) {
  const [tracking, setTracking] = useState<SlaTrackingView | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    api.get<{ tracking: SlaTrackingView }>(`/api/sla/tracking/${incidentId}`)
      .then(r => { if (!cancelled) setTracking(r.tracking) })
      .catch(() => { if (!cancelled) setTracking(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [incidentId])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  if (loading) return null
  if (!tracking) return null

  const fmt = (deadline: string, met: boolean | null) => {
    const d = new Date(deadline).getTime()
    const diff = d - now
    if (met === true) return { label: 'met', tone: 'success' as const }
    if (met === false) return { label: `missed (deadline ${new Date(deadline).toLocaleString()})`, tone: 'danger' as const }
    if (diff <= 0) return { label: `breached by ${formatDelta(-diff)}`, tone: 'danger' as const }
    return { label: `${formatDelta(diff)} left`, tone: diff < 0.25 * 60_000 ? 'danger' as const : 'warning' as const }
  }

  const respView = fmt(tracking.responseDeadline, tracking.responseMet)
  const resoView = fmt(tracking.resolutionDeadline, tracking.resolutionMet)

  return (
    <Card>
      <CardHeader title="SLA" subtitle={tracking.breached ? 'Resolution deadline breached' : 'On the clock'} />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '.85rem' }}>
          <div>
            <div style={{ color: 'var(--text3)', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>
              Response
            </div>
            <div>
              <Badge variant={respView.tone === 'success' ? 'success' : respView.tone === 'danger' ? 'danger' : 'warning'}>
                {respView.label}
              </Badge>
              <span style={{ marginLeft: 8, color: 'var(--text3)', fontSize: '.75rem' }}>
                {tracking.respondedAt ? `responded ${new Date(tracking.respondedAt).toLocaleTimeString()}` : 'not yet'}
              </span>
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text3)', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>
              Resolution
            </div>
            <div>
              <Badge variant={resoView.tone === 'success' ? 'success' : resoView.tone === 'danger' ? 'danger' : 'warning'}>
                {resoView.label}
              </Badge>
              <span style={{ marginLeft: 8, color: 'var(--text3)', fontSize: '.75rem' }}>
                {tracking.resolvedAt ? `resolved ${new Date(tracking.resolvedAt).toLocaleTimeString()}` : 'open'}
              </span>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

function formatDelta(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = min / 60
  if (h < 24) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

// ── ResolutionCard ────────────────────────────────────────────────────
// Shown once an incident is resolved or closed. Surfaces:
//   • Whether resolution was automatic (AutoResolver / health-monitor
//     sweep) or driven by an operator.
//   • The resolution note recorded on the timeline.
//   • Auto-resolver detail: matched runbook, confidence, link to the
//     runbook run when a decision row is available.
//   • Any `auto-resolver` actor notes on the timeline (these capture
//     the runbook name + confidence at the moment of dispatch).
//
// Source of truth is the timeline (always present). The decision row
// from /api/ai/resolver/decisions is a best-effort enrichment for the
// runbook run id — when absent we still surface what we have.

interface ResolverDecisionRow {
  id: string
  incidentId: string | null
  confidence: number
  reasoning: string
  autoApplied: boolean
  outcome: 'pending' | 'success' | 'failed' | 'reopened' | 'overridden'
  payload?: {
    action?: string
    runbookId?: string | null
    runbookName?: string | null
    runId?: string | null
    kbId?: string | null
    kbTitle?: string | null
  }
  createdAt: string
}

function ResolutionCard({ incident, timeline }: {
  incident: Incident
  timeline: TimelineEntry[]
}) {
  const [decision, setDecision] = useState<ResolverDecisionRow | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<{ decisions: ResolverDecisionRow[] }>(
      `/api/ai/resolver/decisions?incidentId=${encodeURIComponent(incident.id)}&limit=10`,
    )
      .then(r => {
        if (cancelled) return
        const list = Array.isArray(r?.decisions) ? r.decisions : []
        // Newest first; pick the most recent auto-applied one if there is
        // one, otherwise just the newest. /api/ai/resolver/decisions
        // already orders by created_at DESC.
        const applied = list.find(d => d.autoApplied) ?? list[0] ?? null
        setDecision(applied)
      })
      .catch(() => { /* silent — card still renders from timeline */ })
    return () => { cancelled = true }
  }, [incident.id])

  // The 'resolved' timeline note carries the resolution string after the
  // SLA prefix. Strip the prefix for cleaner display.
  const resolvedEntry = [...timeline].reverse().find(t => t.type === 'resolved') ?? null
  const resolutionText = resolvedEntry?.message ?? ''
  // Format: "Resolved in 5m (SLA: 60m) ✅ Within SLA. <resolution>"
  const resolutionDetail = (() => {
    const m = /(?:Within SLA|SLA BREACHED)\.?\s+(.+)$/s.exec(resolutionText)
    return m ? m[1].trim() : resolutionText
  })()
  const slaPrefix = (() => {
    const m = /^(Resolved in [^.]+\.\s*(?:✅ Within SLA|⚠️ SLA BREACHED))/.exec(resolutionText)
    return m ? m[1] : null
  })()

  // Auto-resolver notes — actor === 'auto-resolver' OR system 'note' that
  // starts with 'Auto-resolved' (the health-monitor sweep path). Sorted
  // oldest-first so the dispatch note precedes the eventual resolution.
  const autoNotes = timeline
    .filter(t =>
      t.actor === 'auto-resolver'
      || (t.type === 'note' && /^Auto-resolved\b/i.test(t.message)),
    )
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))

  const isAuto =
    autoNotes.length > 0
    || /^auto:/i.test(resolutionDetail)
    || decision?.autoApplied === true

  const verifiedEntry = [...timeline].reverse().find(t =>
    t.type === 'note' && /verification\s+(passed|FAILED)/i.test(t.message),
  )

  return (
    <Card>
      <CardHeader
        title="Resolution"
        subtitle={incident.status === 'closed' ? 'Incident closed' : 'Incident resolved'}
        actions={
          <Badge variant={isAuto ? 'accent' : 'success'}>
            {isAuto ? '🤖 Auto-resolved' : '👤 Manual'}
          </Badge>
        }
      />
      <CardBody>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* When + by whom */}
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: '.85rem' }}>
            <div>
              <div className={styles.aiSectionTitle}>Resolved at</div>
              <div className={styles.aiText}>{formatDate(incident.resolvedAt)}</div>
            </div>
            <div>
              <div className={styles.aiSectionTitle}>Resolved by</div>
              <div className={styles.aiText}>
                {isAuto ? 'auto-resolver' : (resolvedEntry?.actor ?? 'operator')}
              </div>
            </div>
            {slaPrefix && (
              <div>
                <div className={styles.aiSectionTitle}>SLA</div>
                <div className={styles.aiText}>{slaPrefix.replace(/^Resolved in /, '')}</div>
              </div>
            )}
          </div>

          {/* The resolution note itself */}
          {resolutionDetail && (
            <div className={styles.aiSection}>
              <div className={styles.aiSectionTitle}>Resolution notes</div>
              <div className={styles.aiText} style={{ whiteSpace: 'pre-wrap' }}>
                {resolutionDetail.replace(/^auto:\s*/i, '')}
              </div>
            </div>
          )}

          {/* Auto-resolver: matched runbook + decision metadata */}
          {decision && decision.autoApplied && (
            <div className={styles.aiSection}>
              <div className={styles.aiSectionTitle}>AutoResolver decision</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: '.85rem' }}>
                {decision.payload?.runbookName && (
                  <div>
                    <strong>Runbook:</strong>{' '}
                    {decision.payload.runbookId ? (
                      <Link to={`/runbooks/edit/${decision.payload.runbookId}`} style={{ color: 'var(--accent)' }}>
                        {decision.payload.runbookName}
                      </Link>
                    ) : (
                      <span>{decision.payload.runbookName}</span>
                    )}
                  </div>
                )}
                {decision.payload?.runId && (
                  <div>
                    <strong>Run:</strong>{' '}
                    <Link to={`/runbooks/runs/${decision.payload.runId}`} style={{ color: 'var(--accent)' }}>
                      View commands executed →
                    </Link>
                  </div>
                )}
                {decision.payload?.kbTitle && (
                  <div>
                    <strong>Knowledge base match:</strong> {decision.payload.kbTitle}
                  </div>
                )}
                <div>
                  <strong>Confidence:</strong> {(decision.confidence * 100).toFixed(0)}%
                  <span style={{ marginLeft: 8, color: 'var(--text3)' }}>
                    · outcome: {decision.outcome}
                  </span>
                </div>
                {decision.reasoning && (
                  <div style={{ fontStyle: 'italic', color: 'var(--text2)' }}>
                    {decision.reasoning}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Auto-resolver timeline notes — capture the dispatch detail
              even when no decision row is reachable (e.g. older incidents
              from before AiDecisionStore wiring). */}
          {autoNotes.length > 0 && !decision?.autoApplied && (
            <div className={styles.aiSection}>
              <div className={styles.aiSectionTitle}>Auto-resolver activity</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4, fontSize: '.85rem' }}>
                {autoNotes.map(n => (
                  <li key={n.id} style={{ color: 'var(--text)' }}>
                    <span style={{ color: 'var(--text3)', fontSize: '.75rem', marginRight: 6 }}>
                      {formatDate(n.timestamp)}
                    </span>
                    {n.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {verifiedEntry && (
            <div style={{ fontSize: '.8rem', color: 'var(--text2)' }}>
              <strong>Post-resolution check:</strong> {verifiedEntry.message}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

// ── ProblemBanner ─────────────────────────────────────────────────────
// Renders a slim banner at the top of the incident detail page when
// the incident is linked to a recurring-problem record. Queries
// /api/problems/by-incident/:id, which returns { problem: null } when
// no link exists (the banner stays hidden).

interface LinkedProblemView {
  id: string
  title: string
  status: string
  severity: string
  occurrences: number
  firstSeenAt: string
}

function ProblemBanner({ incidentId }: { incidentId: string }) {
  const [problem, setProblem] = useState<LinkedProblemView | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<{ problem: LinkedProblemView | null }>(`/api/problems/by-incident/${incidentId}`)
      .then(r => { if (!cancelled) setProblem(r.problem) })
      .catch(() => { /* silent — banner just stays hidden */ })
    return () => { cancelled = true }
  }, [incidentId])

  if (!problem) return null

  const days = Math.max(
    1,
    Math.round((Date.now() - new Date(problem.firstSeenAt).getTime()) / 86_400_000),
  )

  return (
    <div style={{
      padding: '10px 14px',
      marginBottom: 16,
      background: 'var(--warning-bg)',
      border: '1px solid var(--warning)',
      borderRadius: 'var(--radius-sm)',
      color: 'var(--text)',
      fontSize: '.9rem',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 700, color: 'var(--warning)' }}>↻ Recurring problem</span>
      <Link to={`/problems/${problem.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
        {problem.id}: {problem.title}
      </Link>
      <span style={{ color: 'var(--text2)', fontSize: '.8rem' }}>
        This incident is one of {problem.occurrences} occurrences in the last {days} day{days === 1 ? '' : 's'}.
      </span>
    </div>
  )
}

// ── AssetBanner ───────────────────────────────────────────────────────
// Surfaces the CMDB asset linked to this incident (via the incident's
// server_id). Stays hidden when no link exists, keeping the banner
// surface clean for unscoped/standalone incidents.

interface LinkedAssetView {
  id: string
  type: string
  name: string
  description: string | null
  tags: string[]
}

function AssetBanner({ incidentId }: { incidentId: string }) {
  const [asset, setAsset] = useState<LinkedAssetView | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<{ asset: LinkedAssetView | null }>(`/api/assets/by-incident/${incidentId}`)
      .then(r => { if (!cancelled) setAsset(r.asset) })
      .catch(() => { /* silent — banner stays hidden */ })
    return () => { cancelled = true }
  }, [incidentId])

  if (!asset) return null

  return (
    <div style={{
      padding: '10px 14px',
      marginBottom: 16,
      background: 'var(--accent-bg)',
      border: '1px solid var(--accent)',
      borderRadius: 'var(--radius-sm)',
      color: 'var(--text)',
      fontSize: '.9rem',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 700, color: 'var(--accent)' }}>⊟ Linked asset</span>
      <Link to={`/assets/${asset.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
        {asset.id}: {asset.name}
      </Link>
      <span style={{ color: 'var(--text2)', fontSize: '.8rem', textTransform: 'capitalize' }}>
        {asset.type}{asset.tags.length > 0 ? ' · ' + asset.tags.map(t => '#' + t).join(' ') : ''}
      </span>
    </div>
  )
}

// ── ChangeCorrelationBanner ────────────────────────────────────────
// Asks the correlation engine "did anything just change?". When the
// engine returns one or more matches, surface the top hit with its
// confidence label. The full ranked list is one click away.

interface CorrelatedChangeView {
  change: {
    id: string
    title: string
    status: string
    type: string
    source: string
    createdAt: string
    assetId: string | null
    serverId: string | null
  }
  score: number
  likelihood: 'likely' | 'possible' | 'recent'
  reason: string
  upstreamDepth?: number
}

function ChangeCorrelationBanner({ incidentId }: { incidentId: string }) {
  const [items, setItems] = useState<CorrelatedChangeView[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api.get<{ correlated: CorrelatedChangeView[] }>(`/api/changes/by-incident/${incidentId}`)
      .then(r => { if (!cancelled) setItems(Array.isArray(r.correlated) ? r.correlated : []) })
      .catch(() => { /* silent — banner stays hidden */ })
    return () => { cancelled = true }
  }, [incidentId])

  if (!items || items.length === 0) return null

  // Color the banner by the top hit's likelihood.
  const top = items[0]
  const color = top.likelihood === 'likely' ? 'var(--danger)'
              : top.likelihood === 'possible' ? 'var(--warning)'
              : 'var(--text2)'
  const bg    = top.likelihood === 'likely' ? 'rgba(239,68,68,.08)'
              : top.likelihood === 'possible' ? 'rgba(245,158,11,.08)'
              : 'var(--bg3)'
  const label = top.likelihood === 'likely' ? 'Likely cause'
              : top.likelihood === 'possible' ? 'Possible cause'
              : 'Recent change'

  return (
    <div style={{
      padding: '10px 14px',
      marginBottom: 16,
      background: bg,
      border: `1px solid ${color}`,
      borderRadius: 'var(--radius-sm)',
      color: 'var(--text)',
      fontSize: '.9rem',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, color }}>⚠ {label}</span>
        <Link to={`/changes/${top.change.id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
          {top.change.id}: {top.change.title}
        </Link>
        <span style={{ color: 'var(--text2)', fontSize: '.78rem' }}>
          {top.change.type} · {top.change.status} · {Math.round(top.score * 100)}% match
        </span>
      </div>
      <span style={{ color: 'var(--text2)', fontSize: '.78rem', fontStyle: 'italic' }}>
        {top.reason}
      </span>
      {items.length > 1 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text2)', fontSize: '.78rem' }}>
            + {items.length - 1} more recent change{items.length === 2 ? '' : 's'}
          </summary>
          <ul style={{ margin: '6px 0 0 18px', padding: 0, fontSize: '.82rem' }}>
            {items.slice(1).map(c => (
              <li key={c.change.id}>
                <Link to={`/changes/${c.change.id}`} style={{ color: 'var(--accent)' }}>
                  {c.change.id}
                </Link>{' '}{c.change.title}{' '}<span style={{ color: 'var(--text3)' }}>· {Math.round(c.score * 100)}%</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

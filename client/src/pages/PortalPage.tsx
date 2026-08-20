// Self-service portal — designed for non-technical end-users.
//
// Three sections (each owns its own visual card):
//   1. Report an Issue — simple form, friendly severity labels
//   2. My Tickets     — only this user's incidents, status filter,
//                        click-to-expand timeline + SLA countdown
//   3. Chat            — embedded ChatWidget (inline fullscreen panel)
//
// Stays completely separate from the admin Layout/Sidebar. Uses
// PortalLayout (just a header + logout) so a requester never sees the
// admin chrome. Admins/operators who navigate here see only their own
// tickets — same data, simpler UX.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Send, ChevronDown, ChevronRight, RefreshCw, Clock, MessageCircle, Inbox } from 'lucide-react'
import PortalLayout from '../components/PortalLayout'
import ChatWidget from '../components/ChatWidget'
import { useAuth } from '../hooks/useAuth'
import { useWebSocket } from '../hooks/useWebSocket'
import { api } from '../lib/api'
import type { Server } from '../lib/types'
import styles from './PortalPage.module.css'

// ── Types ────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type Status = 'open' | 'investigating' | 'mitigating' | 'resolved' | 'closed'

interface PortalIncident {
  id: string
  title: string
  description: string
  severity: Severity
  status: Status
  assignedTo: string | null
  assignedAgent: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  slaMinutes: number
  createdBy?: string | null
}

interface TimelineEntry {
  id: string
  timestamp: string
  actor: string
  type: string
  message: string
}

interface MineResponse {
  incidents: PortalIncident[]
  total: number
}

// ── Severity mapping (user-friendly labels → backend values) ─────────

const SEVERITY_LABELS: { value: Severity; label: string; hint: string }[] = [
  { value: 'critical', label: 'Urgent',    hint: 'System down, blocking work' },
  { value: 'high',     label: 'Important', hint: 'Major function impacted'    },
  { value: 'medium',   label: 'Normal',    hint: 'Annoying but workable'      },
  { value: 'low',      label: 'Low',       hint: 'Cosmetic or future fix'     },
]

// SLA / severity / status colours — hex so we can also tint with alpha
// in inline styles. Matches the design tokens (--danger, --warm, etc.).
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#EF4444',
  high:     '#E8734A',
  medium:   '#F59E0B',
  low:      '#306EF0',
}
const STATUS_COLOR: Record<Status, string> = {
  open:           '#EF4444',
  investigating:  '#F59E0B',
  mitigating:     '#F59E0B',
  resolved:       '#22C55E',
  closed:         '#9CA3AF',
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return iso }
}

function ageMinutes(iso: string, now: number): number {
  const t = new Date(iso).getTime()
  return Math.max(0, Math.floor((now - t) / 60000))
}

interface SlaState { pct: number; remaining: number; tone: 'ok' | 'warn' | 'breach' }
function slaState(inc: PortalIncident, now: number): SlaState {
  if (inc.status === 'resolved' || inc.status === 'closed') return { pct: 0, remaining: 0, tone: 'ok' }
  const elapsed = ageMinutes(inc.createdAt, now)
  const sla = Math.max(1, inc.slaMinutes)
  const pct = Math.min(100, Math.round((elapsed / sla) * 100))
  const remaining = Math.max(0, sla - elapsed)
  const tone: SlaState['tone'] = pct >= 100 ? 'breach' : pct >= 75 ? 'warn' : 'ok'
  return { pct, remaining, tone }
}

function humanRemaining(min: number): string {
  if (min <= 0) return 'breached'
  if (min < 60) return `${min}m left`
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h < 24) return `${h}h ${m}m left`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h left`
}

// ── Page ─────────────────────────────────────────────────────────────

export default function PortalPage() {
  const { user, loading: authLoading } = useAuth()
  const { lastEvent } = useWebSocket()
  const [tickets, setTickets] = useState<PortalIncident[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'inprogress' | 'resolved'>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // ── Tick "now" for SLA countdowns. 30s feels live without thrashing. ──
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // ── Fetch own tickets. /mine is the scoped endpoint. ──
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.get<MineResponse | PortalIncident[]>('/api/incidents/mine')
      const arr = Array.isArray(data) ? data : data?.incidents
      setTickets(Array.isArray(arr) ? arr : [])
    } catch (e) {
      // 403 means the platform isn't configured for self-service or the
      // user has no incident permissions. Either way: empty list, no toast.
      setTickets([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (!authLoading) refresh() }, [authLoading, refresh])

  // ── Live refresh on WS events that might affect this user's tickets. ──
  useEffect(() => {
    if (!lastEvent) return
    const evt = lastEvent as { type?: string }
    if (evt?.type === 'incident_updated' || evt?.type === 'incident_created') {
      refresh()
    }
  }, [lastEvent, refresh])

  // ── Filtered view. ──
  const filtered = useMemo(() => {
    if (statusFilter === 'all') return tickets
    if (statusFilter === 'open') return tickets.filter(t => t.status === 'open')
    if (statusFilter === 'inprogress') return tickets.filter(t => t.status === 'investigating' || t.status === 'mitigating')
    if (statusFilter === 'resolved') return tickets.filter(t => t.status === 'resolved' || t.status === 'closed')
    return tickets
  }, [tickets, statusFilter])

  return (
    <PortalLayout>
      <div className={styles.heroRow}>
        <div>
          <h1 className={styles.h1}>How can we help, {user?.username || 'friend'}?</h1>
          <p className={styles.heroSub}>Report a problem, track your tickets, or chat with the assistant.</p>
        </div>
      </div>

      <div className={styles.grid}>
        <ReportSection onCreated={refresh} />
        <MyTicketsSection
          tickets={filtered}
          totalCount={tickets.length}
          loading={loading}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          expandedId={expandedId}
          setExpandedId={setExpandedId}
          now={now}
          onRefresh={refresh}
        />
        <ChatSection />
      </div>
    </PortalLayout>
  )
}

// ── Report an Issue ─────────────────────────────────────────────────

function ReportSection({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [serverId, setServerId] = useState<string>('')
  const [servers, setServers] = useState<Server[]>([])
  const [serversFailed, setServersFailed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ id: string } | null>(null)

  // Server list is optional — requesters typically don't have
  // monitoring.read so the call may 403. That's fine: dropdown just
  // stays empty and the requester picks "no server".
  useEffect(() => {
    let cancelled = false
    api.get<{ servers: Server[] } | Server[]>('/api/servers')
      .then(d => {
        if (cancelled) return
        const arr = Array.isArray(d) ? d : (d?.servers ?? [])
        setServers(Array.isArray(arr) ? arr : [])
      })
      .catch(() => { if (!cancelled) setServersFailed(true) })
    return () => { cancelled = true }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    if (!title.trim()) { setError('Please describe the issue in a few words.'); return }
    setSubmitting(true)
    try {
      const inc = await api.post<{ id: string }>('/api/incidents', {
        title: title.trim(),
        description: description.trim(),
        severity,
        source: 'manual',
        ...(serverId ? { serverId } : {}),
      })
      setSuccess({ id: inc.id })
      setTitle('')
      setDescription('')
      setSeverity('medium')
      setServerId('')
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create ticket')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={`${styles.card} ${styles.reportCard}`}>
      <div className={styles.cardHeader}>
        <AlertCircle size={18} />
        <h2>Report an issue</h2>
      </div>
      <form onSubmit={submit} className={styles.form}>
        <label className={styles.field}>
          <span>What's wrong?</span>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Email not sending, slow VPN, etc."
            maxLength={200}
            disabled={submitting}
            required
          />
        </label>

        <label className={styles.field}>
          <span>More details (optional)</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="When did it start? What were you trying to do?"
            rows={3}
            maxLength={4000}
            disabled={submitting}
          />
        </label>

        <div className={styles.fieldRow}>
          <fieldset className={styles.severityField}>
            <legend>How urgent?</legend>
            <div className={styles.severityChips}>
              {SEVERITY_LABELS.map(s => (
                <button
                  type="button"
                  key={s.value}
                  className={`${styles.sevChip} ${severity === s.value ? styles.sevChipActive : ''}`}
                  style={severity === s.value ? { borderColor: SEVERITY_COLOR[s.value], color: SEVERITY_COLOR[s.value] } : undefined}
                  onClick={() => setSeverity(s.value)}
                  disabled={submitting}
                  title={s.hint}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </fieldset>

          {!serversFailed && servers.length > 0 && (
            <label className={styles.field}>
              <span>Which system? (optional)</span>
              <select value={serverId} onChange={e => setServerId(e.target.value)} disabled={submitting}>
                <option value="">— none / not sure —</option>
                {servers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        {error && <div className={styles.errorBox}>{error}</div>}
        {success && (
          <div className={styles.successBox}>
            ✓ Ticket <strong>{success.id}</strong> created. We'll get back to you shortly.
          </div>
        )}

        <div className={styles.actions}>
          <button type="submit" className={styles.submitBtn} disabled={submitting || !title.trim()}>
            {submitting ? 'Submitting…' : (<><Send size={14} /> Submit ticket</>)}
          </button>
          <span className={styles.preferChat}>
            Prefer to chat? Use the assistant on the right →
          </span>
        </div>
      </form>
    </section>
  )
}

// ── My Tickets ──────────────────────────────────────────────────────

function MyTicketsSection(props: {
  tickets: PortalIncident[]
  totalCount: number
  loading: boolean
  statusFilter: 'all' | 'open' | 'inprogress' | 'resolved'
  setStatusFilter: (v: 'all' | 'open' | 'inprogress' | 'resolved') => void
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  now: number
  onRefresh: () => void
}) {
  const { tickets, totalCount, loading, statusFilter, setStatusFilter, expandedId, setExpandedId, now, onRefresh } = props

  return (
    <section className={`${styles.card} ${styles.ticketsCard}`}>
      <div className={styles.cardHeader}>
        <Inbox size={18} />
        <h2>My tickets</h2>
        <span className={styles.totalPill}>{totalCount}</span>
        <button type="button" className={styles.refreshBtn} onClick={onRefresh} title="Refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      <div className={styles.filterRow}>
        {([
          { v: 'all',        label: 'All'         },
          { v: 'open',       label: 'Open'        },
          { v: 'inprogress', label: 'In progress' },
          { v: 'resolved',   label: 'Resolved'    },
        ] as const).map(o => (
          <button
            key={o.v}
            type="button"
            className={`${styles.filterBtn} ${statusFilter === o.v ? styles.filterBtnActive : ''}`}
            onClick={() => setStatusFilter(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {loading && <div className={styles.empty}>Loading your tickets…</div>}
      {!loading && tickets.length === 0 && (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>📭</div>
          {totalCount === 0 ? 'No tickets yet. Use the form on the left to file one.' : 'No tickets match this filter.'}
        </div>
      )}
      {!loading && tickets.length > 0 && (
        <ul className={styles.ticketList}>
          {tickets.map(t => (
            <TicketCard
              key={t.id}
              ticket={t}
              expanded={expandedId === t.id}
              onToggle={() => setExpandedId(expandedId === t.id ? null : t.id)}
              now={now}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function TicketCard({ ticket, expanded, onToggle, now }: {
  ticket: PortalIncident
  expanded: boolean
  onToggle: () => void
  now: number
}) {
  const sla = slaState(ticket, now)
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null)
  const [timelineErr, setTimelineErr] = useState<string | null>(null)

  // Lazy-fetch timeline only when expanded. /api/incidents/:id with
  // the scoped-read gate succeeds for the owner; we tolerate failures.
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setTimelineErr(null)
    api.get<{ timeline?: TimelineEntry[] } | PortalIncident & { timeline?: TimelineEntry[] }>(`/api/incidents/${ticket.id}`)
      .then(d => {
        if (cancelled) return
        const tl = (d as { timeline?: TimelineEntry[] }).timeline ?? null
        setTimeline(Array.isArray(tl) ? tl : [])
      })
      .catch(e => { if (!cancelled) setTimelineErr(e instanceof Error ? e.message : 'Failed to load timeline') })
    return () => { cancelled = true }
  }, [expanded, ticket.id])

  return (
    <li className={styles.ticket}>
      <button type="button" className={styles.ticketHead} onClick={onToggle} aria-expanded={expanded}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <div className={styles.ticketMain}>
          <div className={styles.ticketTitleRow}>
            <span className={styles.ticketId}>{ticket.id}</span>
            <span className={styles.ticketTitle}>{ticket.title}</span>
          </div>
          <div className={styles.ticketMeta}>
            <span className={styles.badge} style={{ background: SEVERITY_COLOR[ticket.severity] + '22', color: SEVERITY_COLOR[ticket.severity] }}>
              {ticket.severity}
            </span>
            <span className={styles.badge} style={{ background: STATUS_COLOR[ticket.status] + '22', color: STATUS_COLOR[ticket.status] }}>
              {ticket.status}
            </span>
            <span className={styles.metaItem}>
              <Clock size={11} /> {fmtDate(ticket.createdAt)}
            </span>
            {ticket.assignedAgent && (
              <span className={styles.metaItem}>👤 {ticket.assignedAgent}</span>
            )}
          </div>
        </div>
        {ticket.status !== 'resolved' && ticket.status !== 'closed' && (
          <div className={`${styles.slaWrap} ${styles[`sla_${sla.tone}`]}`}>
            <div className={styles.slaTrack}>
              <div className={styles.slaFill} style={{ width: `${Math.min(100, sla.pct)}%` }} />
            </div>
            <span className={styles.slaLabel}>{humanRemaining(sla.remaining)}</span>
          </div>
        )}
      </button>
      {expanded && (
        <div className={styles.ticketBody}>
          {ticket.description && <p className={styles.desc}>{ticket.description}</p>}
          <h4 className={styles.timelineH}>Timeline</h4>
          {timelineErr && <div className={styles.errorBox}>{timelineErr}</div>}
          {timeline === null && !timelineErr && <div className={styles.empty}>Loading…</div>}
          {timeline && timeline.length === 0 && <div className={styles.empty}>No updates yet — we'll post here when something changes.</div>}
          {timeline && timeline.length > 0 && (
            <ul className={styles.timeline}>
              {timeline.map(entry => (
                <li key={entry.id} className={styles.timelineItem}>
                  <span className={styles.timelineTime}>{fmtDate(entry.timestamp)}</span>
                  <span className={styles.timelineActor}>{entry.actor}</span>
                  <span className={styles.timelineMsg}>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

// ── Chat section ────────────────────────────────────────────────────

function ChatSection() {
  const { user } = useAuth()
  return (
    <section className={`${styles.card} ${styles.chatCard}`}>
      <div className={styles.cardHeader}>
        <MessageCircle size={18} />
        <h2>Chat with the assistant</h2>
      </div>
      <div className={styles.chatBody}>
        <ChatWidget
          embedded
          greeting={`שלום ${user?.username || ''}, איך אפשר לעזור?`}
        />
      </div>
    </section>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { MessageCircle, X, Send, Loader2, Paperclip, Trash2 } from 'lucide-react'
import { useWebSocket } from '../hooks/useWebSocket'
import { useAuth } from '../hooks/useAuth'
import styles from './ChatWidget.module.css'

// ── Types ────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'

interface IncidentCard {
  kind: 'incident'
  id: string
  title: string
  severity: Severity
  status: string
  assignedTo: string | null
  createdAt: string
}

interface ServerCard {
  kind: 'server'
  id: string
  name: string
  host: string | null
  status: 'ok' | 'error' | 'unknown'
  enabled: boolean
  lastSeen: string | null
  metrics?: { cpu?: number; memory?: number; disk?: number }
}

type ChatCard = IncidentCard | ServerCard

interface AttachmentPayload {
  name: string
  type: string
  data: string                  // base64 (no data: prefix) — for WS payload
}

interface AttachmentRender {
  name: string
  type: string
  dataUrl: string               // for the bubble thumbnail
}

interface ChatMsg {
  id: string
  role: 'user' | 'bot' | 'update'
  text: string
  incidentId?: string
  cards?: ChatCard[]
  suggestions?: string[]
  attachment?: AttachmentRender
  streaming?: boolean           // true while we're still appending chunks
  timestamp: number
}

interface PersistedState {
  sessionId: string
  messages: ChatMsg[]
}

// ── Constants ─────────────────────────────────────────────────────────

const STORAGE_KEY = 'itops-chat-history'
const MAX_PERSIST_MESSAGES = 100
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024 // 4MB raw before base64 → ~5.5MB on the wire
const ACCEPT_MIME = 'image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,text/csv,application/json'

/** Hex literals match the design tokens (--success, --warning, --danger,
 *  --warm, --accent). Recharts / SVG-style consumers can't resolve
 *  var(--…) at fill time, and we want a stable palette for ARIA labels too. */
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#EF4444',
  high:     '#E8734A',
  medium:   '#F59E0B',
  low:      '#306EF0',
}
const STATUS_COLOR: Record<string, string> = {
  open: '#EF4444',
  investigating: '#F59E0B',
  mitigating: '#F59E0B',
  resolved: '#22C55E',
  closed: '#9CA3AF',
}
const SERVER_STATUS_COLOR: Record<ServerCard['status'], string> = {
  ok: '#22C55E',
  error: '#EF4444',
  unknown: '#9CA3AF',
}

// ── Utilities ─────────────────────────────────────────────────────────

function randId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { sessionId: randId(), messages: [] }
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId ? parsed.sessionId : randId()
    const messages = Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_PERSIST_MESSAGES) : []
    // Stripping `streaming: true` is critical — a tab crash mid-stream
    // would otherwise restore a bubble with a phantom typing indicator.
    return { sessionId, messages: messages.map(m => ({ ...m, streaming: false })) as ChatMsg[] }
  } catch {
    return { sessionId: randId(), messages: [] }
  }
}

function persist(state: PersistedState): void {
  try {
    const trimmed: PersistedState = {
      sessionId: state.sessionId,
      messages: state.messages.slice(-MAX_PERSIST_MESSAGES),
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // Quota errors are rare and not actionable for the user — drop silently.
  }
}

/** Render a chat message, turning any INC-XXXX tokens into in-app links. */
function renderText(text: string, explicitIncidentId?: string): ReactNode {
  const parts: ReactNode[] = []
  const regex = /\b(INC-[A-Z0-9]{4,12})\b/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index))
    const id = m[1]
    seen.add(id)
    parts.push(
      <Link key={`${id}-${m.index}`} to={`/incidents/${id}`} className={styles.incLink}>{id}</Link>
    )
    lastIndex = m.index + id.length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  if (explicitIncidentId && !seen.has(explicitIncidentId)) {
    parts.push(' ')
    parts.push(
      <Link key="explicit" to={`/incidents/${explicitIncidentId}`} className={styles.incLink}>
        Open {explicitIncidentId} →
      </Link>
    )
  }
  return parts
}

function age(d: string): string {
  const s = (Date.now() - new Date(d).getTime()) / 1000
  if (s < 60) return '<1m'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

// ── Card sub-components ───────────────────────────────────────────────

interface CardActionHandlers {
  onAction: (action: 'escalate' | 'resolve', targetId: string) => void
  /** When false, the Escalate/Resolve buttons are hidden — used to keep
   *  viewer accounts from seeing actions they can't run. The server
   *  enforces the same gate regardless, so this is UX-only. */
  canAct: boolean
}

function IncidentCardView({ card, onAction, canAct }: { card: IncidentCard } & CardActionHandlers) {
  const sevColor = SEVERITY_COLOR[card.severity] ?? '#9CA3AF'
  const statusColor = STATUS_COLOR[card.status] ?? '#9CA3AF'
  const resolved = card.status === 'resolved' || card.status === 'closed'
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <Link to={`/incidents/${card.id}`} className={styles.cardTitleLink}>{card.id}</Link>
        <span className={styles.badge} style={{ background: sevColor + '22', color: sevColor, borderColor: sevColor + '55' }}>
          {card.severity}
        </span>
        <span className={styles.badge} style={{ background: statusColor + '22', color: statusColor, borderColor: statusColor + '55' }}>
          {card.status}
        </span>
      </div>
      <div className={styles.cardTitle}>{card.title}</div>
      <div className={styles.cardMeta}>
        {card.assignedTo ? `Assigned: ${card.assignedTo}` : 'Unassigned'}
        {' · '}opened {age(card.createdAt)} ago
      </div>
      {!resolved && canAct && (
        <div className={styles.cardActions}>
          <button type="button" className={styles.cardBtn} onClick={() => onAction('escalate', card.id)}>
            Escalate
          </button>
          <button type="button" className={`${styles.cardBtn} ${styles.cardBtnPrimary}`} onClick={() => onAction('resolve', card.id)}>
            Resolve
          </button>
        </div>
      )}
    </div>
  )
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value))
  const color = v >= 90 ? '#EF4444' : v >= 75 ? '#F59E0B' : '#22C55E'
  return (
    <div className={styles.metricRow}>
      <span className={styles.metricLabel}>{label}</span>
      <div className={styles.metricBar}>
        <div className={styles.metricFill} style={{ width: v + '%', background: color }} />
      </div>
      <span className={styles.metricValue}>{v.toFixed(0)}%</span>
    </div>
  )
}

function ServerCardView({ card }: { card: ServerCard }) {
  const color = SERVER_STATUS_COLOR[card.status]
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardTitleLink}>{card.name}</span>
        <span className={styles.badge} style={{ background: color + '22', color, borderColor: color + '55' }}>
          {card.status}
        </span>
        {!card.enabled && (
          <span className={styles.badge} style={{ background: '#9CA3AF22', color: '#6B7280' }}>disabled</span>
        )}
      </div>
      <div className={styles.cardMeta}>
        {card.host ?? 'local'} · {card.lastSeen ? `seen ${age(card.lastSeen)} ago` : 'never seen'}
      </div>
      {card.metrics && (
        <div className={styles.metrics}>
          {card.metrics.cpu    !== undefined && <MetricBar label="CPU"  value={card.metrics.cpu} />}
          {card.metrics.memory !== undefined && <MetricBar label="MEM"  value={card.metrics.memory} />}
          {card.metrics.disk   !== undefined && <MetricBar label="DISK" value={card.metrics.disk} />}
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────

interface ChatWidgetProps {
  /** When true the widget renders inline (no floating button, no
   *  open/close state) and fills its parent container. Used by the
   *  self-service portal so end-users get a fullscreen chat panel
   *  embedded in the page instead of a corner bubble. */
  embedded?: boolean
  /** Optional greeting override. Defaults to the localized "shalom"
   *  message — portal callers can pass a more domain-appropriate
   *  prompt (e.g. "How can we help?"). */
  greeting?: string
}

export default function ChatWidget({ embedded = false, greeting }: ChatWidgetProps = {}) {
  // Hydrate from localStorage on first render so the user sees yesterday's
  // conversation when they reopen. SessionId persists so push notifications
  // for incidents the previous session watched still arrive.
  const initial = useMemo(loadPersisted, [])
  const [sessionId] = useState<string>(initial.sessionId)
  // Embedded mode is always "open" — there's no bubble to expand.
  const [open, setOpen] = useState(embedded)
  const [messages, setMessages] = useState<ChatMsg[]>(initial.messages)
  const [input, setInput] = useState('')
  const [waiting, setWaiting] = useState(false)
  const [unread, setUnread] = useState(0)
  const [pulse, setPulse] = useState(false)
  const [pendingAttachment, setPendingAttachment] = useState<{ payload: AttachmentPayload; render: AttachmentRender } | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const { connected, lastEvent, send } = useWebSocket()
  const { user } = useAuth()
  // viewers can read everything but can't escalate/resolve. The server
  // refuses regardless of UI state; hiding the buttons just keeps the
  // surface honest.
  const canAct = user?.role !== 'viewer'
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Track the in-progress streaming bubble id so chunks attach to it.
  const streamingBubbleRef = useRef<string | null>(null)
  // Track whether the panel is currently open so chat:update routes
  // correctly between "render in-place" vs "increment unread".
  const openRef = useRef(open)
  useEffect(() => { openRef.current = open }, [open])

  // Persist on every relevant change. Throttling isn't needed — localStorage
  // writes here are bounded to MAX_PERSIST_MESSAGES JSON, and user typing
  // doesn't trigger this effect.
  useEffect(() => {
    persist({ sessionId, messages })
  }, [sessionId, messages])

  // Clear unread when opened.
  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  // Greeting on first-ever open (no persisted history).
  useEffect(() => {
    if (open && messages.length === 0) {
      const greetName = user?.username ? ` ${user.username}` : ''
      const text = greeting
        ? `${greeting.replace('{name}', greetName.trim() || 'there')}`
        : `שלום${greetName}! Hi — I can help with incidents and infrastructure. Try one of the suggestions below or type your own.`
      setMessages([{
        id: randId(),
        role: 'bot',
        text,
        suggestions: embedded
          ? ['פתח קריאה חדשה', 'הקריאות שלי', 'סטטוס שרתים']
          : ['קריאות פתוחות', 'סטטוס שרתים', 'פתח קריאה חדשה'],
        timestamp: Date.now(),
      }])
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open, messages.length, user?.username, embedded, greeting])

  // ── WebSocket event router ─────────────────────────────────────────
  useEffect(() => {
    if (!lastEvent) return
    const evt = lastEvent as {
      type?: string
      sessionId?: string
      text?: string
      chunk?: string
      done?: boolean
      incidentId?: string
      cards?: ChatCard[]
      suggestions?: string[]
    }
    if (evt.sessionId !== sessionId) return

    if (evt.type === 'chat:response') {
      const text = typeof evt.text === 'string' ? evt.text : ''
      streamingBubbleRef.current = null
      setMessages(prev => [...prev, {
        id: randId(),
        role: 'bot',
        text,
        incidentId: evt.incidentId,
        cards: Array.isArray(evt.cards) ? evt.cards : undefined,
        suggestions: Array.isArray(evt.suggestions) ? evt.suggestions : undefined,
        timestamp: Date.now(),
      }])
      setWaiting(false)
      return
    }

    if (evt.type === 'chat:stream') {
      const chunk = typeof evt.chunk === 'string' ? evt.chunk : ''
      const done = !!evt.done
      const id = streamingBubbleRef.current
      if (!id) {
        // First chunk arrives — create the bubble we'll keep appending to.
        const newId = randId()
        streamingBubbleRef.current = newId
        setMessages(prev => [...prev, {
          id: newId,
          role: 'bot',
          text: chunk,
          streaming: !done,
          timestamp: Date.now(),
        }])
      } else {
        setMessages(prev => prev.map(m =>
          m.id === id ? { ...m, text: m.text + chunk } : m
        ))
      }
      if (done) {
        const finalId = streamingBubbleRef.current
        streamingBubbleRef.current = null
        setMessages(prev => prev.map(m =>
          m.id === finalId ? {
            ...m,
            streaming: false,
            incidentId: evt.incidentId,
            cards: Array.isArray(evt.cards) ? evt.cards : m.cards,
            suggestions: Array.isArray(evt.suggestions) ? evt.suggestions : m.suggestions,
          } : m
        ))
        setWaiting(false)
      }
      return
    }

    if (evt.type === 'chat:update') {
      const text = typeof evt.text === 'string' ? evt.text : ''
      setMessages(prev => [...prev, {
        id: randId(),
        role: 'update',
        text,
        incidentId: evt.incidentId,
        timestamp: Date.now(),
      }])
      if (!openRef.current) {
        setUnread(u => u + 1)
        setPulse(true)
        setTimeout(() => setPulse(false), 1500)
      }
    }
  }, [lastEvent, sessionId])

  // Auto-scroll to latest.
  useEffect(() => {
    if (!open) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, waiting, open])

  // ── Sending ─────────────────────────────────────────────────────────
  const sendMessage = useCallback((text: string, attachment?: { payload: AttachmentPayload; render: AttachmentRender }) => {
    const trimmed = text.trim()
    if (!trimmed && !attachment) return
    if (waiting) return
    const userMsg: ChatMsg = {
      id: randId(),
      role: 'user',
      text: trimmed,
      attachment: attachment?.render,
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setPendingAttachment(null)
    setAttachError(null)
    setWaiting(true)
    send({
      type: 'chat:message',
      sessionId,
      text: trimmed,
      ...(attachment ? { attachment: attachment.payload } : {}),
    })
  }, [send, sessionId, waiting])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input, pendingAttachment ?? undefined)
  }, [input, pendingAttachment, sendMessage])

  const handleSuggestion = useCallback((text: string) => {
    sendMessage(text)
  }, [sendMessage])

  const handleAction = useCallback((action: 'escalate' | 'resolve', targetId: string) => {
    if (waiting) return
    setWaiting(true)
    send({ type: 'chat:action', sessionId, action, targetId })
  }, [send, sessionId, waiting])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so re-selecting the same file fires onChange again
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError(`Attachment too large (${(file.size / 1024 / 1024).toFixed(1)}MB, max 4MB).`)
      return
    }
    try {
      const data = await fileToBase64(file)
      const dataUrl = `data:${file.type};base64,${data}`
      setPendingAttachment({
        payload: { name: file.name, type: file.type, data },
        render: { name: file.name, type: file.type, dataUrl },
      })
      setAttachError(null)
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : 'Failed to read file')
    }
  }, [])

  const clearHistory = useCallback(() => {
    if (!confirm('Clear chat history?')) return
    setMessages([])
    streamingBubbleRef.current = null
    setWaiting(false)
    setUnread(0)
  }, [])

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className={embedded ? styles.embeddedShell : undefined}>
      {!open && !embedded && (
        <button
          type="button"
          className={`${styles.bubble} ${pulse ? styles.bubblePulse : ''}`}
          onClick={() => setOpen(true)}
          aria-label={unread > 0 ? `Open chat (${unread} unread)` : 'Open chat'}
        >
          <MessageCircle size={22} />
          {unread > 0 && (
            <span className={styles.badge99} aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}

      {open && (
        <div
          className={`${embedded ? styles.panelEmbedded : styles.panel}`}
          role={embedded ? 'region' : 'dialog'}
          aria-label="RightAPI Forge chat"
        >
          <header className={styles.header}>
            <div className={styles.headerTitle}>
              <MessageCircle size={16} />
              <span>ITOps Assistant</span>
              <span className={connected ? styles.dotOk : styles.dotErr} aria-label={connected ? 'connected' : 'reconnecting'} />
            </div>
            <div className={styles.headerActions}>
              <button
                type="button"
                onClick={clearHistory}
                className={styles.iconBtn}
                aria-label="Clear history"
                title="Clear history"
              >
                <Trash2 size={14} />
              </button>
              {!embedded && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className={styles.iconBtn}
                  aria-label="Close chat"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </header>

          <div className={styles.messages} ref={scrollRef}>
            {messages.map(m => (
              <div key={m.id} className={
                m.role === 'user'   ? styles.rowUser :
                m.role === 'update' ? styles.rowUpdate :
                                      styles.rowBot
              }>
                {m.role === 'update' ? (
                  <div className={styles.updateBubble}>
                    🔔 {renderText(m.text, m.incidentId)}
                  </div>
                ) : (
                  <>
                    {m.attachment && (
                      <div className={m.role === 'user' ? styles.bubbleUser : styles.bubbleBot}>
                        {m.attachment.type.startsWith('image/') ? (
                          <img src={m.attachment.dataUrl} alt={m.attachment.name} className={styles.attachmentImg} />
                        ) : (
                          <div className={styles.attachmentText}>📎 {m.attachment.name}</div>
                        )}
                      </div>
                    )}
                    {(m.text || m.streaming) && (
                      <div className={m.role === 'user' ? styles.bubbleUser : styles.bubbleBot}>
                        {renderText(m.text, m.incidentId)}
                        {m.streaming && <span className={styles.caret} aria-hidden="true">▍</span>}
                      </div>
                    )}
                    {m.cards && m.cards.length > 0 && (
                      <div className={styles.cards}>
                        {m.cards.map((c, i) => (
                          c.kind === 'incident'
                            ? <IncidentCardView key={c.id + i} card={c} onAction={handleAction} canAct={canAct} />
                            : <ServerCardView   key={c.id + i} card={c} />
                        ))}
                      </div>
                    )}
                    {m.suggestions && m.suggestions.length > 0 && (
                      <div className={styles.suggestions}>
                        {m.suggestions.map((s, i) => (
                          <button
                            type="button"
                            key={s + i}
                            className={styles.chip}
                            onClick={() => handleSuggestion(s)}
                            disabled={waiting}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {waiting && streamingBubbleRef.current === null && (
              <div className={styles.rowBot} aria-live="polite">
                <div className={styles.bubbleBot}>
                  <Loader2 size={14} className={styles.spin} /> thinking…
                </div>
              </div>
            )}
          </div>

          {pendingAttachment && (
            <div className={styles.attachmentBar}>
              <Paperclip size={14} />
              <span className={styles.attachmentName}>{pendingAttachment.render.name}</span>
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setPendingAttachment(null)}
                aria-label="Remove attachment"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {attachError && <div className={styles.attachError}>{attachError}</div>}

          <form className={styles.inputRow} onSubmit={handleSubmit}>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_MIME}
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <button
              type="button"
              className={styles.iconBtnSquare}
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || waiting}
              aria-label="Attach file"
              title="Attach image or text file"
            >
              <Paperclip size={16} />
            </button>
            <input
              ref={inputRef}
              type="text"
              className={styles.input}
              placeholder={connected ? 'Type a message…' : 'Reconnecting…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              disabled={!connected}
              maxLength={2000}
            />
            <button
              type="submit"
              className={styles.sendBtn}
              disabled={(!input.trim() && !pendingAttachment) || waiting || !connected}
              aria-label="Send"
            >
              <Send size={16} />
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

// Live Console — real-time event stream from /api/events.
//
// Uses polling (every `pollMs` seconds) since GET /api/events is the
// existing read endpoint and there's no SSE/WS event channel yet.
// Polling is fine for an operator dashboard at this cadence; we can
// graduate to SSE later.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import s from './agentDesigner/common.module.css'

interface AppendedEvent {
  id: string
  timestamp: string
  tenantId: string
  aggregateType: string
  aggregateId: string
  type: string
  actor: string
  correlationId?: string
  causationId?: string
  data: unknown
}

const DEFAULT_POLL_MS = 5_000

export default function LiveConsolePage() {
  const { show } = useToast()
  const [events, setEvents]     = useState<AppendedEvent[]>([])
  const [filterType, setFilterType] = useState('')
  const [filterAgg, setFilterAgg]   = useState('')
  const [filterText, setFilterText] = useState('')
  const [paused, setPaused]     = useState(false)
  const [pollMs, setPollMs]     = useState(DEFAULT_POLL_MS)
  const [openId, setOpenId]     = useState<string | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const lastTsRef = useRef<string | undefined>(undefined)

  const tick = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('limit', '200')
      if (filterType) params.set('type',          filterType)
      if (filterAgg)  params.set('aggregateType', filterAgg)
      if (lastTsRef.current) params.set('since', lastTsRef.current)
      const r = await api.get<{ events: AppendedEvent[] }>(`/api/events?${params.toString()}`)
      const incoming = r.events ?? []
      if (incoming.length > 0) {
        // Merge by id, keep newest 500.
        setEvents(prev => {
          const seen = new Set(prev.map(e => e.id))
          const merged = [...incoming.filter(e => !seen.has(e.id)), ...prev]
          return merged.slice(0, 500)
        })
        // Bump the cursor — `since` is exclusive on the server side.
        lastTsRef.current = incoming[incoming.length - 1].timestamp
      }
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [filterType, filterAgg])

  // Initial load + polling loop.
  useEffect(() => {
    void tick()
    if (paused) return
    const id = setInterval(() => { void tick() }, pollMs)
    return () => clearInterval(id)
  }, [tick, paused, pollMs])

  // Filter by free-text on aggregateId / type / actor.
  const visible = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return events
    return events.filter(e =>
      e.aggregateId.toLowerCase().includes(q)
      || e.type.toLowerCase().includes(q)
      || e.actor.toLowerCase().includes(q)
      || e.tenantId.toLowerCase().includes(q),
    )
  }, [events, filterText])

  const distinctAggregates = useMemo(() => {
    const set = new Set(events.map(e => e.aggregateType))
    return Array.from(set).sort()
  }, [events])

  return (
    <Layout
      title="Live Console"
      subtitle="Streaming view of every domain event the platform emits."
      actions={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={paused ? 'success' : 'ghost'} onClick={() => setPaused(p => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { lastTsRef.current = undefined; setEvents([]); void tick() }}>
            Clear
          </Button>
        </div>
      }
    >
      <div className={s.consoleFilters}>
        <span style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Filters</span>
        <select value={filterAgg} onChange={(e) => setFilterAgg(e.target.value)}>
          <option value="">all aggregates</option>
          {distinctAggregates.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <input
          placeholder="event type (e.g. task.created)"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          style={{ width: 220 }}
        />
        <input
          placeholder="search id / actor / tenant"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          style={{ width: 240 }}
        />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>poll</span>
        <select value={pollMs} onChange={(e) => setPollMs(Number(e.target.value))}>
          <option value="2000">2s</option>
          <option value="5000">5s</option>
          <option value="15000">15s</option>
        </select>
      </div>

      {error && (
        <div style={{ padding: '12px 14px', color: 'var(--danger)', fontSize: 12, background: 'var(--danger-bg)' }}>
          {error}
        </div>
      )}

      <div className={s.eventList}>
        {visible.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>
            No events match the current filter. The console is {paused ? 'paused' : 'live'}.
          </div>
        ) : (
          visible.map(e => (
            <div key={e.id}>
              <div
                className={`${s.event} ${openId === e.id ? s.eventOpen : ''}`}
                onClick={() => setOpenId(openId === e.id ? null : e.id)}
              >
                <div className="ts">{shortTime(e.timestamp)}</div>
                <div className="agg">
                  <div>{e.aggregateType}</div>
                  <div className="actor">{e.aggregateId}</div>
                </div>
                <div className="type">{e.type}</div>
                <div>
                  <span className={`${s.pill} ${pillClass(e.type)}`}>{prefix(e.type)}</span>
                  <span style={{ marginLeft: 6, color: 'var(--text3)' }}>by {e.actor} @ {e.tenantId}</span>
                </div>
              </div>
              {openId === e.id && (
                <div className={s.eventDetails}>
                  <pre>{JSON.stringify(e, null, 2)}</pre>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className={`${s.consoleStatusBar} ${paused ? '' : s.live}`}>
        <span>{visible.length} of {events.length} events</span>
        <span>{paused ? '⏸ paused' : `● live · refreshing every ${(pollMs / 1000).toFixed(0)}s`}</span>
      </div>
    </Layout>
  )
}

function shortTime(ts: string): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function pad(n: number) { return n < 10 ? '0' + n : String(n) }
function prefix(type: string) { return type.split('.')[0] }

function pillClass(type: string): string {
  if (type.includes('failed') || type.includes('error') || type.includes('rejected')) return s.danger
  if (type.includes('completed') || type.includes('success') || type.includes('promoted')) return s.success
  if (type.includes('paused') || type.includes('demoted') || type.includes('warn')) return s.warning
  return s.info
}

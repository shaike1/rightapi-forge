// AutonomyPage — single observability panel for the autonomy loop.
//
// Pulls together the four endpoints that, before this page, the user
// had to SSH in to see:
//
//   GET /api/autonomy/status              — orchestrator state, pattern
//                                            window, daily SDK budget,
//                                            registered crystal.* skills
//   GET /api/improvement-loop/status      — last tick summary, judge
//                                            queries / successes
//   GET /api/sdk/history                  — recent SDK sessions
//   GET /api/crystallized-skills/stats    — counts by status, success rate
//
// Plus a manual /api/autonomy/scan trigger so an operator can force a
// pattern scan instead of waiting for the next periodic tick.
//
// Refresh on a 15s timer; refetch immediately on any websocket event
// of types autonomy.scan, autonomy.sdk_triggered, improvement_loop.tick,
// or sdk.completed.

import { useCallback, useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import { useWebSocket } from '../hooks/useWebSocket'

interface AutonomyStatus {
  enabled: boolean
  patternWindowSize: number
  registeredCrystallizedSkills: Array<{ crystallizedId: string; skillId: string }>
  sdkRequestsToday: number
  maxSdkRequestsPerDay: number
  patternCooldownsActive: number
  lastScan: null | {
    startedAt: string
    finishedAt: string
    patternsConsidered: number
    patternsTriggered: number
    patternsSkipped: Array<{ fingerprint: string; reason: string }>
    sdkRequestsRemainingToday: number
  }
}

interface ImprovementStatus {
  enabled: boolean
  lastTickAt: string | null
  lastSummary: null | {
    startedAt: string
    finishedAt: string
    actions: Array<{ type: string; target: string; [k: string]: unknown }>
    capped: boolean
    durationMs: number
  }
  cooldownsActive: number
  judge: null | { queries: number; successes: number; failures: number }
}

interface SdkSession {
  id: string
  at: string
  actor: string
  description: string
  kind: 'skill' | 'workflow'
  outcome: 'planned' | 'completed' | 'failed' | 'rejected'
  durationMs?: number
  files?: number
  testsPassed?: number
  testsFailed?: number
  branch?: string
  workflowRunId?: number
}

interface CrystalStats {
  counts: { draft: number; approved: number; active: number; rejected: number }
  total: number
  totalUsage: number
  avgConfidence: number
  successRate: number | null
}

const REFRESH_MS = 15_000

export default function AutonomyPage() {
  const { show } = useToast()
  const { lastEvent } = useWebSocket()
  const [autonomy, setAutonomy] = useState<AutonomyStatus | null>(null)
  const [improvement, setImprovement] = useState<ImprovementStatus | null>(null)
  const [sessions, setSessions] = useState<SdkSession[]>([])
  const [stats, setStats] = useState<CrystalStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanRunning, setScanRunning] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [a, imp, hist, st] = await Promise.all([
        api.get<AutonomyStatus>('/api/autonomy/status').catch(() => null),
        api.get<ImprovementStatus>('/api/improvement-loop/status').catch(() => null),
        api.get<{ history: SdkSession[] }>('/api/sdk/history').catch(() => ({ history: [] })),
        api.get<CrystalStats>('/api/crystallized-skills/stats').catch(() => null),
      ])
      setAutonomy(a)
      setImprovement(imp)
      setSessions(Array.isArray(hist?.history) ? hist.history : [])
      setStats(st)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const t = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Refetch immediately on event-bus signals.
  useEffect(() => {
    const interesting = new Set(['autonomy.scan', 'autonomy.sdk_triggered', 'improvement_loop.tick', 'sdk.completed', 'sdk.planned'])
    if (lastEvent && interesting.has(lastEvent.type)) void refresh()
  }, [lastEvent, refresh])

  const triggerScan = useCallback(async () => {
    setScanRunning(true)
    try {
      const result = await api.post<AutonomyStatus['lastScan']>('/api/autonomy/scan', {})
      const triggered = result?.patternsTriggered ?? 0
      const considered = result?.patternsConsidered ?? 0
      show(`Scan complete — considered ${considered}, triggered ${triggered}`, 'success')
      await refresh()
    } catch (err) {
      show(`Scan failed: ${(err as Error).message}`, 'error')
    } finally {
      setScanRunning(false)
    }
  }, [refresh, show])

  if (loading) {
    return <Layout title="Autonomy" subtitle="Loop status, patterns, crystallized skills, SDK sessions."><div style={{ padding: 24 }}>Loading…</div></Layout>
  }

  return (
    <Layout title="Autonomy" subtitle="Loop status, patterns, crystallized skills, SDK sessions.">
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 16 }}>
        <StatCard
          label="Autonomy loop"
          value={autonomy?.enabled ? 'Running' : 'Disabled'}
          color={autonomy?.enabled ? 'success' : 'neutral'}
          sub={autonomy?.lastScan ? `last scan ${formatAgo(autonomy.lastScan.finishedAt)}` : 'no scans yet'}
        />
        <StatCard
          label="Improvement loop"
          value={improvement?.enabled ? 'Running' : 'Disabled'}
          color={improvement?.enabled ? 'success' : 'neutral'}
          sub={improvement?.lastTickAt ? `last tick ${formatAgo(improvement.lastTickAt)}` : 'no ticks yet'}
        />
        <StatCard
          label="SDK budget today"
          value={`${(autonomy?.maxSdkRequestsPerDay ?? 0) - (autonomy?.sdkRequestsToday ?? 0)} / ${autonomy?.maxSdkRequestsPerDay ?? 0}`}
          sub={`${autonomy?.sdkRequestsToday ?? 0} fired`}
          color={(autonomy?.sdkRequestsToday ?? 0) >= (autonomy?.maxSdkRequestsPerDay ?? 0) ? 'warning' : 'default'}
        />
        <StatCard
          label="Crystallized skills"
          value={String(stats?.counts.active ?? 0)}
          sub={`${stats?.counts.draft ?? 0} draft, ${stats?.counts.approved ?? 0} approved, ${stats?.counts.rejected ?? 0} rejected`}
        />
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
        {/* ── Autonomy orchestrator ──────────────────────────────── */}
        <Card>
          <CardHeader title="Autonomy orchestrator" actions={
            <Button size="sm" onClick={triggerScan} loading={scanRunning}>Run scan now</Button>
          } />
          <CardBody>
            <KV k="Pattern window" v={String(autonomy?.patternWindowSize ?? 0)} hint="recent task traces accumulated" />
            <KV k="Cooldowns active" v={String(autonomy?.patternCooldownsActive ?? 0)} hint="patterns held off SDK retry" />
            <KV k="Registered crystal.* skills" v={String(autonomy?.registeredCrystallizedSkills?.length ?? 0)} />
            {autonomy?.registeredCrystallizedSkills && autonomy.registeredCrystallizedSkills.length > 0 && (
              <ul style={{ marginTop: 6, fontSize: 12, color: 'var(--text2)' }}>
                {autonomy.registeredCrystallizedSkills.slice(0, 6).map(s => (
                  <li key={s.crystallizedId} style={{ fontFamily: 'ui-monospace, monospace' }}>{s.skillId}</li>
                ))}
              </ul>
            )}
            <hr style={{ margin: '14px 0', border: 0, borderTop: '1px solid var(--border)' }} />
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>LAST SCAN</div>
            {autonomy?.lastScan ? (
              <>
                <KV k="Considered" v={String(autonomy.lastScan.patternsConsidered)} />
                <KV k="Triggered SDK" v={String(autonomy.lastScan.patternsTriggered)} />
                <KV k="Skipped" v={String(autonomy.lastScan.patternsSkipped.length)} />
                {autonomy.lastScan.patternsSkipped.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text2)' }}>why skipped?</summary>
                    <ul style={{ fontSize: 11, color: 'var(--text2)', marginTop: 6, paddingLeft: 16 }}>
                      {autonomy.lastScan.patternsSkipped.slice(0, 8).map((s, i) => (
                        <li key={i}><span style={{ fontFamily: 'ui-monospace, monospace' }}>{s.fingerprint.slice(0, 60)}</span> — {s.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>Hasn't scanned yet.</div>
            )}
          </CardBody>
        </Card>

        {/* ── Improvement loop ───────────────────────────────────── */}
        <Card>
          <CardHeader title="Improvement loop" />
          <CardBody>
            <KV k="Last tick" v={improvement?.lastTickAt ? formatAgo(improvement.lastTickAt) : '–'} />
            <KV k="Active cooldowns" v={String(improvement?.cooldownsActive ?? 0)} />
            {improvement?.judge && (
              <>
                <hr style={{ margin: '14px 0', border: 0, borderTop: '1px solid var(--border)' }} />
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>LLM JUDGE</div>
                <KV k="Queries" v={String(improvement.judge.queries)} />
                <KV k="Successes" v={String(improvement.judge.successes)} />
                <KV k="Failures" v={String(improvement.judge.failures)} />
              </>
            )}
            <hr style={{ margin: '14px 0', border: 0, borderTop: '1px solid var(--border)' }} />
            <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>LAST TICK ACTIONS</div>
            {improvement?.lastSummary?.actions && improvement.lastSummary.actions.length > 0 ? (
              <ul style={{ fontSize: 12, paddingLeft: 16, color: 'var(--text2)' }}>
                {improvement.lastSummary.actions.slice(0, 8).map((a, i) => (
                  <li key={i}>
                    <Badge variant={actionVariant(a.type)}>{a.type}</Badge>{' '}
                    <span style={{ fontFamily: 'ui-monospace, monospace' }}>{String(a.target).slice(0, 18)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text3)' }}>No actions in the last tick.</div>
            )}
          </CardBody>
        </Card>

        {/* ── Crystallized skills ───────────────────────────────── */}
        <Card>
          <CardHeader title="Crystallized skills" />
          <CardBody>
            {stats ? (
              <>
                <KV k="Total" v={String(stats.total)} />
                <KV k="Active in catalogue" v={String(stats.counts.active)} />
                <KV k="Draft (awaiting promotion)" v={String(stats.counts.draft)} />
                <KV k="Approved (awaiting age)" v={String(stats.counts.approved)} />
                <KV k="Rejected" v={String(stats.counts.rejected)} />
                <KV k="Total usages" v={String(stats.totalUsage)} />
                <KV k="Avg confidence" v={stats.avgConfidence.toFixed(2)} />
                <KV k="Success rate" v={stats.successRate === null ? '—' : `${(stats.successRate * 100).toFixed(0)}%`} />
              </>
            ) : (
              <EmptyState icon="📭" title="No crystallized skills" description="Skills appear here as agents complete recurring multi-step work." />
            )}
          </CardBody>
        </Card>

        {/* ── SDK sessions ───────────────────────────────────────── */}
        <Card>
          <CardHeader title="Recent SDK sessions" />
          <CardBody>
            {sessions.length === 0 ? (
              <EmptyState icon="⚙️" title="No SDK sessions yet" description="Sessions land here when an operator triggers /api/sdk/develop or the autonomy orchestrator crystallizes a recurring pattern." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sessions.slice(0, 8).map(s => (
                  <div key={s.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center', padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                    <Badge variant={outcomeVariant(s.outcome)}>{s.outcome}</Badge>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text2)' }}>{s.kind}</span> · {s.description}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                        {formatAgo(s.at)} · {s.actor}
                        {typeof s.files === 'number' ? ` · ${s.files} files` : ''}
                        {typeof s.testsFailed === 'number' && s.testsFailed > 0 ? ` · ${s.testsFailed} failed test(s)` : ''}
                        {s.branch ? ` · branch ${s.branch}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </Layout>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function KV({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
      <div style={{ fontSize: 12, color: 'var(--text2)' }}>
        {k}{hint && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 6 }}>{hint}</span>}
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, fontFamily: 'ui-monospace, monospace' }}>{v}</div>
    </div>
  )
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return iso
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function outcomeVariant(o: SdkSession['outcome']): 'success' | 'danger' | 'warning' | 'neutral' {
  switch (o) {
    case 'completed': return 'success'
    case 'failed':    return 'danger'
    case 'rejected':  return 'warning'
    default:          return 'neutral'
  }
}

function actionVariant(t: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (t.includes('promoted') || t.includes('analyzed') || t.includes('retried')) return 'success'
  if (t.includes('failed') || t.includes('rejected') || t.includes('cancelled')) return 'danger'
  if (t.includes('held') || t.includes('surfaced') || t.includes('sandbox')) return 'warning'
  return 'neutral'
}

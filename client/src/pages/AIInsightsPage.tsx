// AIInsightsPage — single observability + controls surface for the
// four AI autonomy engines (triage, resolve, predict, runbook-gen).
//
// Pulls aggregate stats from the AiDecisionStore via
// GET /api/ai/insights/summary plus the four per-engine config snapshots,
// and offers PATCH endpoints to flip enabled / threshold values without
// touching env vars.
//
// Refresh on a 30s timer; refetch immediately on any websocket event
// of types triage_decision, resolver_decision, prediction, or
// runbook_draft_suggested.

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

type DecisionKind = 'triage' | 'resolve' | 'predict' | 'runbook-generate'
type DecisionOutcome = 'pending' | 'success' | 'failed' | 'reopened' | 'overridden'

interface AiDecision {
  id: string
  kind: DecisionKind
  incidentId: string | null
  confidence: number
  reasoning: string
  autoApplied: boolean
  outcome: DecisionOutcome
  payload: Record<string, unknown>
  createdAt: string
  reviewedAt: string | null
  reviewedBy: string | null
}

interface InsightsStats {
  total: number
  byKind: Record<DecisionKind, number>
  byOutcome: Record<DecisionOutcome, number>
  autoApplied: number
  suggested: number
  meanConfidence: number
  meanConfidenceByKind: Partial<Record<DecisionKind, number>>
  successRateByKind: Partial<Record<DecisionKind, number>>
}

interface TriageConfig    { enabled: boolean; autoApplyThreshold: number; changeWindowDays: number; knowledgeLimit: number }
interface ResolverConfig  { enabled: boolean; minConfidence: number; excludeCritical: boolean; minKbUseful: number }
interface PredictConfig   { enabled: boolean; intervalMs: number; horizonMs: number; regressionWindowMs: number; seasonalLookbackDays: number; thresholds: Record<string, number> }
interface RunbookGenConfig { enabled: boolean }

interface InsightsSummary {
  stats: InsightsStats | null
  recent: AiDecision[]
  config: {
    triage: TriageConfig | null
    resolver: ResolverConfig | null
    predict: PredictConfig | null
    runbookGen: RunbookGenConfig | null
  }
}

const REFRESH_MS = 30_000

export default function AIInsightsPage() {
  const { show } = useToast()
  const { lastEvent } = useWebSocket()
  const [summary, setSummary] = useState<InsightsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<InsightsSummary>('/api/ai/insights/summary?recent=30')
      setSummary({
        stats: s?.stats ?? null,
        recent: Array.isArray(s?.recent) ? s.recent : [],
        config: {
          triage: s?.config?.triage ?? null,
          resolver: s?.config?.resolver ?? null,
          predict: s?.config?.predict ?? null,
          runbookGen: s?.config?.runbookGen ?? null,
        },
      })
    } catch (e) {
      // Best-effort — keep prior data on transient failures.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const t = setInterval(() => { void refresh() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    const interesting = new Set(['triage_decision', 'resolver_decision', 'prediction', 'runbook_draft_suggested'])
    if (lastEvent && interesting.has(lastEvent.type)) void refresh()
  }, [lastEvent, refresh])

  const patch = useCallback(async (path: string, body: Record<string, unknown>, label: string) => {
    setBusy(true)
    try {
      await api.patch(path, body)
      show(`${label} updated`, 'success')
      await refresh()
    } catch (err) {
      show(`Update failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [refresh, show])

  if (loading) {
    return <Layout title="AI Insights" subtitle="Triage, auto-resolve, predictions, runbook drafts."><div style={{ padding: 24 }}>Loading…</div></Layout>
  }

  const stats = summary?.stats
  const cfg   = summary?.config
  const recent = summary?.recent ?? []

  const triagePct   = pct(stats?.successRateByKind?.triage)
  const resolvePct  = pct(stats?.successRateByKind?.resolve)
  const predictPct  = pct(stats?.successRateByKind?.predict)

  return (
    <Layout title="AI Insights" subtitle="Triage, auto-resolve, predictions, runbook drafts.">
      {/* ── Top stats row ────────────────────────────────────────── */}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginBottom: 16 }}>
        <StatCard
          label="Total AI decisions"
          value={String(stats?.total ?? 0)}
          sub={`${stats?.autoApplied ?? 0} auto · ${stats?.suggested ?? 0} suggested`}
        />
        <StatCard
          label="Triage decisions"
          value={String(stats?.byKind.triage ?? 0)}
          sub={triagePct === null ? 'no completed yet' : `success ${triagePct}%`}
          color={cfg?.triage?.enabled ? 'success' : 'neutral'}
        />
        <StatCard
          label="Auto-resolve runs"
          value={String(stats?.byKind.resolve ?? 0)}
          sub={resolvePct === null ? 'no completed yet' : `success ${resolvePct}%`}
          color={cfg?.resolver?.enabled ? 'success' : 'neutral'}
        />
        <StatCard
          label="Predictions"
          value={String(stats?.byKind.predict ?? 0)}
          sub={predictPct === null ? 'no completed yet' : `accuracy ${predictPct}%`}
          color={cfg?.predict?.enabled ? 'success' : 'neutral'}
        />
        <StatCard
          label="Runbook drafts"
          value={String(stats?.byKind['runbook-generate'] ?? 0)}
          sub={`${stats?.byOutcome.pending ?? 0} pending review`}
          color={cfg?.runbookGen?.enabled ? 'success' : 'neutral'}
        />
      </div>

      {/* ── Engines + controls ──────────────────────────────────── */}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <EngineCard
          title="Auto-Triage"
          enabled={cfg?.triage?.enabled ?? false}
          onToggle={(v) => patch('/api/ai/triage/config', { enabled: v }, 'Auto-triage')}
          stats={[
            { k: 'Decisions',         v: String(stats?.byKind.triage ?? 0) },
            { k: 'Auto-apply threshold', v: cfg?.triage ? `${(cfg.triage.autoApplyThreshold * 100).toFixed(0)}%` : '—' },
            { k: 'Mean confidence',   v: cfg?.triage ? pctStr(stats?.meanConfidenceByKind?.triage) : '—' },
            { k: 'Change window',     v: cfg?.triage ? `${cfg.triage.changeWindowDays}d` : '—' },
          ]}
          slider={cfg?.triage ? {
            label: 'Auto-apply threshold',
            value: cfg.triage.autoApplyThreshold,
            onCommit: (v) => patch('/api/ai/triage/config', { autoApplyThreshold: v }, 'Triage threshold'),
          } : undefined}
          busy={busy}
        />

        <EngineCard
          title="Auto-Resolver"
          enabled={cfg?.resolver?.enabled ?? false}
          onToggle={(v) => patch('/api/ai/resolver/config', { enabled: v }, 'Auto-resolver')}
          stats={[
            { k: 'Decisions',         v: String(stats?.byKind.resolve ?? 0) },
            { k: 'Auto-resolved',     v: String(stats?.byOutcome.success ?? 0) },
            { k: 'Reopened',          v: String(stats?.byOutcome.reopened ?? 0) },
            { k: 'Min confidence',    v: cfg?.resolver ? `${(cfg.resolver.minConfidence * 100).toFixed(0)}%` : '—' },
            { k: 'Exclude critical',  v: cfg?.resolver?.excludeCritical ? 'Yes' : 'No' },
          ]}
          slider={cfg?.resolver ? {
            label: 'Min confidence',
            value: cfg.resolver.minConfidence,
            onCommit: (v) => patch('/api/ai/resolver/config', { minConfidence: v }, 'Resolver threshold'),
          } : undefined}
          extra={cfg?.resolver ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
              <input
                type="checkbox"
                checked={cfg.resolver.excludeCritical}
                disabled={busy}
                onChange={(e) => patch('/api/ai/resolver/config', { excludeCritical: e.target.checked }, 'Resolver excludeCritical')}
              />
              Block auto-resolve on critical incidents
            </label>
          ) : null}
          busy={busy}
        />

        <EngineCard
          title="Predictive Engine"
          enabled={cfg?.predict?.enabled ?? false}
          onToggle={(v) => patch('/api/ai/predictions/config', { enabled: v }, 'Predictive engine')}
          stats={[
            { k: 'Predictions filed', v: String(stats?.byKind.predict ?? 0) },
            { k: 'Correct',           v: String(stats?.byOutcome.success ?? 0) },
            { k: 'False positive',    v: String(stats?.byOutcome.failed ?? 0) },
            { k: 'Horizon',           v: cfg?.predict ? `${Math.round((cfg.predict.horizonMs ?? 0) / 60000)}m` : '—' },
            { k: 'Regression window', v: cfg?.predict ? `${Math.round((cfg.predict.regressionWindowMs ?? 0) / 60000)}m` : '—' },
            { k: 'CPU threshold',     v: cfg?.predict ? `${cfg.predict.thresholds?.cpu ?? '—'}%` : '—' },
          ]}
          busy={busy}
        />

        <EngineCard
          title="Runbook Generator"
          enabled={cfg?.runbookGen?.enabled ?? false}
          onToggle={(v) => patch('/api/ai/runbook-generator/config', { enabled: v }, 'Runbook generator')}
          stats={[
            { k: 'Drafts produced',     v: String(stats?.byKind['runbook-generate'] ?? 0) },
            { k: 'Pending review',      v: String(stats?.byOutcome.pending ?? 0) },
            { k: 'Mean confidence',     v: pctStr(stats?.meanConfidenceByKind?.['runbook-generate']) },
          ]}
          busy={busy}
        />
      </div>

      {/* ── Decision timeline ───────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
      <Card>
        <CardHeader title="Recent AI decisions" actions={
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>Refresh</Button>
        }/>
        <CardBody>
          {recent.length === 0 ? (
            <EmptyState title="No decisions yet" description="Once triage, resolution, prediction, or runbook-draft events fire, they'll show up here." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recent.map((d) => (
                <DecisionRow key={d.id} d={d} />
              ))}
            </div>
          )}
        </CardBody>
      </Card>
      </div>
    </Layout>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────

interface EngineCardProps {
  title: string
  enabled: boolean
  onToggle: (v: boolean) => void
  stats: Array<{ k: string; v: string }>
  slider?: { label: string; value: number; onCommit: (v: number) => void }
  extra?: React.ReactNode
  busy: boolean
}

function EngineCard({ title, enabled, onToggle, stats, slider, extra, busy }: EngineCardProps) {
  return (
    <Card>
      <CardHeader title={title} actions={
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          {enabled ? <Badge variant="success">enabled</Badge> : <Badge variant="neutral">disabled</Badge>}
        </label>
      }/>
      <CardBody>
        {stats.map((s) => <KV key={s.k} k={s.k} v={s.v} />)}
        {slider && <SliderRow label={slider.label} value={slider.value} onCommit={slider.onCommit} disabled={busy} />}
        {extra}
      </CardBody>
    </Card>
  )
}

function SliderRow({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (v: number) => void; disabled: boolean }) {
  const [local, setLocal] = useState(value)
  useEffect(() => { setLocal(value) }, [value])
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text2)' }}>
        <span>{label}</span>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{(local * 100).toFixed(0)}%</span>
      </div>
      <input
        type="range"
        min={0.5}
        max={0.99}
        step={0.01}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(parseFloat(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        style={{ width: '100%' }}
      />
    </div>
  )
}

function DecisionRow({ d }: { d: AiDecision }) {
  const conf = `${Math.round(d.confidence * 100)}%`
  const reasoning = d.reasoning.length > 240 ? d.reasoning.slice(0, 240) + '…' : d.reasoning
  return (
    <div style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <Badge variant={kindColor(d.kind)}>{kindLabel(d.kind)}</Badge>
        <Badge variant={outcomeColor(d.outcome)}>{d.outcome}</Badge>
        {d.autoApplied
          ? <Badge variant="warning">auto-applied</Badge>
          : <Badge variant="neutral">suggested</Badge>}
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>confidence {conf}</span>
        {d.incidentId && (
          <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 'auto', fontFamily: 'ui-monospace, monospace' }}>
            {d.incidentId}
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)' }}>{reasoning}</div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{formatAgo(d.createdAt)}</div>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ fontSize: 12, color: 'var(--text2)' }}>{k}</span>
      <span style={{ fontSize: 12, fontWeight: 500, fontFamily: 'ui-monospace, monospace' }}>{v}</span>
    </div>
  )
}

function kindLabel(k: DecisionKind): string {
  switch (k) {
    case 'triage':           return 'triage'
    case 'resolve':          return 'auto-resolve'
    case 'predict':          return 'predict'
    case 'runbook-generate': return 'runbook'
  }
}

function kindColor(k: DecisionKind): 'success' | 'info' | 'warning' | 'neutral' {
  switch (k) {
    case 'triage':           return 'info'
    case 'resolve':          return 'success'
    case 'predict':          return 'warning'
    case 'runbook-generate': return 'neutral'
  }
}

function outcomeColor(o: DecisionOutcome): 'success' | 'danger' | 'warning' | 'neutral' {
  switch (o) {
    case 'success':    return 'success'
    case 'failed':     return 'danger'
    case 'reopened':   return 'danger'
    case 'overridden': return 'warning'
    case 'pending':    return 'neutral'
  }
}

function pct(n: number | null | undefined): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  return Math.round(n * 100)
}

function pctStr(n: number | null | undefined): string {
  const p = pct(n)
  return p === null ? '—' : `${p}%`
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

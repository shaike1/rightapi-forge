import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
// lucide-react icons were trimmed when StatCard turned out not to accept
// an `icon` prop; we keep imports tight to avoid unused-import warnings.
import Layout from '../components/Layout'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import { Card, CardBody, CardHeader } from '../components/Card'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './SLAPage.module.css'

// ── Types — mirror server-side ────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type Period = '24h' | '7d' | '30d' | '90d'

interface SlaMetrics {
  total: number
  resolutionMet: number
  resolutionMissed: number
  resolutionPending: number
  responseMet: number
  responseMissed: number
  responsePending: number
  mttrMinutes: number | null
  mttaMinutes: number | null
  compliancePercent: number | null
  activeBreaches: number
}

interface SlaTracking {
  id: string
  incidentId: string
  policyId: string
  responseDeadline: string
  resolutionDeadline: string
  responseMet: boolean | null
  resolutionMet: boolean | null
  respondedAt: string | null
  resolvedAt: string | null
  breached: boolean
  warningEmitted: boolean
  createdAt: string
}

interface SlaPolicy {
  id: string
  name: string
  severity: Severity
  responseTimeMinutes: number
  resolutionTimeMinutes: number
  businessHoursOnly: boolean
  enabled: boolean
}

interface MetricsResponse {
  period: Period
  overall: SlaMetrics
  bySeverity: Record<Severity, SlaMetrics>
  trend: Array<{ day: string; compliancePercent: number | null; total: number }>
}

// ── Helpers ──────────────────────────────────────────────────────────

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low']

function formatMinutes(v: number | null): string {
  if (v === null) return '—'
  if (v < 60) return `${Math.round(v)}m`
  const h = v / 60
  if (h < 24) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function formatPercent(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`
}

function deadlineCountdown(deadline: string, now: number): string {
  const d = new Date(deadline).getTime()
  const diff = d - now
  if (diff <= 0) return `+${formatMinutes(Math.abs(diff) / 60_000)} past`
  return `${formatMinutes(diff / 60_000)} left`
}

// ── Page ─────────────────────────────────────────────────────────────

export default function SLAPage() {
  const { show } = useToast()
  const { lastEvent } = useWebSocket()
  const [period, setPeriod] = useState<Period>('7d')
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [tracking, setTracking] = useState<SlaTracking[]>([])
  const [policies, setPolicies] = useState<SlaPolicy[]>([])
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const reload = useCallback(async () => {
    try {
      const [m, t, p] = await Promise.all([
        api.get<MetricsResponse>(`/api/sla/metrics?period=${period}`),
        api.get<{ tracking: SlaTracking[] }>(`/api/sla/tracking?state=breached&limit=50`),
        api.get<{ policies: SlaPolicy[] }>(`/api/sla/policies`),
      ])
      setMetrics(m)
      setTracking(Array.isArray(t?.tracking) ? t.tracking : [])
      setPolicies(Array.isArray(p?.policies) ? p.policies : [])
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load SLA data', 'error')
    } finally {
      setLoading(false)
    }
  }, [period, show])

  useEffect(() => { reload() }, [reload])

  // Live-update on WS sla_breach / sla_warning events.
  useEffect(() => {
    if (!lastEvent) return
    const t = String((lastEvent as { type?: string }).type ?? '')
    if (t === 'sla_breach' || t === 'sla_warning' || t === 'incident_updated') {
      reload()
    }
  }, [lastEvent, reload])

  // Refresh "time remaining" once per minute so countdowns stay current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const policyById = useMemo(() => {
    const m = new Map<string, SlaPolicy>()
    for (const p of policies) m.set(p.id, p)
    return m
  }, [policies])

  if (loading || !metrics) {
    return <Layout title="SLA"><div className={styles.empty}>Loading SLA metrics…</div></Layout>
  }

  return (
    <Layout
      title="SLA"
      subtitle="Service-level objectives, compliance, and active breaches"
      actions={
        <div className={styles.periodRow}>
          {(['24h','7d','30d','90d'] as Period[]).map(p => (
            <button
              key={p}
              type="button"
              className={`${styles.periodBtn} ${p === period ? styles.periodBtnActive : ''}`}
              onClick={() => setPeriod(p)}
            >{p}</button>
          ))}
        </div>
      }
    >
      <div className={styles.kpiRow}>
        <StatCard
          label="Compliance"
          value={formatPercent(metrics.overall.compliancePercent)}
          color={(metrics.overall.compliancePercent ?? 0) < 80 ? 'danger' : 'success'}
        />
        <StatCard
          label="MTTR"
          value={formatMinutes(metrics.overall.mttrMinutes)}
          color="accent"
        />
        <StatCard
          label="MTTA"
          value={formatMinutes(metrics.overall.mttaMinutes)}
          color="accent"
        />
        <StatCard
          label="Active breaches"
          value={String(metrics.overall.activeBreaches)}
          color={metrics.overall.activeBreaches > 0 ? 'danger' : 'success'}
        />
      </div>

      <Card>
        <CardHeader title="Compliance trend" subtitle={`Per-day resolution compliance over ${period}`} />
        <CardBody>
          {metrics.trend.length === 0 ? (
            <div className={styles.empty}>No data in this period.</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={metrics.trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" stroke="#6b7280" fontSize={11} />
                <YAxis domain={[0, 100]} stroke="#6b7280" fontSize={11} tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(v) => v == null ? '—' : `${v}%`} />
                <Line type="monotone" dataKey="compliancePercent" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Per-severity breakdown" />
        <CardBody>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Policy</th>
                  <th>Response → Resolution</th>
                  <th>Tracked</th>
                  <th>Compliance</th>
                  <th>MTTR</th>
                  <th>Active breaches</th>
                </tr>
              </thead>
              <tbody>
                {SEVERITIES.map(sev => {
                  const m = metrics.bySeverity[sev]
                  const policy = policies.find(p => p.severity === sev)
                  return (
                    <tr key={sev}>
                      <td className={styles[`sev_${sev}`]}>{sev}</td>
                      <td>{policy?.name ?? '—'}</td>
                      <td>{policy ? `${policy.responseTimeMinutes}m → ${policy.resolutionTimeMinutes}m` : '—'}</td>
                      <td>{m.total}</td>
                      <td className={(m.compliancePercent ?? 100) < 80 ? styles.bad : styles.ok}>
                        {formatPercent(m.compliancePercent)}
                      </td>
                      <td>{formatMinutes(m.mttrMinutes)}</td>
                      <td className={m.activeBreaches > 0 ? styles.bad : ''}>{m.activeBreaches}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Active breaches" subtitle={`${tracking.length} incident${tracking.length === 1 ? '' : 's'} past SLA`} />
        <CardBody>
          {tracking.length === 0 ? (
            <div className={styles.empty}>No active breaches. 🎉</div>
          ) : (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Incident</th>
                    <th>Policy</th>
                    <th>Response deadline</th>
                    <th>Resolution deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {tracking.map(t => {
                    const policy = policyById.get(t.policyId)
                    return (
                      <tr key={t.id}>
                        <td><Link to={`/incidents/${t.incidentId}`} className={styles.incLink}>{t.incidentId}</Link></td>
                        <td>{policy?.name ?? '—'}</td>
                        <td>
                          <Badge variant={t.responseMet === false ? 'danger' : 'warning'}>
                            {deadlineCountdown(t.responseDeadline, now)}
                          </Badge>
                        </td>
                        <td>
                          <Badge variant="danger">
                            {deadlineCountdown(t.resolutionDeadline, now)}
                          </Badge>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </Layout>
  )
}

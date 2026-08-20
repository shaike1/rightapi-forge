// SuperAdminPage — cross-tenant control surface. Visible only when
// the authenticated user holds the `superadmin` role; other roles are
// redirected to /incidents.
//
// Three sections on one page:
//   • Global stats — counts + per-plan distribution.
//   • Tenant list — table with quick plan changes, suspend/activate.
//   • System health — embeds the `/api/health` deep probe and the
//     DB size snapshot from /api/system/db/status (already shipped
//     with the DB hardening work).

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'

interface TenantRow {
  id: string; slug: string; name: string
  plan: 'free' | 'pro' | 'enterprise'
  status: 'active' | 'suspended'
  ownerUsername: string | null
  createdAt: string; updatedAt: string
  users: number; servers: number
  incidentsThisMonth: number; aiDecisionsThisMonth: number
}

interface AdminStats {
  totals: {
    tenants: number; activeTenants: number; suspendedTenants: number
    totalIncidents: number; totalServers: number; totalAiDecisions: number
  }
  byPlan: Record<string, number>
}

interface HealthSummary {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptimeSec: number
  summary: { pass: number; warn: number; fail: number; total: number }
}

interface DbStatusRow { name: string; totalBytes: number; status: 'ok' | 'warn' | 'fail' }
interface DbStatus { databases: DbStatusRow[] }

export default function SuperAdminPage() {
  const { user } = useAuth()
  const { show } = useToast()
  const navigate = useNavigate()
  const [tenants, setTenants] = useState<TenantRow[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [health, setHealth] = useState<HealthSummary | null>(null)
  const [db, setDb] = useState<DbStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (user && user.role !== 'superadmin') {
      navigate('/incidents', { replace: true })
    }
  }, [user, navigate])

  const refresh = useCallback(async () => {
    try {
      const [tlist, s, h, dbs] = await Promise.all([
        api.get<{ tenants: TenantRow[] }>('/api/admin/tenants').then(r => Array.isArray(r?.tenants) ? r.tenants : []).catch(() => []),
        api.get<AdminStats>('/api/admin/stats').catch(() => null),
        api.get<HealthSummary>('/api/health').catch(() => null),
        api.get<DbStatus>('/api/system/db/status').catch(() => null),
      ])
      setTenants(tlist)
      setStats(s)
      setHealth(h)
      setDb(dbs)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const changePlan = useCallback(async (id: string, plan: string) => {
    setBusy(true)
    try {
      await api.put(`/api/admin/tenants/${id}/plan`, { plan })
      show(`Plan updated to ${plan}`, 'success')
      await refresh()
    } catch (err) {
      show(`Plan change failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [refresh, show])

  const toggleStatus = useCallback(async (id: string, current: string) => {
    const target = current === 'active' ? 'suspended' : 'active'
    if (!window.confirm(`${target === 'suspended' ? 'Suspend' : 'Reactivate'} this tenant?`)) return
    setBusy(true)
    try {
      await api.put(`/api/admin/tenants/${id}/status`, { status: target })
      show(`Tenant ${target}`, 'success')
      await refresh()
    } catch (err) {
      show(`Failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [refresh, show])

  if (loading) return <Layout title="Super Admin"><div style={{ padding: 24 }}>Loading…</div></Layout>
  if (user && user.role !== 'superadmin') return null

  return (
    <Layout title="Super Admin" subtitle="Cross-tenant control surface.">
      {/* Top stats */}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: 16 }}>
        <StatCard label="Tenants" value={String(stats?.totals.tenants ?? 0)}
          sub={`${stats?.totals.activeTenants ?? 0} active · ${stats?.totals.suspendedTenants ?? 0} suspended`} />
        <StatCard label="Total incidents" value={String(stats?.totals.totalIncidents ?? 0)} />
        <StatCard label="Total servers" value={String(stats?.totals.totalServers ?? 0)} />
        <StatCard label="AI decisions"   value={String(stats?.totals.totalAiDecisions ?? 0)} />
        <StatCard label="Health" color={healthColor(health?.status)} value={health?.status ?? '—'}
          sub={`uptime ${formatUptime(health?.uptimeSec ?? 0)}`} />
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', marginBottom: 16 }}>
        <Card>
          <CardHeader title="Plans" />
          <CardBody>
            <KV k="free"       v={String(stats?.byPlan.free       ?? 0)} />
            <KV k="pro"        v={String(stats?.byPlan.pro        ?? 0)} />
            <KV k="enterprise" v={String(stats?.byPlan.enterprise ?? 0)} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="System health" actions={<Badge variant={healthVariant(health?.status)}>{health?.status ?? '—'}</Badge>} />
          <CardBody>
            <KV k="probes pass" v={String(health?.summary.pass  ?? 0)} />
            <KV k="probes warn" v={String(health?.summary.warn  ?? 0)} />
            <KV k="probes fail" v={String(health?.summary.fail  ?? 0)} />
            <KV k="uptime"      v={formatUptime(health?.uptimeSec ?? 0)} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Database sizes" />
          <CardBody>
            {(db?.databases ?? []).slice(0, 8).map((d) => (
              <KV key={d.name} k={d.name} v={`${(d.totalBytes / 1024 / 1024).toFixed(1)} MB ${d.status !== 'ok' ? `(${d.status})` : ''}`} />
            ))}
            {(!db?.databases || db.databases.length === 0) && (
              <div style={{ fontSize: 12, color: 'var(--text2)' }}>No DB stats available.</div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title={`Tenants (${tenants.length})`} actions={
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>Refresh</Button>
        }/>
        <CardBody>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>Slug</th>
                  <th style={{ padding: 8 }}>Name</th>
                  <th style={{ padding: 8 }}>Plan</th>
                  <th style={{ padding: 8 }}>Status</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Users</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Servers</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Inc/mo</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>AI/mo</th>
                  <th style={{ padding: 8 }}>Created</th>
                  <th style={{ padding: 8 }}></th>
                </tr>
              </thead>
              <tbody>
                {tenants.map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: 8, fontFamily: 'ui-monospace, monospace' }}>{t.slug}</td>
                    <td style={{ padding: 8 }}>{t.name}</td>
                    <td style={{ padding: 8 }}>
                      <select value={t.plan} disabled={busy}
                        onChange={(e) => changePlan(t.id, e.target.value)}
                        style={{ padding: '4px 6px', fontSize: 12 }}>
                        <option value="free">free</option>
                        <option value="pro">pro</option>
                        <option value="enterprise">enterprise</option>
                      </select>
                    </td>
                    <td style={{ padding: 8 }}>
                      <Badge variant={t.status === 'active' ? 'success' : 'warning'}>{t.status}</Badge>
                    </td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{t.users}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{t.servers}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{t.incidentsThisMonth}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>{t.aiDecisionsThisMonth}</td>
                    <td style={{ padding: 8, fontSize: 11, color: 'var(--text2)' }}>{formatDate(t.createdAt)}</td>
                    <td style={{ padding: 8, textAlign: 'right' }}>
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => toggleStatus(t.id, t.status)}>
                        {t.status === 'active' ? 'Suspend' : 'Activate'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </Layout>
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

function healthColor(s?: string): 'default' | 'success' | 'warning' | 'danger' {
  if (s === 'healthy') return 'success'
  if (s === 'degraded') return 'warning'
  if (s === 'unhealthy') return 'danger'
  return 'default'
}

function healthVariant(s?: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (s === 'healthy') return 'success'
  if (s === 'degraded') return 'warning'
  if (s === 'unhealthy') return 'danger'
  return 'neutral'
}

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

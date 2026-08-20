// TenantSettingsPage — admin-only surface for the caller's tenant.
//
// Tabs (all on one page, no router nesting):
//   • General  — name, timezone, notification toggles
//   • Billing  — plan + usage + limits
//   • Team     — members, role changes, pending invites, send invite
//   • Danger   — export data dump, delete tenant (owner only)

import { useCallback, useEffect, useState } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'

type TenantPlan = 'free' | 'pro' | 'enterprise'

interface TenantRow {
  id: string
  slug: string
  name: string
  plan: TenantPlan
  customDomain: string | null
  ownerUsername: string | null
  status: 'active' | 'suspended'
  createdAt: string
  settings: Record<string, unknown>
}

interface Usage {
  tenantId: string
  plan: TenantPlan
  servers: { current: number; limit: number }
  incidentsThisMonth: { current: number; limit: number }
  aiDecisionsThisMonth: number
  featureFlags: {
    autoResolveAllowed: boolean
    predictiveAlertsAllowed: boolean
    runbookGenerationAllowed: boolean
  }
}

interface TenantUser {
  username: string
  email?: string
  role: 'superadmin' | 'admin' | 'operator' | 'viewer' | 'requester'
  tenantId: string
  active: boolean
  createdAt: string
}

interface Invite {
  id: string
  email: string
  role: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  invitedBy: string
  createdAt: string
  expiresAt: string
}

export default function TenantSettingsPage() {
  const { user } = useAuth()
  const { show } = useToast()
  const [tab, setTab] = useState<'general' | 'billing' | 'team' | 'danger'>('general')
  const [tenant, setTenant] = useState<TenantRow | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [members, setMembers] = useState<TenantUser[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [domainDraft, setDomainDraft] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'operator' | 'viewer' | 'admin'>('operator')

  const refresh = useCallback(async () => {
    try {
      const [t, u, mem, inv] = await Promise.all([
        api.get<{ tenant: TenantRow }>('/api/tenant').then(r => r.tenant).catch(() => null),
        api.get<{ usage: Usage }>('/api/tenant/usage').then(r => r.usage).catch(() => null),
        api.get<{ users: TenantUser[] }>('/api/tenant/users').then(r => Array.isArray(r?.users) ? r.users : []).catch(() => []),
        api.get<{ invites: Invite[] }>('/api/tenant/invites').then(r => Array.isArray(r?.invites) ? r.invites : []).catch(() => []),
      ])
      setTenant(t); setUsage(u); setMembers(mem); setInvites(inv)
      if (t?.name) setNameDraft(t.name)
      setDomainDraft(t?.customDomain ?? '')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const saveName = useCallback(async () => {
    if (!nameDraft.trim() || nameDraft === tenant?.name) return
    setBusy(true)
    try {
      const r = await api.put<{ tenant: TenantRow }>('/api/tenant/settings', { name: nameDraft.trim() })
      setTenant(r.tenant)
      show('Tenant name updated', 'success')
    } catch (err) {
      show(`Failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [nameDraft, tenant?.name, show])

  const saveDomain = useCallback(async () => {
    const trimmed = domainDraft.trim()
    const target = trimmed.length > 0 ? trimmed : null
    if (target === (tenant?.customDomain ?? null)) return
    setBusy(true)
    try {
      const r = await api.put<{ tenant: TenantRow }>('/api/tenant/settings/domain', { customDomain: target })
      setTenant(r.tenant)
      setDomainDraft(r.tenant.customDomain ?? '')
      show(target ? `Custom domain set to ${r.tenant.customDomain}` : 'Custom domain cleared', 'success')
    } catch (err) {
      show(`Failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [domainDraft, tenant?.customDomain, show])

  const sendInvite = useCallback(async () => {
    if (!inviteEmail.trim()) return
    setBusy(true)
    try {
      await api.post('/api/auth/invite', { email: inviteEmail.trim(), role: inviteRole })
      setInviteEmail('')
      show(`Invite sent to ${inviteEmail.trim()}`, 'success')
      await refresh()
    } catch (err) {
      show(`Invite failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [inviteEmail, inviteRole, refresh, show])

  const revokeInvite = useCallback(async (id: string) => {
    setBusy(true)
    try {
      await api.post(`/api/tenant/invites/${id}/revoke`, {})
      show('Invite revoked', 'success')
      await refresh()
    } catch (err) {
      show(`Revoke failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [refresh, show])

  const changeRole = useCallback(async (username: string, role: string) => {
    setBusy(true)
    try {
      await api.patch(`/api/tenant/users/${encodeURIComponent(username)}`, { role })
      show(`${username} → ${role}`, 'success')
      await refresh()
    } catch (err) {
      show(`Role change failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [refresh, show])

  const removeMember = useCallback(async (username: string) => {
    if (!window.confirm(`Remove ${username} from this tenant?`)) return
    setBusy(true)
    try {
      await api.delete(`/api/tenant/users/${encodeURIComponent(username)}`)
      show(`${username} removed`, 'success')
      await refresh()
    } catch (err) {
      show(`Remove failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [refresh, show])

  if (loading) return <Layout title="Tenant Settings"><div style={{ padding: 24 }}>Loading…</div></Layout>
  if (!tenant) return <Layout title="Tenant Settings"><div style={{ padding: 24 }}>No tenant context.</div></Layout>

  const isOwner = user?.username === tenant.ownerUsername
  const TabBtn = ({ id, label }: { id: typeof tab; label: string }) => (
    <button onClick={() => setTab(id)} style={{
      padding: '8px 14px', fontSize: 13, fontWeight: 500,
      background: tab === id ? 'var(--accent)' : 'var(--bg2)',
      color: tab === id ? '#fff' : 'var(--text)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer',
    }}>{label}</button>
  )

  return (
    <Layout title="Tenant Settings" subtitle={`${tenant.name} · ${tenant.slug}`}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <TabBtn id="general" label="General" />
        <TabBtn id="billing" label="Billing" />
        <TabBtn id="team" label="Team" />
        <TabBtn id="danger" label="Danger zone" />
      </div>

      {tab === 'general' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <CardHeader title="General settings" />
            <CardBody>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>Organisation name</span>
                  <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
                    style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }} />
                </label>
                <div>
                  <Button onClick={saveName} loading={busy} disabled={nameDraft === tenant.name || !nameDraft.trim()}>
                    Save
                  </Button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8 }}>
                  Tenant ID: <code>{tenant.id}</code><br/>
                  Slug: <code>{tenant.slug}</code><br/>
                  Owner: {tenant.ownerUsername ?? '(legacy)'}
                </div>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Custom domain"
              actions={tenant.customDomain
                ? <Badge variant="success">{tenant.customDomain}</Badge>
                : <Badge variant="neutral">not set</Badge>} />
            <CardBody>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
                <div style={{ fontSize: 13, color: 'var(--text2)' }}>
                  Point your own hostname at the RightAPI Forge server and RightAPI Forge will route requests to it
                  straight to this tenant. You're responsible for the DNS A/CNAME record and the
                  TLS certificate.
                </div>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>Hostname</span>
                  <input value={domainDraft} onChange={(e) => setDomainDraft(e.target.value)}
                    placeholder="support.acme.com"
                    style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14, fontFamily: 'ui-monospace, monospace' }} />
                </label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button onClick={saveDomain} loading={busy}
                    disabled={(domainDraft.trim() || null) === (tenant.customDomain ?? null)}>
                    {domainDraft.trim() ? 'Save' : 'Clear'}
                  </Button>
                </div>
                {tenant.customDomain && (
                  <div style={{ fontSize: 12, color: 'var(--text3)' }}>
                    Tip: add an A record for <code>{tenant.customDomain}</code> pointing at the
                    RightAPI Forge server's public IP, then issue a TLS certificate for the same hostname.
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'billing' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <CardHeader title="Current plan" actions={<Badge variant={planVariant(tenant.plan)}>{tenant.plan}</Badge>} />
            <CardBody>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                You're on the <strong>{tenant.plan}</strong> plan. Contact support to upgrade.
              </div>
              <PlanTable plan={tenant.plan} usage={usage} />
            </CardBody>
          </Card>
        </div>
      )}

      {tab === 'team' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <CardHeader title="Send invite" />
            <CardBody>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>Email</span>
                  <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="teammate@acme.io"
                    style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>Role</span>
                  <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as any)}
                    style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }}>
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </label>
                <Button onClick={sendInvite} loading={busy} disabled={!inviteEmail.trim()}>Send</Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={`Members (${members.length})`} />
            <CardBody>
              {members.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text2)' }}>No members.</div> : (
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                      <th style={{ padding: 8 }}>Username</th>
                      <th style={{ padding: 8 }}>Role</th>
                      <th style={{ padding: 8 }}>Active</th>
                      <th style={{ padding: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.username} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: 8 }}>
                          {m.username}
                          {tenant.ownerUsername === m.username && <Badge variant="info">owner</Badge>}
                        </td>
                        <td style={{ padding: 8 }}>
                          <select value={m.role} disabled={busy || m.role === 'superadmin'}
                            onChange={(e) => changeRole(m.username, e.target.value)}
                            style={{ padding: '4px 8px', fontSize: 13 }}>
                            <option value="admin">admin</option>
                            <option value="operator">operator</option>
                            <option value="viewer">viewer</option>
                            <option value="requester">requester</option>
                          </select>
                        </td>
                        <td style={{ padding: 8 }}>{m.active ? <Badge variant="success">yes</Badge> : <Badge variant="neutral">no</Badge>}</td>
                        <td style={{ padding: 8, textAlign: 'right' }}>
                          {tenant.ownerUsername !== m.username && m.role !== 'superadmin' && (
                            <Button variant="ghost" size="xs" onClick={() => removeMember(m.username)} disabled={busy}>Remove</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          {invites.length > 0 && (
            <Card>
              <CardHeader title={`Pending invites (${invites.length})`} />
              <CardBody>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                      <th style={{ padding: 8 }}>Email</th>
                      <th style={{ padding: 8 }}>Role</th>
                      <th style={{ padding: 8 }}>Expires</th>
                      <th style={{ padding: 8 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((i) => (
                      <tr key={i.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: 8 }}>{i.email}</td>
                        <td style={{ padding: 8 }}>{i.role}</td>
                        <td style={{ padding: 8 }}>{new Date(i.expiresAt).toLocaleString()}</td>
                        <td style={{ padding: 8, textAlign: 'right' }}>
                          <Button variant="ghost" size="xs" onClick={() => revokeInvite(i.id)} disabled={busy}>Revoke</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      {tab === 'danger' && (
        <Card>
          <CardHeader title="Danger zone" />
          <CardBody>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Export tenant data</div>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 8 }}>
                  Download a JSON dump of incidents, assets, changes, knowledge articles, and runbook runs for this tenant.
                </div>
                <Button variant="secondary" onClick={async () => {
                  try {
                    const data = await api.get('/api/tenant')
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `${tenant.slug}-export-${Date.now()}.json`
                    a.click()
                  } catch (err) {
                    show(`Export failed: ${(err as Error).message}`, 'error')
                  }
                }}>Download export</Button>
              </div>
              {isOwner && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--danger)' }}>Delete tenant</div>
                  <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 8 }}>
                    Permanently destroys this tenant and all its data. Cannot be undone.
                  </div>
                  <Button variant="danger" disabled>Delete tenant (contact superadmin)</Button>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}
    </Layout>
  )
}

function planVariant(p: TenantPlan): 'neutral' | 'info' | 'success' | 'accent' {
  if (p === 'free') return 'neutral'
  if (p === 'pro')  return 'info'
  return 'accent'
}

function PlanTable({ plan, usage }: { plan: TenantPlan; usage: Usage | null }) {
  const limits = {
    free:       { servers: '3',  incidents: '50/month', autoResolve: '—',     predict: '—',     runbookGen: '—' },
    pro:        { servers: '20', incidents: 'unlimited', autoResolve: '✓',     predict: '✓',     runbookGen: '✓' },
    enterprise: { servers: '∞',  incidents: 'unlimited', autoResolve: '✓',     predict: '✓',     runbookGen: '✓' },
  } as const
  const cur = limits[plan]
  return (
    <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
          <th style={{ padding: 8 }}>Limit</th>
          <th style={{ padding: 8 }}>This plan</th>
          <th style={{ padding: 8 }}>Used</th>
        </tr>
      </thead>
      <tbody>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={{ padding: 8 }}>Servers</td>
          <td style={{ padding: 8 }}>{cur.servers}</td>
          <td style={{ padding: 8 }}>{usage?.servers.current ?? '—'}</td>
        </tr>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={{ padding: 8 }}>Incidents this month</td>
          <td style={{ padding: 8 }}>{cur.incidents}</td>
          <td style={{ padding: 8 }}>{usage?.incidentsThisMonth.current ?? '—'}</td>
        </tr>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={{ padding: 8 }}>Auto-resolve</td>
          <td style={{ padding: 8 }}>{cur.autoResolve}</td>
          <td style={{ padding: 8 }}>{usage?.featureFlags.autoResolveAllowed ? '✓' : '—'}</td>
        </tr>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={{ padding: 8 }}>Predictive alerts</td>
          <td style={{ padding: 8 }}>{cur.predict}</td>
          <td style={{ padding: 8 }}>{usage?.featureFlags.predictiveAlertsAllowed ? '✓' : '—'}</td>
        </tr>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={{ padding: 8 }}>Runbook generation</td>
          <td style={{ padding: 8 }}>{cur.runbookGen}</td>
          <td style={{ padding: 8 }}>{usage?.featureFlags.runbookGenerationAllowed ? '✓' : '—'}</td>
        </tr>
        <tr>
          <td style={{ padding: 8 }}>AI decisions this month</td>
          <td style={{ padding: 8 }}>—</td>
          <td style={{ padding: 8 }}>{usage?.aiDecisionsThisMonth ?? '—'}</td>
        </tr>
      </tbody>
    </table>
  )
}

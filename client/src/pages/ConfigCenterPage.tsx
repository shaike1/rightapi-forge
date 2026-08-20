// Config Center — single page with tabs that brings together every
// configuration surface the platform exposes:
//
//   - Environment / runtime config (GET /api/config + POST /api/config)
//   - Tenants                       (CRUD on /api/tenants)
//   - RBAC                          (roles + assignments + permissions)
//   - Credentials                   (browse only — secrets never displayed)
//   - Schedules                     (list + pause/resume/run + history)
//   - Deploy                        (workflow_dispatch on the deploy.yml pipeline)
//
// Each tab is its own React component. The shell keeps them under one
// route + sidebar entry so an operator has a single "settings" surface
// instead of five disconnected pages.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import s from './ConfigCenterPage.module.css'

const TABS = [
  { id: 'env',          label: 'Environment', icon: '⚙️' },
  { id: 'tenants',      label: 'Tenants',     icon: '🏢' },
  { id: 'rbac',         label: 'RBAC',        icon: '🛡️' },
  { id: 'credentials',  label: 'Credentials', icon: '🔑' },
  { id: 'schedules',    label: 'Schedules',   icon: '⏰' },
  { id: 'deploy',       label: 'Deploy',      icon: '🚀' },
] as const
type Tab = (typeof TABS)[number]['id']

export default function ConfigCenterPage() {
  const [tab, setTab] = useState<Tab>('env')
  const tabMeta = TABS.find(t => t.id === tab)!

  return (
    <Layout
      title="Config Center"
      subtitle="Environment, tenants, RBAC, credentials, schedules — and the deploy bridge."
    >
      <div className={s.shell}>
        <aside className={s.tabs}>
          <div className={s.tabsHeader}>Configuration</div>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`${s.tab} ${tab === t.id ? s.tabActive : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className={s.tabIcon}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </aside>

        <main className={s.main}>
          <h2 className={s.title}>{tabMeta.label}</h2>

          {tab === 'env'         && <EnvTab />}
          {tab === 'tenants'     && <TenantsTab />}
          {tab === 'rbac'        && <RbacTab />}
          {tab === 'credentials' && <CredentialsTab />}
          {tab === 'schedules'   && <SchedulesTab />}
          {tab === 'deploy'      && <DeployTab />}
        </main>
      </div>
    </Layout>
  )
}

// ─── Env tab ──────────────────────────────────────────────────────────

interface RuntimeConfig {
  anthropicKey?: string
  openaiKey?: string
  [key: string]: unknown
}

const ENV_FIELD_META: Record<string, { description?: string; secret?: boolean; dangerous?: boolean }> = {
  anthropicKey: { description: 'Anthropic API key — used by every Claude provider call', secret: true },
  openaiKey:    { description: 'OpenAI API key — used when DEFAULT_AI_PLATFORM=openai',    secret: true },
}

function EnvTab() {
  const { show } = useToast()
  const [config, setConfig] = useState<RuntimeConfig | null>(null)
  const [draft, setDraft]   = useState<RuntimeConfig | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<RuntimeConfig>('/api/config')
      setConfig(r); setDraft(r)
    } catch (err) {
      show(`Failed to load config: ${(err as Error).message}`, 'error')
    }
  }, [show])
  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    try {
      await api.post('/api/config', draft)
      show('Config saved', 'success')
      void refresh()
    } catch (err) {
      show(`Save failed: ${(err as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [draft, refresh, show])

  if (!config || !draft) return <p className={s.subtitle}>Loading…</p>
  const keys = Object.keys(draft).sort()

  return (
    <>
      <p className={s.subtitle}>
        Server runtime config. Secret-shaped values are masked for display + write
        only when changed. Dangerous edits require an explicit Save click.
      </p>
      <div className={s.card}>
        <table className={s.kvTable}>
          <thead>
            <tr><th>Key</th><th>Description</th><th>Value</th></tr>
          </thead>
          <tbody>
            {keys.map(k => {
              const meta = ENV_FIELD_META[k] ?? {}
              return (
                <tr key={k}>
                  <td className={s.key}>
                    {k}
                    {meta.secret    && <span className={`${s.kvBadge} ${s.secret}`}>secret</span>}
                    {meta.dangerous && <span className={s.kvBadge}>danger</span>}
                  </td>
                  <td className={s.desc}>{meta.description ?? '—'}</td>
                  <td className={s.val}>
                    <input
                      type={meta.secret ? 'password' : 'text'}
                      value={String(draft[k] ?? '')}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                      className={meta.dangerous ? s.dangerous : ''}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" size="sm" onClick={save} loading={saving}>Save Changes</Button>
        <Button variant="ghost"   size="sm" onClick={() => setDraft(config)}>Reset</Button>
      </div>
    </>
  )
}

// ─── Tenants tab ─────────────────────────────────────────────────────

interface Tenant {
  id: string
  name: string
  status: 'active' | 'suspended'
  createdAt: string
  updatedAt: string
}

function TenantsTab() {
  const { show } = useToast()
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [newId, setNewId]     = useState('')
  const [newName, setNewName] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ tenants: Tenant[] }>('/api/tenants')
      setTenants(Array.isArray(r?.tenants) ? r.tenants : [])
    } catch (err) {
      show(`Failed to load tenants: ${(err as Error).message}`, 'error')
    }
  }, [show])
  useEffect(() => { void refresh() }, [refresh])

  const create = useCallback(async () => {
    if (!newId.trim()) return
    try {
      await api.post('/api/tenants', { id: newId.trim(), name: newName.trim() || newId.trim() })
      show(`Tenant ${newId} created`, 'success')
      setNewId(''); setNewName('')
      void refresh()
    } catch (err) {
      show(`Create failed: ${(err as Error).message}`, 'error')
    }
  }, [newId, newName, refresh, show])

  const setStatus = useCallback(async (t: Tenant, status: Tenant['status']) => {
    try {
      await api.post('/api/tenants', { id: t.id, name: t.name, status })
      void refresh()
    } catch (err) {
      show(`Update failed: ${(err as Error).message}`, 'error')
    }
  }, [refresh, show])

  return (
    <>
      <p className={s.subtitle}>
        Tenants partition every persisted resource (events, credentials, schedules, …).
        The "system" tenant is the default + cannot be deleted.
      </p>
      <div className={s.card}>
        <h3 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Create tenant</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="id (e.g. acme)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '6px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <input
            placeholder="display name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '6px 10px', fontSize: 12, flex: 1 }}
          />
          <Button variant="primary" size="sm" onClick={create}>Create</Button>
        </div>
      </div>

      <div className={s.card}>
        <table className={s.simpleTable}>
          <thead>
            <tr><th>ID</th><th>Name</th><th>Status</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {tenants.map(t => (
              <tr key={t.id}>
                <td className="id">{t.id}</td>
                <td>{t.name}</td>
                <td>
                  <span className={`${s.runStatus} ${t.status === 'active' ? s.success : s.failure}`}>
                    {t.status}
                  </span>
                </td>
                <td style={{ color: 'var(--text3)', fontSize: 11 }}>{new Date(t.createdAt).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>
                  {t.id !== 'system' && (
                    t.status === 'active'
                      ? <Button size="xs" variant="ghost" onClick={() => void setStatus(t, 'suspended')}>Suspend</Button>
                      : <Button size="xs" variant="ghost" onClick={() => void setStatus(t, 'active')}>Resume</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ─── RBAC tab ────────────────────────────────────────────────────────

interface Role { id: string; name: string; builtin: boolean; inheritsFrom: string; extraPermissions: string[] }
interface Assignment { userId: string; tenantId: string; roleId: string }

function RbacTab() {
  const { show } = useToast()
  const [perms, setPerms]   = useState<string[]>([])
  const [roles, setRoles]   = useState<Role[]>([])
  const [assigns, setAssigns] = useState<Assignment[]>([])

  const refresh = useCallback(async () => {
    try {
      const [p, r, a] = await Promise.all([
        api.get<{ permissions: string[] }>('/api/rbac/permissions'),
        api.get<{ roles: Role[] }>('/api/rbac/roles'),
        api.get<{ assignments: Assignment[] }>('/api/rbac/assignments'),
      ])
      setPerms(Array.isArray(p?.permissions) ? p.permissions : [])
      setRoles(Array.isArray(r?.roles) ? r.roles : [])
      setAssigns(Array.isArray(a?.assignments) ? a.assignments : [])
    } catch (err) {
      show(`Failed to load RBAC: ${(err as Error).message}`, 'error')
    }
  }, [show])
  useEffect(() => { void refresh() }, [refresh])

  return (
    <>
      <p className={s.subtitle}>
        Hierarchical roles + per-resource permissions. User assignments are tenant-scoped.
      </p>
      <div className={s.rbacGrid}>
        <div className={s.card}>
          <h3 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Permissions ({perms.length})</h3>
          <div className={s.permissionList}>
            {perms.map(p => <div key={p} className={s.permissionPill}>{p}</div>)}
          </div>
        </div>
        <div className={s.card}>
          <h3 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Roles ({roles.length})</h3>
          <table className={s.simpleTable}>
            <thead><tr><th>ID</th><th>Inherits</th><th>Extras</th></tr></thead>
            <tbody>
              {roles.map(r => (
                <tr key={r.id}>
                  <td className="id">{r.id}{r.builtin && ' ★'}</td>
                  <td>{r.inheritsFrom}</td>
                  <td style={{ fontSize: 10, color: 'var(--text3)' }}>{r.extraPermissions.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={s.card} style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 12 }}>Assignments ({assigns.length})</h3>
        <table className={s.simpleTable}>
          <thead><tr><th>User</th><th>Tenant</th><th>Role</th></tr></thead>
          <tbody>
            {assigns.map(a => (
              <tr key={`${a.userId}-${a.tenantId}-${a.roleId}`}>
                <td className="id">{a.userId}</td>
                <td>{a.tenantId}</td>
                <td>{a.roleId}</td>
              </tr>
            ))}
            {assigns.length === 0 && (
              <tr><td colSpan={3} style={{ color: 'var(--text3)', textAlign: 'center', padding: 16 }}>
                No explicit assignments. Existing API keys fall back to super_admin (RBAC_LEGACY_FALLBACK).
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ─── Credentials tab ────────────────────────────────────────────────

interface CredentialMeta {
  id: string
  agentId: string
  name: string
  scope: string
  kind?: string
  expiresAt?: string
  rotationIntervalDays?: number
  lastRotatedAt?: string
  lastRotationFailureMessage?: string
}

function CredentialsTab() {
  const { show } = useToast()
  const [list, setList] = useState<CredentialMeta[]>([])
  const [agentId, setAgentId] = useState('')

  const refresh = useCallback(async () => {
    if (!agentId) return setList([])
    try {
      const r = await api.get<{ credentials: CredentialMeta[] }>(`/api/credentials/${encodeURIComponent(agentId)}`)
      setList(Array.isArray(r?.credentials) ? r.credentials : [])
    } catch (err) {
      show(`Load failed: ${(err as Error).message}`, 'error')
    }
  }, [agentId, show])

  return (
    <>
      <p className={s.subtitle}>
        Browse credentials by agent. Secret values are never returned to the dashboard;
        only metadata + lifecycle / rotation status appear here.
      </p>
      <div className={s.card}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="agent id"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            style={{ flex: 1, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', padding: '6px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          />
          <Button variant="primary" size="sm" onClick={() => void refresh()}>Browse</Button>
        </div>
      </div>

      <div className={s.card}>
        <table className={s.simpleTable}>
          <thead>
            <tr><th>ID</th><th>Name</th><th>Kind</th><th>Expires</th><th>Last rotated</th><th>Status</th></tr>
          </thead>
          <tbody>
            {list.map(c => (
              <tr key={c.id}>
                <td className="id">{c.id}</td>
                <td>{c.name}</td>
                <td>{c.kind ?? '—'}</td>
                <td style={{ color: 'var(--text3)', fontSize: 11 }}>{c.expiresAt ? new Date(c.expiresAt).toLocaleString() : '—'}</td>
                <td style={{ color: 'var(--text3)', fontSize: 11 }}>{c.lastRotatedAt ? new Date(c.lastRotatedAt).toLocaleString() : '—'}</td>
                <td>
                  {c.lastRotationFailureMessage
                    ? <span className={`${s.runStatus} ${s.failure}`}>rotation failed</span>
                    : <span className={`${s.runStatus} ${s.success}`}>ok</span>}
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={6} style={{ color: 'var(--text3)', textAlign: 'center', padding: 16 }}>
                Enter an agent id and click Browse.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ─── Schedules tab ───────────────────────────────────────────────────

interface Schedule {
  id: string
  name: string
  cron: string
  status: 'enabled' | 'paused'
  lastRunAt?: string
  nextRunAt?: string
  runCount: number
}

function SchedulesTab() {
  const { show } = useToast()
  const [list, setList] = useState<Schedule[]>([])

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ schedules: Schedule[] }>('/api/schedules')
      setList(Array.isArray(r?.schedules) ? r.schedules : [])
    } catch (err) {
      show(`Load failed: ${(err as Error).message}`, 'error')
    }
  }, [show])
  useEffect(() => { void refresh() }, [refresh])

  const action = useCallback(async (id: string, op: 'pause' | 'resume' | 'run') => {
    try {
      await api.post(`/api/schedules/${encodeURIComponent(id)}/${op}`, {})
      show(`${op} ${id}`, 'success')
      void refresh()
    } catch (err) {
      show(`${op} failed: ${(err as Error).message}`, 'error')
    }
  }, [refresh, show])

  return (
    <>
      <p className={s.subtitle}>
        Cron-driven workflow schedules. Pause/Resume control whether the engine fires;
        Run executes the schedule on demand.
      </p>
      <div className={s.card}>
        <table className={s.simpleTable}>
          <thead>
            <tr><th>ID</th><th>Name</th><th>Cron</th><th>Status</th><th>Last</th><th>Next</th><th>Runs</th><th></th></tr>
          </thead>
          <tbody>
            {list.map(sch => (
              <tr key={sch.id}>
                <td className="id">{sch.id}</td>
                <td>{sch.name}</td>
                <td style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--text2)' }}>{sch.cron}</td>
                <td>
                  <span className={`${s.runStatus} ${sch.status === 'enabled' ? s.success : s.cancelled}`}>{sch.status}</span>
                </td>
                <td style={{ color: 'var(--text3)', fontSize: 11 }}>{sch.lastRunAt ? new Date(sch.lastRunAt).toLocaleString() : '—'}</td>
                <td style={{ color: 'var(--text3)', fontSize: 11 }}>{sch.nextRunAt ? new Date(sch.nextRunAt).toLocaleString() : '—'}</td>
                <td>{sch.runCount}</td>
                <td style={{ textAlign: 'right' }}>
                  {sch.status === 'enabled'
                    ? <Button size="xs" variant="ghost" onClick={() => void action(sch.id, 'pause')}>Pause</Button>
                    : <Button size="xs" variant="ghost" onClick={() => void action(sch.id, 'resume')}>Resume</Button>}
                  <Button size="xs" variant="primary" onClick={() => void action(sch.id, 'run')}>Run</Button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={8} style={{ color: 'var(--text3)', textAlign: 'center', padding: 16 }}>
                No schedules. Use POST /api/schedules to create one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ─── Deploy tab ─────────────────────────────────────────────────────

interface DeployRun {
  id: number
  title: string
  status: 'queued' | 'in_progress' | 'completed' | string
  conclusion: 'success' | 'failure' | 'cancelled' | null
  sha: string
  url: string
  createdAt: string
  updatedAt: string
}

function DeployTab() {
  const { show } = useToast()
  const [configured, setConfigured] = useState(false)
  const [repo, setRepo]     = useState<string | null>(null)
  const [workflow, setWorkflow] = useState<string | null>(null)
  const [runs, setRuns]     = useState<DeployRun[]>([])
  const [error, setError]   = useState<string | null>(null)
  const [triggering, setTriggering] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ configured: boolean; repo?: string; workflow?: string; runs: DeployRun[]; error?: string }>('/api/deploy/status')
      setConfigured(!!r?.configured)
      setRepo(r?.repo ?? null)
      setWorkflow(r?.workflow ?? null)
      setRuns(Array.isArray(r?.runs) ? r.runs : [])
      setError(r?.error ?? null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void refresh() }, 10_000)
    return () => clearInterval(id)
  }, [refresh])

  const trigger = useCallback(async () => {
    if (!confirm('Trigger a production deploy via GitHub Actions?')) return
    setTriggering(true)
    try {
      await api.post('/api/deploy/trigger', {})
      show('Deploy triggered — watch runs below', 'success')
      setTimeout(() => void refresh(), 2000)
    } catch (err) {
      show(`Trigger failed: ${(err as Error).message}`, 'error')
    } finally {
      setTriggering(false)
    }
  }, [refresh, show])

  const rollback = useCallback(async () => {
    if (!confirm('Re-deploy the previously-successful commit?')) return
    // The dashboard's rollback path: fire workflow_dispatch with a
    // ref pointing at the previous successful run's SHA. Operators
    // who need richer rollback semantics call the workflow directly.
    const lastSuccess = runs.find(r => r.conclusion === 'success' && (runs[0]?.id !== r.id))
    if (!lastSuccess) {
      show('No prior successful run found to roll back to', 'warning')
      return
    }
    try {
      await api.post('/api/deploy/trigger', { ref: lastSuccess.sha })
      show(`Rollback triggered to ${lastSuccess.sha}`, 'success')
      setTimeout(() => void refresh(), 2000)
    } catch (err) {
      show(`Rollback failed: ${(err as Error).message}`, 'error')
    }
  }, [runs, refresh, show])

  return (
    <>
      <p className={s.subtitle}>
        Trigger the GitHub Actions deploy.yml pipeline directly from the dashboard.
        Required env on the server: GH_DEPLOY_TOKEN, GH_DEPLOY_REPO, GH_DEPLOY_WORKFLOW.
      </p>
      <div className={s.deployHeader}>
        <span className={`${s.status} ${configured ? s.configured : s.unconfigured}`}>
          {configured ? '● configured' : '○ not configured'}
        </span>
        {repo && <span style={{ color: 'var(--text2)', fontSize: 12 }}>{repo}</span>}
        {workflow && <span style={{ color: 'var(--text3)', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{workflow}</span>}
      </div>

      {error && (
        <div className={s.card} style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <div className={s.deployActions}>
        <Button variant="success" size="sm" onClick={trigger} loading={triggering} disabled={!configured}>
          🚀 Deploy Now
        </Button>
        <Button variant="ghost" size="sm" onClick={rollback} disabled={!configured || runs.length < 2}>
          ↺ Rollback
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>Refresh</Button>
      </div>

      <h3 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.5px', margin: '20px 0 8px' }}>
        Recent runs
      </h3>
      <div className={s.card} style={{ padding: 0, overflow: 'hidden' }}>
        {runs.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text3)', fontSize: 12, textAlign: 'center' }}>
            No deploy runs yet.
          </div>
        ) : runs.map(r => (
          <a
            key={r.id}
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className={s.runRow}
            style={{ textDecoration: 'none' }}
          >
            <span className="ts">{new Date(r.updatedAt).toLocaleString()}</span>
            <span className="title">{r.title}</span>
            <span className="sha">{r.sha}</span>
            <span className={`${s.runStatus} ${runStatusClass(r)}`}>
              {r.conclusion ?? r.status}
            </span>
            <span style={{ color: 'var(--accent-light)', fontSize: 11 }}>view ↗</span>
          </a>
        ))}
      </div>
    </>
  )
}

function runStatusClass(r: DeployRun): string {
  if (r.conclusion === 'success')   return s.success
  if (r.conclusion === 'failure')   return s.failure
  if (r.conclusion === 'cancelled') return s.cancelled
  if (r.status === 'in_progress')   return s.in_progress
  if (r.status === 'queued')        return s.queued
  return s.completed
}

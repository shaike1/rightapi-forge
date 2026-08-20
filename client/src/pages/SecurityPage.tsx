import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './SecurityPage.module.css'

interface Credential {
  id: string
  name: string
  type: 'ssh' | 'api-key' | 'password' | 'certificate'
  environment: string
  lastUsed?: string
  expiresAt?: string
}

interface AuditEvent {
  id: string
  timestamp: string
  user: string
  action: string
  resource: string
  result: 'success' | 'failure'
  type?: string
  details?: string
}

interface AddCredForm {
  name: string
  type: Credential['type']
  environment: string
  value: string
}

interface ApiKey {
  id: string
  provider: string
  baseUrl?: string
  createdAt: string
  enabled: boolean
  key: string
}

interface ApiKeyForm {
  provider: string
  key: string
  baseUrl: string
}

const CRED_TYPE_VARIANT: Record<Credential['type'], 'info' | 'accent' | 'warning' | 'purple'> = {
  'ssh': 'info',
  'api-key': 'accent',
  'password': 'warning',
  'certificate': 'purple',
}

const API_KEY_PROVIDERS = ['claude', 'openai', 'moonshot', 'glm', 'minimax', 'ollama'] as const

type TabKey = 'credentials' | 'audit' | 'apikeys'

export default function SecurityPage() {
  const { show } = useToast()
  const [tab, setTab] = useState<TabKey>('credentials')
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [addModal, setAddModal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState<AddCredForm>({
    name: '', type: 'api-key', environment: 'production', value: '',
  })

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [apiKeysLoaded, setApiKeysLoaded] = useState(false)
  const [apiKeysLoading, setApiKeysLoading] = useState(false)
  const [addApiKeyModal, setAddApiKeyModal] = useState(false)
  const [editApiKeyTarget, setEditApiKeyTarget] = useState<ApiKey | null>(null)
  const [savingApiKey, setSavingApiKey] = useState(false)
  const [deletingApiKeyId, setDeletingApiKeyId] = useState<string | null>(null)
  const [togglingApiKeyId, setTogglingApiKeyId] = useState<string | null>(null)
  const [apiKeyForm, setApiKeyForm] = useState<ApiKeyForm>({ provider: 'claude', key: '', baseUrl: '' })
  const [editApiKeyForm, setEditApiKeyForm] = useState<ApiKeyForm>({ provider: 'claude', key: '', baseUrl: '' })

  // Audit filters and pagination
  const [auditFrom, setAuditFrom] = useState('')
  const [auditTo, setAuditTo] = useState('')
  const [auditType, setAuditType] = useState('all')
  const [auditPage, setAuditPage] = useState(0)
  const [auditTotal, setAuditTotal] = useState(0)
  const AUDIT_PAGE_SIZE = 25

  useEffect(() => {
    Promise.all([
      api.get<{ credentials: Credential[] } | Credential[]>('/api/security/credentials'),
      api.get<{ events: AuditEvent[]; total: number }>(`/api/security/audit?limit=${AUDIT_PAGE_SIZE}&offset=0`),
    ])
      .then(([credData, auditData]) => {
        const credList = Array.isArray(credData) ? credData : credData?.credentials
        setCredentials(Array.isArray(credList) ? credList : [])
        setAuditEvents(Array.isArray(auditData?.events) ? auditData.events : [])
        setAuditTotal(typeof auditData?.total === 'number' ? auditData.total : 0)
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchAudit = async (page: number, from: string, to: string, type: string) => {
    const params = new URLSearchParams({
      limit: String(AUDIT_PAGE_SIZE),
      offset: String(page * AUDIT_PAGE_SIZE),
    })
    if (from) params.set('from', new Date(from).toISOString())
    if (to) params.set('to', new Date(to + 'T23:59:59').toISOString())
    if (type && type !== 'all') params.set('type', type)
    try {
      const data = await api.get<{ events: AuditEvent[]; total: number }>(`/api/security/audit?${params}`)
      setAuditEvents(Array.isArray(data?.events) ? data.events : [])
      setAuditTotal(typeof data?.total === 'number' ? data.total : 0)
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    }
  }

  const handleApplyAuditFilters = () => {
    setAuditPage(0)
    fetchAudit(0, auditFrom, auditTo, auditType)
  }

  const handleClearAuditFilters = () => {
    setAuditFrom('')
    setAuditTo('')
    setAuditType('all')
    setAuditPage(0)
    fetchAudit(0, '', '', 'all')
  }

  const handleAuditPage = (newPage: number) => {
    setAuditPage(newPage)
    fetchAudit(newPage, auditFrom, auditTo, auditType)
  }

  const handleExportCsv = () => {
    const token = localStorage.getItem('itops_token') || sessionStorage.getItem('itops_token') || ''
    const params = new URLSearchParams({ token })
    if (auditFrom) params.set('from', new Date(auditFrom).toISOString())
    if (auditTo) params.set('to', new Date(auditTo + 'T23:59:59').toISOString())
    if (auditType && auditType !== 'all') params.set('type', auditType)
    window.open(`/api/security/audit/export.csv?${params}`, '_blank')
  }

  const handleExportPdf = () => {
    window.print()
  }

  // Lazy-load API keys when the tab is first visited
  useEffect(() => {
    if (tab !== 'apikeys' || apiKeysLoaded) return
    setApiKeysLoading(true)
    api.get<{ keys: ApiKey[] } | ApiKey[]>('/api/api-keys')
      .then(data => {
        const list = Array.isArray(data) ? data : data?.keys
        setApiKeys(Array.isArray(list) ? list : [])
        setApiKeysLoaded(true)
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setApiKeysLoading(false))
  }, [tab, apiKeysLoaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddCredential = async () => {
    if (!form.name.trim()) {
      show('Credential name is required', 'warning')
      return
    }
    setSaving(true)
    try {
      await api.post('/api/security/credentials', form)
      const credData = await api.get<{ credentials: Credential[] } | Credential[]>('/api/security/credentials')
      const credList = Array.isArray(credData) ? credData : credData?.credentials
      setCredentials(Array.isArray(credList) ? credList : [])
      setAddModal(false)
      setForm({ name: '', type: 'api-key', environment: 'production', value: '' })
      show('Credential added', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (cred: Credential) => {
    if (!confirm(`Delete credential "${cred.name}"?`)) return
    setDeletingId(cred.id)
    try {
      await api.delete(`/api/security/credentials/${cred.id}`)
      setCredentials(prev => prev.filter(c => c.id !== cred.id))
      show('Credential deleted', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setDeletingId(null)
    }
  }

  const handleAddApiKey = async () => {
    if (!apiKeyForm.key.trim()) { show('API key is required', 'warning'); return }
    setSavingApiKey(true)
    try {
      await api.post('/api/api-keys', {
        provider: apiKeyForm.provider,
        key: apiKeyForm.key,
        ...(apiKeyForm.baseUrl.trim() ? { baseUrl: apiKeyForm.baseUrl.trim() } : {}),
      })
      const data = await api.get<{ keys: ApiKey[] } | ApiKey[]>('/api/api-keys')
      const list = Array.isArray(data) ? data : data?.keys
      setApiKeys(Array.isArray(list) ? list : [])
      setAddApiKeyModal(false)
      setApiKeyForm({ provider: 'claude', key: '', baseUrl: '' })
      show('API key added', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingApiKey(false)
    }
  }

  const handleEditApiKey = async () => {
    if (!editApiKeyTarget) return
    setSavingApiKey(true)
    try {
      await api.put(`/api/api-keys/${editApiKeyTarget.id}`, {
        ...(editApiKeyForm.key.trim() ? { key: editApiKeyForm.key.trim() } : {}),
        ...(editApiKeyForm.baseUrl.trim() ? { baseUrl: editApiKeyForm.baseUrl.trim() } : { baseUrl: '' }),
      })
      const data = await api.get<{ keys: ApiKey[] } | ApiKey[]>('/api/api-keys')
      const list = Array.isArray(data) ? data : data?.keys
      setApiKeys(Array.isArray(list) ? list : [])
      setEditApiKeyTarget(null)
      show('API key updated', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingApiKey(false)
    }
  }

  const handleDeleteApiKey = async (key: ApiKey) => {
    if (!confirm(`Delete API key for "${key.provider}"?`)) return
    setDeletingApiKeyId(key.id)
    try {
      await api.delete(`/api/api-keys/${key.id}`)
      setApiKeys(prev => prev.filter(k => k.id !== key.id))
      show('API key deleted', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setDeletingApiKeyId(null)
    }
  }

  const handleToggleApiKey = async (key: ApiKey) => {
    setTogglingApiKeyId(key.id)
    try {
      await api.put(`/api/api-keys/${key.id}`, { enabled: !key.enabled })
      setApiKeys(prev => prev.map(k => k.id === key.id ? { ...k, enabled: !k.enabled } : k))
      show(`API key ${key.enabled ? 'disabled' : 'enabled'}`, 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setTogglingApiKeyId(null)
    }
  }

  const openEditApiKey = (key: ApiKey) => {
    setEditApiKeyForm({ provider: key.provider, key: '', baseUrl: key.baseUrl ?? '' })
    setEditApiKeyTarget(key)
  }

  const actions = tab === 'credentials'
    ? <Button variant="primary" size="sm" onClick={() => setAddModal(true)}>+ Add Credential</Button>
    : tab === 'apikeys'
    ? <Button variant="primary" size="sm" onClick={() => setAddApiKeyModal(true)}>+ Add API Key</Button>
    : undefined

  return (
    <Layout title="Security" subtitle="Credentials and access control" actions={actions}>
      {/* Tabs */}
      <div className={styles.tabs}>
        <TabButton active={tab === 'credentials'} onClick={() => setTab('credentials')}>
          🔑 Credentials
        </TabButton>
        <TabButton active={tab === 'audit'} onClick={() => setTab('audit')}>
          📋 Audit Log
        </TabButton>
        <TabButton active={tab === 'apikeys'} onClick={() => setTab('apikeys')}>
          🤖 API Keys
        </TabButton>
      </div>

      {loading && tab !== 'apikeys' ? (
        <div className={styles.loading}>Loading…</div>
      ) : tab === 'credentials' ? (
        <Card>
          <CardHeader title={`Credentials (${credentials.length})`} />
          <CardBody>
            {credentials.length === 0 ? (
              <EmptyState
                icon="🔐"
                title="No credentials stored"
                description="Add SSH keys, API tokens, passwords, and certificates"
                action={{ label: '+ Add Credential', onClick: () => setAddModal(true) }}
              />
            ) : (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {['Name', 'Type', 'Environment', 'Last Used', 'Expires', ''].map((h, i) => (
                        <th key={i} className={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {credentials.map(cred => (
                    <tr key={cred.id} className={styles.tr}>
                      <td className={styles.td}>
                        <span className={styles.credName}>{cred.name}</span>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={CRED_TYPE_VARIANT[cred.type]}>{cred.type}</Badge>
                      </td>
                      <td className={styles.td}>{cred.environment}</td>
                      <td className={styles.td}>
                        {cred.lastUsed ? new Date(cred.lastUsed).toLocaleDateString() : '—'}
                      </td>
                      <td className={styles.td}>
                        {cred.expiresAt ? (
                          <ExpiryCell expiresAt={cred.expiresAt} />
                        ) : '—'}
                      </td>
                      <td className={styles.tdRight}>
                        <Button
                          variant="danger"
                          size="xs"
                          loading={deletingId === cred.id}
                          onClick={() => handleDelete(cred)}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </CardBody>
        </Card>
      ) : tab === 'audit' ? (
        <Card>
          <CardHeader title={`Audit Log (${auditTotal} events)`} />
          <CardBody>
            {/* Filter bar */}
            <div className={styles.filterBar}>
              <input
                type="date"
                value={auditFrom}
                onChange={e => setAuditFrom(e.target.value)}
                className={styles.filterInput}
                placeholder="From"
              />
              <input
                type="date"
                value={auditTo}
                onChange={e => setAuditTo(e.target.value)}
                className={styles.filterInput}
                placeholder="To"
              />
              <select
                value={auditType}
                onChange={e => setAuditType(e.target.value)}
                className={styles.select}
              >
                <option value="all">All Types</option>
                <option value="login">Login</option>
                <option value="incident">Incident</option>
                <option value="agent">Agent</option>
                <option value="settings">Settings</option>
                <option value="security">Security</option>
                <option value="runbook">Runbook</option>
              </select>
              <Button variant="primary" size="sm" onClick={handleApplyAuditFilters}>Apply</Button>
              <Button variant="ghost" size="sm" onClick={handleClearAuditFilters}>Clear</Button>
            </div>

            {/* Export buttons */}
            <div className={styles.exportRow + ' audit-no-print'}>
              <Button variant="ghost" size="sm" onClick={handleExportCsv}>⬇ Export CSV</Button>
              <Button variant="ghost" size="sm" onClick={handleExportPdf}>🖨 Export PDF</Button>
            </div>

            {auditEvents.length === 0 ? (
              <EmptyState icon="📋" title="No audit events" description="Security events will appear here" />
            ) : (
              <>
                <div className={styles.tableWrapper}>
                <table className={styles.table} id="audit-table">
                  <thead>
                    <tr>
                      {['Timestamp', 'Type', 'User', 'Action', 'Resource', 'Result'].map(h => (
                        <th key={h} className={styles.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {auditEvents.map((evt, idx) => (
                      <tr key={evt.id || idx} className={styles.tr}>
                        <td className={styles.td}>
                          <span className={styles.tsSmall}>{new Date(evt.timestamp).toLocaleString()}</span>
                        </td>
                        <td className={styles.td}>{evt.type || '—'}</td>
                        <td className={styles.td}>{evt.user}</td>
                        <td className={styles.td}>{evt.action}</td>
                        <td className={styles.td}>{evt.resource}</td>
                        <td className={styles.td}>
                          <Badge variant={evt.result === 'success' ? 'success' : 'danger'}>
                            {evt.result}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>

                {/* Pagination */}
                <div className={styles.pagination + ' audit-no-print'}>
                  <span className={styles.pageInfo}>
                    {auditPage * AUDIT_PAGE_SIZE + 1}–{Math.min((auditPage + 1) * AUDIT_PAGE_SIZE, auditTotal)} of {auditTotal}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAuditPage(auditPage - 1)}
                    disabled={auditPage === 0}
                  >
                    ← Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleAuditPage(auditPage + 1)}
                    disabled={(auditPage + 1) * AUDIT_PAGE_SIZE >= auditTotal}
                  >
                    Next →
                  </Button>
                </div>
              </>
            )}
          </CardBody>
        </Card>
      ) : apiKeysLoading ? (
        <div className={styles.loading}>Loading…</div>
      ) : (
        <Card>
          <CardHeader title={`API Keys (${apiKeys.length})`} />
          <CardBody>
            {apiKeys.length === 0 ? (
              <EmptyState
                icon="🤖"
                title="No API keys stored"
                description="Add AI provider keys for Claude, OpenAI, and more"
                action={{ label: '+ Add API Key', onClick: () => setAddApiKeyModal(true) }}
              />
            ) : (
              <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {['Provider', 'Key (masked)', 'Base URL', 'Added', 'Status', ''].map((h, i) => (
                      <th key={i} className={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {apiKeys.map(key => (
                    <tr key={key.id} className={styles.tr}>
                      <td className={styles.td}>
                        <span className={styles.credName}>{key.provider}</span>
                      </td>
                      <td className={styles.td}>
                        <span className={styles.tsSmall}>{key.key}</span>
                      </td>
                      <td className={styles.td}>{key.baseUrl || '—'}</td>
                      <td className={styles.td}>
                        <span className={styles.tsSmall}>{new Date(key.createdAt).toLocaleDateString()}</span>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={key.enabled ? 'success' : 'neutral'}>
                          {key.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      </td>
                      <td className={styles.tdRight}>
                        <Button
                          variant="ghost"
                          size="xs"
                          loading={togglingApiKeyId === key.id}
                          onClick={() => handleToggleApiKey(key)}
                        >
                          {key.enabled ? 'Disable' : 'Enable'}
                        </Button>
                        {' '}
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={() => openEditApiKey(key)}
                        >
                          Edit
                        </Button>
                        {' '}
                        <Button
                          variant="danger"
                          size="xs"
                          loading={deletingApiKeyId === key.id}
                          onClick={() => handleDeleteApiKey(key)}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Add Credential Modal */}
      <Modal
        open={addModal}
        onClose={() => setAddModal(false)}
        title="Add Credential"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddModal(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleAddCredential}>Add Credential</Button>
          </>
        }
      >
        <FormField
          label="Name"
          value={form.name}
          onChange={v => setForm(f => ({ ...f, name: v }))}
          placeholder="e.g. Production SSH Key"
        />
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Type</label>
          <select
            value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value as Credential['type'] }))}
            className={styles.select}
          >
            <option value="ssh">SSH Key</option>
            <option value="api-key">API Key</option>
            <option value="password">Password</option>
            <option value="certificate">Certificate</option>
          </select>
        </div>
        <FormField
          label="Environment"
          value={form.environment}
          onChange={v => setForm(f => ({ ...f, environment: v }))}
          placeholder="production"
        />
        <FormField
          label="Value / Secret"
          value={form.value}
          onChange={v => setForm(f => ({ ...f, value: v }))}
          placeholder="Paste the credential value"
          type="password"
        />
      </Modal>

      {/* Add API Key Modal */}
      <Modal
        open={addApiKeyModal}
        onClose={() => setAddApiKeyModal(false)}
        title="Add API Key"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddApiKeyModal(false)}>Cancel</Button>
            <Button variant="primary" loading={savingApiKey} onClick={handleAddApiKey}>Add API Key</Button>
          </>
        }
      >
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Provider</label>
          <select
            value={apiKeyForm.provider}
            onChange={e => setApiKeyForm(f => ({ ...f, provider: e.target.value }))}
            className={styles.select}
          >
            {API_KEY_PROVIDERS.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <FormField
          label="API Key"
          value={apiKeyForm.key}
          onChange={v => setApiKeyForm(f => ({ ...f, key: v }))}
          placeholder="sk-..."
          type="password"
        />
        <FormField
          label="Base URL (optional)"
          value={apiKeyForm.baseUrl}
          onChange={v => setApiKeyForm(f => ({ ...f, baseUrl: v }))}
          placeholder="https://api.example.com"
        />
      </Modal>

      {/* Edit API Key Modal */}
      <Modal
        open={editApiKeyTarget !== null}
        onClose={() => setEditApiKeyTarget(null)}
        title={`Edit API Key — ${editApiKeyTarget?.provider ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditApiKeyTarget(null)}>Cancel</Button>
            <Button variant="primary" loading={savingApiKey} onClick={handleEditApiKey}>Save Changes</Button>
          </>
        }
      >
        <FormField
          label="New API Key (leave blank to keep existing)"
          value={editApiKeyForm.key}
          onChange={v => setEditApiKeyForm(f => ({ ...f, key: v }))}
          placeholder="sk-..."
          type="password"
        />
        <FormField
          label="Base URL (optional)"
          value={editApiKeyForm.baseUrl}
          onChange={v => setEditApiKeyForm(f => ({ ...f, baseUrl: v }))}
          placeholder="https://api.example.com"
        />
      </Modal>
    </Layout>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ExpiryCell({ expiresAt }: { expiresAt: string }) {
  const expires = new Date(expiresAt)
  const now = new Date()
  const daysLeft = Math.ceil((expires.getTime() - now.getTime()) / 86_400_000)
  const variant = daysLeft < 0 ? 'danger' : daysLeft < 30 ? 'warning' : 'neutral'
  return <Badge variant={variant}>{expires.toLocaleDateString()}</Badge>
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`${styles.tab}${active ? ' ' + styles.tabActive : ''}`}
    >
      {children}
    </button>
  )
}

function FormField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div className={styles.fieldGroup}>
      <label className={styles.fieldLabel}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} className={styles.input} />
    </div>
  )
}

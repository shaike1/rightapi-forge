import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plug, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Badge from '../components/Badge'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import styles from './IntegrationsPage.module.css'

// ── Types — mirror the server's PluginStatusRow + PluginConfigField ──

type FieldType = 'string' | 'password' | 'url' | 'number' | 'boolean' | 'select'

interface ConfigField {
  key: string
  label: string
  type: FieldType
  required: boolean
  default?: string | number | boolean
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  helpText?: string
}

interface Integration {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  loaded: boolean
  lastError: string | null
  configSchema: ConfigField[]
  config: Record<string, unknown> | null
  installedAt: string
  updatedAt: string
}

// ── Page component ───────────────────────────────────────────────────

export default function IntegrationsPage() {
  const { user } = useAuth()
  const { show } = useToast()
  const navigate = useNavigate()
  const [items, setItems] = useState<Integration[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Admin-only page.
  useEffect(() => {
    if (user && user.role !== 'admin') navigate('/incidents', { replace: true })
  }, [user, navigate])

  const fetchAll = useCallback(async () => {
    try {
      const data = await api.get<{ integrations: Integration[] }>('/api/integrations/plugins')
      setItems(Array.isArray(data?.integrations) ? data.integrations : [])
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load integrations', 'error')
    } finally {
      setLoading(false)
    }
  }, [show])

  useEffect(() => { fetchAll() }, [fetchAll])

  const selected = useMemo(() => items.find(i => i.id === selectedId) ?? null, [items, selectedId])

  // ── Toggle enable / disable ───────────────────────────────────────────
  const toggle = async (integration: Integration) => {
    try {
      if (integration.enabled) {
        await api.post(`/api/integrations/plugins/${integration.id}/disable`, {})
        show(`Disabled ${integration.name}`, 'success')
      } else {
        await api.post(`/api/integrations/plugins/${integration.id}/enable`, {})
        show(`Enabled ${integration.name}`, 'success')
      }
      fetchAll()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Toggle failed', 'error')
      fetchAll()
    }
  }

  if (loading) {
    return (
      <Layout title="Integrations" subtitle="Event-driven plugins for external systems">
        <div className={styles.empty}>Loading…</div>
      </Layout>
    )
  }

  return (
    <Layout
      title="Integrations"
      subtitle="Event-driven plugins fan incident, metric, and runbook events out to PagerDuty, OpsGenie, Prometheus, and more."
    >
      <div className={styles.layout}>
        <div className={styles.list}>
          {items.length === 0 ? (
            <div className={styles.empty}>No integrations registered.</div>
          ) : items.map(int => (
            <button
              type="button"
              key={int.id}
              className={`${styles.card} ${selectedId === int.id ? styles.cardActive : ''}`}
              onClick={() => setSelectedId(int.id)}
            >
              <div className={styles.cardHead}>
                <span className={styles.cardName}>
                  <Plug size={14} /> {int.name}
                </span>
                <span className={styles.cardVer}>v{int.version}</span>
              </div>
              <div className={styles.cardDesc}>{int.description}</div>
              <div className={styles.cardFoot}>
                {int.enabled
                  ? (int.loaded
                      ? <Badge variant="success">enabled</Badge>
                      : <Badge variant="warning">enabled · error</Badge>)
                  : <Badge variant="neutral">disabled</Badge>
                }
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); toggle(int) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(int) } }}
                  className={styles.toggle}
                >
                  {int.enabled ? 'Disable' : 'Enable'}
                </span>
              </div>
              {int.lastError && (
                <div className={styles.cardError} title={int.lastError}>
                  <ShieldAlert size={12} /> {int.lastError.slice(0, 80)}{int.lastError.length > 80 ? '…' : ''}
                </div>
              )}
            </button>
          ))}
        </div>

        <div className={styles.detail}>
          {!selected
            ? <div className={styles.empty}>Select an integration on the left to view + edit its configuration.</div>
            : <IntegrationDetail key={selected.id} integration={selected} onChange={fetchAll} />
          }
        </div>
      </div>
    </Layout>
  )
}

// ── Detail panel: config form, test, status ──────────────────────────

function IntegrationDetail({ integration, onChange }: { integration: Integration; onChange: () => void }) {
  const { show } = useToast()
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...(integration.config ?? {}) }))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [externalStatus, setExternalStatus] = useState<Record<string, unknown> | null>(null)

  useEffect(() => { setDraft({ ...(integration.config ?? {}) }) }, [integration.id, integration.config])

  // Fetch external status for enabled+loaded plugins.
  useEffect(() => {
    let cancelled = false
    if (!integration.enabled || !integration.loaded) {
      setExternalStatus(null)
      return
    }
    api.get<{ status: Record<string, unknown> }>(`/api/integrations/plugins/${integration.id}/status`)
      .then(r => { if (!cancelled) setExternalStatus(r.status) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [integration.id, integration.enabled, integration.loaded])

  const setField = (key: string, value: unknown) => setDraft(prev => ({ ...prev, [key]: value }))

  // Build a payload that omits the redaction sentinel — sending the empty
  // string back lets the server keep the previously-stored password.
  const buildPayload = (d: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const field of integration.configSchema) {
      const v = d[field.key]
      if (field.type === 'password' && v === '__REDACTED__') {
        out[field.key] = ''
      } else if (v !== undefined) {
        out[field.key] = v
      }
    }
    return out
  }

  const save = async () => {
    setSaving(true)
    setTestResult(null)
    try {
      await api.put(`/api/integrations/plugins/${integration.id}/config`, { config: buildPayload(draft) })
      show('Configuration saved', 'success')
      onChange()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(
        `/api/integrations/plugins/${integration.id}/test`,
        { config: buildPayload(draft) },
      )
      setTestResult(r)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader title={integration.name} subtitle={`${integration.description} (v${integration.version})`} />
        <CardBody>
          <div className={styles.form}>
            {integration.configSchema.map(field => (
              <ConfigFieldRow
                key={field.key}
                field={field}
                value={draft[field.key]}
                onChange={v => setField(field.key, v)}
              />
            ))}
          </div>
          <div className={styles.actionsRow}>
            <Button variant="ghost" onClick={test} loading={testing}>Test connection</Button>
            <Button variant="primary" onClick={save} loading={saving}>Save</Button>
          </div>
          {testResult && (
            <div className={testResult.ok ? styles.testOk : styles.testFail}>
              {testResult.ok
                ? <><CheckCircle2 size={14} /> Connection successful</>
                : <><XCircle size={14} /> {testResult.error ?? 'Test failed'}</>
              }
            </div>
          )}
          {integration.lastError && (
            <div className={styles.lastError}>
              <ShieldAlert size={14} /> Last error: {integration.lastError}
            </div>
          )}
        </CardBody>
      </Card>

      {externalStatus && (
        <Card>
          <CardHeader title="External status" subtitle="Live snapshot from the integration" />
          <CardBody>
            <pre className={styles.statusBody}>{JSON.stringify(externalStatus, null, 2)}</pre>
          </CardBody>
        </Card>
      )}
    </>
  )
}

function ConfigFieldRow({ field, value, onChange }: {
  field: ConfigField
  value: unknown
  onChange: (v: unknown) => void
}) {
  const id = `field-${field.key}`
  let input: React.ReactNode
  switch (field.type) {
    case 'boolean':
      input = (
        <label className={styles.toggleLabel}>
          <input id={id} type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
          <span>{value ? 'on' : 'off'}</span>
        </label>
      )
      break
    case 'number':
      input = (
        <input id={id} type="number" className={styles.input}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder={field.placeholder}
        />
      )
      break
    case 'select':
      input = (
        <select id={id} className={styles.input}
          value={value === undefined ? '' : String(value)}
          onChange={e => onChange(e.target.value)}
        >
          {(field.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
      break
    case 'password':
      input = (
        <input id={id} type="password" className={styles.input}
          value={value === undefined ? '' : String(value)}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder ?? (value === '__REDACTED__' ? '(saved — leave to keep)' : '')}
          autoComplete="new-password"
        />
      )
      break
    case 'url':
      input = (
        <input id={id} type="url" className={styles.input}
          value={value === undefined ? '' : String(value)}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )
      break
    default:
      input = (
        <input id={id} type="text" className={styles.input}
          value={value === undefined ? '' : String(value)}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      )
  }
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {field.label} {field.required && <span className={styles.req}>*</span>}
      </label>
      {input}
      {field.helpText && <div className={styles.help}>{field.helpText}</div>}
    </div>
  )
}

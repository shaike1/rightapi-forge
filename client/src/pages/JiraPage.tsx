import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './JiraPage.module.css'

interface JiraConfig {
  configured: boolean
  url?: string
  project?: string
}

interface JiraIssue {
  key: string
  summary: string
  status: string
  priority: string
  assignee?: string
  created: string
}

type PriorityVariant = 'danger' | 'warning' | 'info' | 'neutral'
const PRIORITY_MAP: Record<string, PriorityVariant> = {
  Highest: 'danger',
  High: 'danger',
  Medium: 'warning',
  Low: 'info',
  Lowest: 'neutral',
}

function priorityVariant(priority: string): PriorityVariant {
  return PRIORITY_MAP[priority] ?? 'neutral'
}

interface ConfigForm {
  url: string
  username: string
  token: string
  project: string
}

export default function JiraPage() {
  const { show } = useToast()
  const [config, setConfig] = useState<JiraConfig | null>(null)
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [configModal, setConfigModal] = useState(false)
  const [form, setForm] = useState<ConfigForm>({ url: '', username: '', token: '', project: '' })
  const [saving, setSaving] = useState(false)
  const [incidents, setIncidents] = useState<Array<{id: string, title: string, severity: string, status: string}>>([])
  const [pushModal, setPushModal] = useState(false)
  const [selectedIncident, setSelectedIncident] = useState<string>('')
  const [pushing, setPushing] = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([
      api.get<JiraConfig>('/api/jira/config'),
      api.get<{ issues: JiraIssue[] }>('/api/jira/issues'),
    ])
      .then(([cfg, issData]) => {
        setConfig(cfg)
        setIssues(Array.isArray(issData?.issues) ? issData.issues : [])
        if (cfg?.url || cfg?.project) {
          setForm(f => ({ ...f, url: cfg.url ?? '', project: cfg.project ?? '' }))
        }
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setLoading(false))
    api.get<{incidents: Array<{id: string, title: string, severity: string, status: string}>}>('/api/incidents')
      .then(d => {
        const list = Array.isArray(d?.incidents) ? d.incidents : []
        setIncidents(list.filter(i => i.status !== 'resolved').slice(0, 20))
      })
      .catch(() => {})
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put('/api/jira/config', form)
      const cfg = await api.get<JiraConfig>('/api/jira/config')
      setConfig(cfg)
      setConfigModal(false)
      show('Jira configuration saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      await api.post('/api/jira/sync')
      const issData = await api.get<{ issues: JiraIssue[] }>('/api/jira/issues')
      setIssues(Array.isArray(issData?.issues) ? issData.issues : [])
      show('Sync complete', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSyncing(false)
    }
  }

  const openConfigModal = () => {
    setForm({ url: config?.url ?? '', username: '', token: '', project: config?.project ?? '' })
    setConfigModal(true)
  }

  const pushToJira = async () => {
    if (!selectedIncident) { show('Select an incident', 'warning'); return }
    setPushing(true)
    try {
      const res = await api.post<{ok: boolean, jiraKey: string}>(`/api/jira/create-from-incident/${selectedIncident}`)
      show(`Created Jira issue ${res.jiraKey}`, 'success')
      setPushModal(false)
      setSelectedIncident('')
      load()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to create Jira issue', 'error')
    } finally {
      setPushing(false)
    }
  }

  return (
    <Layout
      title="Jira Integration"
      subtitle="Sync incidents and issues with Jira"
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => setPushModal(true)}>
            ↑ Push to Jira
          </Button>
          <Button variant="primary" loading={syncing} onClick={handleSync}>
            Sync Now
          </Button>
        </>
      }
    >
      {/* Configuration Card */}
      <Card>
        <CardHeader
          title="Configuration"
          actions={
            <Button variant="secondary" size="sm" onClick={openConfigModal}>
              Configure
            </Button>
          }
        />
        <CardBody>
          {config?.configured ? (
            <div className={styles.configRow}>
              <div className={styles.metaItem}>
                <div className={styles.metaLabel}>Jira URL</div>
                <div className={styles.metaValue}>{config.url}</div>
              </div>
              <div className={styles.metaItem}>
                <div className={styles.metaLabel}>Project</div>
                <div className={styles.metaValue}>{config.project}</div>
              </div>
              <div className={styles.metaItem}>
                <div className={styles.metaLabel}>Status</div>
                <Badge variant="success">Connected</Badge>
              </div>
            </div>
          ) : (
            <div className={styles.unconfigured}>
              Jira is not configured. Click <strong>Configure</strong> to set up the integration.
            </div>
          )}
        </CardBody>
      </Card>

      {/* Issues Table */}
      <div className={styles.spacer}>
        <Card>
          <CardHeader title={`Issues (${issues.length})`} />
          <CardBody className={styles.tableWrap}>
            {loading ? (
              <div className={styles.loading}>Loading…</div>
            ) : issues.length === 0 ? (
              <EmptyState
                icon="🎫"
                title="No Jira issues"
                description="Sync now to pull issues from your Jira project"
                action={{ label: 'Sync Now', onClick: handleSync }}
              />
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    {['Key', 'Summary', 'Status', 'Priority', 'Assignee', 'Created'].map(h => (
                      <th key={h} className={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {issues.map(issue => (
                    <tr key={issue.key} className={styles.tr}>
                      <td className={styles.td}>
                        <code className={styles.issueKey}>{issue.key}</code>
                      </td>
                      <td className={styles.tdSummary}>{issue.summary}</td>
                      <td className={styles.td}>
                        <Badge variant="info">{issue.status}</Badge>
                      </td>
                      <td className={styles.td}>
                        <Badge variant={priorityVariant(issue.priority)}>{issue.priority}</Badge>
                      </td>
                      <td className={styles.td}>{issue.assignee ?? '—'}</td>
                      <td className={styles.td}>{new Date(issue.created).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Configure Modal */}
      <Modal
        open={configModal}
        onClose={() => setConfigModal(false)}
        title="Configure Jira Integration"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfigModal(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleSave}>Save Configuration</Button>
          </>
        }
      >
        <FormField
          label="Jira URL"
          value={form.url}
          onChange={v => setForm(f => ({ ...f, url: v }))}
          placeholder="https://yourorg.atlassian.net"
        />
        <FormField
          label="Username / Email"
          value={form.username}
          onChange={v => setForm(f => ({ ...f, username: v }))}
          placeholder="user@example.com"
        />
        <FormField
          label="API Token"
          value={form.token}
          onChange={v => setForm(f => ({ ...f, token: v }))}
          placeholder="Your Jira API token"
          type="password"
        />
        <FormField
          label="Project Key"
          value={form.project}
          onChange={v => setForm(f => ({ ...f, project: v }))}
          placeholder="OPS"
        />
      </Modal>
      <Modal
        open={pushModal}
        onClose={() => setPushModal(false)}
        title="Create Jira Issue from Incident"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPushModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={pushing} onClick={pushToJira}>Create Issue</Button>
          </>
        }
      >
        <div className={styles.formField}>
          <label className={styles.fieldLabel}>Select open incident</label>
          <select
            className={styles.input}
            value={selectedIncident}
            onChange={e => setSelectedIncident(e.target.value)}
          >
            <option value="">— choose an incident —</option>
            {incidents.map(inc => (
              <option key={inc.id} value={inc.id}>
                [{inc.severity.toUpperCase()}] {inc.title}
              </option>
            ))}
          </select>
          <p style={{ fontSize: '.8rem', color: 'var(--text3)', marginTop: 8 }}>
            This will create a new Jira issue in your configured project and link it to the incident.
          </p>
        </div>
      </Modal>
    </Layout>
  )
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function FormField({
  label, value, onChange, placeholder, type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <div className={styles.formField}>
      <label className={styles.fieldLabel}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={styles.input}
      />
    </div>
  )
}

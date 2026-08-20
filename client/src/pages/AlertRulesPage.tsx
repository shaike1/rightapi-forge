import { useEffect, useState, useCallback } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import { Card, CardBody } from '../components/Card'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { toast } from '../hooks/useToast'
import styles from './AlertRulesPage.module.css'

interface AlertChannel {
  type: 'telegram' | 'slack' | 'discord' | 'webhook' | 'pagerduty' | 'email' | 'teams'
  webhookUrl?: string
  chatId?: string
  routingKey?: string
  email?: string
}

interface AlertRule {
  id: string
  name: string
  enabled: boolean
  metric: 'cpu' | 'memory' | 'disk' | 'ping'
  threshold: number
  operator: '>' | '<' | '>='
  servers: string[]
  cooldownMinutes: number
  severity: 'warning' | 'critical'
  createdAt: string
  lastTriggered?: string
  lastValue?: number
  channels?: AlertChannel[]
  notifyEmail?: boolean
  jiraProject?: string
  runbookId?: string
  autoRemediate?: boolean
}

interface RunbookTemplate {
  id: string
  name: string
  description?: string
}

// ─── Correlation types ────────────────────────────────────────────────────────

interface AlertEvent {
  id: string
  ruleId: string
  ruleName: string
  server: string
  metric: string
  value: number
  severity: string
  firedAt: string
}

interface CorrelationGroup {
  id: string
  alerts: AlertEvent[]
  compositeSeverity: 'low' | 'medium' | 'high' | 'critical'
  affectedServers: string[]
  affectedMetrics: string[]
  firstFiredAt: string
  lastFiredAt: string
  isDuplicate: boolean
  suppressedCount: number
}

interface CorrelationStats {
  totalAlerts: number
  suppressedAlerts: number
  activeGroups: number
  suppressionRate: number
}

interface RuleForm {
  name: string
  metric: AlertRule['metric']
  threshold: string
  operator: AlertRule['operator']
  servers: string
  cooldownMinutes: string
  severity: AlertRule['severity']
  runbookId: string
  autoRemediate: boolean
}

const EMPTY_FORM: RuleForm = {
  name: '',
  metric: 'cpu',
  threshold: '90',
  operator: '>',
  servers: '*',
  cooldownMinutes: '30',
  severity: 'critical',
  runbookId: '',
  autoRemediate: false,
}

function formatDate(ts?: string) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function severityVariant(s: string) {
  return s === 'critical' ? 'danger' : 'warning'
}

export default function AlertRulesPage() {
  const [activeTab, setActiveTab] = useState<'rules' | 'correlations'>('rules')
  const [rules, setRules] = useState<AlertRule[]>([])
  const [templates, setTemplates] = useState<RunbookTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof RuleForm, string>>>({})
  const [submitting, setSubmitting] = useState(false)
  const [editRule, setEditRule] = useState<AlertRule | null>(null)
  const [editForm, setEditForm] = useState<RuleForm>(EMPTY_FORM)
  const [editErrors, setEditErrors] = useState<Partial<Record<keyof RuleForm, string>>>({})
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())

  // Correlation state
  const [corrGroups, setCorrGroups] = useState<CorrelationGroup[]>([])
  const [corrStats, setCorrStats] = useState<CorrelationStats | null>(null)
  const [corrLoading, setCorrLoading] = useState(false)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)

  async function fetchData() {
    try {
      const [rulesData, tmplData] = await Promise.all([
        api.get<AlertRule[]>('/api/alert-rules'),
        api.get<{ runbooks: RunbookTemplate[] }>('/api/runbooks/templates').catch(() => ({ runbooks: [] })),
      ])
      setRules(Array.isArray(rulesData) ? rulesData : [])
      setTemplates(Array.isArray(tmplData?.runbooks) ? tmplData.runbooks : [])
    } catch {
      toast.error('Failed to load alert rules')
    } finally {
      setLoading(false)
    }
  }

  const fetchCorrelations = useCallback(async () => {
    setCorrLoading(true)
    try {
      const [groups, stats] = await Promise.all([
        api.get<CorrelationGroup[]>('/api/alerts/correlations'),
        api.get<CorrelationStats>('/api/alerts/correlations/stats'),
      ])
      setCorrGroups(Array.isArray(groups) ? groups : [])
      setCorrStats(stats)
    } catch {
      // silently ignore — correlation may not be available yet
    } finally {
      setCorrLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [])

  useEffect(() => {
    if (activeTab === 'correlations') {
      fetchCorrelations()
      const id = setInterval(fetchCorrelations, 30_000)
      return () => clearInterval(id)
    }
  }, [activeTab, fetchCorrelations])

  function ruleToForm(rule: AlertRule): RuleForm {
    return {
      name: rule.name,
      metric: rule.metric,
      threshold: String(rule.threshold),
      operator: rule.operator,
      servers: rule.servers.join(', '),
      cooldownMinutes: String(rule.cooldownMinutes),
      severity: rule.severity,
      runbookId: rule.runbookId ?? '',
      autoRemediate: rule.autoRemediate ?? false,
    }
  }

  function validate(f: RuleForm): Partial<Record<keyof RuleForm, string>> {
    const errors: Partial<Record<keyof RuleForm, string>> = {}
    if (!f.name.trim()) errors.name = 'Name is required'
    const t = parseFloat(f.threshold)
    if (isNaN(t) || t < 0) errors.threshold = 'Must be a non-negative number'
    const c = parseInt(f.cooldownMinutes)
    if (isNaN(c) || c < 1) errors.cooldownMinutes = 'Must be at least 1 minute'
    if (!f.servers.trim()) errors.servers = 'Enter at least one server or *'
    if (f.autoRemediate && !f.runbookId) errors.runbookId = 'Select a runbook for auto-remediation'
    return errors
  }

  function formToPayload(f: RuleForm) {
    return {
      name: f.name.trim(),
      metric: f.metric,
      threshold: parseFloat(f.threshold),
      operator: f.operator,
      servers: f.servers.split(',').map(s => s.trim()).filter(Boolean),
      cooldownMinutes: parseInt(f.cooldownMinutes),
      severity: f.severity,
      enabled: true,
      runbookId: f.autoRemediate && f.runbookId ? f.runbookId : undefined,
      autoRemediate: f.autoRemediate,
    }
  }

  async function handleAdd() {
    const errors = validate(form)
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return }
    setSubmitting(true)
    try {
      await api.post('/api/alert-rules', formToPayload(form))
      toast.success('Alert rule created')
      setShowAdd(false)
      setForm(EMPTY_FORM)
      setFormErrors({})
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create rule')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleEdit() {
    if (!editRule) return
    const errors = validate(editForm)
    if (Object.keys(errors).length > 0) { setEditErrors(errors); return }
    setEditSubmitting(true)
    try {
      await api.put(`/api/alert-rules/${editRule.id}`, formToPayload(editForm))
      toast.success('Alert rule updated')
      setEditRule(null)
      setEditErrors({})
      fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update rule')
    } finally {
      setEditSubmitting(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this alert rule?')) return
    try {
      await api.delete(`/api/alert-rules/${id}`)
      toast.success('Rule deleted')
      fetchData()
    } catch {
      toast.error('Failed to delete rule')
    }
  }

  async function handleToggle(rule: AlertRule) {
    setTogglingIds(s => new Set(s).add(rule.id))
    try {
      await api.put(`/api/alert-rules/${rule.id}`, { enabled: !rule.enabled })
      fetchData()
    } catch {
      toast.error('Failed to toggle rule')
    } finally {
      setTogglingIds(s => { const n = new Set(s); n.delete(rule.id); return n })
    }
  }

  async function handleEvaluateNow(id: string) {
    try {
      await api.post(`/api/alert-rules/${id}/evaluate-now`, {})
      toast.success('Evaluation triggered')
    } catch {
      toast.error('Failed to trigger evaluation')
    }
  }

  function RuleFormFields({
    f, errors, onChange
  }: {
    f: RuleForm
    errors: Partial<Record<keyof RuleForm, string>>
    onChange: (patch: Partial<RuleForm>) => void
  }) {
    return (
      <div className={styles.form}>
        <label className={styles.formLabel}>
          Name <span className={styles.required}>*</span>
          <input
            className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
            value={f.name}
            onChange={e => onChange({ name: e.target.value })}
            placeholder="High CPU Alert"
          />
          {errors.name && <span className={styles.errorText}>{errors.name}</span>}
        </label>

        <div className={styles.formRow}>
          <label className={styles.formLabel}>
            Metric
            <select className={styles.input} value={f.metric} onChange={e => onChange({ metric: e.target.value as AlertRule['metric'] })}>
              <option value="cpu">CPU %</option>
              <option value="memory">Memory %</option>
              <option value="disk">Disk %</option>
              <option value="ping">Ping ms</option>
            </select>
          </label>
          <label className={styles.formLabel}>
            Operator
            <select className={styles.input} value={f.operator} onChange={e => onChange({ operator: e.target.value as AlertRule['operator'] })}>
              <option value=">">{'>'} greater than</option>
              <option value=">=">{'>='} greater or equal</option>
              <option value="<">{'<'} less than</option>
            </select>
          </label>
          <label className={styles.formLabel}>
            Threshold <span className={styles.required}>*</span>
            <input
              className={`${styles.input} ${errors.threshold ? styles.inputError : ''}`}
              type="number"
              value={f.threshold}
              onChange={e => onChange({ threshold: e.target.value })}
            />
            {errors.threshold && <span className={styles.errorText}>{errors.threshold}</span>}
          </label>
        </div>

        <div className={styles.formRow}>
          <label className={styles.formLabel}>
            Severity
            <select className={styles.input} value={f.severity} onChange={e => onChange({ severity: e.target.value as AlertRule['severity'] })}>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
            </select>
          </label>
          <label className={styles.formLabel}>
            Cooldown (minutes) <span className={styles.required}>*</span>
            <input
              className={`${styles.input} ${errors.cooldownMinutes ? styles.inputError : ''}`}
              type="number"
              min={1}
              value={f.cooldownMinutes}
              onChange={e => onChange({ cooldownMinutes: e.target.value })}
            />
            {errors.cooldownMinutes && <span className={styles.errorText}>{errors.cooldownMinutes}</span>}
          </label>
        </div>

        <label className={styles.formLabel}>
          Servers <span className={styles.required}>*</span>
          <input
            className={`${styles.input} ${errors.servers ? styles.inputError : ''}`}
            value={f.servers}
            onChange={e => onChange({ servers: e.target.value })}
            placeholder="* (all) or 192.168.1.1, 192.168.1.2"
          />
          <span className={styles.hint}>Use * for all monitored servers, or comma-separated IPs</span>
          {errors.servers && <span className={styles.errorText}>{errors.servers}</span>}
        </label>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>🔧 Auto-remediation</div>
          <label className={styles.toggleLabel}>
            <span className={styles.toggle}>
              <input
                type="checkbox"
                checked={f.autoRemediate}
                onChange={e => onChange({ autoRemediate: e.target.checked, runbookId: e.target.checked ? f.runbookId : '' })}
              />
              <span className={styles.toggleSlider} />
            </span>
            Auto-execute runbook when alert fires
          </label>
          {f.autoRemediate && (
            <label className={styles.formLabel} style={{ marginTop: 10 }}>
              Runbook <span className={styles.required}>*</span>
              <select
                className={`${styles.input} ${errors.runbookId ? styles.inputError : ''}`}
                value={f.runbookId}
                onChange={e => onChange({ runbookId: e.target.value })}
              >
                <option value="">— select a runbook —</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {errors.runbookId && <span className={styles.errorText}>{errors.runbookId}</span>}
              {templates.length === 0 && (
                <span className={styles.hint}>No runbook templates found. Create one in the Runbooks page first.</span>
              )}
            </label>
          )}
        </div>
      </div>
    )
  }

  const enabledCount = rules.filter(r => r.enabled).length
  const remediateCount = rules.filter(r => r.autoRemediate).length

  function corrSeverityVariant(s: string) {
    if (s === 'critical') return 'danger'
    if (s === 'high') return 'danger'
    if (s === 'medium') return 'warning'
    return 'neutral'
  }

  return (
    <Layout title="Alert Rules" subtitle="Define threshold-based alerts and auto-remediation runbooks">

      {/* ── Tab bar ─────────────────────────────────────────────────────────── */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'rules' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('rules')}
        >
          Rules
          <span className={styles.tabCount}>{rules.length}</span>
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'correlations' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('correlations')}
        >
          Correlations
          {corrStats && corrStats.activeGroups > 0 && (
            <span className={styles.tabCount}>{corrStats.activeGroups}</span>
          )}
        </button>
      </div>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'rules' && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <div style={{ flex: 1 }}>
            <Card>
              <CardBody>
                <div className={styles.statLabel}>Total Rules</div>
                <div className={styles.statValue}>{rules.length}</div>
              </CardBody>
            </Card>
            </div>
            <div style={{ flex: 1 }}>
            <Card>
              <CardBody>
                <div className={styles.statLabel}>Enabled</div>
                <div className={styles.statValue}>{enabledCount}</div>
              </CardBody>
            </Card>
            </div>
            <div style={{ flex: 1 }}>
            <Card>
              <CardBody>
                <div className={styles.statLabel}>Auto-remediation</div>
                <div className={styles.statValue}>{remediateCount}</div>
              </CardBody>
            </Card>
            </div>
          </div>

          <Card>
            <CardBody>
              <div className={styles.cardHeader}>
                <div>
                  <strong>Alert Rules</strong>
                  <div className={styles.sub}>Fires when a metric crosses a threshold</div>
                </div>
                <Button size="sm" onClick={() => { setForm(EMPTY_FORM); setFormErrors({}); setShowAdd(true) }}>
                  + Add Rule
                </Button>
              </div>

              {loading ? (
                <div className={styles.loading}>Loading…</div>
              ) : rules.length === 0 ? (
                <EmptyState
                  icon="🔔"
                  title="No alert rules yet"
                  description="Create your first rule to start monitoring"
                />
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Metric</th>
                        <th>Threshold</th>
                        <th>Severity</th>
                        <th>Cooldown</th>
                        <th>Last Triggered</th>
                        <th>Enabled</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map(rule => (
                        <tr key={rule.id}>
                          <td>
                            <div className={styles.ruleName}>
                              {rule.name}
                              {rule.autoRemediate && (
                                <span className={styles.remediateBadge} title={`Auto-executes runbook: ${templates.find(t => t.id === rule.runbookId)?.name ?? rule.runbookId}`}>🔧</span>
                              )}
                            </div>
                            <div className={styles.ruleSub}>{rule.servers.join(', ')}</div>
                          </td>
                          <td><code className={styles.metricCode}>{rule.metric}</code></td>
                          <td className={styles.thresholdCell}>
                            <span className={styles.operator}>{rule.operator}</span> {rule.threshold}
                            {rule.lastValue !== undefined && (
                              <div className={styles.lastVal}>last: {rule.lastValue}</div>
                            )}
                          </td>
                          <td>
                            <Badge variant={severityVariant(rule.severity) as any}>{rule.severity}</Badge>
                          </td>
                          <td className={styles.dateCell}>{rule.cooldownMinutes}m</td>
                          <td className={styles.dateCell}>{formatDate(rule.lastTriggered)}</td>
                          <td>
                            <label className={styles.toggle}>
                              <input
                                type="checkbox"
                                checked={rule.enabled}
                                disabled={togglingIds.has(rule.id)}
                                onChange={() => handleToggle(rule)}
                              />
                              <span className={styles.toggleSlider} />
                            </label>
                          </td>
                          <td>
                            <div className={styles.actionBtns}>
                              <Button size="xs" variant="ghost" onClick={() => handleEvaluateNow(rule.id)}>▶ Run</Button>
                              <Button size="xs" variant="ghost" onClick={() => { setEditRule(rule); setEditForm(ruleToForm(rule)); setEditErrors({}) }}>Edit</Button>
                              <Button size="xs" variant="danger" onClick={() => handleDelete(rule.id)}>Delete</Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'correlations' && (
        <>
          {/* Stats bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
            <div style={{ flex: 1 }}>
              <Card>
                <CardBody>
                  <div className={styles.statLabel}>Total Alerts</div>
                  <div className={styles.statValue}>{corrStats?.totalAlerts ?? '—'}</div>
                </CardBody>
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card>
                <CardBody>
                  <div className={styles.statLabel}>Suppressed</div>
                  <div className={styles.statValue}>{corrStats?.suppressedAlerts ?? '—'}</div>
                </CardBody>
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card>
                <CardBody>
                  <div className={styles.statLabel}>Active Groups</div>
                  <div className={styles.statValue}>{corrStats?.activeGroups ?? '—'}</div>
                </CardBody>
              </Card>
            </div>
            <div style={{ flex: 1 }}>
              <Card>
                <CardBody>
                  <div className={styles.statLabel}>Suppression Rate</div>
                  <div className={styles.statValue}>{corrStats != null ? `${corrStats.suppressionRate}%` : '—'}</div>
                </CardBody>
              </Card>
            </div>
          </div>

          <Card>
            <CardBody>
              <div className={styles.cardHeader}>
                <div>
                  <strong>Correlation Groups</strong>
                  <div className={styles.sub}>Alerts grouped by server + metric within 5-minute windows · auto-refreshes every 30s</div>
                </div>
                <Button size="sm" variant="ghost" onClick={fetchCorrelations}>↺ Refresh</Button>
              </div>

              {corrLoading && corrGroups.length === 0 ? (
                <div className={styles.loading}>Loading correlations…</div>
              ) : corrGroups.length === 0 ? (
                <EmptyState
                  icon="🔗"
                  title="No active correlation groups"
                  description="Groups appear here when multiple alerts fire within a 5-minute window"
                />
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th></th>
                        <th>First Fired</th>
                        <th>Servers</th>
                        <th>Metrics</th>
                        <th>Alerts</th>
                        <th>Suppressed</th>
                        <th>Severity</th>
                        <th>Duplicate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {corrGroups.map(g => (
                        <>
                          <tr
                            key={g.id}
                            className={styles.corrRow}
                            onClick={() => setExpandedGroupId(expandedGroupId === g.id ? null : g.id)}
                            style={{ cursor: 'pointer' }}
                          >
                            <td className={styles.expandIcon}>{expandedGroupId === g.id ? '▾' : '▸'}</td>
                            <td className={styles.dateCell}>{formatDate(g.firstFiredAt)}</td>
                            <td>
                              <div className={styles.tagList}>
                                {g.affectedServers.map(s => (
                                  <span key={s} className={styles.tag}>{s}</span>
                                ))}
                              </div>
                            </td>
                            <td>
                              <div className={styles.tagList}>
                                {g.affectedMetrics.map(m => (
                                  <code key={m} className={styles.metricCode}>{m}</code>
                                ))}
                              </div>
                            </td>
                            <td className={styles.dateCell}>{g.alerts.length}</td>
                            <td className={styles.dateCell}>{g.suppressedCount}</td>
                            <td>
                              <Badge variant={corrSeverityVariant(g.compositeSeverity) as any}>
                                {g.compositeSeverity}
                              </Badge>
                            </td>
                            <td className={styles.dateCell}>{g.isDuplicate ? '✓' : '—'}</td>
                          </tr>
                          {expandedGroupId === g.id && (
                            <tr key={`${g.id}-expanded`}>
                              <td colSpan={8} className={styles.expandedCell}>
                                <table className={styles.innerTable}>
                                  <thead>
                                    <tr>
                                      <th>Rule</th>
                                      <th>Server</th>
                                      <th>Metric</th>
                                      <th>Value</th>
                                      <th>Severity</th>
                                      <th>Fired At</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {g.alerts.map(a => (
                                      <tr key={a.id}>
                                        <td>{a.ruleName}</td>
                                        <td style={{ fontFamily: 'monospace', fontSize: '.8rem' }}>{a.server}</td>
                                        <td><code className={styles.metricCode}>{a.metric}</code></td>
                                        <td>{a.value}</td>
                                        <td><Badge variant={severityVariant(a.severity) as any}>{a.severity}</Badge></td>
                                        <td className={styles.dateCell}>{formatDate(a.firedAt)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* Add Rule Modal */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Alert Rule"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create Rule'}
            </Button>
          </>
        }
      >
        <RuleFormFields
          f={form}
          errors={formErrors}
          onChange={patch => setForm(f => ({ ...f, ...patch }))}
        />
      </Modal>

      {/* Edit Rule Modal */}
      <Modal
        open={!!editRule}
        onClose={() => setEditRule(null)}
        title={`Edit: ${editRule?.name ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditRule(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={editSubmitting}>
              {editSubmitting ? 'Saving…' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <RuleFormFields
          f={editForm}
          errors={editErrors}
          onChange={patch => setEditForm(f => ({ ...f, ...patch }))}
        />
      </Modal>
    </Layout>
  )
}

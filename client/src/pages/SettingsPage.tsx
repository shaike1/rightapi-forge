import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './SettingsPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GeneralSettings {
  platformName: string
  timezone: string
  retentionDays: number
}

interface TeamsSettings {
  incidentsWebhook: string
  alertsWebhook: string
  escalationsWebhook: string
  outgoingSecret: string
}

interface LdapSettings {
  mode: 'ldap' | 'azure-ad'
  // LDAP
  ldapUrl: string
  ldapBindDn: string
  ldapBindPassword: string
  ldapBaseDn: string
  // Azure AD
  azureTenantId: string
  azureClientId: string
  azureClientSecret: string
}

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
  to: string[]   // stored as array, UI uses comma-separated string
  enabled: boolean
}

interface ReportSchedule {
  enabled: boolean
  frequency: 'daily' | 'weekly'
  dayOfWeek: number   // 0-6
  hour: number        // 0-23
  recipients: string[]
  includeIncidents: boolean
  includeAgentHealth: boolean
  includeOpenTasks: boolean
}

interface SlackConfig {
  webhookUrl: string
  channel: string
  enabled: boolean
  events: {
    incidentCreated: boolean
    incidentResolved: boolean
    alertFired: boolean
    agentError: boolean
  }
}

interface DiscordConfig {
  webhookUrl: string
  channelName: string
  enabled: boolean
  events: {
    incidentCreated: boolean
    incidentResolved: boolean
    alertFired: boolean
    agentError: boolean
    taskCompleted: boolean
  }
}

type TabKey = 'general' | 'teams' | 'ldap' | 'email' | 'slack' | 'discord'

const TIMEZONES = [
  'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo',
  'Asia/Shanghai', 'Australia/Sydney',
]

// ── Main Component ────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { show } = useToast()
  const [tab, setTab] = useState<TabKey>('general')

  // General
  const [general, setGeneral] = useState<GeneralSettings>({
    platformName: 'RightAPI Forge',
    timezone: 'UTC',
    retentionDays: 90,
  })
  const [savingGeneral, setSavingGeneral] = useState(false)

  // Teams
  const [teams, setTeams] = useState<TeamsSettings>({
    incidentsWebhook: '',
    alertsWebhook: '',
    escalationsWebhook: '',
    outgoingSecret: '',
  })
  const [savingTeams, setSavingTeams] = useState(false)
  const [testingTeams, setTestingTeams] = useState(false)

  // AD/LDAP
  const [ldap, setLdap] = useState<LdapSettings>({
    mode: 'ldap',
    ldapUrl: '', ldapBindDn: '', ldapBindPassword: '', ldapBaseDn: '',
    azureTenantId: '', azureClientId: '', azureClientSecret: '',
  })
  const [savingLdap, setSavingLdap] = useState(false)

  // SMTP / Email
  const [smtp, setSmtp] = useState<SmtpConfig>({
    host: '', port: 587, secure: false, user: '', pass: '', from: '', to: [], enabled: false,
  })
  const [smtpToRaw, setSmtpToRaw] = useState('')   // comma-separated string for the UI
  const [savingSmtp, setSavingSmtp] = useState(false)
  const [testingSmtp, setTestingSmtp] = useState(false)

  // Report Schedule
  const [reportSchedule, setReportSchedule] = useState<ReportSchedule>({
    enabled: false, frequency: 'daily', dayOfWeek: 1, hour: 8,
    recipients: [], includeIncidents: true, includeAgentHealth: true, includeOpenTasks: true,
  })
  const [reportRecipientsRaw, setReportRecipientsRaw] = useState('')
  const [savingReport, setSavingReport] = useState(false)
  const [sendingReport, setSendingReport] = useState(false)

  // Slack
  const [slack, setSlack] = useState<SlackConfig>({
    webhookUrl: '', channel: '#alerts', enabled: false,
    events: { incidentCreated: true, incidentResolved: true, alertFired: true, agentError: false },
  })
  const [savingSlack, setSavingSlack] = useState(false)
  const [testingSlack, setTestingSlack] = useState(false)

  // Discord
  const [discord, setDiscord] = useState<DiscordConfig>({
    webhookUrl: '', channelName: '#incidents', enabled: false,
    events: { incidentCreated: true, incidentResolved: true, alertFired: true, agentError: false, taskCompleted: false },
  })
  const [savingDiscord, setSavingDiscord] = useState(false)
  const [testingDiscord, setTestingDiscord] = useState(false)

  useEffect(() => {
    Promise.all([
      api.get<GeneralSettings>('/api/settings/general').catch(() => null),
      api.get<TeamsSettings>('/api/settings/teams').catch(() => null),
      api.get<SmtpConfig>('/api/settings/smtp').catch(() => null),
      api.get<SlackConfig>('/api/settings/slack').catch(() => null),
      api.get<ReportSchedule>('/api/settings/reports').catch(() => null),
      api.get<DiscordConfig>('/api/settings/discord').catch(() => null),
    ]).then(([gen, tm, sm, sl, rpt, dc]) => {
      if (gen) setGeneral(gen)
      if (tm) setTeams(tm)
      if (sm) {
        setSmtp(sm)
        setSmtpToRaw(Array.isArray(sm.to) ? sm.to.join(', ') : '')
      }
      if (sl) setSlack(sl)
      if (rpt) {
        setReportSchedule(rpt)
        setReportRecipientsRaw(Array.isArray(rpt.recipients) ? rpt.recipients.join(', ') : '')
      }
      if (dc) setDiscord(dc)
    })
  }, [])

  const handleSaveGeneral = async () => {
    setSavingGeneral(true)
    try {
      await api.put('/api/settings/general', general)
      show('General settings saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingGeneral(false)
    }
  }

  const handleSaveTeams = async () => {
    setSavingTeams(true)
    try {
      await api.put('/api/settings/teams', teams)
      show('Teams configuration saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingTeams(false)
    }
  }

  const handleTestTeams = async () => {
    setTestingTeams(true)
    try {
      await api.post('/api/settings/teams/test')
      show('Test message sent to Teams', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setTestingTeams(false)
    }
  }

  const handleSaveLdap = async () => {
    setSavingLdap(true)
    try {
      await api.put('/api/settings/ldap', ldap)
      show('AD/LDAP configuration saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingLdap(false)
    }
  }

  const handleSaveSmtp = async () => {
    setSavingSmtp(true)
    try {
      const payload: SmtpConfig = {
        ...smtp,
        to: smtpToRaw.split(',').map(s => s.trim()).filter(Boolean),
      }
      await api.post('/api/settings/smtp', payload)
      show('Email settings saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingSmtp(false)
    }
  }

  const handleTestSmtp = async () => {
    setTestingSmtp(true)
    try {
      const result = await api.post<{ ok: boolean; error?: string }>('/api/settings/smtp/test')
      if (result.ok) {
        show('SMTP connection successful', 'success')
      } else {
        show(result.error || 'Connection failed', 'error')
      }
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setTestingSmtp(false)
    }
  }

  const handleSaveReport = async () => {
    setSavingReport(true)
    try {
      const payload: ReportSchedule = {
        ...reportSchedule,
        recipients: reportRecipientsRaw.split(',').map(s => s.trim()).filter(Boolean),
      }
      await api.post('/api/settings/reports', payload)
      setReportSchedule(payload)
      show('Report schedule saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingReport(false)
    }
  }

  const handleSendNow = async () => {
    setSendingReport(true)
    try {
      await api.post('/api/settings/reports/send-now')
      show('Report sent successfully', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSendingReport(false)
    }
  }

  const handleSaveSlack = async () => {
    setSavingSlack(true)
    try {
      await api.post('/api/settings/slack', slack)
      show('Slack configuration saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingSlack(false)
    }
  }

  const handleTestSlack = async () => {
    setTestingSlack(true)
    try {
      const result = await api.post<{ ok: boolean; error?: string }>('/api/settings/slack/test')
      if (result.ok) {
        show('Test message sent to Slack!', 'success')
      } else {
        show(result.error || 'Slack test failed', 'error')
      }
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setTestingSlack(false)
    }
  }

  const handleSaveDiscord = async () => {
    setSavingDiscord(true)
    try {
      await api.post('/api/settings/discord', discord)
      show('Discord configuration saved', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSavingDiscord(false)
    }
  }

  const handleTestDiscord = async () => {
    setTestingDiscord(true)
    try {
      const result = await api.post<{ ok: boolean; error?: string }>('/api/settings/discord/test')
      if (result.ok) {
        show('Test message sent to Discord!', 'success')
      } else {
        show(result.error || 'Discord test failed', 'error')
      }
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setTestingDiscord(false)
    }
  }

  return (
    <Layout title="Settings" subtitle="Platform configuration">
      {/* Tab Bar */}
      <div className={styles.tabs}>
        <TabButton active={tab === 'general'} onClick={() => setTab('general')}>⚙️ General</TabButton>
        <TabButton active={tab === 'teams'} onClick={() => setTab('teams')}>💬 Teams Integration</TabButton>
        <TabButton active={tab === 'ldap'} onClick={() => setTab('ldap')}>🔒 AD / LDAP</TabButton>
        <TabButton active={tab === 'email'} onClick={() => setTab('email')}>📧 Email</TabButton>
        <TabButton active={tab === 'slack'} onClick={() => setTab('slack')}>💬 Slack</TabButton>
        <TabButton active={tab === 'discord'} onClick={() => setTab('discord')}>🎮 Discord</TabButton>
      </div>

      {/* General Tab */}
      {tab === 'general' && (
        <Card>
          <CardHeader title="General Settings" />
          <CardBody>
            <div className={styles.formGrid}>
              <FormField
                label="Platform Name"
                value={general.platformName}
                onChange={v => setGeneral(g => ({ ...g, platformName: v }))}
                placeholder="RightAPI Forge"
              />
              <div className={styles.field}>
                <label className={styles.label}>Timezone</label>
                <select
                  value={general.timezone}
                  onChange={e => setGeneral(g => ({ ...g, timezone: e.target.value }))}
                  className={styles.select}
                >
                  {TIMEZONES.map(tz => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Data Retention (days)</label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={general.retentionDays}
                  onChange={e => setGeneral(g => ({ ...g, retentionDays: Number(e.target.value) }))}
                  className={styles.input}
                />
                <div className={styles.hint}>How long to retain incidents, logs and audit data</div>
              </div>
            </div>
            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingGeneral} onClick={handleSaveGeneral}>
                Save Changes
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Teams Integration Tab */}
      {tab === 'teams' && (
        <Card>
          <CardHeader title="Microsoft Teams Integration" />
          <CardBody>
            <p className={styles.description}>
              Configure incoming webhook URLs to post notifications to Teams channels.
            </p>
            <FormField
              label="Incidents Webhook URL"
              value={teams.incidentsWebhook}
              onChange={v => setTeams(t => ({ ...t, incidentsWebhook: v }))}
              placeholder="https://outlook.office.com/webhook/..."
            />
            <FormField
              label="Alerts Webhook URL"
              value={teams.alertsWebhook}
              onChange={v => setTeams(t => ({ ...t, alertsWebhook: v }))}
              placeholder="https://outlook.office.com/webhook/..."
            />
            <FormField
              label="Escalations Webhook URL"
              value={teams.escalationsWebhook}
              onChange={v => setTeams(t => ({ ...t, escalationsWebhook: v }))}
              placeholder="https://outlook.office.com/webhook/..."
            />
            <FormField
              label="Outgoing Webhook Secret"
              value={teams.outgoingSecret}
              onChange={v => setTeams(t => ({ ...t, outgoingSecret: v }))}
              placeholder="HMAC signature secret"
              type="password"
            />
            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingTeams} onClick={handleSaveTeams}>
                Save Configuration
              </Button>
              <Button variant="secondary" loading={testingTeams} onClick={handleTestTeams}>
                Test Connection
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {/* AD/LDAP Tab */}
      {tab === 'ldap' && (
        <Card>
          <CardHeader title="Directory Integration" />
          <CardBody>
            {/* Mode Toggle */}
            <div className={styles.field}>
              <label className={styles.label}>Directory Type</label>
              <div className={styles.radioGroup}>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    value="ldap"
                    checked={ldap.mode === 'ldap'}
                    onChange={() => setLdap(l => ({ ...l, mode: 'ldap' }))}
                  />
                  LDAP / Active Directory
                </label>
                <label className={styles.radioLabel}>
                  <input
                    type="radio"
                    value="azure-ad"
                    checked={ldap.mode === 'azure-ad'}
                    onChange={() => setLdap(l => ({ ...l, mode: 'azure-ad' }))}
                  />
                  Azure Active Directory
                </label>
              </div>
            </div>

            {ldap.mode === 'ldap' ? (
              <>
                <FormField
                  label="LDAP Server URL"
                  value={ldap.ldapUrl}
                  onChange={v => setLdap(l => ({ ...l, ldapUrl: v }))}
                  placeholder="ldap://dc.example.com:389"
                />
                <FormField
                  label="Bind DN"
                  value={ldap.ldapBindDn}
                  onChange={v => setLdap(l => ({ ...l, ldapBindDn: v }))}
                  placeholder="cn=service,dc=example,dc=com"
                />
                <FormField
                  label="Bind Password"
                  value={ldap.ldapBindPassword}
                  onChange={v => setLdap(l => ({ ...l, ldapBindPassword: v }))}
                  placeholder="Bind account password"
                  type="password"
                />
                <FormField
                  label="Base DN"
                  value={ldap.ldapBaseDn}
                  onChange={v => setLdap(l => ({ ...l, ldapBaseDn: v }))}
                  placeholder="dc=example,dc=com"
                />
              </>
            ) : (
              <>
                <FormField
                  label="Tenant ID"
                  value={ldap.azureTenantId}
                  onChange={v => setLdap(l => ({ ...l, azureTenantId: v }))}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
                <FormField
                  label="Client ID (App Registration)"
                  value={ldap.azureClientId}
                  onChange={v => setLdap(l => ({ ...l, azureClientId: v }))}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                />
                <FormField
                  label="Client Secret"
                  value={ldap.azureClientSecret}
                  onChange={v => setLdap(l => ({ ...l, azureClientSecret: v }))}
                  placeholder="Application client secret"
                  type="password"
                />
              </>
            )}

            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingLdap} onClick={handleSaveLdap}>
                Save Configuration
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
      {/* Email / SMTP Tab */}
      {tab === 'email' && (
        <>
        <Card>
          <CardHeader title="Email Notifications (SMTP)" />
          <CardBody>
            <p className={styles.description}>
              Configure an SMTP server to send alert and incident notifications by email.
            </p>

            {/* Enable toggle */}
            <div className={styles.field}>
              <label className={styles.label}>
                <input
                  type="checkbox"
                  checked={smtp.enabled}
                  onChange={e => setSmtp(s => ({ ...s, enabled: e.target.checked }))}
                  style={{ marginRight: 8 }}
                />
                Enable email notifications
              </label>
            </div>

            <div className={styles.formGrid}>
              <FormField
                label="SMTP Host"
                value={smtp.host}
                onChange={v => setSmtp(s => ({ ...s, host: v }))}
                placeholder="smtp.example.com"
              />
              <div className={styles.field}>
                <label className={styles.label}>Port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={smtp.port}
                  onChange={e => setSmtp(s => ({ ...s, port: Number(e.target.value) }))}
                  className={styles.input}
                />
                <div className={styles.hint}>Common ports: 587 (STARTTLS), 465 (TLS), 25 (plain)</div>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>
                  <input
                    type="checkbox"
                    checked={smtp.secure}
                    onChange={e => setSmtp(s => ({ ...s, secure: e.target.checked }))}
                    style={{ marginRight: 8 }}
                  />
                  Use TLS (port 465) — uncheck for STARTTLS (port 587)
                </label>
              </div>
              <FormField
                label="Username"
                value={smtp.user}
                onChange={v => setSmtp(s => ({ ...s, user: v }))}
                placeholder="alerts@example.com"
              />
              <FormField
                label="Password"
                value={smtp.pass}
                onChange={v => setSmtp(s => ({ ...s, pass: v }))}
                placeholder="SMTP password"
                type="password"
              />
              <FormField
                label="From Address"
                value={smtp.from}
                onChange={v => setSmtp(s => ({ ...s, from: v }))}
                placeholder='RightAPI Forge <alerts@example.com>'
              />
              <div className={styles.field}>
                <label className={styles.label}>Default Recipients</label>
                <input
                  type="text"
                  value={smtpToRaw}
                  onChange={e => setSmtpToRaw(e.target.value)}
                  placeholder="ops@example.com, oncall@example.com"
                  className={styles.input}
                />
                <div className={styles.hint}>Comma-separated list of default alert recipients</div>
              </div>
            </div>

            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingSmtp} onClick={handleSaveSmtp}>
                Save Configuration
              </Button>
              <Button variant="secondary" loading={testingSmtp} onClick={handleTestSmtp}>
                Test Connection
              </Button>
            </div>
          </CardBody>
        </Card>

        {/* Reports Section */}
        <Card>
          <CardHeader title="Scheduled Reports" />
          <CardBody>
            <p className={styles.description}>
              Automatically send HTML summary reports by email on a schedule.
            </p>

            <div className={styles.field}>
              <label className={styles.label}>
                <input
                  type="checkbox"
                  checked={reportSchedule.enabled}
                  onChange={e => setReportSchedule(s => ({ ...s, enabled: e.target.checked }))}
                  style={{ marginRight: 8 }}
                />
                Enable scheduled reports
              </label>
            </div>

            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label className={styles.label}>Frequency</label>
                <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', fontSize: '.875rem' }}>
                    <input type="radio" name="reportFreq" value="daily"
                      checked={reportSchedule.frequency === 'daily'}
                      onChange={() => setReportSchedule(s => ({ ...s, frequency: 'daily' }))} />
                    Daily
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', fontSize: '.875rem' }}>
                    <input type="radio" name="reportFreq" value="weekly"
                      checked={reportSchedule.frequency === 'weekly'}
                      onChange={() => setReportSchedule(s => ({ ...s, frequency: 'weekly' }))} />
                    Weekly
                  </label>
                </div>
              </div>

              {reportSchedule.frequency === 'weekly' && (
                <div className={styles.field}>
                  <label className={styles.label}>Day of Week</label>
                  <select
                    value={reportSchedule.dayOfWeek}
                    onChange={e => setReportSchedule(s => ({ ...s, dayOfWeek: Number(e.target.value) }))}
                    className={styles.input}
                  >
                    {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => (
                      <option key={i} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className={styles.field}>
                <label className={styles.label}>Send Hour (UTC)</label>
                <select
                  value={reportSchedule.hour}
                  onChange={e => setReportSchedule(s => ({ ...s, hour: Number(e.target.value) }))}
                  className={styles.input}
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{String(i).padStart(2, '0')}:00</option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Recipients</label>
                <textarea
                  value={reportRecipientsRaw}
                  onChange={e => setReportRecipientsRaw(e.target.value)}
                  placeholder="ops@example.com, manager@example.com"
                  className={styles.input}
                  rows={2}
                  style={{ resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div className={styles.hint}>Comma-separated list of report recipients</div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Report Contents</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                  {([
                    ['includeIncidents', 'Include Incidents Summary'],
                    ['includeAgentHealth', 'Include Agent Health'],
                    ['includeOpenTasks', 'Include Open Tasks'],
                  ] as [keyof ReportSchedule, string][]).map(([key, label]) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text)', fontSize: '.875rem' }}>
                      <input
                        type="checkbox"
                        checked={reportSchedule[key] as boolean}
                        onChange={e => setReportSchedule(s => ({ ...s, [key]: e.target.checked }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingReport} onClick={handleSaveReport}>
                Save Schedule
              </Button>
              <Button variant="secondary" loading={sendingReport} onClick={handleSendNow}>
                Send Now
              </Button>
            </div>
          </CardBody>
        </Card>
        </>
      )}
      {tab === 'slack' && (
        <Card>
          <CardHeader title="Slack Integration" />
          <CardBody>
            <p className={styles.description}>
              Send incident and alert notifications to a Slack channel via an Incoming Webhook.
            </p>

            <div className={styles.field}>
              <label className={styles.label}>
                <input
                  type="checkbox"
                  checked={slack.enabled}
                  onChange={e => setSlack(s => ({ ...s, enabled: e.target.checked }))}
                  style={{ marginRight: 8 }}
                />
                Enable Slack notifications
              </label>
            </div>

            <FormField
              label="Webhook URL"
              value={slack.webhookUrl}
              onChange={v => setSlack(s => ({ ...s, webhookUrl: v }))}
              placeholder="https://hooks.slack.com/services/..."
              type="password"
            />
            <FormField
              label="Channel"
              value={slack.channel}
              onChange={v => setSlack(s => ({ ...s, channel: v }))}
              placeholder="#alerts"
            />

            <div className={styles.field}>
              <label className={styles.label}>Notify on Events</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(
                  [
                    ['incidentCreated', 'Incident Created'],
                    ['incidentResolved', 'Incident Resolved'],
                    ['alertFired', 'Alert Fired'],
                    ['agentError', 'Agent Error'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className={styles.radioLabel}>
                    <input
                      type="checkbox"
                      checked={slack.events[key]}
                      onChange={e =>
                        setSlack(s => ({ ...s, events: { ...s.events, [key]: e.target.checked } }))
                      }
                      style={{ marginRight: 8 }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingSlack} onClick={handleSaveSlack}>
                Save Configuration
              </Button>
              <Button variant="secondary" loading={testingSlack} onClick={handleTestSlack}>
                Test Connection
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {tab === 'discord' && (
        <Card>
          <CardHeader title="Discord Integration" />
          <CardBody>
            <p className={styles.description}>
              Send incident and alert notifications to a Discord channel via an Incoming Webhook.
            </p>

            <div className={styles.field}>
              <label className={styles.label}>
                <input
                  type="checkbox"
                  checked={discord.enabled}
                  onChange={e => setDiscord(s => ({ ...s, enabled: e.target.checked }))}
                  style={{ marginRight: 8 }}
                />
                Enable Discord notifications
              </label>
            </div>

            <FormField
              label="Webhook URL"
              value={discord.webhookUrl}
              onChange={v => setDiscord(s => ({ ...s, webhookUrl: v }))}
              placeholder="https://discord.com/api/webhooks/..."
              type="password"
            />
            <FormField
              label="Channel Name"
              value={discord.channelName}
              onChange={v => setDiscord(s => ({ ...s, channelName: v }))}
              placeholder="#incidents"
            />

            <div className={styles.field}>
              <label className={styles.label}>Notify on Events</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(
                  [
                    ['incidentCreated',  'Incident Created'],
                    ['incidentResolved', 'Incident Resolved'],
                    ['alertFired',       'Alert Fired'],
                    ['agentError',       'Agent Error'],
                    ['taskCompleted',    'Task Completed'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className={styles.radioLabel}>
                    <input
                      type="checkbox"
                      checked={discord.events[key]}
                      onChange={e =>
                        setDiscord(s => ({ ...s, events: { ...s.events, [key]: e.target.checked } }))
                      }
                      style={{ marginRight: 8 }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.buttonRow}>
              <Button variant="primary" loading={savingDiscord} onClick={handleSaveDiscord}>
                Save Configuration
              </Button>
              <Button variant="secondary" loading={testingDiscord} onClick={handleTestDiscord}>
                Test Connection
              </Button>
            </div>
          </CardBody>
        </Card>
      )}
    </Layout>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`${styles.tab}${active ? ` ${styles.tabActive}` : ''}`}
    >
      {children}
    </button>
  )
}

function FormField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} className={styles.input} />
    </div>
  )
}

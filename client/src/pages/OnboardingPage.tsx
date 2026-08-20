// OnboardingPage — 5-step wizard for a freshly-registered tenant.
//
// State lives server-side (tenant.settings.onboarding) so the wizard
// can resume across logins and devices. Each step calls
// POST /api/onboarding/step/:step with the panel's data; the server
// advances the cursor + returns the new status. We always derive the
// rendered step from the server-returned status, never trust local
// state across reloads.
//
// Skipping: every step (except step 1 "welcome", which captures the
// org name) can be skipped — the cursor still advances. When the user
// hits "Done" on step 5, we POST step=done to flip the completed flag
// and redirect to /incidents.

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'

type StepName = 'welcome' | 'servers' | 'sla' | 'team' | 'done'

interface OnboardingStatus {
  tenantId: string
  state: {
    completed: boolean
    currentStep: number
    completedAt?: string
    steps?: {
      welcome?: { orgName?: string; timezone?: string }
      servers?: { count?: number }
      sla?:     { preset?: 'startup' | 'standard' | 'enterprise' | 'custom' }
      team?:    { invitesSent?: number }
    }
  }
  nextStep: StepName
}

const STEPS: Array<{ name: StepName; title: string; description: string }> = [
  { name: 'welcome', title: 'Welcome to RightAPI Forge', description: "Let's get your tenant set up." },
  { name: 'servers', title: 'Add Your Servers',  description: 'Hosts you want RightAPI Forge to monitor.' },
  { name: 'sla',     title: 'Configure SLA',     description: 'Response + resolution targets.' },
  { name: 'team',    title: 'Invite Your Team',  description: 'Add teammates by email.' },
  { name: 'done',    title: "You're All Set",    description: 'Review and finish.' },
]

export default function OnboardingPage() {
  const { show } = useToast()
  const navigate = useNavigate()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Panel-local state — gets POSTed on Next.
  const [orgName, setOrgName] = useState('')
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [serverHost, setServerHost] = useState('')
  const [serverName, setServerName] = useState('')
  const [serverCount, setServerCount] = useState(0)
  const [slaPreset, setSlaPreset] = useState<'startup' | 'standard' | 'enterprise' | 'custom'>('standard')
  const [inviteEmails, setInviteEmails] = useState('')
  const [invitesSent, setInvitesSent] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const s = await api.get<OnboardingStatus>('/api/onboarding/status')
      setStatus(s)
      if (s.state?.steps?.welcome?.orgName)   setOrgName(s.state.steps.welcome.orgName)
      if (s.state?.steps?.welcome?.timezone)  setTimezone(s.state.steps.welcome.timezone)
      if (s.state?.steps?.servers?.count !== undefined) setServerCount(s.state.steps.servers.count)
      if (s.state?.steps?.sla?.preset)        setSlaPreset(s.state.steps.sla.preset as any)
      if (s.state?.steps?.team?.invitesSent !== undefined) setInvitesSent(s.state.steps.team.invitesSent)
      if (s.state?.completed) {
        // Already done — bounce to the main dashboard.
        navigate('/incidents', { replace: true })
      }
    } catch (err) {
      show(`Failed to load onboarding state: ${(err as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [navigate, show])

  useEffect(() => { void refresh() }, [refresh])

  const saveStep = useCallback(async (step: StepName, payload: Record<string, unknown>) => {
    setBusy(true)
    try {
      const s = await api.post<OnboardingStatus>(`/api/onboarding/step/${step}`, payload)
      setStatus(s)
      if (step === 'done') {
        show('All set! Welcome to RightAPI Forge.', 'success')
        navigate('/incidents', { replace: true })
      }
    } catch (err) {
      show(`Save failed: ${(err as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }, [navigate, show])

  if (loading) {
    return <Layout title="Onboarding"><div style={{ padding: 24 }}>Loading…</div></Layout>
  }

  const currentStepIdx = Math.max(0, Math.min(STEPS.length - 1, (status?.state.currentStep ?? 1) - 1))
  const step = STEPS[currentStepIdx]

  return (
    <Layout title="Onboarding" subtitle={step.description}>
      {/* Progress strip */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {STEPS.map((s, idx) => {
          const isDone = idx < currentStepIdx
          const isCurrent = idx === currentStepIdx
          return (
            <div key={s.name} style={{
              padding: '6px 10px',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              background: isCurrent ? 'var(--accent)' : isDone ? 'var(--success-bg)' : 'var(--bg2)',
              color: isCurrent ? '#fff' : 'var(--text)',
              fontSize: 12, fontWeight: isCurrent ? 600 : 400,
            }}>
              {idx + 1}. {s.title}
            </div>
          )
        })}
      </div>

      <Card>
        <CardHeader title={step.title} actions={<Badge variant="info">Step {currentStepIdx + 1} of {STEPS.length}</Badge>} />
        <CardBody>
          {step.name === 'welcome' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Organisation name</span>
                <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Corp"
                  style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Timezone</span>
                <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Los_Angeles"
                  style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }} />
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>Auto-detected from your browser.</span>
              </label>
              <div style={{ marginTop: 6 }}>
                <Button onClick={() => saveStep('welcome', { orgName, timezone })} loading={busy} disabled={orgName.trim().length < 2}>
                  Save &amp; continue
                </Button>
              </div>
            </div>
          )}

          {step.name === 'servers' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 14 }}>
                Add servers RightAPI Forge should monitor. You can skip this and add servers later from the Servers page.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>Name (display)</span>
                  <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="web-01"
                    style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>SSH host (host:port)</span>
                  <input value={serverHost} onChange={(e) => setServerHost(e.target.value)} placeholder="10.0.0.5"
                    style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14 }} />
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" loading={busy} onClick={async () => {
                  if (!serverName.trim() || !serverHost.trim()) {
                    show('Both name and host are required', 'error')
                    return
                  }
                  setBusy(true)
                  try {
                    await api.post('/api/servers', { name: serverName.trim(), host: serverHost.trim() })
                    setServerCount((c) => c + 1)
                    setServerName(''); setServerHost('')
                    show(`Added server "${serverName.trim()}"`, 'success')
                  } catch (err) {
                    show(`Failed to add server: ${(err as Error).message}`, 'error')
                  } finally {
                    setBusy(false)
                  }
                }}>Add server</Button>
                <span style={{ fontSize: 12, color: 'var(--text2)', alignSelf: 'center' }}>
                  {serverCount === 0 ? 'No servers added yet.' : `${serverCount} server${serverCount === 1 ? '' : 's'} added.`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <Button onClick={() => saveStep('servers', { count: serverCount, addedAt: new Date().toISOString() })} loading={busy}>
                  Continue
                </Button>
                <Button variant="ghost" onClick={() => saveStep('servers', { count: 0 })} loading={busy}>Skip</Button>
              </div>
            </div>
          )}

          {step.name === 'sla' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 14 }}>
                Pick a starting SLA preset. You can tune individual policies later on the SLA page.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                {[
                  { v: 'startup',    title: 'Startup',    sub: '4h response · 24h resolve' },
                  { v: 'standard',   title: 'Standard',   sub: '1h response · 8h resolve' },
                  { v: 'enterprise', title: 'Enterprise', sub: '15m response · 2h resolve' },
                  { v: 'custom',     title: 'Custom',     sub: 'Skip — configure later' },
                ].map((p) => (
                  <button key={p.v} onClick={() => setSlaPreset(p.v as any)} style={{
                    padding: 12, border: `2px solid ${slaPreset === p.v ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius)', textAlign: 'left',
                    background: 'var(--bg2)', cursor: 'pointer',
                  }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{p.sub}</div>
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button onClick={() => saveStep('sla', { preset: slaPreset })} loading={busy}>Save &amp; continue</Button>
                <Button variant="ghost" onClick={() => saveStep('sla', { preset: 'custom' })} loading={busy}>Skip</Button>
              </div>
            </div>
          )}

          {step.name === 'team' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 14 }}>
                Invite teammates by email. Paste one per line. Invited users join as <Badge variant="info">operator</Badge>.
              </div>
              <textarea value={inviteEmails} onChange={(e) => setInviteEmails(e.target.value)} rows={5}
                placeholder={'alice@acme.io\nbob@acme.io'}
                style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" loading={busy} onClick={async () => {
                  const emails = inviteEmails.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
                  if (emails.length === 0) {
                    show('No emails entered', 'error')
                    return
                  }
                  setBusy(true)
                  let sent = 0
                  for (const email of emails) {
                    try {
                      await api.post('/api/auth/invite', { email, role: 'operator' })
                      sent++
                    } catch (err) {
                      show(`Failed to invite ${email}: ${(err as Error).message}`, 'error')
                    }
                  }
                  setInvitesSent(sent)
                  if (sent > 0) show(`Sent ${sent} invite${sent === 1 ? '' : 's'}`, 'success')
                  setBusy(false)
                }}>Send invites</Button>
                <span style={{ fontSize: 12, color: 'var(--text2)', alignSelf: 'center' }}>
                  {invitesSent === 0 ? 'None sent yet.' : `${invitesSent} invite${invitesSent === 1 ? '' : 's'} sent.`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <Button onClick={() => saveStep('team', { invitesSent })} loading={busy}>Continue</Button>
                <Button variant="ghost" onClick={() => saveStep('team', { invitesSent: 0 })} loading={busy}>Skip</Button>
              </div>
            </div>
          )}

          {step.name === 'done' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 14 }}>
                You're all set. Here's a quick summary:
              </div>
              <ul style={{ marginLeft: 18, fontSize: 13, color: 'var(--text2)', lineHeight: 1.7 }}>
                <li>Organisation: <strong>{status?.state.steps?.welcome?.orgName ?? '(not set)'}</strong></li>
                <li>Timezone: <code>{status?.state.steps?.welcome?.timezone ?? '(not set)'}</code></li>
                <li>Servers added: {status?.state.steps?.servers?.count ?? 0}</li>
                <li>SLA preset: {status?.state.steps?.sla?.preset ?? 'custom'}</li>
                <li>Team invites sent: {status?.state.steps?.team?.invitesSent ?? 0}</li>
              </ul>
              <div>
                <Button onClick={() => saveStep('done', {})} loading={busy}>Take me to the dashboard</Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </Layout>
  )
}

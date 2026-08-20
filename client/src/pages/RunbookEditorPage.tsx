import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronUp, ChevronDown, Trash2, Plus, ShieldAlert } from 'lucide-react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { Card, CardHeader, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../hooks/useToast'
import styles from './RunbookEditorPage.module.css'

// ── Types — mirror server-side RunbookTypes ──────────────────────────

type StepType =
  | 'command' | 'check_metric' | 'wait' | 'notification'
  | 'escalate' | 'resolve' | 'condition' | 'approval' | 'action'

interface Step {
  id: string
  type: StepType
  description: string
  requiresApproval?: boolean
  onSuccess?: string
  onFailure?: string
  // type-specific fields, kept loose so we don't fight the schema during edits
  [k: string]: unknown
}

type TriggerType = 'manual' | 'incident_match' | 'metric_threshold'

interface RunbookTemplate {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  enabled?: boolean
  triggerType?: TriggerType
  triggerConfig?: Record<string, unknown>
  steps: Step[]
  createdAt?: string
  updatedAt?: string
}

const STEP_TYPES: { value: StepType; label: string; hint: string }[] = [
  { value: 'command',      label: 'Command',       hint: 'Run a shell command on a server' },
  { value: 'check_metric', label: 'Check metric',  hint: 'Compare CPU/memory/disk against a threshold' },
  { value: 'wait',         label: 'Wait',          hint: 'Pause execution for N seconds' },
  { value: 'notification', label: 'Notify',        hint: 'Send a chat/Slack/etc. alert' },
  { value: 'escalate',     label: 'Escalate',      hint: 'Bump incident severity (needs incident context)' },
  { value: 'resolve',      label: 'Resolve',       hint: 'Resolve the incident (needs incident context)' },
  { value: 'condition',    label: 'Condition',     hint: 'Branch on last exit code / output / metric' },
  { value: 'approval',     label: 'Approval gate', hint: 'Wait for an operator to greenlight' },
  { value: 'action',       label: 'Skill action',  hint: 'Invoke a registered skill (advanced)' },
]

const METRICS = ['cpu', 'memory', 'disk', 'load1', 'load5'] as const
const COMPARES = ['<', '>', '<=', '>=', '=='] as const
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

function blankStep(type: StepType): Step {
  const id = 's' + Math.random().toString(36).slice(2, 6)
  const base: Step = { id, type, description: '' }
  switch (type) {
    case 'command':      return { ...base, description: 'Run command', serverId: 'local', command: '', timeoutMs: 30000 }
    case 'check_metric': return { ...base, description: 'Check metric', metric: 'disk', serverId: 'local', operator: '<', threshold: 85 }
    case 'wait':         return { ...base, description: 'Wait', seconds: 10 }
    case 'notification': return { ...base, description: 'Notify', command: 'alert.send', params: { message: '', severity: 'info' } }
    case 'escalate':     return { ...base, description: 'Escalate', reason: '' }
    case 'resolve':      return { ...base, description: 'Resolve', resolution: '' }
    case 'condition':    return { ...base, description: 'Branch', check: 'last_exit_code', operator: '==', value: 0, onTrue: 'end', onFalse: 'end' }
    case 'approval':     return { ...base, description: 'Approval required', message: '' }
    case 'action':       return { ...base, description: 'Action', command: '', params: {} }
  }
}

// ── Component ────────────────────────────────────────────────────────

export default function RunbookEditorPage() {
  const { id: routeId } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { show } = useToast()

  const isNew = !routeId || routeId === 'new'
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [template, setTemplate] = useState<RunbookTemplate>({
    id: '', name: '', description: '', category: 'custom', tags: [], enabled: true,
    triggerType: 'manual', triggerConfig: {}, steps: [],
  })

  // Admin-only: redirect viewer/operator on mount.
  useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate('/runbooks', { replace: true })
    }
  }, [user, navigate])

  // Load template if editing existing one.
  useEffect(() => {
    if (isNew) return
    setLoading(true)
    api.get<{ template: RunbookTemplate }>(`/api/runbooks/templates/${routeId}`)
      .then(({ template: t }) => {
        setTemplate({
          ...t,
          triggerType: t.triggerType ?? 'manual',
          triggerConfig: t.triggerConfig ?? {},
          enabled: t.enabled !== false,
        })
      })
      .catch(err => show(err instanceof Error ? err.message : 'Failed to load runbook', 'error'))
      .finally(() => setLoading(false))
  }, [routeId, isNew, show])

  const stepIdOptions = useMemo<{ value: string; label: string }[]>(
    () => [{ value: '', label: '— next in order —' }, ...template.steps.map(s => ({ value: s.id, label: `${s.id} (${s.type})` })), { value: 'end', label: 'end (terminate run)' }],
    [template.steps],
  )

  // ── Mutations ─────────────────────────────────────────────────────────

  const setField = <K extends keyof RunbookTemplate>(k: K, v: RunbookTemplate[K]) =>
    setTemplate(t => ({ ...t, [k]: v }))

  const setTriggerConfigField = (k: string, v: unknown) =>
    setTemplate(t => ({ ...t, triggerConfig: { ...(t.triggerConfig ?? {}), [k]: v } }))

  const setStepField = (idx: number, k: string, v: unknown) =>
    setTemplate(t => {
      const steps = t.steps.slice()
      steps[idx] = { ...steps[idx], [k]: v }
      return { ...t, steps }
    })

  const addStep = (type: StepType) =>
    setTemplate(t => ({ ...t, steps: [...t.steps, blankStep(type)] }))

  const removeStep = (idx: number) =>
    setTemplate(t => ({ ...t, steps: t.steps.filter((_, i) => i !== idx) }))

  const moveStep = (idx: number, delta: -1 | 1) =>
    setTemplate(t => {
      const steps = t.steps.slice()
      const target = idx + delta
      if (target < 0 || target >= steps.length) return t
      ;[steps[idx], steps[target]] = [steps[target], steps[idx]]
      return { ...t, steps }
    })

  const save = async () => {
    if (!template.name.trim()) { show('Name is required', 'error'); return }
    if (template.steps.length === 0) { show('At least one step is required', 'error'); return }
    setSaving(true)
    try {
      if (isNew) {
        const slug = template.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        const id = template.id || slug || `rb-${Date.now()}`
        await api.post('/api/runbooks/templates', {
          id, name: template.name.trim(), description: template.description.trim() || '',
          category: template.category || 'custom', tags: template.tags ?? [],
          steps: template.steps, triggerType: template.triggerType ?? 'manual',
          triggerConfig: template.triggerConfig ?? {}, enabled: template.enabled !== false,
        })
        show('Runbook created', 'success')
      } else {
        await api.patch(`/api/runbooks/templates/${routeId}`, {
          name: template.name.trim(), description: template.description.trim() || '',
          category: template.category, tags: template.tags ?? [],
          steps: template.steps, triggerType: template.triggerType,
          triggerConfig: template.triggerConfig, enabled: template.enabled,
        })
        show('Runbook saved', 'success')
      }
      navigate('/runbooks')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (loading) {
    return <Layout title="Runbook Editor"><div className={styles.empty}>Loading…</div></Layout>
  }

  const tc = (template.triggerConfig ?? {}) as Record<string, any>

  return (
    <Layout
      title={isNew ? 'New Runbook' : `Editing: ${template.name || routeId}`}
      subtitle="Compose a sequence of steps. Destructive commands auto-prompt for approval at runtime."
      actions={
        <div className={styles.actionsRow}>
          <Button variant="ghost" onClick={() => navigate('/runbooks')}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>{isNew ? 'Create' : 'Save changes'}</Button>
        </div>
      }
    >
      <Card>
        <CardHeader title="Basics" />
        <CardBody>
          <div className={styles.formGrid}>
            <Field label="Name">
              <input className={styles.input} value={template.name} onChange={e => setField('name', e.target.value)} placeholder="Disk Cleanup"/>
            </Field>
            <Field label="Category">
              <input className={styles.input} value={template.category} onChange={e => setField('category', e.target.value)} placeholder="monitoring"/>
            </Field>
            <Field label="Description" full>
              <textarea className={styles.textarea} value={template.description} onChange={e => setField('description', e.target.value)} placeholder="What this runbook does and when it fires."/>
            </Field>
            <Field label="Enabled">
              <label className={styles.toggle}>
                <input type="checkbox" checked={template.enabled !== false} onChange={e => setField('enabled', e.target.checked)}/>
                <span>{template.enabled !== false ? 'on' : 'off'}</span>
              </label>
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Trigger" subtitle="Optional: auto-fire this runbook on incidents or metrics" />
        <CardBody>
          <div className={styles.formGrid}>
            <Field label="Trigger type">
              <select className={styles.input} value={template.triggerType ?? 'manual'} onChange={e => setField('triggerType', e.target.value as TriggerType)}>
                <option value="manual">Manual only</option>
                <option value="incident_match">When an incident matches…</option>
                <option value="metric_threshold">When a metric crosses a threshold…</option>
              </select>
            </Field>
            {template.triggerType === 'incident_match' && <>
              <Field label="sourceRef LIKE (e.g. disk:%)">
                <input className={styles.input} value={tc.sourceRef ?? ''} onChange={e => setTriggerConfigField('sourceRef', e.target.value || undefined)} placeholder="disk:%"/>
              </Field>
              <Field label="title LIKE (optional)">
                <input className={styles.input} value={tc.title ?? ''} onChange={e => setTriggerConfigField('title', e.target.value || undefined)} placeholder="%cpu%"/>
              </Field>
              <Field label="min severity">
                <select className={styles.input} value={tc.severity ?? ''} onChange={e => setTriggerConfigField('severity', e.target.value || undefined)}>
                  <option value="">— any —</option>
                  {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="serverId (optional, exact)">
                <input className={styles.input} value={tc.serverId ?? ''} onChange={e => setTriggerConfigField('serverId', e.target.value || undefined)} placeholder="web01"/>
              </Field>
            </>}
            {template.triggerType === 'metric_threshold' && <>
              <Field label="metric">
                <select className={styles.input} value={tc.metric ?? 'disk'} onChange={e => setTriggerConfigField('metric', e.target.value)}>
                  {METRICS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="operator">
                <select className={styles.input} value={tc.operator ?? '>'} onChange={e => setTriggerConfigField('operator', e.target.value)}>
                  {COMPARES.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="threshold (%)">
                <input className={styles.input} type="number" value={tc.threshold ?? 90} onChange={e => setTriggerConfigField('threshold', Number(e.target.value))}/>
              </Field>
              <Field label="serverId (optional)">
                <input className={styles.input} value={tc.serverId ?? ''} onChange={e => setTriggerConfigField('serverId', e.target.value || undefined)} placeholder="web01 — leave blank for all"/>
              </Field>
              <Field label="cooldown seconds">
                <input className={styles.input} type="number" value={tc.cooldownSeconds ?? 300} onChange={e => setTriggerConfigField('cooldownSeconds', Number(e.target.value))}/>
              </Field>
            </>}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Steps"
          actions={
            <select className={styles.addSelect} value="" onChange={e => { if (e.target.value) addStep(e.target.value as StepType) }}>
              <option value="">+ Add step…</option>
              {STEP_TYPES.map(s => <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>)}
            </select>
          }
        />
        <CardBody>
          {template.steps.length === 0 ? (
            <div className={styles.empty}>No steps yet. Add one above.</div>
          ) : (
            <div className={styles.stepList}>
              {template.steps.map((step, idx) => (
                <StepCard
                  key={step.id + idx}
                  step={step}
                  idx={idx}
                  total={template.steps.length}
                  stepIdOptions={stepIdOptions}
                  onChange={(k, v) => setStepField(idx, k, v)}
                  onRemove={() => removeStep(idx)}
                  onMove={delta => moveStep(idx, delta)}
                />
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </Layout>
  )
}

// ── Step card ────────────────────────────────────────────────────────

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? styles.fieldFull : styles.field}>
      <label className={styles.label}>{label}</label>
      {children}
    </div>
  )
}

interface StepCardProps {
  step: Step
  idx: number
  total: number
  stepIdOptions: { value: string; label: string }[]
  onChange: (key: string, value: unknown) => void
  onRemove: () => void
  onMove: (delta: -1 | 1) => void
}

function StepCard({ step, idx, total, stepIdOptions, onChange, onRemove, onMove }: StepCardProps) {
  const typeLabel = STEP_TYPES.find(s => s.value === step.type)?.label ?? step.type
  return (
    <div className={styles.stepCard}>
      <div className={styles.stepHead}>
        <div className={styles.stepIndex}>{idx + 1}</div>
        <div className={styles.stepType}>{typeLabel}</div>
        <div className={styles.stepId}>{step.id}</div>
        <div className={styles.stepCtrls}>
          <button type="button" className={styles.iconBtn} disabled={idx === 0} onClick={() => onMove(-1)} aria-label="Move up"><ChevronUp size={14}/></button>
          <button type="button" className={styles.iconBtn} disabled={idx === total - 1} onClick={() => onMove(1)} aria-label="Move down"><ChevronDown size={14}/></button>
          <button type="button" className={styles.iconBtnDanger} onClick={onRemove} aria-label="Remove"><Trash2 size={14}/></button>
        </div>
      </div>
      <div className={styles.stepBody}>
        <Field label="Description" full>
          <input className={styles.input} value={step.description} onChange={e => onChange('description', e.target.value)}/>
        </Field>
        {/* Type-specific fields */}
        {step.type === 'command' && <>
          <Field label="serverId">
            <input className={styles.input} value={String(step.serverId ?? '')} onChange={e => onChange('serverId', e.target.value)} placeholder="local"/>
          </Field>
          <Field label="timeout (ms)">
            <input className={styles.input} type="number" value={Number(step.timeoutMs ?? 30000)} onChange={e => onChange('timeoutMs', Number(e.target.value))}/>
          </Field>
          <Field label="command" full>
            <textarea className={styles.textarea} value={String(step.command ?? '')} onChange={e => onChange('command', e.target.value)} placeholder="df -h | head -20"/>
            <DestructiveHint command={String(step.command ?? '')}/>
          </Field>
        </>}
        {step.type === 'check_metric' && <>
          <Field label="metric">
            <select className={styles.input} value={String(step.metric ?? 'disk')} onChange={e => onChange('metric', e.target.value)}>
              {METRICS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="serverId">
            <input className={styles.input} value={String(step.serverId ?? 'local')} onChange={e => onChange('serverId', e.target.value)}/>
          </Field>
          <Field label="operator">
            <select className={styles.input} value={String(step.operator ?? '<')} onChange={e => onChange('operator', e.target.value)}>
              {COMPARES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="threshold">
            <input className={styles.input} type="number" value={Number(step.threshold ?? 85)} onChange={e => onChange('threshold', Number(e.target.value))}/>
          </Field>
        </>}
        {step.type === 'wait' && (
          <Field label="seconds">
            <input className={styles.input} type="number" value={Number(step.seconds ?? 10)} onChange={e => onChange('seconds', Number(e.target.value))}/>
          </Field>
        )}
        {step.type === 'notification' && <>
          <Field label="skill command">
            <input className={styles.input} value={String(step.command ?? '')} onChange={e => onChange('command', e.target.value)} placeholder="alert.send"/>
          </Field>
          <Field label="message" full>
            <input className={styles.input} value={String((step.params as any)?.message ?? '')} onChange={e => onChange('params', { ...((step.params as any) ?? {}), message: e.target.value })}/>
          </Field>
          <Field label="severity">
            <select className={styles.input} value={String((step.params as any)?.severity ?? 'info')} onChange={e => onChange('params', { ...((step.params as any) ?? {}), severity: e.target.value })}>
              <option>info</option><option>warning</option><option>critical</option>
            </select>
          </Field>
        </>}
        {step.type === 'escalate' && (
          <Field label="reason" full>
            <input className={styles.input} value={String(step.reason ?? '')} onChange={e => onChange('reason', e.target.value)}/>
          </Field>
        )}
        {step.type === 'resolve' && (
          <Field label="resolution" full>
            <input className={styles.input} value={String(step.resolution ?? '')} onChange={e => onChange('resolution', e.target.value)}/>
          </Field>
        )}
        {step.type === 'condition' && <>
          <Field label="check">
            <select className={styles.input} value={String(step.check ?? 'last_exit_code')} onChange={e => onChange('check', e.target.value)}>
              <option value="last_exit_code">last exit code</option>
              <option value="last_output_contains">last output contains</option>
              <option value="metric_value">last metric value</option>
            </select>
          </Field>
          <Field label="operator">
            <select className={styles.input} value={String(step.operator ?? '==')} onChange={e => onChange('operator', e.target.value)}>
              {COMPARES.map(o => <option key={o} value={o}>{o}</option>)}
              <option value="!=">!=</option>
            </select>
          </Field>
          <Field label="value">
            <input className={styles.input} value={String(step.value ?? '')} onChange={e => onChange('value', e.target.value)}/>
          </Field>
          <Field label="then step (onTrue)">
            <StepSelect value={String(step.onTrue ?? '')} options={stepIdOptions} onChange={v => onChange('onTrue', v)}/>
          </Field>
          <Field label="else step (onFalse)">
            <StepSelect value={String(step.onFalse ?? '')} options={stepIdOptions} onChange={v => onChange('onFalse', v)}/>
          </Field>
        </>}
        {step.type === 'approval' && (
          <Field label="message to approver" full>
            <input className={styles.input} value={String(step.message ?? '')} onChange={e => onChange('message', e.target.value)} placeholder="Approve restart? This will cause a brief outage."/>
          </Field>
        )}
        {step.type === 'action' && <>
          <Field label="skill command">
            <input className={styles.input} value={String(step.command ?? '')} onChange={e => onChange('command', e.target.value)} placeholder="bash.exec / monitor.cpu / …"/>
          </Field>
          <Field label="params JSON" full>
            <textarea className={styles.textarea} value={JSON.stringify(step.params ?? {}, null, 2)} onChange={e => {
              try { onChange('params', JSON.parse(e.target.value || '{}')) } catch { /* allow invalid mid-typing */ }
            }}/>
          </Field>
        </>}
        {/* Common controls */}
        {step.type !== 'condition' && <>
          <Field label="on success → step">
            <StepSelect value={String(step.onSuccess ?? '')} options={stepIdOptions} onChange={v => onChange('onSuccess', v || undefined)}/>
          </Field>
          <Field label="on failure → step">
            <StepSelect value={String(step.onFailure ?? '')} options={stepIdOptions} onChange={v => onChange('onFailure', v || undefined)}/>
          </Field>
        </>}
        {step.type !== 'approval' && step.type !== 'condition' && (
          <Field label="requires approval">
            <label className={styles.toggle}>
              <input type="checkbox" checked={!!step.requiresApproval} onChange={e => onChange('requiresApproval', e.target.checked)}/>
              <span>{step.requiresApproval ? 'on' : 'off'}</span>
            </label>
          </Field>
        )}
      </div>
    </div>
  )
}

function StepSelect({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select className={styles.input} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}

const DESTRUCTIVE_HINTS = /\b(rm\s+-[a-z]*r[a-z]*f|mkfs|dd\s+if=|shutdown|reboot|systemctl\s+disable|iptables\s+-F|ufw\s+disable)\b|>\s*\/(etc|var)|rm\s+(-[a-z]+\s+)?\/(etc|var)\//i

function DestructiveHint({ command }: { command: string }) {
  if (!command || !DESTRUCTIVE_HINTS.test(command)) return null
  return (
    <div className={styles.destructive}>
      <ShieldAlert size={14} />
      <span>This command will trigger the destructive-pattern guard at runtime — execution pauses for approval regardless of the toggle below.</span>
    </div>
  )
}

void Plus // referenced by future-add-step UX; keep import warm

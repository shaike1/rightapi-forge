import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CheckCircle2, XCircle, Loader2, AlertCircle, Clock, ShieldAlert, Hourglass } from 'lucide-react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import { Card, CardHeader, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useWebSocket } from '../hooks/useWebSocket'
import { useToast } from '../hooks/useToast'
import styles from './RunbookRunPage.module.css'

type RunStatus = 'running' | 'completed' | 'failed' | 'waiting_approval' | 'cancelled' | 'rejected' | 'timeout'
type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'waiting_approval' | 'rejected'

interface StepResult {
  stepId: string
  stepIndex: number
  type: string
  description: string
  status: StepStatus
  startedAt?: string
  completedAt?: string
  output?: string
  error?: string
  retryCount?: number
  approvedBy?: string
  rejectedBy?: string
  exitCode?: number
}

interface Run {
  id: string
  templateId: string
  templateName: string
  triggeredBy: string
  status: RunStatus
  currentStepIndex: number
  stepResults: StepResult[]
  context?: { incidentId?: string; serverId?: string; user?: string }
  startedAt: string
  completedAt?: string
  error?: string
}

interface Approval {
  id: string
  runId: string
  stepId: string
  stepDescription: string
  reason: string
  requestedBy: string
  requestedAt: string
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  decidedBy?: string
  decidedAt?: string
  decisionReason?: string
}

const RUN_STATUS_VARIANT: Record<RunStatus, 'info' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  running: 'info',
  waiting_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  rejected: 'danger',
  timeout: 'danger',
}

function statusIcon(s: StepStatus) {
  switch (s) {
    case 'success':          return <CheckCircle2 size={16} className={styles.iconOk}/>
    case 'failed':           return <XCircle size={16} className={styles.iconBad}/>
    case 'rejected':         return <XCircle size={16} className={styles.iconBad}/>
    case 'running':          return <Loader2 size={16} className={styles.spin}/>
    case 'waiting_approval': return <Hourglass size={16} className={styles.iconWarn}/>
    case 'skipped':          return <AlertCircle size={16} className={styles.iconDim}/>
    default:                 return <Clock size={16} className={styles.iconDim}/>
  }
}

function durationMs(start?: string, end?: string): string {
  if (!start) return '—'
  const s = new Date(start).getTime()
  const e = end ? new Date(end).getTime() : Date.now()
  const ms = Math.max(0, e - s)
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${Math.floor(sec - min * 60)}s`
}

export default function RunbookRunPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { lastEvent } = useWebSocket()
  const { show } = useToast()

  const [run, setRun] = useState<Run | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [deciding, setDeciding] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  // Only admin can approve/reject (matches the server-side gate on approvals.manage).
  const canDecide = user?.role === 'admin'

  const fetchRun = useCallback(async () => {
    if (!id) return
    try {
      const data = await api.get<{ run: Run; approvals?: Approval[] }>(`/api/runbooks/runs/${id}`)
      setRun(data.run)
      setApprovals(Array.isArray(data.approvals) ? data.approvals : [])
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load run', 'error')
    } finally {
      setLoading(false)
    }
  }, [id, show])

  useEffect(() => { fetchRun() }, [fetchRun])

  // Live updates via WebSocket — every runbook_* / approval:* event for our
  // run triggers a refetch. Refetch (rather than patch in place) keeps the
  // UI honest with the server view, even across reconnects.
  useEffect(() => {
    if (!lastEvent) return
    const evt = lastEvent as { type?: string; data?: any }
    const interesting = ['runbook_started', 'runbook_step_start', 'runbook_step_complete', 'runbook_step_approved', 'runbook_step_rejected', 'runbook_waiting_approval', 'runbook_completed', 'runbook_failed', 'runbook_rejected', 'runbook_cancelled', 'approval:request']
    if (!interesting.includes(String(evt.type))) return
    const runId = evt.data?.runId ?? evt.data?.run?.id ?? evt.data?.id
    if (!runId || runId !== id) return
    fetchRun()
  }, [lastEvent, id, fetchRun])

  const approve = async () => {
    if (!run) return
    setDeciding(true)
    try {
      await api.post(`/api/runbooks/runs/${run.id}/approve`, {})
      show('Step approved', 'success')
      fetchRun()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Approve failed', 'error')
    } finally { setDeciding(false) }
  }

  const reject = async () => {
    if (!run) return
    if (!rejectReason.trim()) { show('Reason is required to reject', 'warning'); return }
    setDeciding(true)
    try {
      await api.post(`/api/runbooks/runs/${run.id}/reject`, { reason: rejectReason.trim() })
      show('Step rejected', 'success')
      setRejectReason('')
      fetchRun()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Reject failed', 'error')
    } finally { setDeciding(false) }
  }

  if (loading) return <Layout title="Runbook Run"><div className={styles.empty}>Loading…</div></Layout>
  if (!run) return <Layout title="Runbook Run"><div className={styles.empty}>Run not found.</div></Layout>

  const pendingApproval = approvals.find(a => a.status === 'pending')

  return (
    <Layout
      title={`${run.templateName}`}
      subtitle={`Run ${run.id}`}
      actions={
        <div className={styles.actionsRow}>
          <Button variant="ghost" onClick={() => navigate('/runbooks')}>← Back</Button>
          <Link to={`/runbooks/edit/${run.templateId}`} className={styles.ghostLink}>Edit template</Link>
        </div>
      }
    >
      <Card>
        <CardBody>
          <div className={styles.headerRow}>
            <div>
              <Badge variant={RUN_STATUS_VARIANT[run.status] ?? 'neutral'}>{run.status}</Badge>
              {run.context?.incidentId && (
                <Link to={`/incidents/${run.context.incidentId}`} className={styles.ctxLink}>
                  incident {run.context.incidentId}
                </Link>
              )}
              {run.context?.serverId && (
                <span className={styles.ctxLink}>server: {run.context.serverId}</span>
              )}
            </div>
            <div className={styles.headerMeta}>
              triggered by <strong>{run.triggeredBy}</strong> · started {new Date(run.startedAt).toLocaleString()} · {durationMs(run.startedAt, run.completedAt)}
            </div>
          </div>
          {run.error && <div className={styles.errorBanner}>{run.error}</div>}
        </CardBody>
      </Card>

      {pendingApproval && (
        <Card>
          <CardHeader title="⚠ Approval required" subtitle="A step is paused for operator review" />
          <CardBody>
            <div className={styles.approvalBody}>
              <div><strong>Step:</strong> {pendingApproval.stepDescription} ({pendingApproval.stepId})</div>
              <div><strong>Reason:</strong> {pendingApproval.reason}</div>
              <div><strong>Requested by:</strong> {pendingApproval.requestedBy} · {new Date(pendingApproval.requestedAt).toLocaleTimeString()}</div>
              {canDecide ? (
                <div className={styles.approvalControls}>
                  <Button variant="primary" loading={deciding} onClick={approve}>Approve</Button>
                  <input
                    className={styles.input}
                    placeholder="Reason (required to reject)"
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                  />
                  <Button variant="danger" loading={deciding} onClick={reject}>Reject</Button>
                </div>
              ) : (
                <div className={styles.approvalNote}>You need the admin role to approve or reject.</div>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Steps" />
        <CardBody>
          <ol className={styles.stepList}>
            {run.stepResults.map((step, idx) => (
              <li key={step.stepId + idx} className={styles.stepRow}>
                <div className={styles.stepStatus}>{statusIcon(step.status)}</div>
                <div className={styles.stepBody}>
                  <div className={styles.stepTitle}>
                    <span className={styles.stepNum}>#{idx + 1}</span>
                    <span className={styles.stepType}>{step.type}</span>
                    <span className={styles.stepDesc}>{step.description}</span>
                    <span className={styles.stepDuration}>{durationMs(step.startedAt, step.completedAt)}</span>
                  </div>
                  {step.output && <pre className={styles.stepOutput}>{step.output}</pre>}
                  {step.error && <pre className={styles.stepError}>{step.error}</pre>}
                  <div className={styles.stepMeta}>
                    {typeof step.exitCode === 'number' && <span>exit={step.exitCode}</span>}
                    {step.approvedBy && <span>approved by {step.approvedBy}</span>}
                    {step.rejectedBy && <span>rejected by {step.rejectedBy}</span>}
                    {step.retryCount && <span>retries: {step.retryCount}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </CardBody>
      </Card>

      {approvals.length > 0 && (
        <Card>
          <CardHeader title="Approval history" />
          <CardBody>
            <ul className={styles.approvalHistory}>
              {approvals.map(a => (
                <li key={a.id} className={styles.approvalHistoryRow}>
                  <Badge variant={
                    a.status === 'approved' ? 'success'
                    : a.status === 'rejected' ? 'danger'
                    : a.status === 'timeout' ? 'warning'
                    : 'info'
                  }>{a.status}</Badge>
                  <div>
                    <div className={styles.stepDesc}>{a.stepDescription} ({a.stepId})</div>
                    <div className={styles.approvalMeta}>
                      reason: {a.reason}
                      {a.decidedBy && ` · decided by ${a.decidedBy} ${new Date(a.decidedAt!).toLocaleTimeString()}`}
                      {a.decisionReason && ` · "${a.decisionReason}"`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </Layout>
  )
}

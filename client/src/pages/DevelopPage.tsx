// Develop — operator surface for the Self-Development SDK.
//
// Flow:
//   1. Operator types a feature description.
//   2. POST /api/sdk/develop (autoApprove=false) returns a plan: kind,
//      file list, scan findings, smoke tests.
//   3. Operator inspects the plan + scan findings, then clicks
//      "Approve & Build" → POST /api/sdk/develop with autoApprove=true.
//   4. Result panel shows the executed steps, sandbox test outcomes,
//      branch + (optionally) the deploy run id.
//
// The history panel polls GET /api/sdk/history every 5 s so operators
// can see prior plans (own + everyone else's, since the in-process
// ring buffer is shared).

import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import s from './DevelopPage.module.css'

type FeatureKind = 'skill' | 'workflow' | 'plugin'

interface FileChange {
  path: string
  contents: string
  mode: 'add' | 'overwrite'
}

interface SecurityFinding {
  severity: 'warn' | 'block'
  pattern: string
  message: string
  file?: string
  line?: number
  snippet?: string
}

interface PlanStepLog {
  step: string
  status: 'ok' | 'failed' | 'skipped'
  message?: string
  startedAt: string
  completedAt: string
}

interface TestCase {
  name: string
  command: string
  params?: Record<string, unknown>
  expect?: { ok?: boolean; summaryIncludes?: string }
}

interface TestResult {
  name: string
  passed: boolean
  duration_ms: number
  output?: string
  error?: string
}

interface FeaturePlan {
  id: string
  description: string
  kind: FeatureKind
  files: FileChange[]
  tests: TestCase[]
  scanFindings: SecurityFinding[]
  steps: PlanStepLog[]
  createdAt: string
}

interface DevelopResult {
  plan: FeaturePlan
  testResults: TestResult[]
  branch?: string
  workflowRunId?: number
}

interface HistoryRow {
  id: string
  at: string
  actor: string
  description: string
  kind: FeatureKind
  outcome: 'planned' | 'completed' | 'failed' | 'rejected'
  branch?: string
  workflowRunId?: number
  durationMs?: number
  files?: number
  testsPassed?: number
  testsFailed?: number
}

export default function DevelopPage() {
  const { show } = useToast()
  const [description, setDescription] = useState('')
  const [plan, setPlan] = useState<FeaturePlan | null>(null)
  const [result, setResult] = useState<DevelopResult | null>(null)
  const [planning, setPlanning] = useState(false)
  const [building, setBuilding] = useState(false)
  const [allowWarnings, setAllowWarnings] = useState(false)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openFile, setOpenFile] = useState<string | null>(null)

  // Poll history every 5 s.
  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        const r = await api.get<{ history: HistoryRow[] }>('/api/sdk/history')
        if (!cancelled) setHistory(Array.isArray(r?.history) ? r.history : [])
      } catch { /* keep prior history on transient errors */ }
    }
    tick()
    const id = window.setInterval(tick, 5000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [result])

  const scanFindings = Array.isArray(plan?.scanFindings) ? plan!.scanFindings : []
  const planFiles    = Array.isArray(plan?.files)        ? plan!.files        : []
  const planTests    = Array.isArray(plan?.tests)        ? plan!.tests        : []
  const planSteps    = Array.isArray(plan?.steps)        ? plan!.steps        : []
  const blocking = scanFindings.filter(f => f.severity === 'block').length
  const warning  = scanFindings.filter(f => f.severity === 'warn').length

  async function generatePlan() {
    if (!description.trim()) { show('Describe the feature first', 'error'); return }
    setPlanning(true); setError(null); setResult(null)
    try {
      const r = await api.post<DevelopResult>('/api/sdk/develop', { description })
      setPlan(r.plan)
    } catch (e) {
      setError((e as Error).message)
      setPlan(null)
    } finally { setPlanning(false) }
  }

  async function approveAndBuild(testOnly: boolean) {
    if (!description.trim()) return
    setBuilding(true); setError(null)
    try {
      const r = await api.post<DevelopResult>('/api/sdk/develop', {
        description,
        autoApprove: true,
        allowSecurityWarnings: allowWarnings,
        testOnly,
      })
      setPlan(r?.plan ?? null)
      setResult(r)
      const testResults = Array.isArray(r?.testResults) ? r.testResults : []
      const failed = testResults.filter(t => !t.passed).length
      show(
        testOnly
          ? `Tested ${testResults.length} case(s) — ${failed} failed`
          : `Built on ${r?.branch ?? '<branch?>'}` + (r?.workflowRunId ? `, deploy run ${r.workflowRunId}` : ''),
        failed === 0 ? 'success' : 'error',
      )
    } catch (e) {
      setError((e as Error).message)
      show('Build failed: ' + (e as Error).message, 'error')
    } finally { setBuilding(false) }
  }

  function reset() {
    setDescription(''); setPlan(null); setResult(null); setError(null); setOpenFile(null)
  }

  return (
    <Layout
      title="Develop"
      subtitle="Self-Development SDK — describe a skill or workflow, review the plan, then build it on a feature branch."
      actions={
        <Button variant="ghost" size="sm" onClick={reset} disabled={planning || building}>Reset</Button>
      }
    >
      <div className={s.shell}>

        {/* ── Left: input + plan ──────────────────────────────────── */}
        <div className={s.editor}>
          <div className={s.field}>
            <label>Feature description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={`Example:\nA skill that runs \`df -h {{mount}}\` and returns disk usage for one mount.`}
              rows={6}
              disabled={planning || building}
            />
            <div className={s.hint}>
              Wrap shell commands in <code>`backticks`</code>. Use{' '}
              <code>{'{{paramName}}'}</code> placeholders for parameters — they'll be
              shell-escaped automatically. Mention "workflow" to generate a JSON workflow
              instead of a skill.
            </div>
          </div>
          <div className={s.actions}>
            <Button variant="primary" onClick={generatePlan} loading={planning} disabled={building}>
              Generate plan
            </Button>
            <Button variant="success" onClick={() => approveAndBuild(true)} loading={building}
                    disabled={!plan || planning}
                    title="Write files + run sandbox tests, no commit">
              Test only
            </Button>
            <Button variant="success" onClick={() => approveAndBuild(false)} loading={building}
                    disabled={!plan || planning || (blocking > 0 && !allowWarnings)}
                    title={blocking > 0 && !allowWarnings ? 'Blocking findings prevent build' : 'Write + test + commit on a feature branch'}>
              Approve &amp; Build
            </Button>
            <label className={s.warningOverride}>
              <input type="checkbox" checked={allowWarnings} onChange={e => setAllowWarnings(e.target.checked)} />
              Allow security warnings
            </label>
          </div>

          {error && <div className={s.error}>{error}</div>}

          {plan && (
            <div className={s.plan}>
              <div className={s.planHeader}>
                <span className={s.planKind}>{plan.kind}</span>
                <span className={s.planId}>{plan.id}</span>
              </div>

              <div className={s.stats}>
                <div className={s.stat}><div className={s.statLabel}>Files</div><div className={s.statValue}>{planFiles.length}</div></div>
                <div className={s.stat}><div className={s.statLabel}>Tests</div><div className={s.statValue}>{planTests.length}</div></div>
                <div className={`${s.stat} ${blocking > 0 ? s.statDanger : ''}`}>
                  <div className={s.statLabel}>Blocks</div><div className={s.statValue}>{blocking}</div>
                </div>
                <div className={`${s.stat} ${warning > 0 ? s.statWarn : ''}`}>
                  <div className={s.statLabel}>Warnings</div><div className={s.statValue}>{warning}</div>
                </div>
              </div>

              {scanFindings.length > 0 && (
                <details className={s.section} open={blocking > 0}>
                  <summary>Security findings ({scanFindings.length})</summary>
                  <ul className={s.findings}>
                    {scanFindings.map((f, i) => (
                      <li key={i} className={f.severity === 'block' ? s.block : s.warn}>
                        <span className={s.pill}>{f.severity}</span>
                        <span className={s.findingPattern}>{f.pattern}</span>
                        <span className={s.findingFile}>{f.file}{f.line ? `:${f.line}` : ''}</span>
                        <div className={s.findingMessage}>{f.message}</div>
                        {f.snippet && <pre className={s.findingSnippet}>{f.snippet}</pre>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <details className={s.section} open>
                <summary>Generated files ({planFiles.length})</summary>
                <ul className={s.files}>
                  {planFiles.map(f => (
                    <li key={f.path}>
                      <button className={s.fileBtn} onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
                        <span className={s.fileMode}>{f.mode}</span>
                        <code>{f.path}</code>
                        <span className={s.fileSize}>{f.contents.length}b</span>
                      </button>
                      {openFile === f.path && <pre className={s.fileBody}>{f.contents}</pre>}
                    </li>
                  ))}
                </ul>
              </details>

              {planTests.length > 0 && (
                <details className={s.section}>
                  <summary>Smoke tests ({planTests.length})</summary>
                  <ul className={s.testList}>
                    {planTests.map(t => (
                      <li key={t.name}>
                        <code>{t.command}</code> · {t.name}
                        {t.params && <span className={s.testParams}>{JSON.stringify(t.params)}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {planSteps.length > 0 && (
                <details className={s.section} open>
                  <summary>Execution log ({planSteps.length})</summary>
                  <ol className={s.stepList}>
                    {planSteps.map((st, i) => (
                      <li key={i} className={s[`step_${st.status}`]}>
                        <span className={s.stepName}>{st.step}</span>
                        <span className={s.stepStatus}>{st.status}</span>
                        {st.message && <span className={s.stepMsg}>{st.message}</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}

              {Array.isArray(result?.testResults) && result.testResults.length > 0 && (
                <details className={s.section} open>
                  <summary>Sandbox test results ({result.testResults.length})</summary>
                  <ul className={s.resultList}>
                    {result.testResults.map((r, i) => (
                      <li key={i} className={r.passed ? s.testPass : s.testFail}>
                        <span className={s.testName}>{r.name}</span>
                        <span className={s.testDur}>{r.duration_ms}ms</span>
                        {r.error && <pre className={s.findingSnippet}>{r.error}</pre>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {result?.branch && (
                <div className={s.outcome}>
                  Committed on <code>{result.branch}</code>
                  {result.workflowRunId && <> · deploy run <code>{result.workflowRunId}</code></>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: history ──────────────────────────────────────── */}
        <aside className={s.history}>
          <div className={s.historyHeader}>History</div>
          {history.length === 0
            ? <div className={s.historyEmpty}>No development sessions yet.</div>
            : (
              <ul className={s.historyList}>
                {history.map(h => (
                  <li key={h.id + h.at} className={s[`hist_${h.outcome}`]}>
                    <div className={s.histRow1}>
                      <span className={s.histKind}>{h.kind}</span>
                      <span className={s.histOutcome}>{h.outcome}</span>
                      <span className={s.histAt}>{new Date(h.at).toLocaleTimeString()}</span>
                    </div>
                    <div className={s.histDesc}>{h.description}</div>
                    <div className={s.histRow2}>
                      <span>{h.actor}</span>
                      {typeof h.files === 'number' && <span>{h.files}f</span>}
                      {typeof h.testsPassed === 'number' && (
                        <span>{h.testsPassed}/{(h.testsPassed + (h.testsFailed ?? 0))}t</span>
                      )}
                      {h.branch && <span><code>{h.branch}</code></span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </aside>
      </div>
    </Layout>
  )
}

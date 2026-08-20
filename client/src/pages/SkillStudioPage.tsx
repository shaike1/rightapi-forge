// SkillStudio — read/edit skill metadata + try them out from the dashboard.
//
// Sources for the list pane:
//   GET /api/skills/summary    — every registered skill, with source
//                                classification (builtin / plugin /
//                                sandboxed / crystallized) + breaker
//                                state.
//   GET /api/crystallized-skills — pulled in for the lifecycle controls
//                                  + usage stats shown for crystallized
//                                  entries.
//
// The Monaco editor edits a "skill descriptor" — a JSON shape the
// backend exposes via /api/skills. There's no in-process source-code
// editing for built-in skills (those ship in the binary); editing is
// limited to metadata (name, description, tags, parameters). For
// crystallized skills, the editor shows the generated workflow body so
// an operator can review what the platform learned.
//
// Test runner sits at the bottom: pick a command from the selected
// skill, fill the params form (JSON textarea by default, or per-field
// inputs if the command exposes a parameters object on the descriptor),
// and POST /api/skills/execute.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Editor from '@monaco-editor/react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './SkillStudioPage.module.css'

interface SkillCommand {
  name: string
  description?: string
  handler: string
}

interface SkillSummary {
  id: string
  name: string
  description: string
  category: string
  enabled: boolean
  commands: SkillCommand[]
  source: 'builtin' | 'plugin' | 'sandboxed' | 'crystallized'
  circuitBreaker: { state: string; consecutiveFailures: number } | null
}

interface CrystallizedSkill {
  id: string
  name: string
  description: string
  status: 'draft' | 'approved' | 'active' | 'rejected'
  confidenceScore: number
  usageCount: number
  recentUsage: Array<{ at: string; outcome: 'success' | 'failed' }>
  generatedWorkflow: string
  tags: string[]
  parameters: Array<{ name: string; type: string; description?: string }>
}

type EditorTab = 'workflow' | 'metadata'

const NEW_SKILL_TEMPLATE = `// Crystallized skills are generated from agent resolutions.
// Editing skill source from the dashboard is read-only for built-in
// skills — modify their .ts source in src/skills/ to change behaviour.
//
// For crystallized skills, the body below is the generated WorkflowDef
// JSON; switch the right-pane controls to approve / promote / reject.
`

export default function SkillStudioPage() {
  const { show } = useToast()

  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [crystallized, setCrystallized] = useState<CrystallizedSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<EditorTab>('workflow')

  // Test runner state.
  const [runCommand, setRunCommand] = useState('')
  const [runParams, setRunParams] = useState('{}')
  const [runOutput, setRunOutput] = useState<{ ok: boolean; text: string } | null>(null)
  const [running, setRunning] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [summaryRes, crystallizedRes] = await Promise.all([
        api.get<{ skills: SkillSummary[] }>('/api/skills/summary'),
        api.get<{ skills: CrystallizedSkill[] }>('/api/crystallized-skills?limit=200').catch(() => ({ skills: [] })),
      ])
      setSkills(Array.isArray(summaryRes?.skills) ? summaryRes.skills : [])
      setCrystallized(Array.isArray(crystallizedRes?.skills) ? crystallizedRes.skills : [])
    } catch (err) {
      show(`Failed to load skills: ${(err as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [show])

  useEffect(() => { void refresh() }, [refresh])

  // Filter + group.
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = (s: SkillSummary) =>
      !q
      || s.id.toLowerCase().includes(q)
      || s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)
    const filtered = skills.filter(matches)
    return {
      builtin:      filtered.filter(s => s.source === 'builtin'),
      plugin:       filtered.filter(s => s.source === 'plugin'),
      sandboxed:    filtered.filter(s => s.source === 'sandboxed'),
      crystallized: filtered.filter(s => s.source === 'crystallized'),
    }
  }, [skills, search])

  const selected = useMemo(
    () => skills.find(s => s.id === selectedId) ?? null,
    [skills, selectedId],
  )
  const selectedCrystal = useMemo(
    () => selected ? crystallized.find(c => {
      // Crystallized records carry the workflow id as `id` on the
      // CrystallizedSkill row, but the skill registered under
      // SkillManager uses the workflow's id (also "crystal.<…>"). We
      // match by the inner workflow id.
      try {
        const wf = JSON.parse(c.generatedWorkflow)
        return wf?.id === selected.id
      } catch { return false }
    }) ?? null : null,
    [selected, crystallized],
  )

  // Editor body — workflow JSON for crystallized, or a placeholder for
  // built-ins / plugins (the source code isn't editable from here).
  const editorValue = useMemo(() => {
    if (!selected) return ''
    if (selectedCrystal) {
      try {
        const wf = JSON.parse(selectedCrystal.generatedWorkflow)
        return JSON.stringify(wf, null, 2)
      } catch {
        return selectedCrystal.generatedWorkflow
      }
    }
    return NEW_SKILL_TEMPLATE
      + `\n\n// Skill: ${selected.id}\n// Source: ${selected.source}\n// Commands:\n`
      + selected.commands.map(c => `//   - ${c.name}: ${c.description ?? ''}`).join('\n')
  }, [selected, selectedCrystal])

  const editorLanguage = selectedCrystal ? 'json' : 'typescript'

  // Default the runner's command to the first command on the selected skill.
  useEffect(() => {
    if (selected?.commands.length && !selected.commands.some(c => c.name === runCommand)) {
      setRunCommand(selected.commands[0].name)
    }
    setRunOutput(null)
  }, [selected, runCommand])

  const runTest = useCallback(async () => {
    if (!runCommand) return
    setRunning(true)
    setRunOutput(null)
    try {
      let parsed: unknown = {}
      try { parsed = JSON.parse(runParams || '{}') }
      catch (err) {
        setRunOutput({ ok: false, text: `Params JSON parse error: ${(err as Error).message}` })
        return
      }
      const res = await api.post<{ result: string }>('/api/skills/execute', {
        command: runCommand,
        params: parsed,
      })
      // The skill's raw return is a SkillResult JSON string. Show it
      // pretty-printed when it parses, or fall back to the raw text.
      try {
        const parsedResult = JSON.parse(res.result)
        setRunOutput({ ok: parsedResult.ok !== false, text: JSON.stringify(parsedResult, null, 2) })
      } catch {
        setRunOutput({ ok: true, text: res.result })
      }
    } catch (err) {
      setRunOutput({ ok: false, text: (err as Error).message })
    } finally {
      setRunning(false)
    }
  }, [runCommand, runParams])

  const runCrystallizedAction = useCallback(async (action: 'approve' | 'reject' | 'promote') => {
    if (!selectedCrystal) return
    try {
      await api.post(`/api/crystallized-skills/${encodeURIComponent(selectedCrystal.id)}/${action}`,
        action === 'reject' ? { reason: 'operator-action' } : undefined)
      show(`${action} ok`, 'success')
      refresh()
    } catch (err) {
      show(`${action} failed: ${(err as Error).message}`, 'error')
    }
  }, [selectedCrystal, refresh, show])

  const newSkill = useCallback(() => {
    show('New skill scaffolding requires editing src/skills/ source code; see docs.', 'info')
  }, [show])

  return (
    <Layout
      title="Skill Studio"
      subtitle="Browse every registered skill, inspect commands, and run them with custom parameters."
      actions={<Button size="sm" variant="primary" onClick={newSkill}>+ New Skill</Button>}
    >
      <div className={styles.shell}>
        {/* ── Skill list ── */}
        <aside className={styles.list}>
          <div className={styles.listHeader}>
            <span>Skills</span>
            <Button size="xs" variant="ghost" onClick={() => void refresh()} loading={loading}>↻</Button>
          </div>
          <div className={styles.listSearch}>
            <input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {(['builtin', 'plugin', 'sandboxed', 'crystallized'] as const).map(group => {
            const items = grouped[group]
            if (items.length === 0) return null
            return (
              <div key={group}>
                <div className={styles.section}>{labelFor(group)} ({items.length})</div>
                {items.map(s => (
                  <button
                    key={s.id}
                    className={`${styles.entry} ${selectedId === s.id ? styles.entryActive : ''}`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <div className={styles.entryName}>
                      <span className={styles.entryDot} style={{ background: groupColour(group) }} />
                      {s.name}
                      {s.circuitBreaker && s.circuitBreaker.state === 'OPEN' && (
                        <span className={styles.cbDot} style={{ background: 'var(--danger)' }} title="Circuit OPEN" />
                      )}
                    </div>
                    <div className={styles.entryMeta}>
                      <span>{s.id}</span>
                      <span>· {s.commands.length} cmd</span>
                    </div>
                  </button>
                ))}
              </div>
            )
          })}
        </aside>

        {/* ── Editor (centre) ── */}
        <div className={styles.editor}>
          {!selected ? (
            <div className={styles.editorEmpty}>
              <div className={styles.editorEmptyTitle}>No skill selected</div>
              <div>Pick a skill on the left to inspect its commands, view its generated workflow, or run a test invocation.</div>
            </div>
          ) : (
            <>
              <div className={styles.editorTopBar}>
                <span className={`${styles.editorBadge} ${styles[selected.source]}`}>{selected.source}</span>
                <h2>{selected.name}</h2>
                <span className={styles.id}>{selected.id}</span>
              </div>
              <div className={styles.editorTabs}>
                <button
                  className={`${styles.editorTab} ${tab === 'workflow' ? styles.editorTabActive : ''}`}
                  onClick={() => setTab('workflow')}
                >{selectedCrystal ? 'Generated Workflow' : 'Source / Notes'}</button>
                <button
                  className={`${styles.editorTab} ${tab === 'metadata' ? styles.editorTabActive : ''}`}
                  onClick={() => setTab('metadata')}
                >Metadata</button>
              </div>

              {tab === 'workflow' ? (
                <div className={styles.editorMonaco}>
                  <Editor
                    theme="vs-dark"
                    language={editorLanguage}
                    value={editorValue}
                    options={{
                      readOnly: true,           // editing skill code from the UI is out of scope here
                      minimap: { enabled: false },
                      fontSize: 12,
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      automaticLayout: true,
                    }}
                  />
                </div>
              ) : (
                <div className={styles.editorMeta}>
                  <div className={styles.field}>
                    <label>ID</label>
                    <input value={selected.id} disabled />
                  </div>
                  <div className={styles.field}>
                    <label>Category</label>
                    <input value={selected.category} disabled />
                  </div>
                  <div className={styles.field}>
                    <label>Name</label>
                    <input value={selected.name} disabled />
                  </div>
                  <div className={styles.field}>
                    <label>Source</label>
                    <input value={selected.source} disabled />
                  </div>
                  <div className={`${styles.field} ${styles.full}`}>
                    <label>Description</label>
                    <textarea value={selected.description} disabled rows={3} />
                  </div>
                  {selectedCrystal && (
                    <>
                      <div className={styles.field}>
                        <label>Status</label>
                        <input value={selectedCrystal.status} disabled />
                      </div>
                      <div className={styles.field}>
                        <label>Confidence</label>
                        <input value={(typeof selectedCrystal.confidenceScore === 'number' ? selectedCrystal.confidenceScore.toFixed(2) : '–')} disabled />
                      </div>
                      <div className={`${styles.field} ${styles.full}`}>
                        <label>Tags</label>
                        <input value={(selectedCrystal.tags ?? []).join(', ')} disabled />
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Test runner ── */}
          {selected && (
            <div className={styles.runner}>
              <div className={styles.runnerInputs}>
                <h3>Test runner</h3>
                <select value={runCommand} onChange={(e) => setRunCommand(e.target.value)}>
                  {selected.commands.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
                <Editor
                  theme="vs-dark"
                  language="json"
                  height="160px"
                  value={runParams}
                  onChange={(v) => setRunParams(v ?? '{}')}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 11,
                    wordWrap: 'on',
                    lineNumbers: 'off',
                  }}
                />
                <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                  <Button size="sm" variant="primary" onClick={runTest} loading={running}>Run Test</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setRunOutput(null); setRunParams('{}') }}>Clear</Button>
                </div>
              </div>
              <div className={styles.runnerOutput}>
                <h3>
                  <span>Output</span>
                  {runOutput && (
                    <span style={{ color: runOutput.ok ? 'var(--success)' : 'var(--danger)' }}>
                      {runOutput.ok ? '✓ ok' : '✗ failed'}
                    </span>
                  )}
                </h3>
                <pre className={runOutput?.ok ? styles.success : (runOutput ? styles.error : '')}>
                  {runOutput?.text ?? '(no run yet)'}
                </pre>
              </div>
            </div>
          )}
        </div>

        {/* ── Right pane: commands + crystallized lifecycle controls ── */}
        <aside className={styles.right}>
          {!selected ? (
            <div className={styles.rightHeader}>(no skill selected)</div>
          ) : (
            <>
              <div className={styles.rightHeader}>Commands ({selected.commands.length})</div>
              {selected.commands.map(c => (
                <div key={c.name} className={styles.command}>
                  <div className={styles.commandName}>{c.name}</div>
                  {c.description && <div className={styles.commandDesc}>{c.description}</div>}
                </div>
              ))}

              {selected.circuitBreaker && (
                <>
                  <div className={styles.rightHeader} style={{ marginTop: 16 }}>Circuit breaker</div>
                  <div className={styles.command}>
                    <div className={styles.crystalRow}>
                      <span>state</span><span>{selected.circuitBreaker.state}</span>
                    </div>
                    <div className={styles.crystalRow}>
                      <span>failures</span><span>{selected.circuitBreaker.consecutiveFailures}</span>
                    </div>
                  </div>
                </>
              )}

              {selectedCrystal && (
                <div className={styles.crystalDetails}>
                  <div className={styles.rightHeader}>Crystallized skill</div>
                  <div className={styles.crystalRow}><span>status</span><span>{selectedCrystal.status}</span></div>
                  <div className={styles.crystalRow}><span>uses</span><span>{selectedCrystal.usageCount}</span></div>
                  <div className={styles.crystalRow}><span>confidence</span><span>{(typeof selectedCrystal.confidenceScore === 'number' ? selectedCrystal.confidenceScore.toFixed(2) : '–')}</span></div>
                  <div className={styles.crystalRow}>
                    <span>recent</span>
                    <span>
                      {(selectedCrystal.recentUsage ?? []).slice(-5).map((u, i) => (
                        <span key={i} style={{ color: u.outcome === 'success' ? 'var(--success)' : 'var(--danger)' }}>●</span>
                      ))}
                    </span>
                  </div>

                  <div className={styles.crystalActions}>
                    {selectedCrystal.status !== 'active' && selectedCrystal.status !== 'rejected' && (
                      <Button size="sm" variant="primary" onClick={() => void runCrystallizedAction('approve')}>Approve</Button>
                    )}
                    {selectedCrystal.status !== 'active' && selectedCrystal.status !== 'rejected' && (
                      <Button size="sm" variant="success" onClick={() => void runCrystallizedAction('promote')}>Promote</Button>
                    )}
                    {selectedCrystal.status !== 'rejected' && (
                      <Button size="sm" variant="danger" onClick={() => void runCrystallizedAction('reject')}>Reject</Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </Layout>
  )
}

function labelFor(group: 'builtin' | 'plugin' | 'sandboxed' | 'crystallized'): string {
  switch (group) {
    case 'builtin':      return 'Built-in'
    case 'plugin':       return 'Plugins'
    case 'sandboxed':    return 'Sandboxed'
    case 'crystallized': return 'Crystallized'
  }
}
function groupColour(group: 'builtin' | 'plugin' | 'sandboxed' | 'crystallized'): string {
  switch (group) {
    case 'builtin':      return 'var(--info)'
    case 'plugin':       return 'var(--purple)'
    case 'sandboxed':    return 'var(--warning)'
    case 'crystallized': return 'var(--success)'
  }
}

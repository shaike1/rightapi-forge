// Agent Designer — visual editor for the existing agent roster.
//
// Reads from the legacy /api/agents endpoints (already in the server)
// and the new personality-engine endpoints I added in the agent-
// personality phase. The page is a list-on-left / form-on-right
// layout matching the rest of the management UI:
//
//   - Left  : agents grouped by role with online/offline dot.
//   - Right : metadata form + skill multi-select + personality
//             sliders + a test pane that submits a free-text task and
//             streams the ReAct trace back via the existing
//             /api/agents/:id/run-test endpoint when available, or
//             falls back to a synchronous POST /api/tasks otherwise.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import s from './agentDesigner/common.module.css'

interface AgentRow {
  id: string
  name: string
  role: 'director' | 'sysadmin' | 'specialist' | 'manager' | 'individual' | string
  description?: string
  skills: string[]
  status: 'active' | 'inactive' | 'idle' | 'busy' | string
  /** Optional aggregate stats from the legacy endpoint. */
  stats?: { tasks?: number; rating?: number }
}

interface PersonalityProfile {
  agentId: string
  communication: { verbosity: number; formality: number; structure: number; emoji: number }
  decisions: { autonomy: number; riskTolerance: number; thoroughness: number; curiosity: number }
  expertiseAreas: string[]
  learnedBehaviours: string[]
  avoidPatterns: string[]
  stats: {
    feedbackPositive: number
    feedbackNegative: number
    reflectionsRecorded: number
    successesRecorded: number
    failuresRecorded: number
    driftClamps: number
  }
}

interface SkillRow { id: string; name: string; description: string; category: string }

/** Personality slider helper — calls back with the new value (0..1). */
function Slider({
  label, value, onChange,
}: { label: string; value: number; onChange(v: number): void }) {
  return (
    <div className={s.slider}>
      <label>{label}</label>
      <input
        type="range" min={0} max={1} step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={s.value}>{value.toFixed(2)}</span>
    </div>
  )
}

export default function AgentDesignerPage() {
  const { show } = useToast()

  const [agents, setAgents] = useState<AgentRow[]>([])
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [profile, setProfile] = useState<PersonalityProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)

  // Test pane state.
  const [testInput, setTestInput] = useState('')
  const [testRunning, setTestRunning] = useState(false)
  const [testSteps, setTestSteps] = useState<Array<{ iteration: number; thought?: string; tool?: string; observation?: string; error?: string }>>([])

  // Edit-mode form state.
  const [form, setForm] = useState<{ description: string; skills: Set<string> }>({
    description: '',
    skills: new Set(),
  })

  // ── Data load ─────────────────────────────────────────────────────────
  // /api/agents returns the org tree { director, sysadmins[], specialists[] }
  // — not a flat list. Flatten it here so the rest of the page can treat
  // the roster uniformly. Falls back to the legacy { agents: [...] } and
  // direct-array shapes too, in case the endpoint changes again.
  const refresh = useCallback(async () => {
    try {
      const [a, sk] = await Promise.all([
        api.get<unknown>('/api/agents').catch(() => null),
        api.get<{ skills: SkillRow[] }>('/api/skills'),
      ])
      setAgents(flattenAgentRoster(a))
      setSkills(Array.isArray(sk?.skills) ? sk.skills : [])
    } catch (err) {
      show(`Failed to load agents: ${(err as Error).message}`, 'error')
    }
  }, [show])
  useEffect(() => { void refresh() }, [refresh])

  // Pull personality data when an agent is selected. The endpoint may
  // 404 when there's no profile yet — that's fine, the form adapts.
  useEffect(() => {
    if (!selectedId) { setProfile(null); return }
    setProfileLoading(true)
    api.get<{ profile: PersonalityProfile }>(`/api/agents/${encodeURIComponent(selectedId)}/personality`)
      .then(r => setProfile(r.profile))
      .catch(() => setProfile(null))
      .finally(() => setProfileLoading(false))
  }, [selectedId])

  const selected = useMemo(() => agents.find(a => a.id === selectedId) ?? null, [agents, selectedId])

  // Sync form state when the selection changes.
  useEffect(() => {
    if (selected) {
      setForm({
        description: selected.description ?? '',
        skills: new Set(selected.skills ?? []),
      })
    }
  }, [selected])

  // ── Group + filter ────────────────────────────────────────────────────
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase()
    const matches = (a: AgentRow) =>
      !q || a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || (a.role ?? '').toLowerCase().includes(q)
    const filtered = agents.filter(matches)
    const groups = new Map<string, AgentRow[]>()
    for (const a of filtered) {
      const role = a.role ?? 'individual'
      if (!groups.has(role)) groups.set(role, [])
      groups.get(role)!.push(a)
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [agents, search])

  // ── Save metadata edits (best-effort: legacy endpoint may not exist) ──
  const save = useCallback(async () => {
    if (!selected) return
    try {
      await api.put(`/api/agents/${encodeURIComponent(selected.id)}`, {
        description: form.description,
        skills: Array.from(form.skills),
      })
      show('Agent updated', 'success')
      void refresh()
    } catch (err) {
      show(`Save failed: ${(err as Error).message}`, 'error')
    }
  }, [selected, form, refresh, show])

  // ── Run a test task ───────────────────────────────────────────────────
  const runTest = useCallback(async () => {
    if (!selected || !testInput.trim()) return
    setTestRunning(true)
    setTestSteps([])
    try {
      // Try the explicit test endpoint first; if it 404s, fall back to
      // creating a real task and watching its history.
      const res = await api.post<{ steps: typeof testSteps }>(
        `/api/agents/${encodeURIComponent(selected.id)}/test`,
        { task: testInput },
      ).catch(() => null)
      if (res?.steps) {
        setTestSteps(res.steps)
        show('Test complete', 'success')
        return
      }
      const created = await api.post<{ taskId: string }>('/api/tasks', {
        title: testInput.slice(0, 80),
        description: testInput,
        assignedTo: selected.id,
      })
      show(`Task ${created.taskId} dispatched`, 'success')
    } catch (err) {
      show(`Test failed: ${(err as Error).message}`, 'error')
    } finally {
      setTestRunning(false)
    }
  }, [selected, testInput, show])

  // Personality slider handler — debounce via uncontrolled commit-on-mouseup.
  const updateTrait = useCallback(async (
    section: 'communication' | 'decisions',
    field: string,
    value: number,
  ) => {
    if (!profile) return
    const next: PersonalityProfile = {
      ...profile,
      [section]: { ...profile[section], [field]: value },
    }
    setProfile(next)
    // Server commit happens on a separate "Save personality" button so
    // the operator can make multiple adjustments before persisting.
  }, [profile])

  const savePersonality = useCallback(async () => {
    if (!profile || !selected) return
    try {
      await api.put(
        `/api/agents/${encodeURIComponent(selected.id)}/personality`,
        { communication: profile.communication, decisions: profile.decisions },
      )
      show('Personality updated', 'success')
    } catch (err) {
      show(`Save failed: ${(err as Error).message}`, 'error')
    }
  }, [profile, selected, show])

  return (
    <Layout title="Agent Designer" subtitle="Configure agent skills, personality, and run live tests.">
      <div className={s.shell}>
        <aside className={s.sidebar}>
          <div className={s.sidebarHeader}>
            <span>Agents</span>
            <Button size="xs" variant="ghost" onClick={() => void refresh()}>↻</Button>
          </div>
          <div className={s.sidebarSearch}>
            <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {grouped.map(([role, list]) => (
            <div key={role}>
              <div style={{ padding: '12px 14px 6px', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text3)', fontWeight: 600 }}>
                {role} ({list.length})
              </div>
              {list.map(a => (
                <button
                  key={a.id}
                  className={`${s.entry} ${selectedId === a.id ? s.entryActive : ''}`}
                  onClick={() => setSelectedId(a.id)}
                >
                  <div className={s.entryName}>
                    <span className={s.entryDot} style={{ background: agentDot(a.status) }} />
                    {a.name}
                  </div>
                  <div className={s.entryMeta}>
                    <span>{a.id}</span>
                    <span>· {(a.skills ?? []).length} skills</span>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className={s.main}>
          {!selected ? (
            <div className={s.empty}>
              <div className={s.emptyTitle}>No agent selected</div>
              <div>Select an agent on the left to edit its skills, personality, and run a test.</div>
            </div>
          ) : (
            <>
              <div className={s.mainHeader}>
                <h2>{selected.name}</h2>
                <span className={`${s.pill} ${selected.status === 'active' ? s.success : s.info}`}>{selected.role}</span>
                <span className={s.id}>{selected.id}</span>
              </div>

              <div className={s.mainBody}>
                <div className={s.stats}>
                  <Stat label="Tasks completed" value={String(profile?.stats?.successesRecorded ?? selected.stats?.tasks ?? '–')} />
                  <Stat label="Avg rating"        value={profile ? avgRating(profile).toFixed(2) : '–'} />
                  <Stat label="Reflections"       value={String(profile?.stats?.reflectionsRecorded ?? '–')} />
                  <Stat label="Drift clamps"      value={String(profile?.stats?.driftClamps ?? 0)} />
                </div>

                {/* ── Metadata form ───────────────────────────────── */}
                <div className={s.section}>Configuration</div>
                <div className={s.formGrid}>
                  <div className={s.field}>
                    <label>Name</label>
                    <input value={selected.name} disabled />
                  </div>
                  <div className={s.field}>
                    <label>Role</label>
                    <input value={selected.role} disabled />
                  </div>
                  <div className={`${s.field} ${s.full}`}>
                    <label>Description</label>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                    />
                  </div>
                  <div className={`${s.field} ${s.full}`}>
                    <label>Assigned skills ({form.skills.size})</label>
                    <div className={s.skillGrid}>
                      {skills.map(sk => {
                        const checked = form.skills.has(sk.id)
                        return (
                          <label key={sk.id} className={`${s.skillChip} ${checked ? s.checked : ''}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const next = new Set(form.skills)
                                if (e.target.checked) next.add(sk.id); else next.delete(sk.id)
                                setForm({ ...form, skills: next })
                              }}
                            />
                            {sk.name}
                          </label>
                        )
                      })}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
                  <Button variant="primary" size="sm" onClick={save}>Save Configuration</Button>
                </div>

                {/* ── Personality sliders ─────────────────────────── */}
                <div className={s.section}>Personality {profileLoading && <em style={{ fontSize: 11, color: 'var(--text3)' }}>(loading…)</em>}</div>
                {!profile ? (
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
                    No personality profile yet. The platform creates one on first feedback / reflection signal.
                  </div>
                ) : (
                  <>
                    <div className={s.formGrid} style={{ gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                      <div>
                        <h4 style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'uppercase', marginBottom: 8 }}>Communication</h4>
                        <Slider label="Verbosity"  value={profile.communication.verbosity} onChange={(v) => updateTrait('communication', 'verbosity', v)} />
                        <Slider label="Formality"  value={profile.communication.formality} onChange={(v) => updateTrait('communication', 'formality', v)} />
                        <Slider label="Structure"  value={profile.communication.structure} onChange={(v) => updateTrait('communication', 'structure', v)} />
                        <Slider label="Emoji use"  value={profile.communication.emoji}     onChange={(v) => updateTrait('communication', 'emoji', v)} />
                      </div>
                      <div>
                        <h4 style={{ fontSize: 11, color: 'var(--text2)', textTransform: 'uppercase', marginBottom: 8 }}>Decisions</h4>
                        <Slider label="Autonomy"      value={profile.decisions.autonomy}      onChange={(v) => updateTrait('decisions', 'autonomy', v)} />
                        <Slider label="Risk tolerance" value={profile.decisions.riskTolerance} onChange={(v) => updateTrait('decisions', 'riskTolerance', v)} />
                        <Slider label="Thoroughness" value={profile.decisions.thoroughness}   onChange={(v) => updateTrait('decisions', 'thoroughness', v)} />
                        <Slider label="Curiosity"    value={profile.decisions.curiosity}      onChange={(v) => updateTrait('decisions', 'curiosity', v)} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
                      <Button variant="primary" size="sm" onClick={savePersonality}>Save Personality</Button>
                    </div>
                  </>
                )}

                {/* ── Test pane ───────────────────────────────────── */}
                <div className={s.section}>Test Run</div>
                <div className={s.formGrid}>
                  <div className={`${s.field} ${s.full}`}>
                    <label>Task description</label>
                    <textarea
                      placeholder="Describe a task for this agent to attempt…"
                      value={testInput}
                      onChange={(e) => setTestInput(e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  <Button variant="success" size="sm" onClick={runTest} loading={testRunning}>Run Test</Button>
                  <Button variant="ghost" size="sm" onClick={() => { setTestInput(''); setTestSteps([]) }}>Clear</Button>
                </div>

                {testSteps.length > 0 && (
                  <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    {testSteps.map((step, i) => (
                      <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '10px 14px' }}>
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 4 }}>iteration {step.iteration}</div>
                        {step.thought && <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>💭 {step.thought}</div>}
                        {step.tool && <div style={{ fontSize: 12, color: 'var(--accent-light)', fontFamily: 'ui-monospace, monospace' }}>→ {step.tool}</div>}
                        {step.observation && <div style={{ fontSize: 11, color: 'var(--text)', marginTop: 4, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }}>{step.observation}</div>}
                        {step.error && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>error: {step.error}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </Layout>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={s.statCard}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
      {sub && <div className={s.statSub}>{sub}</div>}
    </div>
  )
}

function avgRating(p: PersonalityProfile): number {
  const total = p.stats.feedbackPositive + p.stats.feedbackNegative
  if (total === 0) return 0
  // Map +/- counts to a 1-5 scale: 100% positive → 5; 100% negative → 1.
  return 1 + 4 * (p.stats.feedbackPositive / total)
}

/**
 * /api/agents returns the org tree shape `{ director, sysadmins[],
 * specialists[] }` — flatten it into a single AgentRow[]. Also tolerates
 * the legacy `{ agents: [...] }` envelope and a direct array, so the
 * page survives an endpoint format change.
 */
function flattenAgentRoster(data: unknown): AgentRow[] {
  if (!data) return []
  if (Array.isArray(data)) return data as AgentRow[]
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.agents)) return obj.agents as AgentRow[]

  const out: AgentRow[] = []
  const push = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>
    if (!r.id || !r.name) return
    out.push({
      id: String(r.id),
      name: String(r.name),
      role: (r.role as AgentRow['role']) ?? 'individual',
      description: typeof r.description === 'string' ? r.description : undefined,
      skills: Array.isArray(r.skills) ? r.skills.map(String) : [],
      status: (r.status as AgentRow['status']) ?? 'active',
    })
  }
  push(obj.director)
  if (Array.isArray(obj.sysadmins)) obj.sysadmins.forEach(push)
  if (Array.isArray(obj.specialists)) obj.specialists.forEach(push)
  if (Array.isArray(obj.managers)) obj.managers.forEach(push)
  if (Array.isArray(obj.individuals)) obj.individuals.forEach(push)
  return out
}

function agentDot(status: string): string {
  switch (status) {
    case 'active': case 'idle':  return 'var(--success)'
    case 'busy':                  return 'var(--warning)'
    case 'inactive':              return 'var(--text3)'
    default:                      return 'var(--info)'
  }
}

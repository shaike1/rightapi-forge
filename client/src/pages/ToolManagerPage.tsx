// Tool Manager — operations view of every registered skill + the
// plugin loaders that own them.
//
// Three columns of data on the page:
//   - skill table        (id, source, breaker state, controls)
//   - plugin section     (in-process + sandboxed loaders, with the
//                          declared permissions for sandboxed plugins)
//   - controls           (rescan, force breaker, install new tool)

import { useCallback, useEffect, useMemo, useState } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import s from './agentDesigner/common.module.css'

interface SkillSummary {
  id: string
  name: string
  description: string
  category: string
  enabled: boolean
  source: 'builtin' | 'plugin' | 'sandboxed' | 'crystallized'
  commands: Array<{ name: string }>
  circuitBreaker: { state: string; consecutiveFailures: number; reopensAfterMs?: number } | null
}

interface PluginInfo {
  skillId: string
  filePath: string
  loadedAt: number
}

type View = 'skills' | 'plugins'

export default function ToolManagerPage() {
  const { show } = useToast()
  const [view, setView] = useState<View>('skills')
  const [skills, setSkills]           = useState<SkillSummary[]>([])
  const [plugins, setPlugins]         = useState<PluginInfo[]>([])
  const [sandboxed, setSandboxed]     = useState<PluginInfo[]>([])
  const [loading, setLoading]         = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [skillsRes, pluginsRes, sandboxRes] = await Promise.all([
        api.get<{ skills: SkillSummary[] }>('/api/skills/summary'),
        api.get<{ plugins: PluginInfo[] }>('/api/skill-plugins').catch(() => ({ plugins: [] as PluginInfo[] })),
        api.get<{ plugins: PluginInfo[] }>('/api/skill-plugins/sandboxed').catch(() => ({ plugins: [] as PluginInfo[] })),
      ])
      setSkills(Array.isArray(skillsRes?.skills) ? skillsRes.skills : [])
      setPlugins(Array.isArray(pluginsRes?.plugins) ? pluginsRes.plugins : [])
      setSandboxed(Array.isArray(sandboxRes?.plugins) ? sandboxRes.plugins : [])
    } catch (err) {
      show(`Failed to load tools: ${(err as Error).message}`, 'error')
    } finally { setLoading(false) }
  }, [show])
  useEffect(() => { void refresh() }, [refresh])

  const breakerCounts = useMemo(() => {
    const counts = { open: 0, halfOpen: 0, closed: 0 }
    for (const sk of skills) {
      const state = sk.circuitBreaker?.state
      if (state === 'OPEN') counts.open++
      else if (state === 'HALF_OPEN') counts.halfOpen++
      else if (state === 'CLOSED' || !state) counts.closed++
    }
    return counts
  }, [skills])

  const resetBreaker = useCallback(async (id: string) => {
    try {
      await api.post(`/api/skills/circuit-breakers/${encodeURIComponent(id)}/reset`)
      show(`Circuit reset for ${id}`, 'success')
      void refresh()
    } catch (err) {
      show(`Reset failed: ${(err as Error).message}`, 'error')
    }
  }, [refresh, show])

  const rescan = useCallback(async (sandbox: boolean) => {
    try {
      await api.post(sandbox ? '/api/skill-plugins/sandboxed/rescan' : '/api/skill-plugins/rescan')
      show('Rescan complete', 'success')
      void refresh()
    } catch (err) {
      show(`Rescan failed: ${(err as Error).message}`, 'error')
    }
  }, [refresh, show])

  return (
    <Layout
      title="Tool Manager"
      subtitle="Inspect every registered skill, watch circuit breakers, and reload plugins."
      actions={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" variant={view === 'skills'  ? 'primary' : 'ghost'} onClick={() => setView('skills')}>Skills</Button>
          <Button size="sm" variant={view === 'plugins' ? 'primary' : 'ghost'} onClick={() => setView('plugins')}>Plugins</Button>
          <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={loading}>Refresh</Button>
        </div>
      }
    >
      <div style={{ padding: 20 }}>
        <div className={s.stats}>
          <Stat label="Total skills"        value={String(skills.length)} />
          <Stat label="Closed (healthy)"    value={String(breakerCounts.closed)} sub="circuit breakers" />
          <Stat label="Half-open"           value={String(breakerCounts.halfOpen)} sub="probing" />
          <Stat label="Open"                value={String(breakerCounts.open)}    sub="failing" />
          <Stat label="Plugins (in-proc)"   value={String(plugins.length)} />
          <Stat label="Plugins (sandboxed)" value={String(sandboxed.length)} />
        </div>

        {view === 'skills' && (
          <>
            <div className={s.section}>Skills</div>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--bg3)', color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>
                  <tr>
                    <th style={th}>Skill</th>
                    <th style={th}>Source</th>
                    <th style={th}>Commands</th>
                    <th style={th}>Status</th>
                    <th style={{ ...th, textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {skills.map(sk => (
                    <tr key={sk.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={td}>
                        <div style={{ color: 'var(--text)', fontWeight: 500 }}>{sk.name}</div>
                        <div style={{ color: 'var(--text3)', fontFamily: 'ui-monospace, monospace', fontSize: 10 }}>{sk.id}</div>
                      </td>
                      <td style={td}>
                        <span className={`${s.pill} ${sourcePillClass(sk.source)}`}>{sk.source}</span>
                      </td>
                      <td style={{ ...td, color: 'var(--text2)' }}>{sk.commands.length}</td>
                      <td style={td}>{breakerPill(sk.circuitBreaker)}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {sk.circuitBreaker && sk.circuitBreaker.state !== 'CLOSED' && (
                          <Button size="xs" variant="ghost" onClick={() => void resetBreaker(sk.id)}>Reset</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {view === 'plugins' && (
          <>
            <div className={s.section} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>In-process plugins ({plugins.length})</span>
              <Button size="xs" variant="ghost" onClick={() => void rescan(false)}>Rescan</Button>
            </div>
            <PluginTable rows={plugins} sandboxed={false} />

            <div className={s.section} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Sandboxed plugins ({sandboxed.length})</span>
              <Button size="xs" variant="ghost" onClick={() => void rescan(true)}>Rescan</Button>
            </div>
            <PluginTable rows={sandboxed} sandboxed={true} />
          </>
        )}
      </div>
    </Layout>
  )
}

function PluginTable({ rows, sandboxed }: { rows: PluginInfo[]; sandboxed: boolean }) {
  if (rows.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--text3)', fontSize: 12, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
        No plugins loaded. {sandboxed
          ? 'Drop a *.plugin.js into SKILL_SANDBOX_PLUGIN_DIR to enable.'
          : 'Drop a *.plugin.js into SKILL_PLUGIN_DIR to enable.'}
      </div>
    )
  }
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead style={{ background: 'var(--bg3)', color: 'var(--text3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' }}>
          <tr>
            <th style={th}>Skill</th>
            <th style={th}>File</th>
            <th style={th}>Loaded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.filePath} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={td}><span style={{ fontFamily: 'ui-monospace, monospace' }}>{p.skillId}</span></td>
              <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--text2)', fontSize: 10 }}>{p.filePath}</td>
              <td style={{ ...td, color: 'var(--text3)' }}>{new Date(p.loadedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const th: React.CSSProperties = { padding: '8px 14px', textAlign: 'left', fontWeight: 600 }
const td: React.CSSProperties = { padding: '10px 14px', verticalAlign: 'top' }

function sourcePillClass(src: SkillSummary['source']): string {
  switch (src) {
    case 'builtin':      return s.info
    case 'plugin':       return s.info
    case 'sandboxed':    return s.warning
    case 'crystallized': return s.success
  }
}

function breakerPill(b: SkillSummary['circuitBreaker']): React.ReactNode {
  if (!b || b.state === 'CLOSED') return <span className={`${s.pill} ${s.success}`}>healthy</span>
  if (b.state === 'HALF_OPEN')    return <span className={`${s.pill} ${s.warning}`}>half-open</span>
  return <span className={`${s.pill} ${s.danger}`}>open ({b.consecutiveFailures})</span>
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

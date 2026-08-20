import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import EmptyState from '../components/EmptyState'
import { Card, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './MissionControlPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  name: string
  role: string
  status: string
  skills?: string[]
}

interface DashboardData {
  boards?: { activeBoards?: number }
  activity?: { recentCount?: number }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type StatusVariant = 'success' | 'warning' | 'danger' | 'neutral'
function statusVariant(status: string): StatusVariant {
  const s = status.toLowerCase()
  if (s === 'active') return 'success'
  if (s === 'idle') return 'warning'
  if (s === 'error' || s === 'offline') return 'danger'
  return 'neutral'
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MissionControlPage() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [skillsCount, setSkillsCount] = useState(0)
  const [boardsCount, setBoardsCount] = useState(0)
  const [tasksCount, setTasksCount] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const { connected, lastEvent } = useWebSocket()

  const fetchAll = useCallback(async () => {
    try {
      const [dashboard, agentsData, skillsData] = await Promise.all([
        api.get<DashboardData>('/api/mission-control/dashboard'),
        api.get<{ agents: Agent[] }>('/api/mission-control/agents'),
        api.get<{ skills: unknown[] }>('/api/mission-control/skills'),
      ])
      setBoardsCount(dashboard?.boards?.activeBoards ?? 0)
      setTasksCount(dashboard?.activity?.recentCount ?? 0)
      setAgents(Array.isArray(agentsData?.agents) ? agentsData.agents : [])
      setSkillsCount(Array.isArray(skillsData?.skills) ? skillsData.skills.length : 0)
    } catch {
      // silent on failures
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  useEffect(() => {
    if (
      lastEvent?.type === 'task_created' ||
      lastEvent?.type === 'task_updated' ||
      lastEvent?.type === 'task_completed' ||
      lastEvent?.type === 'task_failed' ||
      lastEvent?.type === 'agents'
    ) {
      fetchAll()
    }
  }, [lastEvent, fetchAll])

  const visible = agents.filter(a =>
    !search || a.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Layout title="Mission Control" subtitle="Agent orchestration and system overview">
      <div className={styles.statsRow}>
        <StatCard label="Agents" value={agents.length} color="success" />
        <StatCard label="Tasks" value={tasksCount} color="warning" />
        <StatCard label="Skills" value={skillsCount} color="accent" />
        <StatCard label="Boards" value={boardsCount} color="neutral" />
      </div>

      <Card>
        <CardBody>
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              placeholder="Search agents..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span className={styles.liveIndicator} data-connected={connected}>
              {connected ? '● Live' : '○ Connecting…'}
            </span>
          </div>

          {loading ? (
            <div className={styles.loading}>Loading agents…</div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon="🎯"
              title={search ? 'No agents match your search' : 'No agents available'}
              description={search ? 'Try a different search term.' : 'No agents are currently registered.'}
            />
          ) : (
            <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Name</th>
                  <th className={styles.th}>Role</th>
                  <th className={styles.th}>Status</th>
                  <th className={styles.th}>Skills</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((agent, i) => (
                  <tr key={agent.name + i} className={styles.tr}>
                    <td className={styles.td} style={{ fontWeight: 600 }}>{agent.name}</td>
                    <td className={styles.td} style={{ color: 'var(--text2)' }}>{agent.role || '—'}</td>
                    <td className={styles.td}>
                      <Badge variant={statusVariant(agent.status)}>
                        {agent.status || 'unknown'}
                      </Badge>
                    </td>
                    <td className={styles.td}>
                      <div className={styles.skillTags}>
                        {agent.skills && agent.skills.length > 0
                          ? agent.skills.map(s => (
                              <Badge key={s} variant="accent">{s}</Badge>
                            ))
                          : <span style={{ color: 'var(--text2)' }}>—</span>
                        }
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
    </Layout>
  )
}

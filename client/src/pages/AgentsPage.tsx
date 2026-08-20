import { useState, useEffect, useRef } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import StatCard from '../components/StatCard'
import EmptyState from '../components/EmptyState'
import Modal from '../components/Modal'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './AgentsPage.module.css'

interface Agent {
  id: string
  name: string
  type: string
  status: 'idle' | 'busy' | 'error' | 'offline'
  model?: string
  skills?: string[]
  lastActivity?: string
  tasksCompleted?: number
}

interface MemoryFact {
  fact: string
  created_at: string
}

interface MemoryResolution {
  id: string
  incident_title: string
  incident_severity: string
  resolution: string
  runbook_used: string | null
  created_at: string
}

interface MemoryStats {
  totalFacts: number
  resolutionPatterns: number
  lastUpdated: string | null
}

interface AgentMemory {
  facts: MemoryFact[]
  resolutions: MemoryResolution[]
  stats: MemoryStats
}

type StatusVariant = 'success' | 'warning' | 'danger' | 'neutral'
const STATUS_BADGE: Record<Agent['status'], StatusVariant> = {
  idle: 'success',
  busy: 'warning',
  error: 'danger',
  offline: 'neutral',
}
type StatColor = 'default' | 'success' | 'warning' | 'neutral'

export default function AgentsPage() {
  const { show } = useToast()
  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [restartingId, setRestartingId] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Memory modal state
  const [memoryAgent, setMemoryAgent] = useState<Agent | null>(null)
  const [memory, setMemory] = useState<AgentMemory | null>(null)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryTab, setMemoryTab] = useState<'resolutions' | 'facts'>('resolutions')
  const [teachInput, setTeachInput] = useState('')
  const [teachLoading, setTeachLoading] = useState(false)
  const [clearingMemory, setClearingMemory] = useState(false)
  const [memoryFacts, setMemoryFacts] = useState<Record<string, number>>({})

  const fetchAgents = () => {
    api.get<{ agents: Agent[] } | Agent[]>('/api/agents')
      .then(data => {
        const list = Array.isArray(data) ? data : data?.agents
        const safe = Array.isArray(list) ? list : []
        setAgents(safe)
        if (selectedAgent) {
          const updated = safe.find(a => a.id === selectedAgent.id)
          if (updated) setSelectedAgent(updated)
        }
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setLoading(false))
  }

  const fetchMemoryFactCount = (agentId: string) => {
    api.get<{ stats: MemoryStats }>(`/api/agents/${agentId}/memory`)
      .then(data => setMemoryFacts(prev => ({ ...prev, [agentId]: data.stats.totalFacts })))
      .catch(() => {})
  }

  useEffect(() => {
    fetchAgents()
    intervalRef.current = setInterval(fetchAgents, 10_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    agents.forEach(a => fetchMemoryFactCount(a.id))
  }, [agents.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const openLogs = async (agent: Agent) => {
    setSelectedAgent(agent)
    setLogsLoading(true)
    setLogs([])
    try {
      const data = await api.get<{ logs: string[] } | string[]>(`/api/agents/${agent.id}/logs`)
      const list = Array.isArray(data) ? data : data?.logs
      setLogs(Array.isArray(list) ? list : [])
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setLogsLoading(false)
    }
  }

  const openMemory = async (agent: Agent) => {
    setMemoryAgent(agent)
    setMemoryLoading(true)
    setMemory(null)
    setMemoryTab('resolutions')
    try {
      const data = await api.get<AgentMemory>(`/api/agents/${agent.id}/memory`)
      setMemory(data)
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setMemoryLoading(false)
    }
  }

  const handleTeach = async () => {
    if (!memoryAgent || !teachInput.trim()) return
    setTeachLoading(true)
    try {
      await api.post(`/api/agents/${memoryAgent.id}/memory/teach`, { fact: teachInput.trim() })
      setTeachInput('')
      show('Fact stored!', 'success')
      const data = await api.get<AgentMemory>(`/api/agents/${memoryAgent.id}/memory`)
      setMemory(data)
      setMemoryFacts(prev => ({ ...prev, [memoryAgent.id]: data.stats.totalFacts }))
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setTeachLoading(false)
    }
  }

  const handleClearMemory = async () => {
    if (!memoryAgent || !confirm(`Clear all memory for ${memoryAgent.name}?`)) return
    setClearingMemory(true)
    try {
      await api.delete(`/api/agents/${memoryAgent.id}/memory`)
      show('Memory cleared', 'success')
      setMemory({ facts: [], resolutions: [], stats: { totalFacts: 0, resolutionPatterns: 0, lastUpdated: null } })
      setMemoryFacts(prev => ({ ...prev, [memoryAgent.id]: 0 }))
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setClearingMemory(false)
    }
  }

  const handleRestart = async (agent: Agent) => {
    setRestartingId(agent.id)
    try {
      await api.post(`/api/agents/${agent.id}/restart`)
      show(`${agent.name} restarted`, 'success')
      fetchAgents()
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setRestartingId(null)
    }
  }

  const total = agents.length
  const active = agents.filter(a => a.status === 'idle').length
  const busy = agents.filter(a => a.status === 'busy').length
  const offline = agents.filter(a => a.status === 'offline' || a.status === 'error').length

  return (
    <Layout title="Agents" subtitle="AI agent status and activity">
      <div className={styles.statsRow}>
        <StatCard label="Total Agents" value={total} color="default" />
        <StatCard label="Active" value={active} color="success" />
        <StatCard label="Busy" value={busy} color="warning" />
        <StatCard label="Offline / Error" value={offline} color="neutral" />
      </div>

      {loading ? (
        <div className={styles.loading}>Loading…</div>
      ) : agents.length === 0 ? (
        <EmptyState icon="🤖" title="No agents found" description="No agents are currently registered in the platform" />
      ) : (
        <div className={styles.grid}>
          {agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              isSelected={selectedAgent?.id === agent.id}
              isRestarting={restartingId === agent.id}
              factCount={memoryFacts[agent.id] ?? 0}
              onViewLogs={() => openLogs(agent)}
              onRestart={() => handleRestart(agent)}
              onViewMemory={() => openMemory(agent)}
            />
          ))}
        </div>
      )}

      {/* Log Panel */}
      {selectedAgent && (
        <div className={styles.logPanelWrap}>
          <Card>
            <CardHeader
              title={`Logs — ${selectedAgent.name}`}
              actions={<Button variant="ghost" size="sm" onClick={() => setSelectedAgent(null)}>Close</Button>}
            />
            <CardBody>
              {logsLoading ? (
                <div className={styles.logLoading}>Loading logs…</div>
              ) : logs.length === 0 ? (
                <div className={styles.logEmpty}>No logs available</div>
              ) : (
                <pre className={styles.logPanel}>
                  {logs.map((line, i) => <div key={i}>{line}</div>)}
                </pre>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {/* Memory Modal */}
      <Modal
        open={!!memoryAgent}
        onClose={() => setMemoryAgent(null)}
        title={`🧠 Agent Memory — ${memoryAgent?.name ?? ''}`}
        width={700}
        footer={
          <div className={styles.memoryFooter}>
            <Button variant="danger" size="sm" loading={clearingMemory} onClick={handleClearMemory}>
              Clear Memory
            </Button>
          </div>
        }
      >
        {memoryLoading ? (
          <div className={styles.memoryLoading}>Loading memory…</div>
        ) : memory ? (
          <div className={styles.memoryContent}>
            {/* Stats row */}
            <div className={styles.memoryStats}>
              <div className={styles.memoryStat}>
                <span className={styles.memoryStatValue}>{memory.stats.totalFacts}</span>
                <span className={styles.memoryStatLabel}>Total Facts</span>
              </div>
              <div className={styles.memoryStat}>
                <span className={styles.memoryStatValue}>{memory.stats.resolutionPatterns}</span>
                <span className={styles.memoryStatLabel}>Resolution Patterns</span>
              </div>
              <div className={styles.memoryStat}>
                <span className={styles.memoryStatValue}>
                  {memory.stats.lastUpdated ? new Date(memory.stats.lastUpdated).toLocaleDateString() : '—'}
                </span>
                <span className={styles.memoryStatLabel}>Last Updated</span>
              </div>
            </div>

            {/* Tabs */}
            <div className={styles.memoryTabs}>
              <button
                className={`${styles.memoryTab} ${memoryTab === 'resolutions' ? styles.memoryTabActive : ''}`}
                onClick={() => setMemoryTab('resolutions')}
              >Resolutions</button>
              <button
                className={`${styles.memoryTab} ${memoryTab === 'facts' ? styles.memoryTabActive : ''}`}
                onClick={() => setMemoryTab('facts')}
              >All Facts</button>
            </div>

            {/* Tab content */}
            <div className={styles.memoryTabContent}>
              {memoryTab === 'resolutions' ? (
                memory.resolutions.length === 0 ? (
                  <div className={styles.memoryEmpty}>No resolution patterns stored yet. They are captured automatically when runbooks complete.</div>
                ) : (
                  <table className={styles.memoryTable}>
                    <thead>
                      <tr>
                        <th>Incident</th>
                        <th>Severity</th>
                        <th>Resolution</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {memory.resolutions.map(r => (
                        <tr key={r.id}>
                          <td>{r.incident_title}</td>
                          <td><span className={`${styles.severityBadge} ${styles['sev_' + r.incident_severity]}`}>{r.incident_severity}</span></td>
                          <td className={styles.resolutionText}>{r.resolution.slice(0, 120)}{r.resolution.length > 120 ? '…' : ''}</td>
                          <td className={styles.dateCell}>{new Date(r.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              ) : (
                memory.facts.length === 0 ? (
                  <div className={styles.memoryEmpty}>No facts stored yet.</div>
                ) : (
                  <div className={styles.factsList}>
                    {memory.facts.map((f, i) => (
                      <div key={i} className={styles.factItem}>
                        <span className={styles.factText}>{f.fact}</span>
                        <span className={styles.factDate}>{new Date(f.created_at).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>

            {/* Teach input */}
            <div className={styles.teachSection}>
              <div className={styles.teachLabel}>Teach a fact</div>
              <div className={styles.teachRow}>
                <input
                  className={styles.teachInput}
                  type="text"
                  placeholder="Enter a fact to teach this agent…"
                  value={teachInput}
                  onChange={e => setTeachInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleTeach()}
                />
                <Button size="sm" loading={teachLoading} onClick={handleTeach} disabled={!teachInput.trim()}>
                  Teach
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </Layout>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AgentCard({
  agent, isSelected, isRestarting, factCount, onViewLogs, onRestart, onViewMemory,
}: {
  agent: Agent
  isSelected: boolean
  isRestarting: boolean
  factCount: number
  onViewLogs: () => void
  onRestart: () => void
  onViewMemory: () => void
}) {
  return (
    <div className={`${styles.agentCard}${isSelected ? ' ' + styles.agentCardSelected : ''}`}>
      <div className={styles.cardTop}>
        <div>
          <div className={styles.agentName}>{agent.name}</div>
          <Badge variant="neutral">{agent.type}</Badge>
        </div>
        <div className={styles.cardTopRight}>
          <Badge variant={STATUS_BADGE[agent.status]}>{agent.status}</Badge>
          <button className={styles.memoryBtn} onClick={onViewMemory} title="View agent memory">
            🧠 <span className={styles.memoryCount}>{factCount}</span>
          </button>
        </div>
      </div>

      {agent.model && (
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Model</span>
          <span className={styles.metaVal}>{agent.model}</span>
        </div>
      )}

      {agent.tasksCompleted !== undefined && (
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Tasks Completed</span>
          <span className={styles.metaVal}>{agent.tasksCompleted}</span>
        </div>
      )}

      {agent.lastActivity && (
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Last Activity</span>
          <span className={styles.metaVal}>{new Date(agent.lastActivity).toLocaleString()}</span>
        </div>
      )}

      {agent.skills && agent.skills.length > 0 && (
        <div className={styles.skillsSection}>
          <div className={styles.skillsLabel}>Skills</div>
          <div className={styles.tagList}>
            {agent.skills.map(skill => (
              <span key={skill} className={styles.tag}>{skill}</span>
            ))}
          </div>
        </div>
      )}

      <div className={styles.cardActions}>
        <Button variant="ghost" size="xs" onClick={onViewLogs}>View Logs</Button>
        <Button variant="secondary" size="xs" loading={isRestarting} onClick={onRestart}>Restart</Button>
      </div>
    </div>
  )
}

// Suppress unused warning for StatColor since it's used in inference
const _unused: StatColor = 'default'
void _unused

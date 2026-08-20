import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import { Card, CardBody } from '../components/Card'
import StatCard from '../components/StatCard'
import Badge from '../components/Badge'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './TaskQueuePage.module.css'

interface Task {
  id: string
  title: string
  status: string
  priority: string
  assignedTo?: string
  /** Display name resolved server-side. Falls back to the uuid when
   *  the agent has been deleted or the id doesn't match. */
  assignedToName?: string | null
  ownerId: string
  ownerName?: string | null
  createdAt: string
}

interface TaskStats {
  total: number
  pending: number
  inProgress: number
  completed: number
  failed: number
}

interface Agent {
  id: string
  name: string
  role?: string
}

/** /api/agents may return either a flat { agents: [] } or the org-chart shape
 *  { director, sysadmins, specialists }. Flatten both into a name lookup so
 *  the table can show readable names instead of opaque ids. */
interface AgentsResponse {
  agents?: Agent[]
  director?: Agent
  sysadmins?: Agent[]
  specialists?: Agent[]
}

function flattenAgents(res: AgentsResponse | null | undefined): Agent[] {
  if (!res) return []
  if (Array.isArray(res.agents)) return res.agents
  const out: Agent[] = []
  if (res.director) out.push(res.director)
  if (Array.isArray(res.sysadmins))   out.push(...res.sysadmins)
  if (Array.isArray(res.specialists)) out.push(...res.specialists)
  return out
}

type BadgeVariant = 'warning' | 'accent' | 'success' | 'danger' | 'neutral'
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: 'warning',
  in_progress: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  assigned: 'accent',
  dropped: 'neutral',
  blocked: 'danger',
  rolling_back: 'warning',
  rolled_back: 'neutral',
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  assigned: 'Assigned',
  dropped: 'Dropped',
  blocked: 'Blocked',
  rolling_back: 'Rolling Back',
  rolled_back: 'Rolled Back',
}

export default function TaskQueuePage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [stats, setStats] = useState<TaskStats>({ total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 })
  const [agentNames, setAgentNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const { lastEvent } = useWebSocket()

  const fetchData = useCallback(() => {
    Promise.all([
      api.get<{ tasks: Task[] }>('/api/task-queue'),
      api.get<TaskStats>('/api/task-queue/stats'),
      api.get<AgentsResponse>('/api/agents').catch(() => ({} as AgentsResponse)),
    ]).then(([queue, s, agentsRes]) => {
      setTasks(Array.isArray(queue?.tasks) ? queue.tasks : [])
      setStats(s ?? { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 })
      const map: Record<string, string> = {}
      for (const a of flattenAgents(agentsRes)) {
        if (a?.id && a?.name) map[a.id] = a.name
      }
      setAgentNames(map)
    }).finally(() => setLoading(false))
  }, [])

  /** Look up an agent's display name by id. Falls back to the raw id when
   *  unknown so we never render "undefined" or lose the value. */
  const resolveAgent = (idOrName?: string | null): string => {
    if (!idOrName) return '—'
    return agentNames[idOrName] ?? idOrName
  }

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (
      lastEvent?.type === 'task_completed' ||
      lastEvent?.type === 'task_failed' ||
      lastEvent?.type === 'task_created' ||
      lastEvent?.type === 'task_updated'
    ) {
      fetchData()
    }
  }, [lastEvent, fetchData])

  const filtered = tasks.filter(t => {
    const matchesStatus = statusFilter === 'all' || t.status === statusFilter
    const matchesSearch = !search || t.title.toLowerCase().includes(search.toLowerCase()) || t.id.toLowerCase().includes(search.toLowerCase())
    return matchesStatus && matchesSearch
  })

  return (
    <Layout title="Task Queue" subtitle="Monitor and manage agent tasks">
      <div className={styles.statsRow}>
        <StatCard label="Total" value={stats.total} color="default" />
        <StatCard label="Pending" value={stats.pending} color="warning" />
        <StatCard label="In Progress" value={stats.inProgress} color="accent" />
        <StatCard label="Completed" value={stats.completed} color="success" />
      </div>

      <Card>
        <CardBody>
          <div className={styles.toolbar}>
            <input
              className={styles.search}
              placeholder="Search tasks…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select
              className={styles.select}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {loading ? (
            <div className={styles.loading}>Loading tasks…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon="📋"
              title="No tasks found"
              description={statusFilter !== 'all' || search ? 'No tasks match your filters.' : 'No tasks in the queue yet.'}
            />
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>Task ID</th>
                  <th className={styles.th}>Title</th>
                  <th className={styles.th}>Status</th>
                  <th className={styles.th}>Agent</th>
                  <th className={styles.th}>Created</th>
                  <th className={styles.th}>Priority</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(task => (
                  <tr key={task.id} className={styles.tr}>
                    <td className={styles.td} style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text2)' }}>
                      {task.id.slice(0, 8)}…
                    </td>
                    <td className={styles.td}>{task.title}</td>
                    <td className={styles.td}>
                      <Badge variant={STATUS_VARIANT[task.status] ?? 'neutral'}>
                        {STATUS_LABEL[task.status] ?? task.status}
                      </Badge>
                    </td>
                    <td
                      className={styles.td}
                      style={{ color: 'var(--text2)' }}
                      title={task.assignedTo ?? task.ownerId ?? ''}
                    >
                      {/* Prefer the server-side enrichment when present —
                       *  buildTaskQueuePayload joins agent ids → names so the
                       *  client doesn't have to. Fall back to the client-side
                       *  agent map (resolveAgent) for older payloads or for
                       *  ids that the server couldn't resolve (deleted
                       *  agents). */}
                      {task.assignedToName
                        ?? task.ownerName
                        ?? resolveAgent(task.assignedTo ?? task.ownerId)}
                    </td>
                    <td className={styles.td} style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                      {new Date(task.createdAt).toLocaleString()}
                    </td>
                    <td className={styles.td}>
                      <Badge variant={
                        task.priority === 'high' ? 'danger' :
                        task.priority === 'medium' ? 'warning' :
                        'neutral'
                      }>
                        {task.priority ?? '—'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
    </Layout>
  )
}

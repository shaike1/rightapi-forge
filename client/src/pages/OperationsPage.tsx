import { useState, useEffect, useCallback, useRef } from 'react'
import Layout from '../components/Layout'
import StatCard from '../components/StatCard'
import { Card, CardBody } from '../components/Card'
import { api } from '../lib/api'
import { useWebSocket } from '../hooks/useWebSocket'
import styles from './OperationsPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Task {
  id: string
  title: string
  status: string
  priority: string
  assignedTo?: string | null
  ownerId: string
  createdAt: string
  updatedAt?: string
  completedAt?: string | null
}

interface Agent {
  id: string
  name: string
  role: string
  status?: string
}

interface AgentTree {
  director?: Agent
  sysadmins?: Agent[]
  specialists?: Agent[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set(['pending', 'assigned', 'in_progress'])

function elapsed(createdAt: string): string {
  const s = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function isToday(dateStr: string | null | undefined): boolean {
  if (!dateStr) return false
  const d = new Date(dateStr)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'pending': return `${styles.badge} ${styles.badgePending}`
    case 'assigned': return `${styles.badge} ${styles.badgeAssigned}`
    case 'in_progress': return `${styles.badge} ${styles.badgeInProgress}`
    case 'completed': return `${styles.badge} ${styles.badgeCompleted}`
    case 'failed': return `${styles.badge} ${styles.badgeFailed}`
    default: return `${styles.badge} ${styles.badgeGray}`
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: 'Pending', assigned: 'Assigned', in_progress: 'In Progress',
    completed: 'Completed', failed: 'Failed', blocked: 'Blocked',
  }
  return map[status] ?? status
}

function flattenAgents(tree: AgentTree | null | undefined): Agent[] {
  const list: Agent[] = []
  if (!tree) return list
  if (tree.director) list.push(tree.director)
  if (Array.isArray(tree.sysadmins)) list.push(...tree.sysadmins)
  if (Array.isArray(tree.specialists)) list.push(...tree.specialists)
  return list
}

// ── Reassign Dropdown ─────────────────────────────────────────────────────────

interface ReassignDropdownProps {
  taskId: string
  agents: Agent[]
  onReassigned: () => void
}

function ReassignDropdown({ taskId, agents, onReassigned }: ReassignDropdownProps) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  async function handleSelect(agentId: string) {
    setOpen(false)
    setBusy(true)
    try {
      await api.patch(`/api/task-queue/${taskId}`, { assignedTo: agentId })
      onReassigned()
    } catch {
      // silently ignore
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.reassignWrap} ref={ref}>
      <button
        className={styles.reassignBtn}
        onClick={() => setOpen(v => !v)}
        disabled={busy}
        title="Reassign task"
      >
        {busy ? '…' : 'Reassign ▼'}
      </button>
      {open && (
        <div className={styles.reassignDropdown}>
          {agents.length === 0 ? (
            <div className={styles.empty}>No agents</div>
          ) : (
            agents.map(a => (
              <button
                key={a.id}
                className={styles.reassignOption}
                onClick={() => handleSelect(a.id)}
              >
                {a.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function OperationsPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [fadingOut, setFadingOut] = useState<Set<string>>(new Set())

  const { connected, lastEvent } = useWebSocket()

  const fetchData = useCallback(async () => {
    try {
      const [queueRes, agentsRes] = await Promise.all([
        api.get<{ tasks: Task[] }>('/api/task-queue'),
        api.get<AgentTree>('/api/agents'),
      ])
      setTasks(Array.isArray(queueRes?.tasks) ? queueRes.tasks : [])
      setAgents(flattenAgents(agentsRes))
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Patch tasks in-place from WS events, or refetch
  useEffect(() => {
    if (!lastEvent) return
    const { type, data } = lastEvent

    if (type === 'task_created') {
      const task = data as Task
      if (task?.id) {
        setTasks(prev => [task, ...prev.filter(t => t.id !== task.id)])
      } else {
        fetchData()
      }
    } else if (type === 'task_updated') {
      const task = data as Task
      if (task?.id) {
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...task } : t))
      } else {
        fetchData()
      }
    } else if (type === 'task_completed' || type === 'task_failed') {
      const task = data as Task
      if (task?.id) {
        // Update status then fade out
        setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...task } : t))
        setFadingOut(prev => new Set([...prev, task.id]))
        setTimeout(() => {
          setTasks(prev => prev.filter(t => t.id !== task.id))
          setFadingOut(prev => { const s = new Set(prev); s.delete(task.id); return s })
        }, 1500)
      } else {
        fetchData()
      }
    } else if (type === 'agents') {
      fetchData()
    }
  }, [lastEvent, fetchData])

  // Derived stats
  const activeTasks = tasks.filter(t => t.status === 'in_progress')
  const pendingTasks = tasks.filter(t => t.status === 'pending' || t.status === 'assigned')
  const completedToday = tasks.filter(t => t.status === 'completed' && isToday(t.completedAt ?? t.updatedAt))
  const failedToday = tasks.filter(t => t.status === 'failed' && isToday(t.updatedAt))

  // Active feed (pending + assigned + in_progress)
  const activeFeed = tasks.filter(t => ACTIVE_STATUSES.has(t.status))

  // Agent activity: map assignedTo → task
  const agentTaskMap = new Map<string, Task>()
  activeFeed.forEach(t => { if (t.assignedTo) agentTaskMap.set(t.assignedTo, t) })

  return (
    <Layout title="Live Operations" subtitle="Real-time task and agent activity">
      {/* Stats row */}
      <div className={styles.statsRow}>
        <StatCard label="Active Tasks" value={activeTasks.length} color="accent" />
        <StatCard label="Pending" value={pendingTasks.length} color="warning" />
        <StatCard label="Completed Today" value={completedToday.length} color="success" />
        <StatCard label="Failed Today" value={failedToday.length} color="danger" />
      </div>

      {/* Two-column layout */}
      <div className={styles.twoCol}>
        {/* Left: Active Task Feed */}
        <Card>
          <CardBody>
            <div className={styles.headerRow}>
              <span className={styles.sectionTitle}>Active Task Feed</span>
              <span className={styles.liveIndicator} data-connected={connected}>
                {connected ? '● Live' : '○ Connecting…'}
              </span>
            </div>
            <div className={styles.taskFeed}>
              {activeFeed.length === 0 ? (
                <div className={styles.empty}>No active tasks</div>
              ) : (
                activeFeed.map(task => (
                  <div
                    key={task.id}
                    className={`${styles.taskRow} ${fadingOut.has(task.id) ? styles.fadeOut : ''}`}
                  >
                    <span className={statusBadgeClass(task.status)}>
                      {statusLabel(task.status)}
                    </span>
                    <span className={styles.taskTitle} title={task.title}>{task.title}</span>
                    {task.assignedTo && (
                      <span className={styles.taskMeta} title="Assigned to">{task.assignedTo}</span>
                    )}
                    <span className={styles.taskMeta} title="Owner">{task.ownerId}</span>
                    <span className={styles.taskElapsed}>{elapsed(task.createdAt)}</span>
                    <ReassignDropdown
                      taskId={task.id}
                      agents={agents}
                      onReassigned={fetchData}
                    />
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>

        {/* Right: Agent Activity */}
        <Card>
          <CardBody>
            <div className={styles.headerRow}>
              <span className={styles.sectionTitle}>Agent Activity</span>
            </div>
            <div className={styles.agentList}>
              {agents.length === 0 ? (
                <div className={styles.empty}>No agents found</div>
              ) : (
                agents.map(agent => {
                  const currentTask = agentTaskMap.get(agent.id)
                  return (
                    <div key={agent.id} className={styles.agentRow}>
                      <span className={styles.agentName}>{agent.name}</span>
                      {currentTask ? (
                        <span className={statusBadgeClass(currentTask.status)}>
                          {statusLabel(currentTask.status)}
                        </span>
                      ) : (
                        <span className={`${styles.badge} ${styles.badgeGray}`}>idle</span>
                      )}
                      <span className={styles.agentTask} title={currentTask?.title}>
                        {currentTask?.title ?? '—'}
                      </span>
                    </div>
                  )
                })
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </Layout>
  )
}

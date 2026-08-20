import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { Card, CardHeader, CardBody } from '../components/Card'
import Button from '../components/Button'
import Badge from '../components/Badge'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import StatCard from '../components/StatCard'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './A2APage.module.css'

interface A2AAgent {
  id: string
  name: string
  type: string
  status: 'idle' | 'busy' | 'error' | 'offline'
  endpoint: string
  capabilities: string[]
}

interface A2ATask {
  id: string
  fromAgent: string
  toAgent: string
  message: string
  status: string
  createdAt: string
  response?: string
}

type StatusVariant = 'accent' | 'warning' | 'danger' | 'neutral'
const STATUS_VARIANT: Record<A2AAgent['status'], StatusVariant> = {
  idle: 'accent',
  busy: 'warning',
  error: 'danger',
  offline: 'neutral',
}

const STATUS_DOT: Record<A2AAgent['status'], string> = {
  idle: 'var(--success)',
  busy: 'var(--warning)',
  error: 'var(--danger)',
  offline: 'var(--text3)',
}

interface SendTaskForm {
  targetAgent: string
  message: string
  priority: string
}

export default function A2APage() {
  const { show } = useToast()
  const [agents, setAgents] = useState<A2AAgent[]>([])
  const [tasks, setTasks] = useState<A2ATask[]>([])
  const [loading, setLoading] = useState(true)
  const [sendModal, setSendModal] = useState(false)
  const [sending, setSending] = useState(false)
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [form, setForm] = useState<SendTaskForm>({ targetAgent: '', message: '', priority: 'normal' })

  useEffect(() => {
    Promise.all([
      api.get<{ agents: A2AAgent[] }>('/api/a2a/agents'),
      api.get<{ tasks: A2ATask[] }>('/api/a2a/tasks'),
    ])
      .then(([agentData, taskData]) => {
        const agentList = Array.isArray(agentData?.agents) ? agentData.agents : []
        const taskList = Array.isArray(taskData?.tasks) ? taskData.tasks : []
        setAgents(agentList)
        setTasks(taskList)
        if (agentList.length > 0) {
          setForm(f => ({ ...f, targetAgent: agentList[0].id }))
        }
      })
      .catch((err: unknown) => show((err as Error).message, 'error'))
      .finally(() => setLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSendTask = async () => {
    if (!form.targetAgent || !form.message.trim()) {
      show('Please select a target agent and enter a message', 'warning')
      return
    }
    setSending(true)
    try {
      await api.post('/api/a2a/tasks', form)
      const taskData = await api.get<{ tasks: A2ATask[] }>('/api/a2a/tasks')
      setTasks(Array.isArray(taskData?.tasks) ? taskData.tasks : [])
      setSendModal(false)
      setForm(f => ({ ...f, message: '' }))
      show('Task sent successfully', 'success')
    } catch (err: unknown) {
      show((err as Error).message, 'error')
    } finally {
      setSending(false)
    }
  }

  const toggleExpand = (id: string) => {
    setExpandedTask(prev => (prev === id ? null : id))
  }

  const activeAgents = agents.filter(a => a.status === 'idle' || a.status === 'busy').length
  const tasksDone = tasks.filter(t => t.status === 'completed').length

  return (
    <Layout
      title="A2A Agent Mesh"
      subtitle="Multi-agent communication and task routing"
      actions={
        <Button variant="primary" onClick={() => setSendModal(true)}>
          Send Task
        </Button>
      }
    >
      {/* Stats row */}
      <div className={styles.statsRow}>
        <StatCard label="Total Agents" value={agents.length} />
        <StatCard label="Active" value={activeAgents} color="success" />
        <StatCard label="Tasks Sent" value={tasks.length} />
        <StatCard label="Tasks Done" value={tasksDone} color="accent" />
      </div>

      {loading ? (
        <div className={styles.loading}>Loading…</div>
      ) : (
        <div className={styles.twoCol}>
          {/* Agent Registry */}
          <Card>
            <CardHeader title={`Agent Registry (${agents.length})`} />
            <CardBody>
              {agents.length === 0 ? (
                <EmptyState icon="🤖" title="No agents registered" description="No A2A agents are currently connected" />
              ) : (
                <div className={styles.agentList}>
                  {agents.map(agent => (
                    <AgentCard key={agent.id} agent={agent} />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Task Messages */}
          <Card>
            <CardHeader title={`Task Messages (${tasks.length})`} />
            <CardBody>
              {tasks.length === 0 ? (
                <EmptyState
                  icon="📨"
                  title="No tasks yet"
                  description="Send a task to route a message between agents"
                  action={{ label: 'Send Task', onClick: () => setSendModal(true) }}
                />
              ) : (
                <div className={styles.taskList}>
                  {tasks.map(task => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      expanded={expandedTask === task.id}
                      onToggle={() => toggleExpand(task.id)}
                    />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {/* Send Task Modal */}
      <Modal
        open={sendModal}
        onClose={() => setSendModal(false)}
        title="Send Agent Task"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSendModal(false)}>Cancel</Button>
            <Button variant="primary" loading={sending} onClick={handleSendTask}>Send Task</Button>
          </>
        }
      >
        <div className={styles.formField}>
          <label className={styles.fieldLabel}>Target Agent</label>
          <select
            value={form.targetAgent}
            onChange={e => setForm(f => ({ ...f, targetAgent: e.target.value }))}
            className={styles.select}
          >
            {agents.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
            ))}
          </select>
        </div>
        <div className={styles.formField}>
          <label className={styles.fieldLabel}>Priority</label>
          <select
            value={form.priority}
            onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            className={styles.select}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className={styles.formField}>
          <label className={styles.fieldLabel}>Message</label>
          <textarea
            value={form.message}
            onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
            placeholder="Describe the task for the target agent…"
            rows={5}
            className={styles.textarea}
          />
        </div>
      </Modal>
    </Layout>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: A2AAgent }) {
  return (
    <div className={styles.agentCard}>
      <div className={styles.agentHeader}>
        <div className={styles.agentNameRow}>
          <span
            className={styles.statusDot}
            style={{ background: STATUS_DOT[agent.status] }}
          />
          <strong className={styles.agentName}>{agent.name}</strong>
        </div>
        <div className={styles.agentBadges}>
          <Badge variant={STATUS_VARIANT[agent.status]}>{agent.status}</Badge>
          <Badge variant="neutral">{agent.type}</Badge>
        </div>
      </div>
      <div className={styles.agentEndpoint}>{agent.endpoint}</div>
      {agent.capabilities.length > 0 && (
        <div className={styles.capTags}>
          {agent.capabilities.map(cap => (
            <span key={cap} className={styles.capTag}>{cap}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function TaskItem({ task, expanded, onToggle }: { task: A2ATask; expanded: boolean; onToggle: () => void }) {
  const statusVariantMap: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
    completed: 'success',
    pending: 'warning',
    failed: 'danger',
    processing: 'info',
  }
  const variant = statusVariantMap[task.status] ?? 'neutral'

  return (
    <div className={styles.taskItem}>
      <div className={styles.taskHeader} onClick={onToggle}>
        <div className={styles.taskContent}>
          <div className={styles.taskRoute}>
            <span className={styles.taskRouteStrong}>{task.fromAgent}</span>
            {' → '}
            <span className={styles.taskRouteStrong}>{task.toAgent}</span>
          </div>
          <div className={styles.taskMessage}>{task.message}</div>
        </div>
        <div className={styles.taskMeta}>
          <Badge variant={variant}>{task.status}</Badge>
          <span className={styles.taskTime}>{new Date(task.createdAt).toLocaleTimeString()}</span>
          <span className={styles.taskChevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>
      {expanded && (
        <div className={styles.taskExpanded}>
          <div className={styles.taskSectionLabel}>Full Message</div>
          <div className={styles.taskFullMessage}>{task.message}</div>
          {task.response && (
            <>
              <div className={styles.taskSectionLabel}>Response</div>
              <pre className={styles.response}>{task.response}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

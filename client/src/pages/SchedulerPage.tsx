import { useEffect, useState } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Badge from '../components/Badge'
import { Card, CardBody } from '../components/Card'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { api } from '../lib/api'
import { toast } from '../hooks/useToast'
import type { ScheduledTask } from '../lib/types'
import styles from './SchedulerPage.module.css'

interface TaskForm {
  name: string
  cron: string
  action: string
}

interface HistoryEntry {
  index: number
  started: string
  duration?: string
  status: string
  output?: string
}

const EMPTY_FORM: TaskForm = { name: '', cron: '', action: '' }

function lastStatusVariant(status?: string) {
  if (!status) return 'neutral'
  if (status === 'success') return 'success'
  if (status === 'failed' || status === 'error') return 'danger'
  if (status === 'running') return 'accent'
  return 'neutral'
}

function formatDate(ts?: string) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function SchedulerPage() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<TaskForm>(EMPTY_FORM)
  const [formErrors, setFormErrors] = useState<Partial<TaskForm>>({})
  const [submitting, setSubmitting] = useState(false)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null)
  const [editForm, setEditForm] = useState<TaskForm>(EMPTY_FORM)
  const [editErrors, setEditErrors] = useState<Partial<TaskForm>>({})
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null)

  async function fetchTasks() {
    try {
      const data = await api.get<{ tasks: ScheduledTask[] } | ScheduledTask[]>('/api/scheduler/tasks')
      const list = Array.isArray(data) ? data : data?.tasks
      setTasks(Array.isArray(list) ? list : [])
    } catch {
      toast.error('Failed to load scheduled tasks')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchTasks()
  }, [])

  function validateForm(): boolean {
    const errors: Partial<TaskForm> = {}
    if (!form.name.trim()) errors.name = 'Name is required'
    if (!form.cron.trim()) errors.cron = 'Cron expression is required'
    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function handleAddTask() {
    if (!validateForm()) return
    setSubmitting(true)
    try {
      await api.post('/api/scheduler/tasks', {
        name: form.name.trim(),
        cron: form.cron.trim(),
        action: form.action.trim(),
        enabled: true,
      })
      toast.success('Task created')
      setShowAdd(false)
      setForm(EMPTY_FORM)
      setFormErrors({})
      fetchTasks()
    } catch {
      toast.error('Failed to create task')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleToggle(task: ScheduledTask) {
    setTogglingIds(prev => new Set(prev).add(task.id))
    try {
      await api.put(`/api/scheduler/tasks/${task.id}`, { enabled: !task.enabled })
      setTasks(prev =>
        prev.map(t => (t.id === task.id ? { ...t, enabled: !t.enabled } : t)),
      )
    } catch {
      toast.error('Failed to update task')
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }

  async function handleRunNow(id: string) {
    setRunningIds(prev => new Set(prev).add(id))
    try {
      await api.post(`/api/scheduler/tasks/${id}/run`)
      toast.success('Task triggered')
      setTimeout(fetchTasks, 1000)
    } catch {
      toast.error('Failed to run task')
    } finally {
      setRunningIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete task "${name}"? This cannot be undone.`)) return
    try {
      await api.delete(`/api/scheduler/tasks/${id}`)
      toast.success('Task deleted')
      setTasks(prev => prev.filter(t => t.id !== id))
    } catch {
      toast.error('Failed to delete task')
    }
  }

  async function handleEditSave() {
    const errors: Partial<TaskForm> = {}
    if (!editForm.name.trim()) errors.name = 'Name is required'
    if (!editForm.cron.trim()) errors.cron = 'Cron expression is required'
    setEditErrors(errors)
    if (Object.keys(errors).length > 0) return
    setEditSubmitting(true)
    try {
      await api.put(`/api/scheduler/tasks/${editTask!.id}`, {
        name: editForm.name.trim(),
        cron: editForm.cron.trim(),
        action: editForm.action.trim(),
      })
      toast.success('Task updated')
      setEditTask(null)
      fetchTasks()
    } catch {
      toast.error('Failed to update task')
    } finally {
      setEditSubmitting(false)
    }
  }

  function openEdit(task: ScheduledTask) {
    setEditTask(task)
    setEditForm({ name: task.name, cron: task.cron, action: task.action || '' })
    setEditErrors({})
  }

  function closeEditModal() {
    setEditTask(null)
    setEditForm(EMPTY_FORM)
    setEditErrors({})
  }

  function getHistoryEntries(task: ScheduledTask): HistoryEntry[] {
    if (!task.lastRun) return []
    return [{ index: 1, started: task.lastRun, status: task.lastStatus || 'unknown' }]
  }

  function closeModal() {
    setShowAdd(false)
    setForm(EMPTY_FORM)
    setFormErrors({})
  }

  return (
    <Layout
      title="Scheduler"
      subtitle="Manage and trigger scheduled automation tasks"
      actions={
        <Button variant="primary" onClick={() => setShowAdd(true)}>
          + Add Task
        </Button>
      }
    >
      {!loading && tasks.length === 0 ? (
        <EmptyState
          icon="⏰"
          title="No scheduled tasks"
          description="Create your first scheduled task to automate recurring operations."
          action={{ label: '+ Add Task', onClick: () => setShowAdd(true) }}
        />
      ) : (
        <Card>
          <CardBody>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Schedule</th>
                    <th>Next Run</th>
                    <th>Last Run</th>
                    <th>Status</th>
                    <th>Enabled</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map(task => (
                    <tr key={task.id}>
                      <td>
                        <div className={styles.taskName}>{task.name}</div>
                        {task.action && (
                          <div className={styles.taskAction}>{task.action}</div>
                        )}
                      </td>
                      <td>
                        <code className={styles.cronCode}>{task.cron}</code>
                      </td>
                      <td className={styles.dateCell}>{formatDate(task.nextRun)}</td>
                      <td className={styles.dateCell}>{formatDate(task.lastRun)}</td>
                      <td>
                        {task.lastStatus ? (
                          <Badge variant={lastStatusVariant(task.lastStatus)}>
                            {task.lastStatus}
                          </Badge>
                        ) : (
                          <span className={styles.na}>—</span>
                        )}
                      </td>
                      <td>
                        <label className={styles.toggle}>
                          <input
                            type="checkbox"
                            checked={task.enabled}
                            disabled={togglingIds.has(task.id)}
                            onChange={() => handleToggle(task)}
                          />
                          <span className={styles.toggleSlider} />
                        </label>
                      </td>
                      <td>
                        <div className={styles.actionBtns}>
                          <Button
                            variant="ghost"
                            size="xs"
                            loading={runningIds.has(task.id)}
                            onClick={() => handleRunNow(task.id)}
                          >
                            ▶ Run
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => openEdit(task)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setHistoryTask(task)}
                          >
                            📋 History
                          </Button>
                          <Button
                            variant="danger"
                            size="xs"
                            onClick={() => handleDelete(task.id, task.name)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

      {/* Add Task Modal */}
      <Modal
        open={showAdd}
        onClose={closeModal}
        title="Add Scheduled Task"
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>
              Cancel
            </Button>
            <Button variant="primary" loading={submitting} onClick={handleAddTask}>
              Create Task
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <label className={styles.formLabel}>
            Task Name <span className={styles.required}>*</span>
            <input
              className={`${styles.input} ${formErrors.name ? styles.inputError : ''}`}
              value={form.name}
              onChange={e => {
                setForm(f => ({ ...f, name: e.target.value }))
                if (formErrors.name) setFormErrors(fe => ({ ...fe, name: undefined }))
              }}
              placeholder="Daily database backup"
            />
            {formErrors.name && (
              <span className={styles.errorText}>{formErrors.name}</span>
            )}
          </label>

          <label className={styles.formLabel}>
            Cron Expression <span className={styles.required}>*</span>
            <input
              className={`${styles.input} ${formErrors.cron ? styles.inputError : ''}`}
              value={form.cron}
              onChange={e => {
                setForm(f => ({ ...f, cron: e.target.value }))
                if (formErrors.cron) setFormErrors(fe => ({ ...fe, cron: undefined }))
              }}
              placeholder="0 2 * * *"
              style={{ fontFamily: 'monospace' }}
            />
            {formErrors.cron ? (
              <span className={styles.errorText}>{formErrors.cron}</span>
            ) : (
              <span className={styles.hint}>e.g. 0 2 * * * (daily at 2am)</span>
            )}
          </label>

          <label className={styles.formLabel}>
            Action / Command
            <input
              className={styles.input}
              value={form.action}
              onChange={e => setForm(f => ({ ...f, action: e.target.value }))}
              placeholder="scripts/backup.sh"
            />
          </label>
        </div>
      </Modal>

      {/* Edit Task Modal */}
      <Modal
        open={editTask !== null}
        onClose={closeEditModal}
        title="Edit Task"
        footer={
          <>
            <Button variant="ghost" onClick={closeEditModal}>
              Cancel
            </Button>
            <Button variant="primary" loading={editSubmitting} onClick={handleEditSave}>
              Save Changes
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <label className={styles.formLabel}>
            Task Name <span className={styles.required}>*</span>
            <input
              className={`${styles.input} ${editErrors.name ? styles.inputError : ''}`}
              value={editForm.name}
              onChange={e => {
                setEditForm(f => ({ ...f, name: e.target.value }))
                if (editErrors.name) setEditErrors(fe => ({ ...fe, name: undefined }))
              }}
              placeholder="Daily database backup"
            />
            {editErrors.name && (
              <span className={styles.errorText}>{editErrors.name}</span>
            )}
          </label>

          <label className={styles.formLabel}>
            Cron Expression <span className={styles.required}>*</span>
            <input
              className={`${styles.input} ${editErrors.cron ? styles.inputError : ''}`}
              value={editForm.cron}
              onChange={e => {
                setEditForm(f => ({ ...f, cron: e.target.value }))
                if (editErrors.cron) setEditErrors(fe => ({ ...fe, cron: undefined }))
              }}
              placeholder="0 2 * * *"
              style={{ fontFamily: 'monospace' }}
            />
            {editErrors.cron ? (
              <span className={styles.errorText}>{editErrors.cron}</span>
            ) : (
              <span className={styles.hint}>e.g. 0 2 * * * (daily at 2am)</span>
            )}
          </label>

          <label className={styles.formLabel}>
            Action / Command
            <input
              className={styles.input}
              value={editForm.action}
              onChange={e => setEditForm(f => ({ ...f, action: e.target.value }))}
              placeholder="scripts/backup.sh"
            />
          </label>
        </div>
      </Modal>

      {/* Run History Modal */}
      <Modal
        open={historyTask !== null}
        onClose={() => setHistoryTask(null)}
        title={historyTask ? `Run History — ${historyTask.name}` : 'Run History'}
        footer={
          <Button variant="ghost" onClick={() => setHistoryTask(null)}>
            Close
          </Button>
        }
      >
        {historyTask && (() => {
          const entries = getHistoryEntries(historyTask)
          return entries.length === 0 ? (
            <p className={styles.historyEmpty}>No run history available for this task.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Status</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.index}>
                      <td className={styles.dateCell}>{entry.index}</td>
                      <td className={styles.dateCell}>{formatDate(entry.started)}</td>
                      <td className={styles.dateCell}>{entry.duration ?? '—'}</td>
                      <td>
                        <Badge variant={lastStatusVariant(entry.status)}>
                          {entry.status}
                        </Badge>
                      </td>
                      <td className={styles.historyOutput}>{entry.output ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })()}
      </Modal>
    </Layout>
  )
}

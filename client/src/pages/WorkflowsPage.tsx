import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import Button from '../components/Button'
import Modal from '../components/Modal'
import EmptyState from '../components/EmptyState'
import { Card, CardBody, CardFooter } from '../components/Card'
import { api } from '../lib/api'
import { useToast } from '../hooks/useToast'
import styles from './WorkflowsPage.module.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WorkflowStep {
  id?: string
  name?: string
  type?: string
}

interface Workflow {
  id: string
  name: string
  description?: string
  steps: WorkflowStep[]
  createdAt: string
  status?: string
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function WorkflowsPage() {
  const { show } = useToast()

  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', description: '' })
  const [submitting, setSubmitting] = useState(false)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Run loading per workflow id
  const [runLoading, setRunLoading] = useState<Record<string, boolean>>({})

  const fetchWorkflows = useCallback(async () => {
    try {
      const data = await api.get<{ templates: Workflow[] } | Workflow[]>('/api/workflows')
      const list = Array.isArray(data) ? data : data?.templates
      setWorkflows(Array.isArray(list) ? list : [])
    } catch (err) {
      show(err instanceof Error ? err.message : 'Failed to load workflows', 'error')
    } finally {
      setLoading(false)
    }
  }, [show])

  useEffect(() => { fetchWorkflows() }, [fetchWorkflows])

  // ── Create ────────────────────────────────────────────────────────────────────

  const createWorkflow = async () => {
    if (!form.name.trim()) { show('Name is required', 'error'); return }
    setSubmitting(true)
    try {
      await api.post('/api/workflows', {
        name: form.name.trim(),
        description: form.description || undefined,
        steps: [],
      })
      show('Workflow created', 'success')
      setShowCreate(false)
      setForm({ name: '', description: '' })
      fetchWorkflows()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Create failed', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────────

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/workflows/${deleteTarget.id}`)
      show('Workflow deleted', 'info')
      setDeleteTarget(null)
      fetchWorkflows()
    } catch (err) {
      show(err instanceof Error ? err.message : 'Delete failed', 'error')
    } finally {
      setDeleting(false)
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────────

  const runWorkflow = async (wf: Workflow) => {
    setRunLoading(p => ({ ...p, [wf.id]: true }))
    try {
      await api.post(`/api/workflows/${wf.id}/run`)
      show(`Workflow "${wf.name}" triggered`, 'success')
    } catch (err) {
      show(err instanceof Error ? err.message : 'Run failed', 'error')
    } finally {
      setRunLoading(p => { const n = { ...p }; delete n[wf.id]; return n })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Layout
      title="Workflows"
      subtitle="Manage and trigger automation workflow templates"
      actions={
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
          + Create Template
        </Button>
      }
    >
      {loading ? (
        <div className={styles.loading}>Loading workflows…</div>
      ) : workflows.length === 0 ? (
        <EmptyState
          icon="⚡"
          title="No workflows yet"
          description="Create your first workflow template"
          action={{ label: '+ Create Template', onClick: () => setShowCreate(true) }}
        />
      ) : (
        <div className={styles.grid}>
          {workflows.map(wf => (
            <Card key={wf.id} className={styles.card}>
              <CardBody>
                <div className={styles.cardName}>{wf.name}</div>
                {wf.description && (
                  <div className={styles.cardDesc}>{wf.description}</div>
                )}
                <div className={styles.cardMeta}>
                  <span className={styles.metaItem}>
                    <span className={styles.metaIcon}>⚙️</span>
                    {wf.steps.length} step{wf.steps.length !== 1 ? 's' : ''}
                  </span>
                  <span className={styles.metaItem}>
                    <span className={styles.metaIcon}>📅</span>
                    {new Date(wf.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </CardBody>
              <CardFooter>
                <div className={styles.cardActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={runLoading[wf.id]}
                    onClick={() => runWorkflow(wf)}
                  >
                    ▶ Run
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleteTarget(wf)}
                  >
                    Delete
                  </Button>
                </div>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}

      {/* Create Template Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Create Workflow Template"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={submitting} onClick={createWorkflow}>
              Create
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <label className={styles.label}>
            Name <span className={styles.required}>*</span>
          </label>
          <input
            className={styles.input}
            placeholder="Workflow name"
            value={form.name}
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && createWorkflow()}
          />

          <label className={styles.label}>Description</label>
          <textarea
            className={styles.textarea}
            placeholder="What does this workflow do? (optional)"
            rows={3}
            value={form.description}
            onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
          />
        </div>
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Workflow"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" size="sm" loading={deleting} onClick={confirmDelete}>
              Delete
            </Button>
          </>
        }
      >
        <p className={styles.confirmText}>
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
        </p>
      </Modal>
    </Layout>
  )
}

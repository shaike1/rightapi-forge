// Visual workflow builder built on React Flow (@xyflow/react).
//
// The page composes three pieces:
//   - StepNode (custom React Flow node component)
//   - PropertyEditor (right pane)
//   - the palette + toolbar + canvas wiring (this file)
//
// Round-trip with the server:
//   GET  /api/workflows/json   → existing user workflows
//   GET  /api/runbooks         → bundled library
//   POST /api/workflows/json/validate
//   POST /api/workflows/json   → save (in-memory register)
//   POST /api/workflows/json/:id/run
//
// Internal model: each React Flow node carries the WorkflowDef step
// shape inside `data` (plus a generated stepId). We rebuild the
// WorkflowDef on demand for save/validate/run; the canvas is the
// editor's source of truth.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import Layout from '../components/Layout'
import Button from '../components/Button'
import { useToast } from '../hooks/useToast'
import { api } from '../lib/api'

import StepNode, { type StepNodeData, type StepFlowNode } from './workflowBuilder/StepNode'
import PropertyEditor from './workflowBuilder/PropertyEditor'
import { STEP_TYPES, defaultsFor, type StepType } from './workflowBuilder/stepTypes'
import styles from './WorkflowBuilderPage.module.css'

// Single-instance node-type registration so React Flow doesn't warn
// about a fresh object on every render.
const nodeTypes = { step: StepNode }

interface RunResult {
  runId: string
  status: 'completed' | 'failed' | 'pending_approval'
  error?: string
  steps: Array<{ id: string; status: string; error?: string }>
}

interface WorkflowSummary { id: string; name: string; version: string; steps: number }
interface RunbookSummary  { id: string; name: string; version: string; tags?: string[]; steps: number }

export default function WorkflowBuilderPage() {
  return (
    <Layout title="Workflow Builder" subtitle="Design, save, and run JSON-defined workflows visually.">
      <ReactFlowProvider>
        <Builder />
      </ReactFlowProvider>
    </Layout>
  )
}

function Builder() {
  const { show } = useToast()

  // Workflow metadata.
  const [meta, setMeta] = useState({
    id: 'my-workflow',
    name: 'New Workflow',
    version: '1.0.0',
    description: '',
    defaultOnError: 'fail',
  })

  // React Flow state.
  const [nodes, setNodes] = useState<StepFlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Status line + last run record (rendered in the right pane).
  const [status, setStatus] = useState<{ text: string; level?: 'ok' | 'danger' }>({ text: '' })
  const [lastRun, setLastRun] = useState<RunResult | null>(null)

  // Sidebar lists.
  const [savedWorkflows, setSavedWorkflows] = useState<WorkflowSummary[]>([])
  const [runbooks, setRunbooks] = useState<RunbookSummary[]>([])

  // Ref counter for new step ids.
  const nextStepIdRef = useRef(1)

  // ── Load saved workflows + runbook library on mount ──────────────────────
  useEffect(() => {
    api.get<{ workflows: WorkflowSummary[] }>('/api/workflows/json')
      .then(r => setSavedWorkflows(r.workflows ?? []))
      .catch(() => { /* listing is best-effort */ })
    api.get<{ runbooks: RunbookSummary[] }>('/api/runbooks')
      .then(r => setRunbooks(r.runbooks ?? []))
      .catch(() => { /* same */ })
  }, [])

  // ── React Flow change handlers ───────────────────────────────────────────
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns) as StepFlowNode[]),
    [],
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  )

  // Connect handler: edge style + label depends on the source handle.
  const onConnect = useCallback((conn: Connection) => {
    const styleClass =
      conn.sourceHandle === 'then' ? 'then'
      : conn.sourceHandle === 'else' ? 'else'
      : conn.sourceHandle === 'err'  ? 'err'
      : ''
    const label =
      conn.sourceHandle === 'then' ? 'then'
      : conn.sourceHandle === 'else' ? 'else'
      : conn.sourceHandle === 'err'  ? 'on err'
      : undefined
    setEdges((es) => addEdge({
      ...conn,
      id: `e-${conn.source}-${conn.target}-${conn.sourceHandle ?? 'out'}`,
      label,
      className: styleClass,
      animated: conn.sourceHandle === 'err',
    }, es))
  }, [])

  const onNodeClick = useCallback((_: React.MouseEvent, node: { id: string }) => {
    setSelectedId(node.id)
  }, [])
  const onPaneClick = useCallback(() => setSelectedId(null), [])

  // ── Drop a palette item onto the canvas ──────────────────────────────────
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/x-step-type') as StepType | ''
    if (!type) return
    if (!rfInstance || !wrapperRef.current) return

    const bounds = wrapperRef.current.getBoundingClientRect()
    const position = rfInstance.screenToFlowPosition({
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top,
    })
    const stepId = `step_${nextStepIdRef.current++}`
    const node: StepFlowNode = {
      id: stepId,
      type: 'step',
      position,
      data: { stepId, type, ...defaultsFor(type) } as StepNodeData,
    }
    setNodes((ns) => [...ns, node])
    setSelectedId(stepId)
  }, [rfInstance])

  // ── Property editor wiring ──────────────────────────────────────────────
  const selected = useMemo(
    () => nodes.find(n => n.id === selectedId) ?? null,
    [nodes, selectedId],
  )
  const siblingIds = useMemo(
    () => nodes.filter(n => n.id !== selectedId).map(n => n.id),
    [nodes, selectedId],
  )

  const updateSelectedData = useCallback((next: Record<string, unknown>) => {
    setNodes((ns) =>
      ns.map(n => n.id === selectedId ? { ...n, data: { ...n.data, ...next } as StepNodeData } : n),
    )
    // If the user renamed the step id, propagate to React Flow's node id
    // and rewrite any edges that referenced the old id.
    if (next.stepId && typeof next.stepId === 'string' && next.stepId !== selectedId) {
      const newId = next.stepId
      setNodes((ns) =>
        ns.map(n => n.id === selectedId ? { ...n, id: newId } : n),
      )
      setEdges((es) =>
        es.map(e => ({
          ...e,
          source: e.source === selectedId ? newId : e.source,
          target: e.target === selectedId ? newId : e.target,
        })),
      )
      setSelectedId(newId)
    }
  }, [selectedId])

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    setNodes((ns) => ns.filter(n => n.id !== selectedId))
    setEdges((es) => es.filter(e => e.source !== selectedId && e.target !== selectedId))
    setSelectedId(null)
  }, [selectedId])

  // ── Translate the canvas to/from a WorkflowDef ──────────────────────────
  const toWorkflowDef = useCallback(() => {
    // For each node, lift its `data` (already shaped like a step) into a
    // WorkflowDef step. Conditional then/else come from the matching
    // edges; onError.goto is preserved as-is on the node.
    const orderedNodes = [...nodes].sort((a, b) => a.position.y - b.position.y)
    const steps = orderedNodes.map(n => {
      const { type, stepId, ...rest } = n.data as Record<string, unknown> & { stepId: string; type: string }
      const step: Record<string, unknown> = { id: stepId, type, ...rest }
      if (type === 'conditional') {
        const thenEdge = edges.find(e => e.source === n.id && e.sourceHandle === 'then')
        const elseEdge = edges.find(e => e.source === n.id && e.sourceHandle === 'else')
        if (thenEdge) step.then = thenEdge.target
        if (elseEdge) step.else = elseEdge.target
      }
      return step
    })
    return {
      schemaVersion: 1,
      id: meta.id,
      name: meta.name,
      version: meta.version,
      description: meta.description,
      onError: meta.defaultOnError,
      steps,
    }
  }, [nodes, edges, meta])

  /** Lay out a loaded workflow on the canvas: stack nodes vertically,
   *  wire sequential edges between adjacent steps, conditional then/else
   *  via the source-handle ids, and onError.goto via the err handle. */
  const fromWorkflowDef = useCallback((wf: { id: string; name: string; version: string; description?: string; onError?: string; steps: Array<Record<string, unknown>> }) => {
    setMeta({
      id: wf.id,
      name: wf.name,
      version: wf.version,
      description: wf.description ?? '',
      defaultOnError: typeof wf.onError === 'string' ? wf.onError : 'fail',
    })
    const xCol = 60
    const yStep = 140
    const nextNodes: StepFlowNode[] = wf.steps.map((s, i) => {
      const stepId = String(s.id)
      return {
        id: stepId,
        type: 'step',
        position: { x: xCol, y: 60 + i * yStep },
        data: { ...(s as Record<string, unknown>), stepId, type: String(s.type) } as StepNodeData,
      }
    })
    const nextEdges: Edge[] = []
    for (let i = 0; i < wf.steps.length; i++) {
      const s = wf.steps[i] as Record<string, unknown>
      const id = String(s.id)
      if (s.type === 'conditional') {
        if (typeof s.then === 'string' && s.then) {
          nextEdges.push({ id: `e-${id}-${s.then}-then`, source: id, target: String(s.then), sourceHandle: 'then', label: 'then', className: 'then' })
        }
        if (typeof s.else === 'string' && s.else) {
          nextEdges.push({ id: `e-${id}-${s.else}-else`, source: id, target: String(s.else), sourceHandle: 'else', label: 'else', className: 'else' })
        }
      } else {
        const next = wf.steps[i + 1]
        if (next) {
          nextEdges.push({ id: `e-${id}-${String(next.id)}-out`, source: id, target: String(next.id), sourceHandle: 'out' })
        }
      }
      const oe = s.onError
      if (oe && typeof oe === 'object' && typeof (oe as { goto?: string }).goto === 'string') {
        const tgt = (oe as { goto: string }).goto
        if (tgt) {
          nextEdges.push({ id: `e-${id}-${tgt}-err`, source: id, target: tgt, sourceHandle: 'err', label: 'on err', className: 'err', animated: true })
        }
      }
    }
    setNodes(nextNodes)
    setEdges(nextEdges)
    setSelectedId(null)
    nextStepIdRef.current = wf.steps.length + 1
  }, [])

  // ── Toolbar actions ──────────────────────────────────────────────────────
  const importJson = useCallback(() => {
    const text = window.prompt('Paste WorkflowDef JSON:')
    if (!text) return
    try {
      const parsed = JSON.parse(text)
      fromWorkflowDef(parsed)
      setStatus({ text: `imported ${parsed.steps?.length ?? 0} step(s)`, level: 'ok' })
    } catch (err) {
      setStatus({ text: `import failed: ${(err as Error).message}`, level: 'danger' })
    }
  }, [fromWorkflowDef])

  const exportJson = useCallback(() => {
    const wf = toWorkflowDef()
    const text = JSON.stringify(wf, null, 2)
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => setStatus({ text: 'JSON copied to clipboard', level: 'ok' }),
        () => window.prompt('Copy:', text),
      )
    } else {
      window.prompt('Copy:', text)
    }
  }, [toWorkflowDef])

  const validate = useCallback(async () => {
    setStatus({ text: 'validating…' })
    try {
      const wf = toWorkflowDef()
      const res = await api.post<{ ok: boolean; errors?: Array<{ path: string; message: string }> }>(
        '/api/workflows/json/validate', wf,
      )
      if (res.ok) {
        setStatus({ text: 'valid', level: 'ok' })
      } else {
        const first = res.errors?.[0]
        setStatus({ text: `${res.errors?.length ?? 0} error(s) — ${first?.path}: ${first?.message}`, level: 'danger' })
      }
    } catch (err) {
      setStatus({ text: `validate failed: ${(err as Error).message}`, level: 'danger' })
    }
  }, [toWorkflowDef])

  const save = useCallback(async () => {
    setStatus({ text: 'saving…' })
    try {
      const wf = toWorkflowDef()
      const res = await api.post<{ success?: boolean; ok?: boolean; errors?: Array<{ path: string; message: string }> }>(
        '/api/workflows/json', wf,
      )
      if ('ok' in res && res.ok === false) {
        const first = res.errors?.[0]
        setStatus({ text: `save blocked — ${first?.path}: ${first?.message}`, level: 'danger' })
        return
      }
      setStatus({ text: 'saved (registered in memory)', level: 'ok' })
      show(`Saved workflow "${wf.id}"`, 'success')
      // Refresh the saved-workflows list.
      api.get<{ workflows: WorkflowSummary[] }>('/api/workflows/json')
        .then(r => setSavedWorkflows(r.workflows ?? []))
        .catch(() => { /* */ })
    } catch (err) {
      setStatus({ text: `save failed: ${(err as Error).message}`, level: 'danger' })
    }
  }, [toWorkflowDef, show])

  const run = useCallback(async () => {
    if (!meta.id) { setStatus({ text: 'workflow id required', level: 'danger' }); return }
    setStatus({ text: 'running…' })
    try {
      const res = await api.post<{ run: RunResult }>(
        `/api/workflows/json/${encodeURIComponent(meta.id)}/run`, {},
      )
      setLastRun(res.run)
      setStatus({
        text: `run ${res.run.status}`,
        level: res.run.status === 'completed' ? 'ok' : 'danger',
      })
    } catch (err) {
      setStatus({ text: `run failed: ${(err as Error).message}`, level: 'danger' })
    }
  }, [meta.id])

  const loadById = useCallback(async (id: string) => {
    // Library + saved workflows are both registered with the same
    // registry, so /api/runbooks/:id is the most informative read for
    // library entries (it returns the full WorkflowDef).
    try {
      // Try the library route first; it includes the full workflow body.
      const lib = await api.get<{ runbook: { workflow: any } }>(`/api/runbooks/${encodeURIComponent(id)}`)
      fromWorkflowDef(lib.runbook.workflow)
      setStatus({ text: `loaded library runbook ${id}`, level: 'ok' })
    } catch {
      // Fall back: GET /api/workflows/json/:id isn't a documented endpoint
      // here — surface a hint to use Import instead.
      setStatus({
        text: 'load not available — use Import to paste the JSON',
        level: 'danger',
      })
    }
  }, [fromWorkflowDef])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={styles.shell}>
      {/* Top toolbar */}
      <div className={styles.toolbar}>
        <input className={styles.id}
          placeholder="workflow id"
          value={meta.id}
          onChange={(e) => setMeta(m => ({ ...m, id: e.target.value }))}
        />
        <input className={styles.name}
          placeholder="Display name"
          value={meta.name}
          onChange={(e) => setMeta(m => ({ ...m, name: e.target.value }))}
        />
        <input className={styles.ver}
          placeholder="1.0.0"
          value={meta.version}
          onChange={(e) => setMeta(m => ({ ...m, version: e.target.value }))}
        />
        <div className={styles.toolbarSpacer} />
        <span
          className={
            status.level === 'danger' ? `${styles.toolbarStatus} ${styles.danger}` :
            status.level === 'ok'     ? `${styles.toolbarStatus} ${styles.ok}` :
            styles.toolbarStatus
          }
        >{status.text}</span>
        <Button variant="ghost"   size="sm" onClick={importJson}>Import</Button>
        <Button variant="ghost"   size="sm" onClick={exportJson}>Export</Button>
        <Button variant="ghost"   size="sm" onClick={validate}>Validate</Button>
        <Button variant="primary" size="sm" onClick={save}>Save</Button>
        <Button variant="success" size="sm" onClick={run}>Run</Button>
      </div>

      {/* Three-pane split */}
      <div className={styles.split}>
        {/* Palette */}
        <aside className={styles.palette}>
          <div className={styles.paletteHeader}>Step Library</div>
          <div className={styles.paletteList}>
            {STEP_TYPES.map(s => (
              <div
                key={s.type}
                className={styles.paletteItem}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-step-type', s.type)
                  e.dataTransfer.effectAllowed = 'move'
                }}
              >
                <span className={styles.paletteDot} style={{ background: s.color }} />
                <div className={styles.paletteItemBody}>
                  <div className={styles.paletteItemLabel}>{s.label}</div>
                  <div className={styles.paletteItemDesc}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.paletteSection}>Runbook Library</div>
          {runbooks.length === 0 && (
            <div className={styles.paletteList}>
              <div className={styles.libraryItemSub} style={{ padding: '0 8px' }}>(no library content)</div>
            </div>
          )}
          {runbooks.length > 0 && (
            <div className={styles.paletteList}>
              {runbooks.map(rb => (
                <button
                  key={rb.id}
                  type="button"
                  className={styles.libraryItem}
                  onClick={() => loadById(rb.id)}
                >
                  <div>{rb.name}</div>
                  <div className={styles.libraryItemSub}>{rb.id} · {rb.steps} steps</div>
                </button>
              ))}
            </div>
          )}

          <div className={styles.paletteSection}>Saved Workflows</div>
          <div className={styles.paletteList}>
            {savedWorkflows.length === 0 && (
              <div className={styles.libraryItemSub} style={{ padding: '0 8px' }}>(none yet)</div>
            )}
            {savedWorkflows.map(w => (
              <button
                key={w.id}
                type="button"
                className={styles.libraryItem}
                onClick={() => loadById(w.id)}
              >
                <div>{w.name}</div>
                <div className={styles.libraryItemSub}>{w.id} · v{w.version} · {w.steps} steps</div>
              </button>
            ))}
          </div>
        </aside>

        {/* Canvas */}
        <div ref={wrapperRef} className={styles.canvas} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onInit={setRfInstance}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls position="bottom-left" />
            <MiniMap pannable zoomable nodeColor={(n) => {
              const type = (n.data as any)?.type as string | undefined
              return type ? STEP_TYPES.find(t => t.type === type)?.color ?? '#9CA3AF' : '#9CA3AF'
            }} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className={styles.empty} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
              <div className={styles.emptyTitle}>Drag a step from the left to start</div>
              <div>Connect nodes by dragging from one handle to another. Conditional steps expose green/red branches; the orange handle wires onError → goto.</div>
            </div>
          )}
        </div>

        {/* Property editor */}
        <aside className={styles.props}>
          <PropertyEditor
            data={selected ? (selected.data as Record<string, unknown>) : null}
            siblingIds={siblingIds}
            workflow={{ description: meta.description, defaultOnError: meta.defaultOnError }}
            onWorkflowChange={(w) => setMeta(m => ({ ...m, description: w.description, defaultOnError: w.defaultOnError }))}
            onChange={updateSelectedData}
            onDelete={deleteSelected}
          />

          {lastRun && (
            <div className={styles.runResult}>
              <div className={styles.runHeader}>Last run</div>
              <div style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', marginBottom: 8 }}>
                <div style={{ color: 'var(--text2)' }}>runId</div>
                <div>{lastRun.runId}</div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span className={`${styles.runStatus} ${styles[lastRun.status]}`}>
                  {lastRun.status}
                </span>
                {lastRun.error && (
                  <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>{lastRun.error}</div>
                )}
              </div>
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text2)' }}>
                  Steps ({lastRun.steps.length})
                </summary>
                <div style={{ marginTop: 6 }}>
                  {lastRun.steps.map((s) => (
                    <div key={s.id} className={styles.runStep}>
                      <span className={styles.runStepId}>{s.id}</span>
                      <span className={`${styles.runStepStatus} ${styles[s.status as 'success' | 'failed' | 'pending_approval'] ?? ''}`}>
                        {s.status}
                      </span>
                      {s.error && <span style={{ color: 'var(--danger)' }}>{s.error}</span>}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

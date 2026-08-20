// Right-pane property editor.
//
// Renders form fields for the selected step. Fields are type-aware:
// every step type gets a dedicated set of inputs that map 1:1 onto the
// WorkflowDef shape so saved JSON has no extra round-tripping.
//
// onChange propagates a fresh data object up to the parent so the
// parent can update React Flow's node state (and hence the canvas
// preview) on every keystroke.

import type { ChangeEvent } from 'react'
import styles from '../WorkflowBuilderPage.module.css'

export interface PropertyEditorProps {
  /** Currently-selected step's data; null when nothing is selected. */
  data: Record<string, unknown> | null
  /** Available sibling step ids for the conditional then/else +
   *  onError.goto dropdowns. Excludes the current step. */
  siblingIds: string[]
  onChange(next: Record<string, unknown>): void
  onDelete(): void
  /** Workflow-level metadata edited when no node is selected. */
  workflow: { description: string; defaultOnError: string }
  onWorkflowChange(next: { description: string; defaultOnError: string }): void
}

export default function PropertyEditor(props: PropertyEditorProps) {
  if (!props.data) return <WorkflowProps {...props} />
  return <StepProps {...props} />
}

function WorkflowProps({ workflow, onWorkflowChange }: PropertyEditorProps) {
  return (
    <>
      <div className={styles.propsHeader}>Workflow</div>
      <div className={styles.propsField}>
        <label className={styles.propsLabel}>Description</label>
        <textarea
          className={styles.propsTextarea}
          rows={3}
          value={workflow.description}
          onChange={(e) => onWorkflowChange({ ...workflow, description: e.target.value })}
        />
      </div>
      <div className={styles.propsField}>
        <label className={styles.propsLabel}>Default onError</label>
        <select
          className={styles.propsSelect}
          value={workflow.defaultOnError}
          onChange={(e) => onWorkflowChange({ ...workflow, defaultOnError: e.target.value })}
        >
          <option value="fail">fail</option>
          <option value="continue">continue</option>
        </select>
      </div>
      <p className={styles.propsHint}>
        Click a node on the canvas to edit step-specific properties.
      </p>
    </>
  )
}

function StepProps({ data, siblingIds, onChange, onDelete }: PropertyEditorProps) {
  // Narrow `data` to a workable record. Caller has already null-checked.
  const d = data!
  const update = (patch: Record<string, unknown>) => onChange({ ...d, ...patch })

  // Type-specific fields. Every input dispatches an `update()` so the
  // canvas preview re-renders on each keystroke.
  const renderTypeFields = () => {
    switch (d.type) {
      case 'bash':
        return (
          <Field label="Command">
            <textarea
              className={styles.propsTextarea}
              rows={4}
              value={String(d.command ?? '')}
              onChange={(e) => update({ command: e.target.value })}
            />
          </Field>
        )
      case 'skill':
        return (
          <>
            <Field label="Skill">
              <input
                className={styles.propsInput}
                value={String(d.skill ?? '')}
                onChange={(e) => update({ skill: e.target.value })}
              />
            </Field>
            <Field label="Params (JSON)">
              <textarea
                className={styles.propsTextarea}
                rows={3}
                value={JSON.stringify(d.params ?? {}, null, 2)}
                onChange={(e) => {
                  try { update({ params: JSON.parse(e.target.value || '{}') }) }
                  catch { /* keep typing; parse errors are fine until blur */ }
                }}
              />
            </Field>
          </>
        )
      case 'api_call':
        return (
          <>
            <Field label="Method">
              <select
                className={styles.propsSelect}
                value={String(d.method ?? 'GET')}
                onChange={(e) => update({ method: e.target.value })}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="URL">
              <input
                className={styles.propsInput}
                value={String(d.url ?? '')}
                onChange={(e) => update({ url: e.target.value })}
              />
            </Field>
          </>
        )
      case 'delegation':
        return (
          <>
            <Field label="To agent ID">
              <input
                className={styles.propsInput}
                value={String(d.toAgentId ?? '')}
                onChange={(e) => update({ toAgentId: e.target.value })}
              />
            </Field>
            <Field label="Objective">
              <textarea
                className={styles.propsTextarea}
                rows={3}
                value={String(d.objective ?? '')}
                onChange={(e) => update({ objective: e.target.value })}
              />
            </Field>
          </>
        )
      case 'approval_gate':
        return (
          <Field label="Command (logical)">
            <input
              className={styles.propsInput}
              value={String(d.command ?? '')}
              onChange={(e) => update({ command: e.target.value })}
            />
          </Field>
        )
      case 'conditional':
        return (
          <>
            <Field label="When (template)">
              <input
                className={styles.propsInput}
                value={String(d.when ?? '')}
                onChange={(e) => update({ when: e.target.value })}
              />
            </Field>
            <Field label="Equals (optional)">
              <input
                className={styles.propsInput}
                value={String(d.equals ?? '')}
                onChange={(e) => update({ equals: e.target.value })}
              />
            </Field>
            <Field label="Then →">
              <StepIdSelect
                value={String(d.then ?? '')}
                ids={siblingIds}
                onChange={(v) => update({ then: v })}
              />
            </Field>
            <Field label="Else →">
              <StepIdSelect
                value={String(d.else ?? '')}
                ids={siblingIds}
                onChange={(v) => update({ else: v })}
              />
            </Field>
          </>
        )
      default:
        return null
    }
  }

  // onError editor — common to every step type.
  const oe = d.onError
  const oeMode: string = !oe ? 'inherit' : typeof oe === 'string' ? oe : 'goto'
  const oeGoto: string = oe && typeof oe === 'object' ? (oe as { goto?: string }).goto ?? '' : ''
  const onModeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const mode = e.target.value
    if (mode === 'inherit')   { const next = { ...d }; delete next.onError; onChange(next) }
    else if (mode === 'goto') update({ onError: { goto: '' } })
    else                      update({ onError: mode })
  }

  return (
    <>
      <div className={styles.propsHeader}>
        <span>Step</span>
        <button className={styles.propsDelete} onClick={onDelete}>delete</button>
      </div>

      <Field label="ID">
        <input
          className={styles.propsInput}
          value={String(d.stepId ?? '')}
          onChange={(e) => update({ stepId: e.target.value })}
        />
      </Field>
      <Field label="Type">
        <input className={styles.propsInput} value={String(d.type)} disabled />
      </Field>
      <Field label="Description">
        <input
          className={styles.propsInput}
          value={String(d.description ?? '')}
          onChange={(e) => update({ description: e.target.value })}
        />
      </Field>

      {renderTypeFields()}

      <Field label="On error">
        <select className={styles.propsSelect} value={oeMode} onChange={onModeChange}>
          <option value="inherit">inherit</option>
          <option value="fail">fail</option>
          <option value="continue">continue</option>
          <option value="goto">goto</option>
        </select>
      </Field>
      {oeMode === 'goto' && (
        <Field label="Goto step">
          <StepIdSelect
            value={oeGoto}
            ids={siblingIds}
            onChange={(v) => update({ onError: { goto: v } })}
          />
        </Field>
      )}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.propsField}>
      <label className={styles.propsLabel}>{label}</label>
      {children}
    </div>
  )
}

function StepIdSelect({
  value, ids, onChange,
}: { value: string; ids: string[]; onChange(v: string): void }) {
  return (
    <select className={styles.propsSelect} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">(none)</option>
      {ids.map(id => <option key={id} value={id}>{id}</option>)}
    </select>
  )
}

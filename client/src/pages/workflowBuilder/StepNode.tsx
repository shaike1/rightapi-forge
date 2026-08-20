// React Flow custom node for a workflow step.
//
// The node carries the same shape we put inside the generated
// WorkflowDef step (type-tagged union). Rendering picks colours via
// stepTypes.ts so every node uses one consistent palette.
//
// Handles:
//   • Top:    "in"  source          (incoming edges land here)
//   • Bottom: "out" target          (sequential next; default flow)
//   • Conditionals add two extra bottom handles "then" + "else".
//   • All step types add an "err" handle for onError.goto routing.

import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { colorFor, nodePreview } from './stepTypes'
import styles from '../WorkflowBuilderPage.module.css'

export interface StepNodeData extends Record<string, unknown> {
  /** Workflow step.id — used in the bottom-right corner badge. */
  stepId: string
  /** Step type discriminator; drives colour + handle layout. */
  type: string
}

/** React Flow v12 typed-node alias — the generic flows through nodes,
 *  edges, and the node-component prop signature so we don't have to
 *  cast at every callsite. */
export type StepFlowNode = Node<StepNodeData, 'step'>

export default function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const colour = colorFor(data.type)
  const isConditional = data.type === 'conditional'
  const onErrorGoto = data.onError && typeof data.onError === 'object'
    ? (data.onError as { goto?: string }).goto
    : undefined

  return (
    <div className={selected ? `${styles.node} ${styles.nodeSelected}` : styles.node}>
      <Handle type="target" position={Position.Top} id="in" />

      <div className={styles.nodeHeader}>
        <span className={styles.nodeDot} style={{ background: colour }} />
        <span className={styles.nodeType}>{data.type}</span>
        <span className={styles.nodeId}>{data.stepId}</span>
      </div>

      <div className={styles.nodeBody}>{nodePreview(data) || '(empty)'}</div>

      <div className={styles.nodeFooter}>
        {isConditional ? (
          <>
            <span className={`${styles.nodeBadge} ${styles.then}`}>then</span>
            <span className={`${styles.nodeBadge} ${styles.else}`}>else</span>
          </>
        ) : (
          <span>&nbsp;</span>
        )}
        {onErrorGoto && <span className={`${styles.nodeBadge} ${styles.err}`}>on err</span>}
      </div>

      {/* Default flow: every node has a generic "out" handle. */}
      {!isConditional && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="out"
          style={{ left: '50%' }}
        />
      )}

      {/* Conditional handles — sit at 30% / 70% so the labels above them
          line up with the dots. */}
      {isConditional && (
        <>
          <Handle
            type="source"
            position={Position.Bottom}
            id="then"
            className="then-handle"
            style={{ left: '30%' }}
          />
          <Handle
            type="source"
            position={Position.Bottom}
            id="else"
            className="else-handle"
            style={{ left: '70%' }}
          />
        </>
      )}

      {/* Error handle — every step that has an onError.goto target draws
          this. Sits offset to the right so it doesn't visually collide
          with the conditional handles. */}
      {onErrorGoto && (
        <Handle
          type="source"
          position={Position.Right}
          id="err"
          className="err-handle"
          style={{ top: '50%' }}
        />
      )}
    </div>
  )
}

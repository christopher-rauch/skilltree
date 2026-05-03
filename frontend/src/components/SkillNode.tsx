import { useContext } from 'react'
import { Handle, Position, NodeResizeControl, ResizeControlVariant } from '@xyflow/react'
import { FlowNodeData } from '../types'
import { BadgeContext, RunContext } from './NodeBoard'
import './SkillNode.css'

interface Props {
  id: string
  data: FlowNodeData
  selected: boolean
}

export function SkillNode({ id, data, selected }: Props) {
  const badge = useContext(BadgeContext).get(id)
  const runStatus = useContext(RunContext).get(id)

  const badgeLabel = runStatus === 'done' ? '✓'
    : runStatus === 'error' ? '✗'
    : runStatus === 'running' ? '▶'
    : badge ?? null
  const handleStyle = {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: 'var(--surface-3)',
    border: '2px solid var(--border-2)',
  }

  return (
    <>
      {badgeLabel && (
        <div className={`node-badge${runStatus ? ` badge-${runStatus}` : ''}`}>
          {badgeLabel}
        </div>
      )}
      {/* Handles sit outside the clipped inner div so they're never cut off */}
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />

      {selected && (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
        <NodeResizeControl
          key={pos}
          position={pos}
          variant={ResizeControlVariant.Handle}
          minWidth={160}
          minHeight={44}
          style={{
            width: 9,
            height: 9,
            borderRadius: 2,
            background: 'var(--surface-2)',
            border: '1.5px solid var(--primary)',
          }}
        />
      ))}

      <div className={`skill-node ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="node-body">
          <div className="node-name">{data.label || data.skillName}</div>
          {data.description && (
            <div className="node-desc">{data.description}</div>
          )}
        </div>
      </div>
    </>
  )
}

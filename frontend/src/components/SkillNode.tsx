import { Handle, Position, NodeResizeControl, ResizeControlVariant } from '@xyflow/react'
import { FlowNodeData } from '../types'
import './SkillNode.css'

interface Props {
  data: FlowNodeData
  selected: boolean
}

export function SkillNode({ data, selected }: Props) {
  const handleStyle = {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: 'var(--surface-3)',
    border: '2px solid var(--border-2)',
  }

  return (
    <>
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

      <div className={`skill-node ${selected ? 'selected' : ''}`}>
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

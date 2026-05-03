import { useContext, useMemo } from 'react'
import { Handle, Position, NodeResizeControl, ResizeControlVariant, useReactFlow } from '@xyflow/react'
import { FlowNodeData } from '../types'
import { BadgeContext, RunContext, IsRunningContext } from './NodeBoard'
import './SkillNode.css'

interface Props {
  id: string
  data: FlowNodeData
  selected: boolean
}

// Extract individual argument tokens from an argument-hint string.
// e.g. "<number1> <number2>" → ["<number1>", "<number2>"]
// Returns [] when there is 0 or 1 token (handled by the single-input path).
function parseArgTokens(hint: string): string[] {
  const matches = [...hint.matchAll(/[<\[][^>\]]+[>\]]/g)].map(m => m[0])
  return matches.length > 1 ? matches : []
}

function tokenLabel(token: string) {
  return token.replace(/^[<\[]/, '').replace(/[>\]]$/, '')
}

export function SkillNode({ id, data, selected }: Props) {
  const badge = useContext(BadgeContext).get(id)
  const runStatus = useContext(RunContext).get(id)
  const isRunning = useContext(IsRunningContext)
  const { updateNodeData } = useReactFlow()

  const badgeLabel = runStatus === 'done' ? '✓'
    : runStatus === 'error' ? '✗'
    : runStatus === 'running' ? '▶'
    : badge ?? null

  const argHint = data.argumentHint as string | undefined
  const argTokens = useMemo(() => (argHint ? parseArgTokens(argHint) : []), [argHint])
  const isMultiArg = argTokens.length > 1

  // Split stored value across individual inputs
  const argParts = useMemo(() => {
    const val = (data.argumentValue as string) ?? ''
    if (!isMultiArg) return []
    const parts = val.split(' ')
    return argTokens.map((_, i) => parts[i] ?? '')
  }, [data.argumentValue, argTokens, isMultiArg])

  function handleArgPartChange(idx: number, val: string) {
    const next = argParts.map((p, i) => i === idx ? val : p)
    updateNodeData(id, { ...data, argumentValue: next.join(' ') })
  }

  const handleStyle = {
    width: 10, height: 10, borderRadius: '50%',
    background: 'var(--surface-3)', border: '2px solid var(--border-2)',
  }

  return (
    <>
      {badgeLabel && (
        <div className={`node-badge${runStatus ? ` badge-${runStatus}` : ''}`}>
          {badgeLabel}
        </div>
      )}
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />

      {selected && !isRunning && (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
        <NodeResizeControl key={pos} position={pos} variant={ResizeControlVariant.Handle}
          minWidth={160} minHeight={44}
          style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--surface-2)', border: '1.5px solid var(--primary)' }}
        />
      ))}

      <div className={`skill-node ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="node-body nowheel">
          <div className="node-name">{data.label || data.skillName}</div>
          {data.description && (
            <div className="node-desc">{data.description}</div>
          )}
        </div>

        {argHint && (
          <div className="node-arg">
            {isMultiArg ? (
              argTokens.map((token, i) => (
                <div key={i} className="node-arg-row">
                  <span className="node-arg-label">{tokenLabel(token)}</span>
                  <input
                    className="node-arg-input nodrag nopan nowheel"
                    placeholder={token}
                    value={argParts[i] ?? ''}
                    disabled={isRunning}
                    onChange={(e) => handleArgPartChange(i, e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              ))
            ) : (
              <input
                className="node-arg-input nodrag nopan nowheel"
                placeholder={argHint}
                value={(data.argumentValue as string) ?? ''}
                disabled={isRunning}
                onChange={(e) => updateNodeData(id, { ...data, argumentValue: e.target.value })}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )}
      </div>
    </>
  )
}

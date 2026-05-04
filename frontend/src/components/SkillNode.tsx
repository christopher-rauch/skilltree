import { useContext, useMemo } from 'react'
import { Handle, Position, NodeResizeControl, ResizeControlVariant, useReactFlow } from '@xyflow/react'
import { FlowNodeData } from '../types'
import type { SkillField } from '../types'
import { BadgeContext, RunContext, IsRunningContext, SetDirtyContext } from './NodeBoard'
import './SkillNode.css'

interface Props {
  id: string
  data: FlowNodeData
  selected: boolean
}

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
  const markDirty = useContext(SetDirtyContext)
  const { updateNodeData } = useReactFlow()

  const badgeLabel = runStatus === 'done' ? '✓'
    : runStatus === 'error' ? '✗'
    : runStatus === 'running' ? '▶'
    : badge ?? null

  // Skill fields (multi-input, takes precedence over argumentHint)
  const fields = (data.fields as SkillField[] | undefined) ?? []
  const hasFields = fields.length > 0

  // Single-argument fallback
  const argHint = data.argumentHint as string | undefined
  const argTokens = useMemo(() => (argHint ? parseArgTokens(argHint) : []), [argHint])
  const isMultiArg = argTokens.length > 1

  const argParts = useMemo(() => {
    const val = (data.argumentValue as string) ?? ''
    if (!isMultiArg) return []
    const parts = val.split(' ')
    return argTokens.map((_, i) => parts[i] ?? '')
  }, [data.argumentValue, argTokens, isMultiArg])

  // Skill field values
  const skillFieldValues = (data.skillFieldValues as Record<string, string> | undefined) ?? {}

  function setArgPart(idx: number, val: string) {
    const next = argParts.map((p, i) => i === idx ? val : p)
    updateNodeData(id, { ...data, argumentValue: next.join(' ') })
    markDirty()
  }

  function setFieldValue(key: string, val: string) {
    updateNodeData(id, { ...data, skillFieldValues: { ...skillFieldValues, [key]: val } })
    markDirty()
  }

  // Initialize default values on first render
  useMemo(() => {
    if (!hasFields) return
    const needsInit = fields.some(f => f.default && skillFieldValues[f.key] === undefined)
    if (needsInit) {
      const init: Record<string, string> = { ...skillFieldValues }
      fields.forEach(f => { if (f.default && init[f.key] === undefined) init[f.key] = f.default })
      updateNodeData(id, { ...data, skillFieldValues: init })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFields, id])

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

        {/* Skill fields (multi-input from frontmatter) */}
        {hasFields && (
          <div className="node-arg">
            {fields.map((field) => {
              const val = skillFieldValues[field.key] ?? field.default ?? ''
              if (field.type === 'select' && field.options?.length) {
                return (
                  <div key={field.key} className="node-arg-row">
                    <span className="node-arg-label">{field.label}</span>
                    <select
                      className="node-field-select nodrag nopan nowheel"
                      value={val}
                      disabled={isRunning}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                )
              }
              if (field.type === 'textarea') {
                return (
                  <div key={field.key} className="node-field-textarea-wrap">
                    <span className="node-arg-label">{field.label}</span>
                    <textarea
                      className="node-field-textarea nodrag nopan nowheel"
                      placeholder={field.placeholder ?? ''}
                      value={val}
                      disabled={isRunning}
                      onChange={(e) => setFieldValue(field.key, e.target.value)}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                  </div>
                )
              }
              return (
                <div key={field.key} className="node-arg-row">
                  <span className="node-arg-label">{field.label}</span>
                  <input
                    className="node-arg-input nodrag nopan nowheel"
                    type={field.type === 'number' ? 'number' : 'text'}
                    placeholder={field.placeholder ?? ''}
                    value={val}
                    disabled={isRunning}
                    onChange={(e) => setFieldValue(field.key, e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* Single argument-hint fallback (only when no fields defined) */}
        {!hasFields && argHint && (
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
                    onChange={(e) => setArgPart(i, e.target.value)}
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
                onChange={(e) => { updateNodeData(id, { ...data, argumentValue: e.target.value }); markDirty() }}
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

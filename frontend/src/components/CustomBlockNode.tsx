import { useContext, useState, useRef, useEffect, useCallback } from 'react'
import { Handle, Position, NodeResizeControl, ResizeControlVariant, useReactFlow } from '@xyflow/react'
import { Puzzle, FolderOpen } from 'lucide-react'
import { BadgeContext, RunContext, IsRunningContext, SetDirtyContext, CustomBlocksContext } from './NodeBoard'
import { SelectAnyFile } from '../../wailsjs/go/main/App'
import './CustomBlockNode.css'

// Inlined to avoid circular dependency: CustomBlockNode → BuildingBlockNodes → NodeBoard → CustomBlockNode
function useLocalValue(external: string | undefined): [string, (v: string) => void] {
  const [local, setLocal] = useState(external ?? '')
  const ownUpdate = useRef(false)
  useEffect(() => {
    if (!ownUpdate.current) setLocal(external ?? '')
    ownUpdate.current = false
  }, [external])
  const set = useCallback((v: string) => { ownUpdate.current = true; setLocal(v) }, [])
  return [local, set]
}

const HANDLE_STYLE = {
  width: 10, height: 10, borderRadius: '50%',
  background: 'var(--surface-3)', border: '2px solid var(--border-2)',
}

export function CustomBlockNode({ id, data, selected }: { id: string; data: Record<string, unknown>; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const isRunning = useContext(IsRunningContext)
  const runStatus = useContext(RunContext).get(id)
  const markDirty = useContext(SetDirtyContext)
  const badge = useContext(BadgeContext).get(id)
  const defs = useContext(CustomBlocksContext)

  const blockId = data.blockDefinitionId as string | undefined
  const def = blockId ? defs.find((d) => d.id === blockId) : undefined
  const fieldValues = (data.fieldValues as Record<string, string>) ?? {}

  const badgeLabel = runStatus === 'done' ? '✓' : runStatus === 'error' ? '✗' : runStatus === 'running' ? '▶' : badge ?? null

  function setField(key: string, val: string) {
    updateNodeData(id, { ...data, fieldValues: { ...fieldValues, [key]: val } })
    markDirty()
  }

  const accentColor = def?.color ?? '#a855f7'

  return (
    <>
      {badgeLabel && <div className={`node-badge${runStatus ? ` badge-${runStatus}` : ''}`}>{badgeLabel}</div>}
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      {selected && !isRunning && (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
        <NodeResizeControl key={pos} position={pos} variant={ResizeControlVariant.Handle}
          minWidth={200} minHeight={60}
          style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--surface-2)', border: `1.5px solid ${accentColor}` }} />
      ))}

      <div className="custom-block-node" style={{ '--accent': accentColor } as React.CSSProperties}>
        <div className="custom-block-header">
          <Puzzle size={12} className="custom-block-icon" />
          <span className="custom-block-name">{def?.name ?? (blockId ? `Unknown: ${blockId}` : 'Custom Block')}</span>
        </div>
        {!def && (
          <div className="custom-block-missing">Definition deleted — remove this node</div>
        )}
        {(def?.fields ?? []).map((field) => {
          if (field.type === 'textarea') {
            return (
              <div key={field.key} className="custom-block-field">
                <label className="custom-block-label">{field.label}</label>
                <TextareaField
                  value={fieldValues[field.key] ?? String(field.default ?? '')}
                  placeholder={field.placeholder ?? ''}
                  disabled={isRunning}
                  onChange={(v) => setField(field.key, v)}
                />
              </div>
            )
          }
          if (field.type === 'select') {
            return (
              <div key={field.key} className="custom-block-field">
                <label className="custom-block-label">{field.label}</label>
                <select
                  className="custom-block-select nodrag nopan nowheel"
                  value={fieldValues[field.key] ?? String(field.default ?? '')}
                  disabled={isRunning}
                  onChange={(e) => setField(field.key, e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            )
          }
          if (field.type === 'file') {
            const basename = fieldValues[field.key]?.split('/').pop() ?? ''
            return (
              <div key={field.key} className="custom-block-field">
                <label className="custom-block-label">{field.label}</label>
                <div className="custom-block-file-row nodrag nopan nowheel">
                  <span className="custom-block-file-name">{basename || <em>No file</em>}</span>
                  <button className="custom-block-browse nodrag nopan" disabled={isRunning}
                    onClick={async () => { const p = await SelectAnyFile(); if (p) setField(field.key, p) }}>
                    <FolderOpen size={11} />
                  </button>
                </div>
              </div>
            )
          }
          // text / number — default
          return (
            <div key={field.key} className="custom-block-field">
              <label className="custom-block-label">{field.label}</label>
              <input
                className="custom-block-input nodrag nopan nowheel"
                type={field.type === 'number' ? 'number' : 'text'}
                placeholder={field.placeholder ?? ''}
                value={fieldValues[field.key] ?? String(field.default ?? '')}
                disabled={isRunning}
                onChange={(e) => setField(field.key, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
              />
            </div>
          )
        })}
      </div>
    </>
  )
}

// Cursor-safe textarea using useLocalValue from BuildingBlockNodes
function TextareaField({ value, placeholder, disabled, onChange }: {
  value: string; placeholder: string; disabled: boolean; onChange: (v: string) => void
}) {
  const [local, setLocal] = useLocalValue(value)
  return (
    <textarea
      className="custom-block-textarea nodrag nopan nowheel"
      placeholder={placeholder}
      value={local}
      disabled={disabled}
      onChange={(e) => { setLocal(e.target.value); onChange(e.target.value) }}
      onMouseDown={(e) => e.stopPropagation()}
    />
  )
}

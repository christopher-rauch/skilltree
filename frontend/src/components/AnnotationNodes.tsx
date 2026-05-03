import { useState, useRef, useEffect, useCallback } from 'react'
import { useReactFlow } from '@xyflow/react'
import './AnnotationNodes.css'

// ── Text annotation ─────────────────────────────────────────────────────────

interface TextData { text?: string; editing?: boolean }

export function AnnotationTextNode({ id, data, selected }: { id: string; data: TextData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(data.editing ?? false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) taRef.current?.select()
  }, [editing])

  const commit = useCallback((text: string) => {
    updateNodeData(id, { text, editing: false })
    setEditing(false)
  }, [id, updateNodeData])

  return (
    <div className={`ann-text ${selected ? 'selected' : ''}`} onDoubleClick={() => setEditing(true)}>
      {editing ? (
        <textarea
          ref={taRef}
          className="ann-textarea nodrag nopan nowheel"
          defaultValue={data.text ?? ''}
          autoFocus
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') commit((e.target as HTMLTextAreaElement).value) }}
        />
      ) : (
        <span className="ann-text-content">{data.text || 'Double-click to edit'}</span>
      )}
    </div>
  )
}

// ── Sticky note ──────────────────────────────────────────────────────────────

const STICKY_COLORS: Record<string, { bg: string; border: string }> = {
  yellow: { bg: '#422d05', border: '#92400e' },
  pink:   { bg: '#3b0a1e', border: '#9d174d' },
  blue:   { bg: '#0c2340', border: '#1e4a8a' },
  green:  { bg: '#052e16', border: '#166534' },
  purple: { bg: '#1e0f3a', border: '#5b21b6' },
}

interface StickyData { text?: string; color?: string; editing?: boolean }

export function AnnotationStickyNode({ id, data, selected }: { id: string; data: StickyData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(data.editing ?? false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const color = data.color ?? 'yellow'
  const theme = STICKY_COLORS[color] ?? STICKY_COLORS.yellow

  useEffect(() => {
    if (editing) taRef.current?.select()
  }, [editing])

  const commit = useCallback((text: string) => {
    updateNodeData(id, { ...data, text, editing: false })
    setEditing(false)
  }, [id, data, updateNodeData])

  return (
    <div
      className={`ann-sticky ${selected ? 'selected' : ''}`}
      style={{ background: theme.bg, borderColor: theme.border }}
      onDoubleClick={() => setEditing(true)}
    >
      <div className="ann-sticky-dots nodrag nopan">
        {Object.keys(STICKY_COLORS).map((c) => (
          <button
            key={c}
            className={`ann-sticky-dot ${c === color ? 'active' : ''}`}
            style={{ background: STICKY_COLORS[c].border }}
            onClick={(e) => { e.stopPropagation(); updateNodeData(id, { ...data, color: c }) }}
          />
        ))}
      </div>
      {editing ? (
        <textarea
          ref={taRef}
          className="ann-textarea nodrag nopan nowheel"
          defaultValue={data.text ?? ''}
          autoFocus
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') commit((e.target as HTMLTextAreaElement).value) }}
        />
      ) : (
        <div className="ann-sticky-content">{data.text || 'Double-click to edit'}</div>
      )}
    </div>
  )
}

// ── Freehand drawing ─────────────────────────────────────────────────────────

interface DrawingData { path?: string; width?: number; height?: number; color?: string }

export function AnnotationDrawingNode({ data, selected }: { data: DrawingData; selected: boolean }) {
  const w = data.width ?? 100
  const h = data.height ?? 100
  return (
    <div className={`ann-drawing ${selected ? 'selected' : ''}`} style={{ width: w, height: h }}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
        <path
          d={data.path ?? ''}
          stroke={data.color ?? 'var(--text-2)'}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

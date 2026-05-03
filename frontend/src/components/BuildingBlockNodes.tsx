import { useState, useRef, useEffect, useContext } from 'react'
import { Handle, Position, NodeResizeControl, ResizeControlVariant, useReactFlow } from '@xyflow/react'
import { Type, Terminal, BookOpen, FolderOpen, Paperclip, Globe, Braces, Plus, X } from 'lucide-react'
import { BadgeContext, RunContext, IsRunningContext, SetDirtyContext } from './NodeBoard'
import { SaveBlockAsLibrarySkill, SelectScriptFile, SelectAnyFile } from '../../wailsjs/go/main/App'
import './BuildingBlockNodes.css'

const HANDLE_STYLE = {
  width: 10, height: 10, borderRadius: '50%',
  background: 'var(--surface-3)', border: '2px solid var(--border-2)',
}

const RESIZE_STYLE = {
  width: 9, height: 9, borderRadius: 2,
  background: 'var(--surface-2)', border: '1.5px solid var(--text-3)',
}

// ── Shared sub-components ────────────────────────────────────────────────────

function BlockBadge({ id }: { id: string }) {
  const badge = useContext(BadgeContext).get(id)
  const runStatus = useContext(RunContext).get(id)
  const label = runStatus === 'done' ? '✓' : runStatus === 'error' ? '✗' : runStatus === 'running' ? '▶' : badge ?? null
  if (!label) return null
  return <div className={`node-badge${runStatus ? ` badge-${runStatus}` : ''}`}>{label}</div>
}

function BlockResizeControls({ selected }: { selected: boolean }) {
  const isRunning = useContext(IsRunningContext)
  if (!selected || isRunning) return null
  return (
    <>
      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((pos) => (
        <NodeResizeControl key={pos} position={pos} variant={ResizeControlVariant.Handle}
          minWidth={200} minHeight={60} style={RESIZE_STYLE} />
      ))}
    </>
  )
}

function SaveToLibrary({ id, getContent, blockType }: {
  id: string
  getContent: () => string
  blockType: 'text' | 'command'
}) {
  const { updateNodeData } = useReactFlow()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  async function handleSave() {
    const n = name.trim()
    if (!n) return
    setSaving(true)
    try {
      await SaveBlockAsLibrarySkill(n, getContent(), blockType)
      updateNodeData(id, { savedSkillName: n })
      setOpen(false)
      setName('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="block-save-library nodrag nopan nowheel">
      {open ? (
        <div className="block-save-row">
          <input
            ref={inputRef}
            className="block-save-input"
            placeholder="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') { setOpen(false); setName('') }
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button className="block-save-confirm" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? '…' : 'Save'}
          </button>
          <button className="block-save-cancel" onClick={() => { setOpen(false); setName('') }}>
            <X size={10} />
          </button>
        </div>
      ) : (
        <button className="block-library-btn nodrag nopan" onClick={() => setOpen(true)}>
          <BookOpen size={10} /> Save to Library
        </button>
      )}
    </div>
  )
}

// ── Text Block ───────────────────────────────────────────────────────────────

interface TextBlockData {
  label?: string
  content?: string
  savedSkillName?: string
  [key: string]: unknown
}

export function TextBlockNode({ id, data, selected }: { id: string; data: TextBlockData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const isRunning = useContext(IsRunningContext)
  const runStatus = useContext(RunContext).get(id)
  const markDirty = useContext(SetDirtyContext)

  return (
    <>
      <BlockBadge id={id} />
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <BlockResizeControls selected={selected} />

      <div className={`block-node block-text ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="block-header">
          <Type size={12} className="block-icon" />
          <input
            className="block-label-input nodrag nopan nowheel"
            value={data.label ?? 'Text Block'}
            disabled={isRunning}
            onChange={(e) => { updateNodeData(id, { ...data, label: e.target.value }); markDirty() }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {data.savedSkillName && <span className="block-saved-badge">library</span>}
        </div>
        <textarea
          className="block-textarea nodrag nopan nowheel"
          placeholder="Type instructions for Claude…"
          value={data.content ?? ''}
          disabled={isRunning}
          onChange={(e) => { updateNodeData(id, { ...data, content: e.target.value }); markDirty() }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <SaveToLibrary
          id={id}
          getContent={() => data.content ?? ''}
          blockType="text"
        />
      </div>
    </>
  )
}

// ── File Input Block ─────────────────────────────────────────────────────────

interface FileInputData {
  label?: string
  filePath?: string
  instruction?: string
  savedSkillName?: string
  [key: string]: unknown
}

export function FileInputNode({ id, data, selected }: { id: string; data: FileInputData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const isRunning = useContext(IsRunningContext)
  const runStatus = useContext(RunContext).get(id)
  const markDirty = useContext(SetDirtyContext)

  const basename = data.filePath ? data.filePath.split('/').pop() ?? data.filePath : ''

  async function handleBrowse() {
    const path = await SelectAnyFile()
    if (path) { updateNodeData(id, { ...data, filePath: path }); markDirty() }
  }

  return (
    <>
      <BlockBadge id={id} />
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <BlockResizeControls selected={selected} />

      <div className={`block-node block-file ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="block-header">
          <Paperclip size={12} className="block-icon" />
          <input
            className="block-label-input nodrag nopan nowheel"
            value={data.label ?? 'File Input'}
            disabled={isRunning}
            onChange={(e) => { updateNodeData(id, { ...data, label: e.target.value }); markDirty() }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {data.savedSkillName && <span className="block-saved-badge">library</span>}
        </div>
        <div className="block-file-row nodrag nopan nowheel">
          <span className="block-file-path" title={data.filePath ?? ''}>
            {basename || <span className="block-file-placeholder">No file selected</span>}
          </span>
          <button className="block-browse-btn nodrag nopan" onClick={handleBrowse} disabled={isRunning} title="Browse for file">
            <FolderOpen size={12} />
          </button>
        </div>
        <textarea
          className="block-textarea nodrag nopan nowheel"
          placeholder="Instruction (optional) — how Claude should use this file…"
          value={data.instruction ?? ''}
          disabled={isRunning}
          onChange={(e) => { updateNodeData(id, { ...data, instruction: e.target.value }); markDirty() }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <SaveToLibrary
          id={id}
          getContent={() => data.filePath ?? ''}
          blockType="command"
        />
      </div>
    </>
  )
}

// ── Run Command Block ────────────────────────────────────────────────────────

interface RunCommandData {
  label?: string
  scriptPath?: string
  savedSkillName?: string
  [key: string]: unknown
}

export function RunCommandNode({ id, data, selected }: { id: string; data: RunCommandData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const isRunning = useContext(IsRunningContext)
  const runStatus = useContext(RunContext).get(id)
  const markDirty = useContext(SetDirtyContext)

  const basename = data.scriptPath
    ? data.scriptPath.split('/').pop() ?? data.scriptPath
    : ''

  async function handleBrowse() {
    const path = await SelectScriptFile()
    if (path) {
      updateNodeData(id, { ...data, scriptPath: path })
      markDirty()
    }
  }

  return (
    <>
      <BlockBadge id={id} />
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <BlockResizeControls selected={selected} />

      <div className={`block-node block-command ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="block-header">
          <Terminal size={12} className="block-icon" />
          <input
            className="block-label-input nodrag nopan nowheel"
            value={data.label ?? 'Run Command'}
            disabled={isRunning}
            onChange={(e) => { updateNodeData(id, { ...data, label: e.target.value }); markDirty() }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {data.savedSkillName && <span className="block-saved-badge">library</span>}
        </div>
        <div className="block-file-row nodrag nopan nowheel">
          <span className="block-file-path" title={data.scriptPath ?? ''}>
            {basename || <span className="block-file-placeholder">No script selected</span>}
          </span>
          <button
            className="block-browse-btn nodrag nopan"
            onClick={handleBrowse}
            disabled={isRunning}
            title="Browse for shell script"
          >
            <FolderOpen size={12} />
          </button>
        </div>
        <SaveToLibrary
          id={id}
          getContent={() => data.scriptPath ?? ''}
          blockType="command"
        />
      </div>
    </>
  )
}

// ── Context Injector ─────────────────────────────────────────────────────────

interface ContextInjectorData {
  label?: string
  content?: string
  savedSkillName?: string
  [key: string]: unknown
}

export function ContextInjectorNode({ id, data, selected }: { id: string; data: ContextInjectorData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const isRunning = useContext(IsRunningContext)
  const runStatus = useContext(RunContext).get(id)
  const markDirty = useContext(SetDirtyContext)

  return (
    <>
      <BlockBadge id={id} />
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <BlockResizeControls selected={selected} />

      <div className={`block-node block-context ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="block-header">
          <Globe size={12} className="block-icon" />
          <input
            className="block-label-input nodrag nopan nowheel"
            value={data.label ?? 'Context'}
            disabled={isRunning}
            onChange={(e) => { updateNodeData(id, { ...data, label: e.target.value }); markDirty() }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {data.savedSkillName && <span className="block-saved-badge">library</span>}
        </div>
        <textarea
          className="block-textarea nodrag nopan nowheel"
          placeholder="Static context for all downstream steps — project background, constraints, style guide…"
          value={data.content ?? ''}
          disabled={isRunning}
          onChange={(e) => { updateNodeData(id, { ...data, content: e.target.value }); markDirty() }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <SaveToLibrary
          id={id}
          getContent={() => data.content ?? ''}
          blockType="text"
        />
      </div>
    </>
  )
}

// ── Variable Node ────────────────────────────────────────────────────────────

interface VarEntry { name: string; value: string }

interface VariableData {
  label?: string
  variables?: VarEntry[]
  [key: string]: unknown
}

export function VariableNode({ id, data, selected }: { id: string; data: VariableData; selected: boolean }) {
  const { updateNodeData } = useReactFlow()
  const isRunning = useContext(IsRunningContext)
  const runStatus = useContext(RunContext).get(id)
  const markDirty = useContext(SetDirtyContext)

  const vars: VarEntry[] = (data.variables as VarEntry[] | undefined) ?? []

  function updateVars(next: VarEntry[]) {
    updateNodeData(id, { ...data, variables: next })
    markDirty()
  }

  function setVar(idx: number, field: 'name' | 'value', val: string) {
    const next = vars.map((v, i) => i === idx ? { ...v, [field]: val } : v)
    updateVars(next)
  }

  return (
    <>
      <BlockBadge id={id} />
      <Handle type="target" position={Position.Top} style={HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <BlockResizeControls selected={selected} />

      <div className={`block-node block-variable ${selected ? 'selected' : ''} ${runStatus ?? ''}`}>
        <div className="block-header">
          <Braces size={12} className="block-icon" />
          <input
            className="block-label-input nodrag nopan nowheel"
            value={data.label ?? 'Variables'}
            disabled={isRunning}
            onChange={(e) => { updateNodeData(id, { ...data, label: e.target.value }); markDirty() }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>
        <div className="block-var-list nodrag nopan nowheel">
          {vars.map((v, i) => (
            <div key={i} className="block-var-row">
              <input
                className="block-var-name"
                placeholder="name"
                value={v.name}
                disabled={isRunning}
                onChange={(e) => setVar(i, 'name', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
              />
              <span className="block-var-eq">=</span>
              <input
                className="block-var-value"
                placeholder="value"
                value={v.value}
                disabled={isRunning}
                onChange={(e) => setVar(i, 'value', e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
              />
              <button
                className="block-var-remove"
                disabled={isRunning}
                onClick={() => updateVars(vars.filter((_, j) => j !== i))}
              >
                <X size={9} />
              </button>
            </div>
          ))}
          <button
            className="block-var-add nodrag nopan"
            disabled={isRunning}
            onClick={() => updateVars([...vars, { name: '', value: '' }])}
          >
            <Plus size={10} /> Add variable
          </button>
        </div>
      </div>
    </>
  )
}

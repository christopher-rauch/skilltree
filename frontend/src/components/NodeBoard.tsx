import { useCallback, useRef, useState, useEffect, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  useNodes,
  useViewport,
  useReactFlow,
  useStore as useRFStore,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type EdgeMouseHandler,
  type ReactFlowInstance,
  BackgroundVariant,
  MarkerType,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useStore } from '../store'
import { Flow, FlowNode, FlowEdge } from '../types'
import { SkillNode } from './SkillNode'
import {
  SaveFlow,
  DeleteFlow,
  NewFlowID,
  GenerateFlowSkill,
  SetBoardDirty,
} from '../../wailsjs/go/main/App'
import {
  Plus, Save, Trash2, Download, ChevronDown, Check, X, Copy, AlertTriangle,
} from 'lucide-react'
import { ProjectScopeInfo } from './ProjectScopeInfo'
import { GithubButton } from './GithubButton'
import './NodeBoard.css'

const nodeTypes = { skill: SkillNode }

// Only treat a node change as "dirty" if it's a real structural mutation.
// - 'select'     → just a click/focus, no data change
// - 'dimensions' → React Flow auto-measures on load; only dirty when the
//                  user is actively resizing (resizing === true)
function isStructuralNodeChange(c: NodeChange): boolean {
  if (c.type === 'select') return false
  if (c.type === 'dimensions') return (c as NodeChange & { resizing?: boolean }).resizing === true
  return true
}

function isStructuralEdgeChange(c: EdgeChange): boolean {
  return c.type !== 'select'
}

interface Props {
  onRefresh: () => Promise<void>
}

export function NodeBoard({ onRefresh }: Props) {
  const {
    skills, flows, projectDir,
    setError, upsertFlow, removeFlow,
    selectedFlowId, setSelectedFlowId,
    setBoardDirty: setStoreBoardDirty,
    setOnSaveBoard, setOnDiscardBoard,
  } = useStore()

  // Derive active flow
  const activeFlow = flows.find((f) => f.id === selectedFlowId) ?? null

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [flowName, setFlowName] = useState('')
  const [dirty, setDirtyState] = useState(false)

  function setDirty(value: boolean) {
    setDirtyState(value)
    SetBoardDirty(value)
    setStoreBoardDirty(value)
  }
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [exportName, setExportName] = useState('')
  const [exportScope, setExportScope] = useState<'global' | 'project'>('global')
  const [showFlowMenu, setShowFlowMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [edgeMenu, setEdgeMenu] = useState<{ edgeId: string; x: number; y: number } | null>(null)
  const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [pendingFlowId, setPendingFlowId] = useState<string | null>(null)

  const reactFlowWrapper = useRef<HTMLDivElement>(null)
  const rfInstance = useRef<ReactFlowInstance | null>(null)
  const nodeIdCounter = useRef(0)

  // Keep refs to latest save/discard so App.tsx can call them without stale closures
  const handleSaveRef = useRef<() => Promise<void>>(async () => {})
  const handleDiscardRef = useRef<() => void>(() => {})

  useEffect(() => {
    setOnSaveBoard(() => handleSaveRef.current())
    setOnDiscardBoard(() => { handleDiscardRef.current(); setDirty(false) })
    return () => { setOnSaveBoard(null); setOnDiscardBoard(null) }
  }, [])

  // Detect gaps: rogue nodes (no connections) or disconnected subgraphs
  const flowWarning = useMemo(() => {
    if (nodes.length < 2) return null

    const adj = new Map<string, Set<string>>()
    for (const n of nodes) adj.set(n.id, new Set())
    for (const e of edges) {
      adj.get(e.source)?.add(e.target)
      adj.get(e.target)?.add(e.source)
    }

    const visited = new Set<string>()
    let components = 0
    for (const n of nodes) {
      if (visited.has(n.id)) continue
      components++
      const stack = [n.id]
      while (stack.length) {
        const cur = stack.pop()!
        if (visited.has(cur)) continue
        visited.add(cur)
        for (const nb of adj.get(cur) ?? []) stack.push(nb)
      }
    }

    if (components === 1) return null

    const isolated = nodes.filter((n) => adj.get(n.id)!.size === 0)
    const parts: string[] = []
    if (isolated.length)
      parts.push(`${isolated.length} unconnected node${isolated.length > 1 ? 's' : ''}`)
    const groups = components - isolated.length
    if (groups > 1)
      parts.push(`${groups} disconnected group${groups > 1 ? 's' : ''}`)
    else if (groups === 1 && isolated.length)
      parts.push('remaining nodes form a separate group')

    return parts.join(' · ')
  }, [nodes, edges])

  // Delete selected nodes (+ their edges) on Backspace, unless focus is in a text field
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return

      e.preventDefault() // stop WebKit playing the system alert sound

      setNodes((nds) => {
        const selectedIds = new Set(nds.filter((n) => n.selected).map((n) => n.id))
        if (selectedIds.size === 0) return nds
        setEdges((eds) => eds.filter((e) => !selectedIds.has(e.source) && !selectedIds.has(e.target)))
        setDirty(true)
        return nds.filter((n) => !n.selected)
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function toRFNodes(flowNodes: FlowNode[]): Node[] {
    return flowNodes.map((n) => ({
      id: n.id,
      type: n.type || 'skill',
      position: n.position,
      data: n.data,
      ...(n.width  ? { width:  n.width  } : {}),
      ...(n.height ? { height: n.height } : {}),
    }))
  }

  function toRFEdges(flowEdges: FlowEdge[]): Edge[] {
    return flowEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      animated: e.animated ?? true,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: 'var(--primary)', strokeWidth: 1.5 },
    }))
  }

  // Load flow into canvas when selectedFlowId changes
  useEffect(() => {
    if (activeFlow) {
      setNodes(toRFNodes(activeFlow.nodes))
      setEdges(toRFEdges(activeFlow.edges))
      setFlowName(activeFlow.name)
      setDirty(false)
      // Fit to existing nodes only — never fire on an empty canvas
      if (activeFlow.nodes.length > 0) {
        setTimeout(() => rfInstance.current?.fitView({ padding: 0.15, duration: 200 }), 50)
      }
    } else {
      setNodes([])
      setEdges([])
      setFlowName('')
      setDirty(false)
    }
  }, [selectedFlowId])

  const onConnect = useCallback(
    (params: Connection) => {
      if (params.source === params.target) return

      // Reject if adding this edge would create a cycle:
      // check whether params.source is already reachable from params.target
      setEdges((eds) => {
        const reachable = new Set<string>()
        const stack = [params.target!]
        while (stack.length) {
          const cur = stack.pop()!
          if (reachable.has(cur)) continue
          reachable.add(cur)
          for (const e of eds) {
            if (e.source === cur) stack.push(e.target)
          }
        }
        if (reachable.has(params.source!)) return eds // would be cyclic

        return addEdge(
          {
            ...params,
            animated: true,
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: 'var(--primary)', strokeWidth: 1.5 },
          },
          eds
        )
      })
      setDirty(true)
    },
    []
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData('application/skilltree')
      if (!raw || !rfInstance.current) return

      const skill = JSON.parse(raw)
      // screenToFlowPosition accounts for current pan and zoom level.
      // Subtract half the node's approximate dimensions so the node
      // is centered on the cursor rather than placed top-left at it.
      const position = rfInstance.current.screenToFlowPosition({
        x: e.clientX - 80,  // half of ~160px min-width
        y: e.clientY - 25,  // half of ~50px typical height
      })

      nodeIdCounter.current += 1
      const id = `node-${Date.now()}-${nodeIdCounter.current}`

      const newNode: Node = {
        id,
        type: 'skill',
        position,
        width: 200,
        height: 100,
        data: {
          skillName: skill.name,
          label: skill.name,
          description: skill.description,
        },
      }

      setNodes((nds) => [...nds, newNode])
      setDirty(true)
    },
    []
  )

  const onEdgeContextMenu: EdgeMouseHandler = useCallback((event, edge) => {
    event.preventDefault()
    setEdgeMenu({ edgeId: edge.id, x: event.clientX, y: event.clientY })
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    setNodeMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
  }, [])

  function removeNode(nodeId: string) {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId))
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    setDirty(true)
    setNodeMenu(null)
  }

  function duplicateNode(nodeId: string) {
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) return
    nodeIdCounter.current += 1
    const newId = `node-${Date.now()}-${nodeIdCounter.current}`
    setNodes((nds) => [
      ...nds,
      {
        ...node,
        id: newId,
        position: { x: node.position.x + 24, y: node.position.y + 24 },
        selected: false,
      },
    ])
    setDirty(true)
    setNodeMenu(null)
  }

  function deleteEdge(edgeId: string) {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId))
    setDirty(true)
    setEdgeMenu(null)
  }

  function reverseEdge(edgeId: string) {
    setEdges((eds) =>
      eds.map((e) => {
        if (e.id !== edgeId) return e
        return {
          ...e,
          source: e.target,
          target: e.source,
          sourceHandle: e.targetHandle,
          targetHandle: e.sourceHandle,
        }
      })
    )
    setDirty(true)
    setEdgeMenu(null)
  }

  async function handleNewFlow() {
    const id = await NewFlowID()
    const flow: Flow = { id, name: 'New Skilltree', description: '', contentHash: '', nodes: [], edges: [] }
    await SaveFlow(flow as any)
    upsertFlow(flow)
    setSelectedFlowId(id)
    setFlowName('New Skilltree')
    setNodes([])
    setEdges([])
    setDirty(false)
  }

  async function handleSave() {
    if (!activeFlow) return
    setSaving(true)
    try {
      const updated: Flow = {
        id: activeFlow.id,
        name: flowName || 'New Skilltree',
        description: activeFlow.description ?? '',
        contentHash: activeFlow.contentHash ?? '',
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'skill',
          position: n.position,
          data: n.data as FlowNode['data'],
          width: n.width,
          height: n.height,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? '',
          targetHandle: e.targetHandle ?? '',
          animated: e.animated ?? true,
        })),
      }
      await SaveFlow(updated as any)
      upsertFlow(updated)
      setDirty(false)
      // Show checkmark briefly
      setSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 1800)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  // Keep refs current so App.tsx callbacks never close over stale state
  handleSaveRef.current = handleSave
  handleDiscardRef.current = () => setDirty(false)

  async function handleDelete() {
    if (!activeFlow) return
    try {
      await DeleteFlow(activeFlow.id)
      removeFlow(activeFlow.id)
      setSelectedFlowId(null)
      setConfirmDelete(false)
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  async function handleExport() {
    if (!activeFlow || !exportName) return
    try {
      const current: Flow = {
        id: activeFlow.id,
        name: flowName,
        description: activeFlow.description ?? '',
        contentHash: activeFlow.contentHash ?? '',
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'skill',
          position: n.position,
          data: n.data as FlowNode['data'],
          width: n.width,
          height: n.height,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? '',
          targetHandle: e.targetHandle ?? '',
          animated: e.animated ?? true,
        })),
      }
      await GenerateFlowSkill(current as any, exportName, exportScope)
      await onRefresh()
      setShowExport(false)
      setExportName('')
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  return (
    <div className="node-board">
      {/* Left palette */}
      <aside className="skill-palette">
        <div className="palette-header">
          <span>Skills</span>
          <span className="palette-hint">drag onto canvas</span>
        </div>
        <div className="palette-list">
          {skills.length === 0 && (
            <div className="palette-empty">No skills loaded</div>
          )}
          {skills.map((skill) => (
            <div
              key={`${skill.scope}-${skill.name}`}
              className="palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/skilltree', JSON.stringify(skill))
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <span className="palette-item-name">{skill.name}</span>
              <span className={`palette-badge ${skill.scope}`}>{skill.scope === 'global' ? 'G' : 'P'}</span>
            </div>
          ))}
        </div>
        <GithubButton />
      </aside>

      {/* Canvas area */}
      <div className="canvas-area">
        {/* Toolbar */}
        <div className="board-toolbar">
          {/* Flow selector */}
          <div className="flow-selector" onClick={() => setShowFlowMenu((v) => !v)}>
            <span className="flow-selector-name">
              {activeFlow ? flowName || activeFlow.name : 'No skilltree selected'}
            </span>
            <ChevronDown size={13} />
            {showFlowMenu && (
              <div className="flow-dropdown" onClick={(e) => e.stopPropagation()}>
                {flows.map((f) => (
                  <div
                    key={f.id}
                    className={`flow-dropdown-item ${f.id === selectedFlowId ? 'active' : ''}`}
                    onClick={() => {
                      setShowFlowMenu(false)
                      if (f.id === selectedFlowId) return
                      if (dirty) { setPendingFlowId(f.id); return }
                      setSelectedFlowId(f.id)
                    }}
                  >
                    {f.id === selectedFlowId && <Check size={12} />}
                    <span>{f.name}</span>
                  </div>
                ))}
                {flows.length === 0 && (
                  <div className="flow-dropdown-empty">No skilltrees yet</div>
                )}
              </div>
            )}
          </div>

          {activeFlow && (
            <>
              <input
                className="flow-name-input"
                value={flowName}
                onChange={(e) => { setFlowName(e.target.value); setDirty(true) }}
                placeholder="Skilltree name"
              />
              {flowWarning && (
                <div className="flow-warning">
                  <AlertTriangle size={14} className="flow-warning-icon" />
                  <div className="flow-warning-tooltip">{flowWarning}</div>
                </div>
              )}
            </>
          )}

          <div className="toolbar-gap" />

          <button className="btn-ghost toolbar-btn" onClick={handleNewFlow} title="New skilltree">
            <Plus size={14} /> New Skilltree
          </button>

          {activeFlow && (
            <>
              <button
                className={`btn-secondary toolbar-btn save-btn ${saved ? 'saved' : ''}`}
                onClick={handleSave}
                disabled={saving || !dirty}
                title="Save skilltree"
              >
                <span className={`save-icon ${saved ? 'hidden' : ''}`}><Save size={14} /></span>
                <span className={`check-icon ${saved ? 'visible' : ''}`}><Check size={14} /></span>
                {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
              </button>
              <button
                className="btn-secondary toolbar-btn"
                onClick={() => setShowExport(true)}
                title="Export as skill"
              >
                <Download size={14} /> Export
              </button>
              <button
                className="btn-ghost toolbar-btn danger"
                onClick={() => setConfirmDelete(true)}
                title="Delete skilltree"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>

        {/* React Flow canvas */}
        <div className="rf-wrapper" ref={reactFlowWrapper}>
          {!activeFlow ? (
            <div className="no-flow">
              <p>Create or select a skilltree to start building.</p>
              <button className="btn-primary" onClick={handleNewFlow}>
                <Plus size={14} /> New Skilltree
              </button>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={(changes) => {
                onNodesChange(changes)
                if (changes.some(isStructuralNodeChange)) setDirty(true)
              }}
              onEdgesChange={(changes) => {
                onEdgesChange(changes)
                if (changes.some(isStructuralEdgeChange)) setDirty(true)
              }}
              onConnect={onConnect}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onEdgeContextMenu={onEdgeContextMenu}
              onNodeContextMenu={onNodeContextMenu}
              onPaneClick={() => { setEdgeMenu(null); setNodeMenu(null) }}
              onNodeClick={() => setEdgeMenu(null)}
              onEdgeClick={() => setNodeMenu(null)}
              onInit={(inst) => { rfInstance.current = inst }}
              nodeTypes={nodeTypes}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              snapToGrid
              snapGrid={[16, 16]}
              deleteKeyCode={null}
              proOptions={{ hideAttribution: true }}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={20}
                size={1}
                color="var(--border)"
              />
              <Controls
                className="rf-controls"
                showInteractive={false}
              />
              <Panel position="bottom-right" className="rf-minimap-panel">
                <FlowMiniMap />
              </Panel>
              {nodes.length === 0 && (
                <Panel position="top-center">
                  <div className="canvas-hint">
                    Drag skills from the palette to add them here
                  </div>
                </Panel>
              )}
            </ReactFlow>
          )}
        </div>
      </div>

      {/* Unsaved changes guard — flow switch */}
      {pendingFlowId && (
        <UnsavedDialog
          onSave={async () => {
            await handleSave()
            setSelectedFlowId(pendingFlowId)
            setPendingFlowId(null)
          }}
          onDiscard={() => {
            setDirty(false)
            setSelectedFlowId(pendingFlowId)
            setPendingFlowId(null)
          }}
          onCancel={() => setPendingFlowId(null)}
        />
      )}

      {/* Edge context menu */}
      {edgeMenu && (
        <EdgeContextMenu
          x={edgeMenu.x}
          y={edgeMenu.y}
          onDelete={() => deleteEdge(edgeMenu.edgeId)}
          onReverse={() => reverseEdge(edgeMenu.edgeId)}
          onClose={() => setEdgeMenu(null)}
        />
      )}

      {/* Node context menu */}
      {nodeMenu && (
        <NodeContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          onRemove={() => removeNode(nodeMenu.nodeId)}
          onDuplicate={() => duplicateNode(nodeMenu.nodeId)}
          onClose={() => setNodeMenu(null)}
        />
      )}

      {/* Export modal */}
      {showExport && (
        <div className="modal-overlay" onClick={() => setShowExport(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Export Skilltree as Skill</h3>
            <p>
              This generates a new SKILL.md that tells Claude to execute each
              connected skill in sequence.
            </p>
            <div className="export-fields">
              <div className="editor-field">
                <label>Skill name</label>
                <input
                  value={exportName}
                  onChange={(e) => setExportName(e.target.value)}
                  placeholder="e.g. my-workflow"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && handleExport()}
                />
              </div>
              <div className="editor-field">
                <label>Scope</label>
                <div className="scope-selector">
                  <button
                    className={`scope-opt ${exportScope === 'global' ? 'active' : ''}`}
                    onClick={() => setExportScope('global')}
                  >
                    Global
                  </button>
                  <button
                    className={`scope-opt ${exportScope === 'project' ? 'active' : ''}`}
                    onClick={() => { if (projectDir) setExportScope('project') }}
                    disabled={!projectDir}
                  >
                    Project
                  </button>
                </div>
                <ProjectScopeInfo projectDir={projectDir} />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowExport(false)}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleExport}
                disabled={!exportName}
              >
                <Download size={13} /> Export
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete &ldquo;{activeFlow?.name}&rdquo;?</h3>
            <p>This will permanently delete the saved skilltree.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={handleDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Fixed world size in flow units. Nodes placed within ±1500 units from origin
// will always appear in the minimap. The viewport rect shrinks as you zoom in.
const MM_WORLD = 4000
const MM_W = 160
const MM_H = 110
const MM_SCALE = MM_WORLD / MM_W // flow units per minimap pixel
const MM_OFFSET = MM_WORLD / 2   // origin sits at the center of the world

function UnsavedDialog({
  onSave, onDiscard, onCancel,
}: {
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Unsaved changes</h3>
        <p>This skilltree has unsaved changes. What would you like to do?</p>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-ghost" onClick={onDiscard} style={{ color: 'var(--red)' }}>
            Don&apos;t Save
          </button>
          <button className="btn-primary" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  )
}

function FlowMiniMap() {
  const nodes = useNodes()
  const { x: tx, y: ty, zoom } = useViewport()
  const { setViewport } = useReactFlow()
  const cw = useRFStore((s) => s.width)
  const ch = useRFStore((s) => s.height)
  const svgRef = useRef<SVGSVGElement>(null)

  // Viewport rect in minimap pixels
  const vpFlowW = cw / zoom
  const vpFlowH = ch / zoom
  const vpFlowX = -tx / zoom
  const vpFlowY = -ty / zoom
  const mvpX = (vpFlowX + MM_OFFSET) / MM_SCALE
  const mvpY = (vpFlowY + MM_OFFSET) / MM_SCALE
  const mvpW = vpFlowW / MM_SCALE
  const mvpH = vpFlowH / MM_SCALE

  function minimapToFlow(mx: number, my: number) {
    return { x: mx * MM_SCALE - MM_OFFSET, y: my * MM_SCALE - MM_OFFSET }
  }

  const navigate = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * MM_W
    const my = ((e.clientY - rect.top) / rect.height) * MM_H
    const { x: fx, y: fy } = minimapToFlow(mx, my)
    setViewport({ x: -fx * zoom + cw / 2, y: -fy * zoom + ch / 2, zoom }, { duration: 150 })
  }, [zoom, cw, ch, setViewport])

  // Drag support
  const dragging = useRef(false)
  const onMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    dragging.current = true
    navigate(e)
  }, [navigate])
  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragging.current) return
    navigate(e)
  }, [navigate])
  const onMouseUp = useCallback(() => { dragging.current = false }, [])

  return (
    <svg
      ref={svgRef}
      width={MM_W}
      height={MM_H}
      viewBox={`0 0 ${MM_W} ${MM_H}`}
      className="rf-minimap-svg"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    >
      {/* Nodes */}
      {nodes.map((n) => {
        const nx = (n.position.x + MM_OFFSET) / MM_SCALE
        const ny = (n.position.y + MM_OFFSET) / MM_SCALE
        const nw = Math.max(2, (n.width ?? 200) / MM_SCALE)
        const nh = Math.max(1, (n.height ?? 100) / MM_SCALE)
        return <rect key={n.id} x={nx} y={ny} width={nw} height={nh} rx={1} fill="var(--border-2)" />
      })}

      {/* Viewport indicator */}
      <rect
        x={mvpX}
        y={mvpY}
        width={Math.max(4, mvpW)}
        height={Math.max(4, mvpH)}
        rx={1}
        fill="rgba(16,185,129,0.07)"
        stroke="var(--primary)"
        strokeWidth={1.5}
        pointerEvents="none"
      />
    </svg>
  )
}

function NodeContextMenu({
  x, y, onRemove, onDuplicate, onClose,
}: {
  x: number; y: number
  onRemove: () => void
  onDuplicate: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div
      className="edge-context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="edge-menu-item" onClick={onDuplicate}>
        <Copy size={13} />
        Duplicate
      </button>
      <div className="edge-menu-divider" />
      <button className="edge-menu-item danger" onClick={onRemove}>
        <Trash2 size={13} />
        Remove node
      </button>
    </div>
  )
}

function EdgeContextMenu({
  x, y, onDelete, onReverse, onClose,
}: {
  x: number; y: number
  onDelete: () => void
  onReverse: () => void
  onClose: () => void
}) {
  // Close on any outside click
  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div
      className="edge-context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="edge-menu-item" onClick={onReverse}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M7 16V4m0 0L3 8m4-4l4 4"/>
          <path d="M17 8v12m0 0l4-4m-4 4l-4-4"/>
        </svg>
        Reverse direction
      </button>
      <div className="edge-menu-divider" />
      <button className="edge-menu-item danger" onClick={onDelete}>
        <Trash2 size={13} />
        Delete connection
      </button>
    </div>
  )
}

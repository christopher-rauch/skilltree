import { useCallback, useRef, useState, useEffect, useMemo, createContext } from 'react'
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
import { AnnotationTextNode, AnnotationStickyNode, AnnotationDrawingNode } from './AnnotationNodes'
import { TextBlockNode, RunCommandNode, FileInputNode, ContextInjectorNode, VariableNode, OutputCaptureNode, HttpRequestNode } from './BuildingBlockNodes'
import {
  SaveFlow,
  DeleteFlow,
  NewFlowID,
  GenerateFlowSkill,
  SetBoardDirty,
  RunFlow,
  StopFlowRun,
} from '../../wailsjs/go/main/App'
import { EventsOn, EventsOff } from '../../wailsjs/runtime/runtime'
import {
  Plus, Save, Trash2, Download, ChevronDown, Check, X, Copy, AlertTriangle,
  Type, StickyNote, Pen, Play, Square, Terminal, Paperclip, Globe, Braces, HardDriveDownload, Wifi,
} from 'lucide-react'
import { ProjectScopeInfo } from './ProjectScopeInfo'
import { GithubButton } from './GithubButton'
import './NodeBoard.css'

const nodeTypes = {
  skill: SkillNode,
  'annotation-text':    AnnotationTextNode,
  'annotation-sticky':  AnnotationStickyNode,
  'annotation-drawing': AnnotationDrawingNode,
  'block-text':    TextBlockNode,
  'block-command': RunCommandNode,
  'block-file':    FileInputNode,
  'block-context':   ContextInjectorNode,
  'block-variable':  VariableNode,
  'block-output':    OutputCaptureNode,
  'block-http':      HttpRequestNode,
}

export const BadgeContext = createContext<Map<string, string>>(new Map())

export type RunStatus = 'running' | 'done' | 'error'
export const RunContext = createContext<Map<string, RunStatus>>(new Map())
export const IsRunningContext = createContext(false)
export const SetDirtyContext = createContext<() => void>(() => {})

function computeNodeBadges(nodes: Node[], edges: Edge[]): Map<string, string> {
  const connectedIds = new Set<string>()
  for (const e of edges) { connectedIds.add(e.source); connectedIds.add(e.target) }
  if (connectedIds.size === 0) return new Map()

  const nodeLabel = (id: string) => {
    const n = nodes.find((nd) => nd.id === id)
    return ((n?.data as Record<string, unknown>)?.label as string) || id
  }

  // Undirected adjacency for component detection
  const undirAdj = new Map<string, Set<string>>()
  for (const n of nodes) undirAdj.set(n.id, new Set())
  for (const e of edges) {
    undirAdj.get(e.source)?.add(e.target)
    undirAdj.get(e.target)?.add(e.source)
  }

  // Find connected components
  const compVisited = new Set<string>()
  const components: string[][] = []
  for (const id of connectedIds) {
    if (compVisited.has(id)) continue
    const component: string[] = []
    const queue = [id]
    while (queue.length) {
      const cur = queue.shift()!
      if (compVisited.has(cur)) continue
      compVisited.add(cur); component.push(cur)
      for (const nb of undirAdj.get(cur) ?? []) if (!compVisited.has(nb)) queue.push(nb)
    }
    components.push(component)
  }

  const result = new Map<string, string>()

  for (const component of components) {
    const compSet = new Set(component)

    // Directed adjacency + in-degree
    const dirAdj = new Map<string, string[]>()
    const inDegree = new Map<string, number>()
    for (const id of component) { dirAdj.set(id, []); inDegree.set(id, 0) }
    for (const e of edges) {
      if (!compSet.has(e.source) || !compSet.has(e.target)) continue
      dirAdj.get(e.source)!.push(e.target)
      inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    }
    // Sort children alphabetically for determinism
    for (const ch of dirAdj.values()) ch.sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b)))

    // Deepest-level topo sort (mirrors Go implementation)
    const level = new Map<string, number>()
    const remaining = new Map(inDegree)
    const topoQ: string[] = []
    for (const [id, deg] of inDegree) { if (deg === 0) { topoQ.push(id); level.set(id, 0) } }
    while (topoQ.length) {
      const cur = topoQ.shift()!
      for (const nxt of dirAdj.get(cur) ?? []) {
        const nl = (level.get(cur) ?? 0) + 1
        if (nl > (level.get(nxt) ?? 0)) level.set(nxt, nl)
        remaining.set(nxt, (remaining.get(nxt) ?? 1) - 1)
        if (remaining.get(nxt) === 0) topoQ.push(nxt)
      }
    }

    // DFS from sorted roots: visit each subtree in full before moving to the
    // next sibling. This means all descendants of branch "a" are stamped before
    // any descendant of branch "b", giving consistent letters across levels.
    const roots = component
      .filter(id => inDegree.get(id) === 0)
      .sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b)))

    const dfsOrder = new Map<string, number>() // nodeId → visit index within its level
    const levelCounter = new Map<number, number>()
    const dfsVisited = new Set<string>()
    // Stack is LIFO — push children in reverse so first child is popped first
    const stack = [...roots].reverse()
    while (stack.length) {
      const id = stack.pop()!
      if (dfsVisited.has(id)) continue
      dfsVisited.add(id)
      const lv = level.get(id) ?? 0
      dfsOrder.set(id, levelCounter.get(lv) ?? 0)
      levelCounter.set(lv, (levelCounter.get(lv) ?? 0) + 1)
      const ch = dirAdj.get(id) ?? []
      for (let i = ch.length - 1; i >= 0; i--) {
        if (!dfsVisited.has(ch[i])) stack.push(ch[i])
      }
    }

    // Group by level, sort by DFS order, assign badges
    const byLevel = new Map<number, string[]>()
    for (const [id, lv] of level) {
      if (!byLevel.has(lv)) byLevel.set(lv, [])
      byLevel.get(lv)!.push(id)
    }

    Array.from(byLevel.keys()).sort((a, b) => a - b).forEach((lv, i) => {
      const ids = byLevel.get(lv)!.sort((a, b) => (dfsOrder.get(a) ?? 0) - (dfsOrder.get(b) ?? 0))
      const num = i + 1
      ids.forEach((id, j) => {
        result.set(id, ids.length === 1 ? String(num) : `${num}${String.fromCharCode(97 + j)}`)
      })
    })
  }

  return result
}

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
    terminalOpen, setTerminalOpen,
  } = useStore()

  // Derive active flow
  const activeFlow = flows.find((f) => f.id === selectedFlowId) ?? null

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const nodeBadges = useMemo(() => computeNodeBadges(nodes, edges), [nodes, edges])

  // Flow run state
  const [runState, setRunState] = useState<Map<string, RunStatus>>(new Map())
  const [isRunning, setIsRunning] = useState(false)
  const isRunningRef = useRef(false)
  useEffect(() => { isRunningRef.current = isRunning }, [isRunning])

  useEffect(() => {
    EventsOn('run:node-active', (nodeId: string) =>
      setRunState((prev) => new Map(prev).set(nodeId, 'running')))
    EventsOn('run:node-done',   (nodeId: string) =>
      setRunState((prev) => new Map(prev).set(nodeId, 'done')))
    EventsOn('run:node-error',  (nodeId: string) =>
      setRunState((prev) => new Map(prev).set(nodeId, 'error')))
    EventsOn('run:done',    () => setIsRunning(false))
    EventsOn('run:stopped', () => setIsRunning(false))
    return () => {
      EventsOff('run:node-active', 'run:node-done', 'run:node-error', 'run:done', 'run:stopped')
    }
  }, [])

  // Clear run state when switching flows
  useEffect(() => {
    setRunState(new Map())
    setIsRunning(false)
  }, [selectedFlowId])

  // Annotation tools
  const [annotationTool, setAnnotationToolState] = useState<'text' | 'sticky' | 'pencil' | null>(null)
  const annotationToolRef = useRef<'text' | 'sticky' | 'pencil' | null>(null)
  function setAnnotationTool(t: typeof annotationTool) {
    setAnnotationToolState(t)
    annotationToolRef.current = t
  }

  // Pencil drawing
  const pencilRef = useRef<{ screenPts: { x: number; y: number }[] } | null>(null)
  const [pencilOverlay, setPencilOverlay] = useState<{ x: number; y: number }[] | null>(null)

  // Right-click marquee selection
  const marqueeAnchor = useRef<{ screenX: number; screenY: number } | null>(null)
  const marqueeActive = useRef(false)
  const marqueeBoxRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const [marqueeBox, setMarqueeBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      // Marquee
      if (marqueeAnchor.current) {
        const dx = e.clientX - marqueeAnchor.current.screenX
        const dy = e.clientY - marqueeAnchor.current.screenY
        if (!marqueeActive.current && Math.hypot(dx, dy) < 4) return
        marqueeActive.current = true
        const box = {
          x: Math.min(e.clientX, marqueeAnchor.current.screenX),
          y: Math.min(e.clientY, marqueeAnchor.current.screenY),
          w: Math.abs(dx),
          h: Math.abs(dy),
        }
        marqueeBoxRef.current = box
        setMarqueeBox(box)
      }

      // Pencil
      if (pencilRef.current) {
        const pts = pencilRef.current.screenPts
        const last = pts[pts.length - 1]
        if (Math.hypot(e.clientX - last.x, e.clientY - last.y) < 3) return
        pts.push({ x: e.clientX, y: e.clientY })
        setPencilOverlay([...pts])
      }
    }

    function onMouseUp(e: MouseEvent) {
      // Marquee (right button)
      if (e.button === 2) {
        if (marqueeActive.current && rfInstance.current && marqueeBoxRef.current) {
          const { x, y, w, h } = marqueeBoxRef.current
          const rf = rfInstance.current
          const tl = rf.screenToFlowPosition({ x, y })
          const br = rf.screenToFlowPosition({ x: x + w, y: y + h })
          setNodes((nds) => nds.map((n) => {
            const nw = n.width ?? 200
            const nh = n.height ?? 100
            const hit = n.position.x < br.x && n.position.x + nw > tl.x &&
                        n.position.y < br.y && n.position.y + nh > tl.y
            return { ...n, selected: hit }
          }))
        }
        marqueeAnchor.current = null
        marqueeActive.current = false
        marqueeBoxRef.current = null
        setMarqueeBox(null)
      }

      // Pencil commit (left button)
      if (e.button === 0 && pencilRef.current && rfInstance.current) {
        const pts = pencilRef.current.screenPts
        if (pts.length > 1) {
          const rf = rfInstance.current
          const PAD = 6
          const flowPts = pts.map((p) => rf.screenToFlowPosition(p))
          const xs = flowPts.map((p) => p.x)
          const ys = flowPts.map((p) => p.y)
          const minX = Math.min(...xs) - PAD
          const minY = Math.min(...ys) - PAD
          const maxX = Math.max(...xs) + PAD
          const maxY = Math.max(...ys) + PAD
          const relPts = flowPts.map((p) => ({ x: p.x - minX, y: p.y - minY }))
          const pathD = 'M ' + relPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')
          const annId = `ann-${Date.now()}`
          setNodes((nds) => [
            ...nds,
            {
              id: annId,
              type: 'annotation-drawing',
              position: { x: minX, y: minY },
              data: { path: pathD, width: maxX - minX, height: maxY - minY },
              width: maxX - minX,
              height: maxY - minY,
              selected: false,
            },
          ])
          setDirty(true)
        }
        pencilRef.current = null
        setPencilOverlay(null)
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [setNodes])

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

  const hasEmptyArgs = useMemo(() =>
    nodes.some((n) => !n.type?.startsWith('annotation-') && n.data.argumentHint && !(n.data.argumentValue as string | undefined)?.trim()),
    [nodes]
  )

  // Detect gaps: rogue nodes (no connections) or disconnected subgraphs
  const flowWarning = useMemo(() => {
    const skillNodes = nodes.filter((n) => !n.type?.startsWith('annotation-'))
    if (skillNodes.length < 2) return null

    const adj = new Map<string, Set<string>>()
    for (const n of skillNodes) adj.set(n.id, new Set())
    for (const e of edges) {
      adj.get(e.source)?.add(e.target)
      adj.get(e.target)?.add(e.source)
    }

    const visited = new Set<string>()
    let components = 0
    for (const n of skillNodes) {
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

    const isolated = skillNodes.filter((n) => adj.get(n.id)!.size === 0)
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
      if (isRunningRef.current) return
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

  function toRFNodes(flowNodes: FlowNode[], annotations: Flow['annotations'] = []): Node[] {
    const skill = flowNodes.map((n) => {
      const skillName = n.data.skillName as string | undefined
      const matchedSkill = skills.find((s) => s.name === skillName)
      return {
        id: n.id,
        type: n.type || 'skill',
        position: n.position,
        data: {
          ...n.data,
          ...(matchedSkill?.argumentHint ? { argumentHint: matchedSkill.argumentHint } : {}),
        },
        ...(n.width  ? { width:  n.width  } : {}),
        ...(n.height ? { height: n.height } : {}),
      }
    })
    const ann = (annotations ?? []).map((a) => ({
      id: a.id,
      type: `annotation-${a.type}`,
      position: a.position,
      data: a.data,
      ...(a.width  ? { width:  a.width  } : {}),
      ...(a.height ? { height: a.height } : {}),
    }))
    return [...skill, ...ann]
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
      setNodes(toRFNodes(activeFlow.nodes, activeFlow.annotations))
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
      if (isRunningRef.current) return
      if (params.source === params.target) return

      // Reject if adding this edge would create a cycle:
      // check whether params.source is already reachable from params.target
      setEdges((eds) => {
        if (eds.some((e) => e.target === params.target)) return eds // target already has an input

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
      if (isRunningRef.current || !rfInstance.current) return

      // Building block drop
      const blockRaw = e.dataTransfer.getData('application/skilltree-block')
      if (blockRaw) {
        const { blockType } = JSON.parse(blockRaw)
        const position = rfInstance.current.screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 40 })
        nodeIdCounter.current += 1
        const id = `node-${Date.now()}-${nodeIdCounter.current}`
        const defaults: Record<string, { label: string; height: number; data: Record<string, unknown> }> = {
          text:    { label: 'Text Block',  height: 180, data: { content: '' } },
          command: { label: 'Run Command', height: 90,  data: { scriptPath: '' } },
          file:    { label: 'File Input',      height: 140, data: { filePath: '', instruction: '' } },
          context:  { label: 'Context Injector', height: 180, data: { content: '' } },
          variable: { label: 'Variables',        height: 130, data: { variables: [] } },
          output:   { label: 'Output Capture',   height: 110, data: { destination: 'file', filePath: '' } },
          http:     { label: 'HTTP Request',     height: 160, data: { method: 'GET', url: '', headers: [], body: '', responseVar: 'http_response', showHeaders: false } },
        }
        const def = defaults[blockType] ?? defaults.text
        setNodes((nds) => [...nds, {
          id,
          type: `block-${blockType}`,
          position,
          width: 240,
          height: def.height,
          data: { label: def.label, ...def.data },
        }])
        setDirty(true)
        return
      }

      const raw = e.dataTransfer.getData('application/skilltree')
      if (!raw) return

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
          ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
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
    setEdges((eds) => {
      const edge = eds.find((e) => e.id === edgeId)
      if (!edge) return eds
      // After reversal, edge.source becomes the new target — reject if it already has another input
      const newTarget = edge.source
      if (eds.some((e) => e.id !== edgeId && e.target === newTarget)) return eds
      return eds.map((e) => {
        if (e.id !== edgeId) return e
        return {
          ...e,
          source: e.target,
          target: e.source,
          sourceHandle: e.targetHandle,
          targetHandle: e.sourceHandle,
        }
      })
    })
    setDirty(true)
    setEdgeMenu(null)
  }

  async function handleRun() {
    if (!activeFlow || isRunning) return
    setTerminalOpen(true)
    setRunState(new Map())
    setIsRunning(true)
    const skillNodes = nodes.filter((n) => !n.type?.startsWith('annotation-'))
    const runFlow = {
      id: activeFlow.id,
      name: flowName || activeFlow.name,
      description: activeFlow.description ?? '',
      contentHash: activeFlow.contentHash ?? '',
      nodes: skillNodes.map((n) => ({
        id: n.id, type: n.type ?? 'skill', position: n.position,
        data: n.data as FlowNode['data'], width: n.width ?? 0, height: n.height ?? 0,
      })),
      edges: edges.map((e) => ({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: e.sourceHandle ?? '', targetHandle: e.targetHandle ?? '',
        animated: e.animated ?? true,
      })),
    }
    await RunFlow(runFlow as any)
  }

  function handleStopRun() {
    StopFlowRun()
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
      const skillNodes = nodes.filter((n) => !n.type?.startsWith('annotation-'))
      const annNodes   = nodes.filter((n) =>  n.type?.startsWith('annotation-'))
      const updated: Flow = {
        id: activeFlow.id,
        name: flowName || 'New Skilltree',
        description: activeFlow.description ?? '',
        contentHash: activeFlow.contentHash ?? '',
        nodes: skillNodes.map((n) => ({
          id: n.id,
          type: n.type ?? 'skill',
          position: n.position,
          data: n.data as FlowNode['data'],
          width: n.width,
          height: n.height,
        })),
        annotations: annNodes.map((n) => ({
          id: n.id,
          type: n.type!.replace('annotation-', '') as 'text' | 'sticky' | 'drawing',
          position: n.position,
          data: n.data as Record<string, unknown>,
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
              className={`palette-item ${isRunning ? 'disabled' : ''}`}
              draggable={!isRunning}
              onDragStart={(e) => {
                e.dataTransfer.setData('application/skilltree', JSON.stringify(skill))
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <span className="palette-item-name">{skill.name}</span>
              <span className={`palette-badge ${skill.scope}`}>{skill.scope === 'global' ? 'G' : skill.scope === 'library' ? 'L' : 'P'}</span>
            </div>
          ))}
        </div>
        <div className="palette-tools-section">
          <div className="palette-tools-header">Building Blocks</div>
          <div className="palette-tools-list">
            {([
              { blockType: 'text',    icon: <Type size={13} />,      label: 'Text Block'      },
              { blockType: 'command', icon: <Terminal size={13} />,  label: 'Run Command'     },
              { blockType: 'file',    icon: <Paperclip size={13} />, label: 'File Input'      },
              { blockType: 'context',  icon: <Globe size={13} />,   label: 'Context Injector' },
              { blockType: 'variable', icon: <Braces size={13} />,          label: 'Variable'        },
              { blockType: 'output',   icon: <HardDriveDownload size={13} />, label: 'Output Capture' },
              { blockType: 'http',     icon: <Wifi size={13} />,             label: 'HTTP Request'   },
            ] as const).map(({ blockType, icon, label }) => (
              <div
                key={blockType}
                className={`palette-item ${isRunning ? 'disabled' : ''}`}
                draggable={!isRunning}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/skilltree-block', JSON.stringify({ blockType }))
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <span className="palette-item-name" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {icon}{label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="palette-tools-section">
          <div className="palette-tools-header">Canvas Tools</div>
          <div className="palette-tools-list">
            {([
              { tool: 'text',   icon: <Type size={13} />,       label: 'Text'   },
              { tool: 'sticky', icon: <StickyNote size={13} />, label: 'Sticky' },
              { tool: 'pencil', icon: <Pen size={13} />,        label: 'Pencil' },
            ] as const).map(({ tool, icon, label }) => (
              <button
                key={tool}
                className={`palette-tool-btn ${annotationTool === tool ? 'active' : ''}`}
                onClick={() => !isRunning && setAnnotationTool(annotationTool === tool ? null : tool)}
                disabled={isRunning}
                title={label}
              >
                {icon}
                <span>{label}</span>
              </button>
            ))}
          </div>
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
                disabled={saving || !dirty || isRunning}
                title="Save skilltree"
              >
                <span className={`save-icon ${saved ? 'hidden' : ''}`}><Save size={14} /></span>
                <span className={`check-icon ${saved ? 'visible' : ''}`}><Check size={14} /></span>
                {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
              </button>
              <button
                className="btn-secondary toolbar-btn"
                onClick={() => setShowExport(true)}
                disabled={isRunning}
                title="Export as skill"
              >
                <Download size={14} /> Export
              </button>
              {!isRunning ? (
                <button
                  className="btn-primary toolbar-btn"
                  onClick={handleRun}
                  disabled={dirty || hasEmptyArgs}
                  title={dirty ? 'Save before running' : hasEmptyArgs ? 'Fill in all argument inputs before running' : 'Run skilltree step by step'}
                >
                  <Play size={14} /> Run
                </button>
              ) : (
                <button
                  className="btn-danger toolbar-btn"
                  onClick={handleStopRun}
                  title="Stop run"
                >
                  <Square size={14} /> Stop
                </button>
              )}
              <button
                className="btn-ghost toolbar-btn danger"
                onClick={() => setConfirmDelete(true)}
                disabled={isRunning}
                title="Delete skilltree"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>

        {/* React Flow canvas */}
        <div
          className="rf-wrapper"
          ref={reactFlowWrapper}
          style={{ cursor: annotationTool === 'pencil' ? 'crosshair' : annotationTool ? 'cell' : undefined }}
          onMouseDown={(e) => {
            const target = e.target as HTMLElement
            const onNode = target.closest('.react-flow__node') || target.closest('.react-flow__edge')

            // Right-click marquee (pane only)
            if (e.button === 2 && !onNode) {
              marqueeAnchor.current = { screenX: e.clientX, screenY: e.clientY }
              marqueeActive.current = false
              return
            }

            // Left-click annotation tool (pane only)
            if (e.button === 0 && !onNode && rfInstance.current && !isRunningRef.current) {
              const tool = annotationToolRef.current
              if (tool === 'text' || tool === 'sticky') {
                const pos = rfInstance.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                const annId = `ann-${Date.now()}`
                setNodes((nds) => [...nds, {
                  id: annId,
                  type: `annotation-${tool}`,
                  position: { x: pos.x - 60, y: pos.y - 12 },
                  data: { text: '', editing: true },
                  selected: false,
                }])
                setDirty(true)
              } else if (tool === 'pencil') {
                pencilRef.current = { screenPts: [{ x: e.clientX, y: e.clientY }] }
                setPencilOverlay([{ x: e.clientX, y: e.clientY }])
              }
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {marqueeBox && (
            <div
              className="marquee-box"
              style={{ left: marqueeBox.x, top: marqueeBox.y, width: marqueeBox.w, height: marqueeBox.h }}
            />
          )}
          {pencilOverlay && pencilOverlay.length > 1 && (
            <svg className="pencil-overlay" style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 1000 }}>
              <polyline
                points={pencilOverlay.map((p) => `${p.x},${p.y}`).join(' ')}
                stroke="var(--text-2)"
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {!activeFlow ? (
            <div className="no-flow">
              <p>Create or select a skilltree to start building.</p>
              <button className="btn-primary" onClick={handleNewFlow}>
                <Plus size={14} /> New Skilltree
              </button>
            </div>
          ) : (
            <SetDirtyContext.Provider value={() => setDirty(true)}>
            <IsRunningContext.Provider value={isRunning}>
            <RunContext.Provider value={runState}>
            <BadgeContext.Provider value={nodeBadges}>
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
              nodesDraggable={!isRunning}
              nodesConnectable={!isRunning}
              panOnDrag={annotationTool === null}
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
            </BadgeContext.Provider>
            </RunContext.Provider>
            </IsRunningContext.Provider>
            </SetDirtyContext.Provider>
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
      {edgeMenu && (() => {
        const menuEdge = edges.find((e) => e.id === edgeMenu.edgeId)
        const canReverse = menuEdge
          ? !edges.some((e) => e.id !== edgeMenu.edgeId && e.target === menuEdge.source)
          : false
        return (
          <EdgeContextMenu
            x={edgeMenu.x}
            y={edgeMenu.y}
            onDelete={() => deleteEdge(edgeMenu.edgeId)}
            onReverse={() => reverseEdge(edgeMenu.edgeId)}
            onClose={() => setEdgeMenu(null)}
            canReverse={canReverse}
          />
        )
      })()}

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
  x, y, onDelete, onReverse, onClose, canReverse,
}: {
  x: number; y: number
  onDelete: () => void
  onReverse: () => void
  onClose: () => void
  canReverse: boolean
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
      <button className="edge-menu-item" onClick={onReverse} disabled={!canReverse} title={!canReverse ? 'Target node already has an input' : undefined}>
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

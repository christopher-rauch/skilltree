import { useEffect, useRef, useCallback, useState } from 'react'
import './App.css'
import { useStore } from './store'
import { SkillManager } from './components/SkillManager'
import { NodeBoard } from './components/NodeBoard'
import { SkillTrees } from './components/SkillTrees'
import { Terminal } from './components/Terminal'
import {
  GetGlobalSkills, GetProjectSkills, GetFlows,
  GetProjectDir, OpenProjectDirectory,
  NewFlowID, SaveFlow,
  GenerateFlowDescriptions,
  OpenURL,
} from '../wailsjs/go/main/App'
import { EventsOn, EventsOff } from '../wailsjs/runtime/runtime'
import { GitBranch, FolderOpen, X, TerminalSquare, ChevronDown } from 'lucide-react'

function App() {
  const {
    view, setView,
    setSkills, setFlows,
    projectDir, setProjectDir,
    error, setError,
    upsertFlow, setSelectedFlowId,
    terminalOpen, setTerminalOpen,
    terminalHeight, setTerminalHeight,
    terminalAlive, setTerminalAlive,
    updateFlowDescription,
    boardDirty,
    onSaveBoard, onDiscardBoard,
  } = useStore()

  const [pendingView, setPendingView] = useState<'skills' | 'trees' | 'board' | null>(null)

  function requestView(v: 'skills' | 'trees' | 'board') {
    if (v === view) return
    if (view === 'board' && boardDirty) {
      setPendingView(v)
    } else {
      setView(v)
    }
  }

  const dragState = useRef<{ startY: number; startH: number } | null>(null)

  async function loadAll() {
    try {
      const [global, project, flows] = await Promise.all([
        GetGlobalSkills(), GetProjectSkills(), GetFlows(),
      ])
      const g = (global ?? []).map((s) => ({ ...s, scope: 'global' as const }))
      const p = (project ?? []).map((s) => ({ ...s, scope: 'project' as const }))
      setSkills([...g, ...p])
      setFlows((flows ?? []) as any)
      // Kick off description generation for any flows missing one
      GenerateFlowDescriptions()
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  useEffect(() => {
    GetProjectDir().then((d) => { if (d) setProjectDir(d) })
    loadAll()

    // MCP events — Claude controlling the GUI
    EventsOn('mcp:navigate', (view: string) => setView(view as any))
    EventsOn('mcp:refresh', () => loadAll())
    EventsOn('mcp:open_flow', (id: string) => {
      setSelectedFlowId(id)
      setView('board')
    })
    // Description generated in background
    EventsOn('flow:description_updated', (payload: { id: string; description: string }) => {
      updateFlowDescription(payload.id, payload.description)
    })

    return () => {
      EventsOff('mcp:navigate')
      EventsOff('mcp:refresh')
      EventsOff('mcp:open_flow')
      EventsOff('flow:description_updated')
    }
  }, [])

  async function handleOpenProject() {
    try {
      const dir = await OpenProjectDirectory()
      if (dir) {
        setProjectDir(dir)
        const [global, project] = await Promise.all([GetGlobalSkills(), GetProjectSkills()])
        const g = (global ?? []).map((s) => ({ ...s, scope: 'global' as const }))
        const p = (project ?? []).map((s) => ({ ...s, scope: 'project' as const }))
        setSkills([...g, ...p])
      }
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  async function handleNewFlow() {
    const id = await NewFlowID()
    const flow = { id, name: 'New Skilltree', description: '', contentHash: '', nodes: [], edges: [] }
    await SaveFlow(flow as any)
    upsertFlow(flow)
    setSelectedFlowId(id)
    setView('board')
  }

  // Resize drag for terminal panel
  const onResizeDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragState.current = { startY: e.clientY, startH: terminalHeight }
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return
      const delta = dragState.current.startY - ev.clientY
      setTerminalHeight(Math.max(120, Math.min(600, dragState.current.startH + delta)))
    }
    const onUp = () => {
      dragState.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [terminalHeight])

  const projectBasename = projectDir ? projectDir.split('/').filter(Boolean).pop() : null

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-logo">
          <GitBranch size={16} />
          <span className="titlebar-title">Skilltree</span>
        </div>

        <nav className="titlebar-nav">
          {(['skills', 'trees', 'board'] as const).map((v) => (
            <button
              key={v}
              className={`nav-btn ${view === v ? 'active' : ''}`}
              onClick={() => requestView(v)}
            >
              {v === 'skills' ? 'Skills' : v === 'trees' ? 'Skilltrees' : 'Builder'}
            </button>
          ))}
        </nav>

        <div className="titlebar-spacer" />

        <div className="titlebar-project">
          {projectBasename && (
            <span className="project-path" title={projectDir}>{projectBasename}</span>
          )}
          <button className="btn-ghost" onClick={handleOpenProject} title="Open project directory">
            <FolderOpen size={14} />
          </button>
          <button
            className={`btn-ghost terminal-toggle ${terminalOpen ? 'active' : ''}`}
            onClick={() => setTerminalOpen(!terminalOpen)}
            title="Toggle terminal"
          >
            <TerminalSquare size={14} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-bar">
          <span>{error}</span>
          <button className="btn-ghost" onClick={() => setError(null)}><X size={12} /></button>
        </div>
      )}

      <div className="content-with-terminal">
        <main className="main-content">
          {view === 'skills' && <SkillManager onRefresh={loadAll} />}
          {view === 'trees' && (
            <SkillTrees
              onOpenInBoard={(id) => { setSelectedFlowId(id); setView('board') }}
              onNewFlow={handleNewFlow}
              onRefresh={loadAll}
            />
          )}
          {view === 'board' && <NodeBoard onRefresh={loadAll} />}
        </main>

        {terminalOpen && (
          <>
            <div
              className="terminal-resize-handle"
              onMouseDown={onResizeDragStart}
            />
            <div className="terminal-panel" style={{ height: terminalHeight }}>
              <div className="terminal-header">
                <TerminalSquare size={13} />
                <span>Claude</span>
                {terminalAlive && <span className="terminal-alive-dot" />}
                <div className="terminal-header-gap" />
                <button
                  className="btn-ghost terminal-close"
                  onClick={() => setTerminalOpen(false)}
                >
                  <ChevronDown size={13} />
                </button>
              </div>
              <div className="terminal-body">
                <Terminal onExit={() => setTerminalAlive(false)} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Unsaved changes guard — view navigation */}
      {pendingView && (
        <div className="modal-overlay" onClick={() => setPendingView(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Unsaved changes</h3>
            <p>This skilltree has unsaved changes. What would you like to do?</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setPendingView(null)}>
                Cancel
              </button>
              <button
                className="btn-ghost"
                style={{ color: 'var(--red)' }}
                onClick={() => {
                  onDiscardBoard?.()
                  setView(pendingView)
                  setPendingView(null)
                }}
              >
                Don&apos;t Save
              </button>
              <button
                className="btn-primary"
                onClick={async () => {
                  await onSaveBoard?.()
                  setView(pendingView)
                  setPendingView(null)
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

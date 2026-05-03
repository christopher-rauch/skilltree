import { useState } from 'react'
import { useStore } from '../store'
import { Flow } from '../types'
import { DeleteFlow, GenerateFlowSkill, RegenerateFlowDescription, DuplicateFlow } from '../../wailsjs/go/main/App'
import { Plus, Trash2, ArrowRight, Download, GitBranch, Layers, RefreshCw, Copy } from 'lucide-react'
import { ProjectScopeInfo } from './ProjectScopeInfo'
import './SkillTrees.css'

interface Props {
  onOpenInBoard: (flowId: string) => void
  onNewFlow: () => void
  onRefresh: () => Promise<void>
}

export function SkillTrees({ onOpenInBoard, onNewFlow, onRefresh }: Props) {
  const { flows, projectDir, removeFlow, setError } = useStore()
  const [confirmDelete, setConfirmDelete] = useState<Flow | null>(null)
  const [exporting, setExporting] = useState<Flow | null>(null)
  const [exportName, setExportName] = useState('')
  const [exportScope, setExportScope] = useState<'global' | 'project'>('global')

  async function handleDelete(flow: Flow) {
    try {
      await DeleteFlow(flow.id)
      removeFlow(flow.id)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setConfirmDelete(null)
    }
  }

  async function handleExport() {
    if (!exporting || !exportName.trim()) return
    try {
      await GenerateFlowSkill(exporting as any, exportName.trim(), exportScope)
      await onRefresh()
      setExporting(null)
      setExportName('')
    } catch (e: unknown) {
      setError(String(e))
    }
  }

  return (
    <div className="skilltrees-page">
      <div className="skilltrees-header">
        <div>
          <h1 className="skilltrees-title">Skilltrees</h1>
          <p className="skilltrees-subtitle">
            {flows.length} saved skilltree{flows.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button className="btn-primary" onClick={onNewFlow}>
          <Plus size={14} /> New Skilltree
        </button>
      </div>

      {flows.length === 0 ? (
        <div className="trees-empty">
          <GitBranch size={40} />
          <p>No skilltrees yet.</p>
          <button className="btn-primary" onClick={onNewFlow}>
            <Plus size={14} /> Create your first skilltree
          </button>
        </div>
      ) : (
        <div className="trees-grid">
          {flows.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onOpen={() => onOpenInBoard(flow.id)}
              onDelete={() => setConfirmDelete(flow)}
              onExport={() => { setExporting(flow); setExportName(flow.name.toLowerCase().replace(/\s+/g, '-')) }}
              onDuplicate={async () => { await DuplicateFlow(flow.id); onRefresh() }}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete &ldquo;{confirmDelete.name}&rdquo;?</h3>
            <p>This will permanently delete the saved skilltree.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn-danger" onClick={() => handleDelete(confirmDelete)}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Export modal */}
      {exporting && (
        <div className="modal-overlay" onClick={() => setExporting(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Export &ldquo;{exporting.name}&rdquo; as Skill</h3>
            <p>
              Generates a SKILL.md that tells Claude to execute each connected
              skill in phase order, running concurrent nodes in parallel.
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
                  >Global</button>
                  <button
                    className={`scope-opt ${exportScope === 'project' ? 'active' : ''}`}
                    onClick={() => { if (projectDir) setExportScope('project') }}
                    disabled={!projectDir}
                  >Project</button>
                </div>
                <ProjectScopeInfo projectDir={projectDir} />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setExporting(null)}>Cancel</button>
              <button className="btn-primary" onClick={handleExport} disabled={!exportName.trim()}>
                <Download size={13} /> Export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function FlowCard({
  flow, onOpen, onDelete, onExport, onDuplicate,
}: {
  flow: Flow
  onOpen: () => void
  onDelete: () => void
  onExport: () => void
  onDuplicate: () => void
}) {
  const [regenerating, setRegenerating] = useState(false)

  async function handleRegenerate() {
    setRegenerating(true)
    RegenerateFlowDescription(flow.id)
    // The result arrives via the flow:description_updated event (handled in App.tsx)
    // Show spinner for a couple seconds then reset regardless
    setTimeout(() => setRegenerating(false), 4000)
  }

  // Build a deduplicated, sorted list of skill names from nodes
  const skillNames = [...new Set(
    flow.nodes.map((n) => (n.data.label as string) || (n.data.skillName as string) || '').filter(Boolean)
  )].sort()

  // Count edges per source to detect fan-out (concurrent steps).
  // Condition nodes have two outputs by design (yes/no branches) — exclude them.
  const conditionNodeIds = new Set(flow.nodes.filter((n) => n.type === 'block-condition').map((n) => n.id))
  const outDegree: Record<string, number> = {}
  for (const edge of flow.edges) {
    if (!conditionNodeIds.has(edge.source)) {
      outDegree[edge.source] = (outDegree[edge.source] ?? 0) + 1
    }
  }
  const hasConcurrent = Object.values(outDegree).some((d) => d > 1)

  return (
    <div className="flow-card">
      <div className="flow-card-header">
        <div className="flow-card-meta">
          <h2 className="flow-card-name">{flow.name}</h2>
          {regenerating ? (
            <p className="flow-card-description flow-card-description-loading">Generating…</p>
          ) : flow.description ? (
            <p className="flow-card-description">{flow.description}</p>
          ) : null}
          <div className="flow-card-stats">
            <span><Layers size={11} /> {flow.nodes.length} node{flow.nodes.length !== 1 ? 's' : ''}</span>
            <span><GitBranch size={11} /> {flow.edges.length} connection{flow.edges.length !== 1 ? 's' : ''}</span>
            {hasConcurrent && <span className="badge-concurrent">concurrent</span>}
          </div>
        </div>
      </div>

      {skillNames.length > 0 && (
        <div className="flow-card-nodes">
          {skillNames.slice(0, 8).map((name) => (
            <span key={name} className="flow-node-chip">{name}</span>
          ))}
          {skillNames.length > 8 && (
            <span className="flow-node-chip muted">+{skillNames.length - 8} more</span>
          )}
        </div>
      )}

      {flow.nodes.length === 0 && (
        <p className="flow-card-empty">Empty skilltree</p>
      )}

      <div className="flow-card-actions">
        <button className="btn-ghost flow-action-btn" onClick={onDuplicate} title="Duplicate">
          <Copy size={13} />
        </button>
        <button
          className={`btn-ghost flow-action-btn ${regenerating ? 'regenerating' : ''}`}
          onClick={handleRegenerate}
          disabled={regenerating || flow.nodes.length === 0}
          title="Regenerate description"
        >
          <RefreshCw size={13} className={regenerating ? 'spin' : ''} />
        </button>
        <button className="btn-ghost flow-action-btn" onClick={onExport} title="Export as skill">
          <Download size={13} /> Export
        </button>
        <button className="btn-ghost flow-action-btn danger" onClick={onDelete} title="Delete">
          <Trash2 size={13} />
        </button>
        <button className="btn-primary flow-action-btn" onClick={onOpen}>
          Open <ArrowRight size={13} />
        </button>
      </div>
    </div>
  )
}

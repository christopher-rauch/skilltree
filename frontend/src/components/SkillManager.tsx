import { useState } from 'react'
import { useStore } from '../store'
import { Skill, SkillScope } from '../types'
import { SkillEditor } from './SkillEditor'
import { Plus, Trash2, Edit2, Globe, Folder, ChevronRight } from 'lucide-react'
import './SkillManager.css'
import { DeleteSkill } from '../../wailsjs/go/main/App'
import { GithubButton } from './GithubButton'

interface Props {
  onRefresh: () => Promise<void>
}

export function SkillManager({ onRefresh }: Props) {
  const { skills, activeScope, setActiveScope, setError, projectDir } = useStore()
  const [editing, setEditing] = useState<Skill | null>(null)
  const [creating, setCreating] = useState<SkillScope | null>(null)
  const [selected, setSelected] = useState<Skill | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Skill | null>(null)

  const scopeSkills = skills.filter((s) => s.scope === activeScope)

  async function handleDelete(skill: Skill) {
    try {
      await DeleteSkill(skill.name, skill.scope)
      await onRefresh()
      if (selected?.name === skill.name && selected?.scope === skill.scope) {
        setSelected(null)
      }
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setConfirmDelete(null)
    }
  }

  function handleEditorClose() {
    setEditing(null)
    setCreating(null)
  }

  async function handleEditorSave(saved: Skill) {
    await onRefresh()
    setEditing(null)
    setCreating(null)
    setSelected(saved)
  }

  const displaySkill = selected

  return (
    <div className="skill-manager">
      {/* Sidebar */}
      <aside className="skill-sidebar">
        <div className="scope-tabs">
          <button
            className={`scope-tab ${activeScope === 'global' ? 'active' : ''}`}
            onClick={() => { setActiveScope('global'); setSelected(null) }}
          >
            <Globe size={13} />
            Global
          </button>
          <button
            className={`scope-tab ${activeScope === 'project' ? 'active' : ''}`}
            onClick={() => { setActiveScope('project'); setSelected(null) }}
            title={projectDir || 'No project open'}
          >
            <Folder size={13} />
            Project
          </button>
        </div>

        <div className="skill-list-header">
          <span className="skill-list-count">{scopeSkills.length} skill{scopeSkills.length !== 1 ? 's' : ''}</span>
          <button
            className="btn-primary btn-sm"
            onClick={() => setCreating(activeScope)}
            title="New skill"
          >
            <Plus size={13} />
            New
          </button>
        </div>

        <div className="skill-list" style={{ flex: 1 }}>
          {scopeSkills.length === 0 ? (
            <div className="skill-list-empty">
              {activeScope === 'project' && !projectDir
                ? 'Open a project to see project skills'
                : 'No skills yet'}
            </div>
          ) : (
            scopeSkills.map((skill) => (
              <div
                key={skill.name}
                className={`skill-item ${selected?.name === skill.name && selected?.scope === skill.scope ? 'active' : ''}`}
                onClick={() => setSelected(skill)}
              >
                <div className="skill-item-body">
                  <span className="skill-item-name">{skill.name}</span>
                  {skill.description && (
                    <span className="skill-item-desc">{skill.description}</span>
                  )}
                </div>
                <div className="skill-item-actions">
                  <button
                    className="skill-icon-btn"
                    title="Edit"
                    onClick={(e) => { e.stopPropagation(); setEditing(skill) }}
                  >
                    <Edit2 size={12} />
                  </button>
                  <button
                    className="skill-icon-btn danger"
                    title="Delete"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(skill) }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <ChevronRight size={12} className="skill-item-chevron" />
              </div>
            ))
          )}
        </div>
        <GithubButton />
      </aside>

      {/* Detail panel */}
      <div className="skill-detail">
        {displaySkill ? (
          <SkillDetail skill={displaySkill} onEdit={() => setEditing(displaySkill)} />
        ) : (
          <div className="empty-state">
            <Edit2 size={32} />
            <p>Select a skill to preview it, or create a new one.</p>
          </div>
        )}
      </div>

      {/* Editor panel (create or edit) */}
      {(editing || creating) && (
        <SkillEditor
          skill={editing ?? undefined}
          defaultScope={creating ?? editing?.scope ?? 'global'}
          onClose={handleEditorClose}
          onSave={handleEditorSave}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete &ldquo;{confirmDelete.name}&rdquo;?</h3>
            <p>This will permanently remove the skill from disk.</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={() => handleDelete(confirmDelete)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SkillDetail({ skill, onEdit }: { skill: Skill; onEdit: () => void }) {
  return (
    <div className="skill-detail-content">
      <div className="skill-detail-header">
        <div>
          <h2 className="skill-detail-name">{skill.name}</h2>
          {skill.description && (
            <p className="skill-detail-desc">{skill.description}</p>
          )}
        </div>
        <button className="btn-secondary btn-sm" onClick={onEdit}>
          <Edit2 size={13} /> Edit
        </button>
      </div>

      {(skill.argumentHint || skill.allowedTools) && (
        <div className="skill-meta">
          {skill.argumentHint && (
            <div className="meta-row">
              <span className="meta-label">argument-hint</span>
              <code className="meta-value">{skill.argumentHint}</code>
            </div>
          )}
          {skill.allowedTools && (
            <div className="meta-row">
              <span className="meta-label">allowed-tools</span>
              <div className="tool-chips">
                {skill.allowedTools.split(',').map((t) => (
                  <span key={t.trim()} className="tool-chip">{t.trim()}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="skill-body-container">
        <label>Body</label>
        <pre className="skill-body">{skill.body || <span style={{ color: 'var(--text-3)' }}>No body content</span>}</pre>
      </div>
    </div>
  )
}

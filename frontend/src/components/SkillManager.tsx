import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { Skill, SkillScope } from '../types'
import { SkillEditor } from './SkillEditor'
import { Plus, Trash2, Edit2, Globe, Folder, BookOpen, ChevronRight, Lock } from 'lucide-react'
import './SkillManager.css'
import { DeleteSkill } from '../../wailsjs/go/main/App'
import { GithubButton } from './GithubButton'

interface Props {
  onRefresh: () => Promise<void>
}

export function SkillManager({ onRefresh }: Props) {
  const { skills, activeScope, setActiveScope, setError, projectDir, previewSkill, setPreviewSkill } = useStore()
  const [editing, setEditing] = useState<Skill | null>(null)
  const [creating, setCreating] = useState<SkillScope | null>(null)
  const [selected, setSelected] = useState<Skill | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Skill | null>(null)
  const [projectPrompt, setProjectPrompt] = useState<{ action: 'create' | 'edit'; skill?: Skill } | null>(null)

  // Handle preview requests from the Builder
  useEffect(() => {
    if (!previewSkill) return
    const skill = skills.find((s) => s.name === previewSkill.name && s.scope === previewSkill.scope)
    if (skill) {
      setActiveScope(previewSkill.scope)
      setSelected(skill)
    }
    setPreviewSkill(null)
  }, [previewSkill])

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
            className={`scope-tab scope-global ${activeScope === 'global' ? 'active' : ''}`}
            onClick={() => { setActiveScope('global'); setSelected(null) }}
          >
            <Globe size={13} />
            Global
          </button>
          <button
            className={`scope-tab scope-project ${activeScope === 'project' ? 'active' : ''}`}
            onClick={() => { setActiveScope('project'); setSelected(null) }}
            title={projectDir || 'No project open'}
          >
            <Folder size={13} />
            Project
          </button>
          <button
            className={`scope-tab scope-library ${activeScope === 'library' ? 'active' : ''}`}
            onClick={() => { setActiveScope('library'); setSelected(null) }}
            title="Library skills — inlined into exported skilltrees (~/.claude/skilltree/skills)"
          >
            <BookOpen size={13} />
            Library
          </button>
        </div>

        <div className="skill-list-header">
          <span className="skill-list-count">{scopeSkills.length} skill{scopeSkills.length !== 1 ? 's' : ''}</span>
          <button
            className={`btn-primary btn-sm scope-${activeScope}`}
            onClick={() => activeScope === 'project' ? setProjectPrompt({ action: 'create' }) : setCreating(activeScope)}
            disabled={activeScope === 'project' && !projectDir}
            title={activeScope === 'project' && !projectDir ? 'Open a project first' : 'New skill'}
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
                : activeScope === 'library'
                ? 'No library skills yet — library skills are inlined into exported skilltrees'
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
                  {skill.system ? (
                    <span className="skill-system-badge" title="System skill — read only">
                      <Lock size={11} />
                    </span>
                  ) : (
                    <>
                      <button
                        className="skill-icon-btn"
                        title="Edit"
                        onClick={(e) => { e.stopPropagation(); skill.scope === 'project' ? setProjectPrompt({ action: 'edit', skill }) : setEditing(skill) }}
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
                    </>
                  )}
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
          <SkillDetail skill={displaySkill} onEdit={displaySkill.system ? undefined : () => displaySkill.scope === 'project' ? setProjectPrompt({ action: 'edit', skill: displaySkill }) : setEditing(displaySkill)} />
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

      {/* Project scope warning — create or edit */}
      {projectPrompt && (
        <div className="modal-overlay" onClick={() => setProjectPrompt(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{projectPrompt.action === 'create' ? 'Project skill' : `Edit "${projectPrompt.skill?.name}"`}</h3>
            <p>
              {projectPrompt.action === 'create'
                ? 'This skill will be saved to .claude/skills/ inside your project and will be visible to all collaborators who open this project.'
                : 'Changes to this skill will affect all collaborators — it is stored in .claude/skills/ inside the project repository.'}
            </p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setProjectPrompt(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => {
                if (projectPrompt.action === 'create') setCreating('project')
                else setEditing(projectPrompt.skill ?? null)
                setProjectPrompt(null)
              }}>
                {projectPrompt.action === 'create' ? 'Continue' : 'Edit anyway'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete &ldquo;{confirmDelete.name}&rdquo;?</h3>
            <p>
              This will permanently remove the skill from disk.
              {confirmDelete.scope === 'project' && (
                <> It is stored in .claude/skills/ and this deletion will affect all collaborators on this project.</>
              )}
            </p>
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

function SkillDetail({ skill, onEdit }: { skill: Skill; onEdit?: () => void }) {
  return (
    <div className="skill-detail-content">
      <div className="skill-detail-header">
        <div>
          <h2 className="skill-detail-name">
            {skill.name}
            {skill.system && <span className="skill-system-badge-inline"><Lock size={11} /> system</span>}
          </h2>
          {skill.description && (
            <p className="skill-detail-desc">{skill.description}</p>
          )}
        </div>
        {onEdit && <button className="btn-secondary btn-sm" onClick={onEdit}>
          <Edit2 size={13} /> Edit
        </button>}
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

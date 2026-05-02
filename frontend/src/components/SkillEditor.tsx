import { useState, useRef, useEffect } from 'react'
import { Skill, SkillScope } from '../types'
import { SaveSkill } from '../../wailsjs/go/main/App'
import { useStore } from '../store'
import { X, Globe, Folder } from 'lucide-react'
import { ProjectScopeInfo } from './ProjectScopeInfo'
import './SkillEditor.css'

interface Props {
  skill?: Skill
  defaultScope: SkillScope
  onClose: () => void
  onSave: (saved: Skill) => Promise<void>
}

export function SkillEditor({ skill, defaultScope, onClose, onSave }: Props) {
  const { setError, projectDir } = useStore()
  const isNew = !skill

  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [argumentHint, setArgumentHint] = useState(skill?.argumentHint ?? '')
  const [allowedTools, setAllowedTools] = useState(skill?.allowedTools ?? '')
  const [body, setBody] = useState(skill?.body ?? '')
  const [scope, setScope] = useState<SkillScope>(skill?.scope ?? defaultScope)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])

  function validateName(v: string) {
    if (!v.trim()) return 'Name is required'
    if (!/^[a-z0-9-]+$/.test(v)) return 'Only lowercase letters, numbers, and hyphens'
    return ''
  }

  async function handleSave() {
    const err = validateName(name)
    if (err) { setNameError(err); return }

    setSaving(true)
    try {
      const saved: Skill = { name, description, argumentHint, allowedTools, body, scope }
      await SaveSkill(saved, skill?.name ?? '')
      await onSave(saved)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose()
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <div className="modal-overlay" onKeyDown={handleKeyDown}>
      <div className="skill-editor" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <h2>{isNew ? 'New Skill' : `Edit — ${skill.name}`}</h2>
          <button className="btn-ghost editor-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="editor-body">
          {/* Scope selector */}
          <div className="editor-field">
            <label>Scope</label>
            <div className="scope-selector">
              <button
                className={`scope-opt ${scope === 'global' ? 'active' : ''}`}
                onClick={() => setScope('global')}
              >
                <Globe size={12} /> Global (~/.claude/skills)
              </button>
              <button
                className={`scope-opt ${scope === 'project' ? 'active' : ''}`}
                onClick={() => setScope('project')}
                disabled={!projectDir}
              >
                <Folder size={12} /> Project (.claude/skills)
              </button>
            </div>
            <ProjectScopeInfo projectDir={projectDir} />
          </div>

          {/* Name */}
          <div className="editor-field">
            <label htmlFor="skill-name">Name</label>
            <input
              id="skill-name"
              ref={nameRef}
              value={name}
              onChange={(e) => { setName(e.target.value); setNameError('') }}
              placeholder="e.g. fix-bug"
              className={nameError ? 'input-error' : ''}
              spellCheck={false}
            />
            {nameError && <span className="field-error">{nameError}</span>}
          </div>

          {/* Description */}
          <div className="editor-field">
            <label htmlFor="skill-desc">Description</label>
            <textarea
              id="skill-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When to invoke this skill..."
              rows={2}
            />
          </div>

          {/* Argument hint */}
          <div className="editor-field">
            <label htmlFor="skill-arg">Argument Hint <span className="optional">(optional)</span></label>
            <input
              id="skill-arg"
              value={argumentHint}
              onChange={(e) => setArgumentHint(e.target.value)}
              placeholder="e.g. [ticket key]"
            />
          </div>

          {/* Allowed tools */}
          <div className="editor-field">
            <label htmlFor="skill-tools">Allowed Tools <span className="optional">(optional, comma-separated)</span></label>
            <input
              id="skill-tools"
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder="Read, Write, Bash, Edit"
            />
          </div>

          {/* Body */}
          <div className="editor-field editor-body-field">
            <label htmlFor="skill-body">Body</label>
            <textarea
              id="skill-body"
              className="body-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Markdown content for Claude to follow..."
              spellCheck={false}
            />
          </div>
        </div>

        <div className="editor-footer">
          <span className="editor-hint">⌘S to save</span>
          <div className="editor-actions">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : isNew ? 'Create Skill' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

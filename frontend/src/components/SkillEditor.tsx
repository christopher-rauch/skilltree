import { useState, useRef, useEffect } from 'react'
import { Skill, SkillScope } from '../types'
import { SaveSkill, DeleteSkill, GenerateSkillContent } from '../../wailsjs/go/main/App'
import { useStore } from '../store'
import { X, Globe, Folder, BookOpen, Sparkles, FileCode } from 'lucide-react'
import { ProjectScopeInfo } from './ProjectScopeInfo'
import './SkillEditor.css'

interface Props {
  skill?: Skill
  defaultScope: SkillScope
  onClose: () => void
  onSave: (saved: Skill) => Promise<void>
}

// Parse a raw SKILL.md string into field values.
function parseSkillMd(raw: string) {
  const trimmed = raw.trim()
  const out = { name: '', description: '', argumentHint: '', allowedTools: '', body: '' }
  if (!trimmed.startsWith('---')) { out.body = trimmed; return out }
  const rest = trimmed.slice(3)
  const end = rest.indexOf('\n---')
  if (end < 0) { out.body = trimmed; return out }
  const fm = rest.slice(0, end)
  out.body = rest.slice(end + 4).trimStart()
  for (const line of fm.split('\n')) {
    const [k, ...vParts] = line.split(':')
    const v = vParts.join(':').trim().replace(/^["']|["']$/g, '')
    if (k?.trim() === 'name') out.name = v
    else if (k?.trim() === 'description') out.description = v
    else if (k?.trim() === 'argument-hint') out.argumentHint = v
    else if (k?.trim() === 'allowed-tools') out.allowedTools = v
  }
  return out
}

// Serialize form fields back to SKILL.md format.
function toSkillMd(name: string, description: string, argumentHint: string, allowedTools: string, body: string) {
  const fmLines = [`name: ${name}`]
  if (description) fmLines.push(`description: ${description}`)
  if (argumentHint) fmLines.push(`argument-hint: ${argumentHint}`)
  if (allowedTools) fmLines.push(`allowed-tools: ${allowedTools}`)
  return `---\n${fmLines.join('\n')}\n---\n\n${body}`
}

type EditorMode = 'form' | 'markdown'

export function SkillEditor({ skill, defaultScope, onClose, onSave }: Props) {
  const { setError, projectDir, claudeAvailable } = useStore()
  const isNew = !skill

  const [mode, setMode] = useState<EditorMode>('form')
  const [name, setName] = useState(skill?.name ?? '')
  const [description, setDescription] = useState(skill?.description ?? '')
  const [argumentHint, setArgumentHint] = useState(skill?.argumentHint ?? '')
  const [allowedTools, setAllowedTools] = useState(skill?.allowedTools ?? '')
  const [body, setBody] = useState(skill?.body ?? '')
  const [scope, setScope] = useState<SkillScope>(skill?.scope ?? defaultScope)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState('')
  const [scopeChangePrompt, setScopeChangePrompt] = useState(false)

  // Markdown tab
  const [markdownText, setMarkdownText] = useState('')

  // Generate tab
  const [generatePrompt, setGeneratePrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)

  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { nameRef.current?.focus() }, [])

  // Sync markdown text when switching to markdown mode
  function switchMode(m: EditorMode) {
    if (m === 'markdown') {
      setMarkdownText(toSkillMd(name, description, argumentHint, allowedTools, body))
    } else if (mode === 'markdown') {
      // Parse back when leaving markdown mode
      const parsed = parseSkillMd(markdownText)
      setName(parsed.name || name)
      setDescription(parsed.description || description)
      setArgumentHint(parsed.argumentHint || argumentHint)
      setAllowedTools(parsed.allowedTools || allowedTools)
      setBody(parsed.body || body)
    }
    setMode(m)
  }

  function handleMarkdownChange(raw: string) {
    setMarkdownText(raw)
    // Live-parse to keep form fields in sync
    const p = parseSkillMd(raw)
    setName(p.name); setDescription(p.description)
    setArgumentHint(p.argumentHint); setAllowedTools(p.allowedTools)
    setBody(p.body)
  }

  async function handleGenerate() {
    if (!generatePrompt.trim()) return
    setGenerating(true)
    try {
      const raw = await GenerateSkillContent(generatePrompt.trim())
      const p = parseSkillMd(raw)
      setName(p.name || name); setDescription(p.description || description)
      setArgumentHint(p.argumentHint); setAllowedTools(p.allowedTools)
      setBody(p.body)
      if (mode === 'markdown') setMarkdownText(raw)
      setShowGenerate(false)
      setGeneratePrompt('')
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setGenerating(false)
    }
  }

  function validateName(v: string) {
    if (!v.trim()) return 'Name is required'
    if (!/^[a-z0-9-]+$/.test(v)) return 'Only lowercase letters, numbers, and hyphens'
    return ''
  }

  async function handleSave() {
    const err = validateName(name)
    if (err) { setNameError(err); return }
    if (!isNew && skill?.scope !== scope) { setScopeChangePrompt(true); return }
    await commitSave(false)
  }

  async function commitSave(removeFromSource: boolean) {
    setSaving(true)
    setScopeChangePrompt(false)
    try {
      const saved: Skill = { name, description, argumentHint, allowedTools, body, scope }
      await SaveSkill(saved, skill?.name ?? '')
      if (removeFromSource && skill) await DeleteSkill(skill.name, skill.scope)
      await onSave(saved)
    } catch (e: unknown) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose()
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave() }
  }

  return (
    <div className="modal-overlay" onKeyDown={handleKeyDown}>
      <div className="skill-editor" onClick={(e) => e.stopPropagation()}>
        <div className="editor-header">
          <h2>{isNew ? 'New Skill' : `Edit — ${skill.name}`}</h2>
          <div className="editor-mode-tabs">
            <button className={`editor-mode-tab ${mode === 'form' ? 'active' : ''}`} onClick={() => switchMode('form')}>
              Form
            </button>
            <button className={`editor-mode-tab ${mode === 'markdown' ? 'active' : ''}`} onClick={() => switchMode('markdown')}>
              <FileCode size={12} /> Markdown
            </button>
          </div>
          <button className="btn-ghost editor-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="editor-body">
          {/* Scope selector — always visible */}
          <div className="editor-field">
            <label>Scope</label>
            <div className="scope-selector">
              <button className={`scope-opt scope-global ${scope === 'global' ? 'active' : ''}`} onClick={() => setScope('global')}>
                <Globe size={12} /> Global (~/.claude/skills)
              </button>
              <button className={`scope-opt scope-project ${scope === 'project' ? 'active' : ''}`} onClick={() => setScope('project')} disabled={!projectDir}>
                <Folder size={12} /> Project (.claude/skills)
              </button>
              <button className={`scope-opt scope-library ${scope === 'library' ? 'active' : ''}`} onClick={() => setScope('library')}>
                <BookOpen size={12} /> Library (inlined on export)
              </button>
            </div>
            <ProjectScopeInfo projectDir={projectDir} />
          </div>

          {mode === 'form' ? (
            <>
              <div className="editor-field">
                <label htmlFor="skill-name">Name</label>
                <input id="skill-name" ref={nameRef} value={name}
                  onChange={(e) => { setName(e.target.value); setNameError('') }}
                  placeholder="e.g. fix-bug" className={nameError ? 'input-error' : ''} spellCheck={false} />
                {nameError && <span className="field-error">{nameError}</span>}
              </div>
              <div className="editor-field">
                <label htmlFor="skill-desc">Description</label>
                <textarea id="skill-desc" value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="When to invoke this skill..." rows={2} />
              </div>
              <div className="editor-field">
                <label htmlFor="skill-arg">Argument Hint <span className="optional">(optional)</span></label>
                <input id="skill-arg" value={argumentHint} onChange={(e) => setArgumentHint(e.target.value)} placeholder="e.g. [ticket key]" />
              </div>
              <div className="editor-field">
                <label htmlFor="skill-tools">Allowed Tools <span className="optional">(optional, comma-separated)</span></label>
                <input id="skill-tools" value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="Read, Write, Bash, Edit" />
              </div>
              <div className="editor-field editor-body-field">
                <label htmlFor="skill-body">Body</label>
                <textarea id="skill-body" className="body-textarea" value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Markdown content for Claude to follow..." spellCheck={false} />
              </div>

              {/* Generate with Claude */}
              {claudeAvailable && (
                <div className="editor-generate">
                  <button className={`editor-generate-toggle ${showGenerate ? 'open' : ''}`}
                    onClick={() => setShowGenerate(!showGenerate)}>
                    <Sparkles size={13} />
                    {showGenerate ? 'Hide generator' : 'Generate with Claude'}
                  </button>
                  {showGenerate && (
                    <div className="editor-generate-body">
                      <textarea
                        className="editor-generate-input"
                        placeholder="Describe what this skill should do — e.g. 'Review code for security vulnerabilities and output a structured findings report'"
                        value={generatePrompt}
                        onChange={(e) => setGeneratePrompt(e.target.value)}
                        rows={3}
                      />
                      <button className="btn-primary btn-sm" onClick={handleGenerate}
                        disabled={generating || !generatePrompt.trim()}>
                        {generating ? 'Generating…' : 'Generate'}
                      </button>
                      <span className="editor-generate-hint">
                        Fills in the form fields — review before saving
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="editor-field editor-body-field">
              <label>SKILL.md content</label>
              <textarea
                className="body-textarea editor-markdown-ta"
                value={markdownText}
                onChange={(e) => handleMarkdownChange(e.target.value)}
                placeholder={'---\nname: my-skill\ndescription: What this skill does\nallowed-tools: Read, Bash\n---\n\n# My Skill\n\nStep-by-step instructions...'}
                spellCheck={false}
              />
              <span className="field-hint">Paste a full SKILL.md — form fields update live</span>
            </div>
          )}
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

      {scopeChangePrompt && (
        <div className="modal-overlay" onClick={() => setScopeChangePrompt(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Scope changed</h3>
            <p>Move <strong>{skill?.name}</strong> from <strong>{skill?.scope}</strong> to <strong>{scope}</strong>, or keep a copy in both?</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setScopeChangePrompt(false)}>Cancel</button>
              <button className="btn-secondary" onClick={() => commitSave(false)}>Duplicate</button>
              <button className="btn-primary" onClick={() => commitSave(true)}>Move</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

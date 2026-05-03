import { useState, useEffect } from 'react'
import { X, FolderOpen } from 'lucide-react'
import { GetSettings, SaveSettings, BrowseForDirectory } from '../../wailsjs/go/main/App'
import './Settings.css'

interface Props {
  onClose: () => void
}

export function Settings({ onClose }: Props) {
  const [globalSkillsDir, setGlobalSkillsDir] = useState('')
  const [librarySkillsDir, setLibrarySkillsDir] = useState('')
  const [projectSkillsRelPath, setProjectSkillsRelPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    GetSettings().then((s) => {
      setGlobalSkillsDir(s.globalSkillsDir ?? '')
      setLibrarySkillsDir(s.librarySkillsDir ?? '')
      setProjectSkillsRelPath(s.projectSkillsRelPath ?? '')
    })
  }, [])

  async function handleBrowse(field: 'global' | 'library', title: string) {
    const dir = await BrowseForDirectory(title)
    if (!dir) return
    if (field === 'global') setGlobalSkillsDir(dir)
    else setLibrarySkillsDir(dir)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await SaveSettings({
        globalSkillsDir,
        librarySkillsDir,
        projectSkillsRelPath,
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="btn-ghost settings-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <h3 className="settings-section-title">Skill Paths</h3>
            <p className="settings-section-desc">
              Configure where Skilltree reads and writes skill files.
            </p>

            <div className="settings-field">
              <label>Global skills folder</label>
              <div className="settings-path-row">
                <input
                  className="settings-input"
                  value={globalSkillsDir}
                  onChange={(e) => setGlobalSkillsDir(e.target.value)}
                  placeholder="~/.claude/skills"
                  spellCheck={false}
                />
                <button
                  className="settings-browse-btn"
                  onClick={() => handleBrowse('global', 'Select Global Skills Folder')}
                  title="Browse"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
              <span className="settings-hint">
                Skills available across all Claude Code sessions
              </span>
            </div>

            <div className="settings-field">
              <label>Library skills folder</label>
              <div className="settings-path-row">
                <input
                  className="settings-input"
                  value={librarySkillsDir}
                  onChange={(e) => setLibrarySkillsDir(e.target.value)}
                  placeholder="~/.claude/skilltree/skills"
                  spellCheck={false}
                />
                <button
                  className="settings-browse-btn"
                  onClick={() => handleBrowse('library', 'Select Library Skills Folder')}
                  title="Browse"
                >
                  <FolderOpen size={14} />
                </button>
              </div>
              <span className="settings-hint">
                Private building-block skills inlined on export
              </span>
            </div>

            <div className="settings-field">
              <label>Project skills relative path</label>
              <div className="settings-path-row">
                <input
                  className="settings-input"
                  value={projectSkillsRelPath}
                  onChange={(e) => setProjectSkillsRelPath(e.target.value)}
                  placeholder=".claude/skills"
                  spellCheck={false}
                />
              </div>
              <span className="settings-hint">
                Relative to the open project directory
              </span>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

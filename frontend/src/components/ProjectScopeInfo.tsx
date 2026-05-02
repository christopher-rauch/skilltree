import { Folder } from 'lucide-react'
import './ProjectScopeInfo.css'

interface Props {
  projectDir: string
}

export function ProjectScopeInfo({ projectDir }: Props) {
  if (projectDir) {
    const basename = projectDir.split('/').filter(Boolean).pop() ?? projectDir
    return (
      <div className="scope-project-info">
        <Folder size={11} />
        <span className="scope-project-name" title={projectDir}>{basename}</span>
      </div>
    )
  }
  return (
    <div className="scope-project-info scope-no-project">
      No project open — use the <Folder size={11} className="scope-inline-icon" /> icon in the toolbar to open one
    </div>
  )
}

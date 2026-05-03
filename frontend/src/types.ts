export interface Skill {
  name: string
  description: string
  argumentHint: string
  allowedTools: string
  body: string
  scope: 'global' | 'project' | 'library'
}

export interface FlowNodeData {
  skillName: string
  label: string
  description: string
  argumentHint?: string
  argumentValue?: string
  [key: string]: unknown
}

export interface FlowAnnotation {
  id: string
  type: 'text' | 'sticky' | 'drawing'
  position: { x: number; y: number }
  data: Record<string, unknown>
  width?: number
  height?: number
}

export interface Flow {
  id: string
  name: string
  description: string
  contentHash: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  annotations?: FlowAnnotation[]
  updatedAt?: number  // Unix ms, from file mtime
}

export interface FlowNode {
  id: string
  type: string
  position: { x: number; y: number }
  data: FlowNodeData
  width?: number
  height?: number
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  animated?: boolean
}

export type View = 'skills' | 'board' | 'trees'

export interface CustomBlockField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'number' | 'file'
  placeholder?: string
  default?: string | number
  options?: string[]
}

export interface CustomBlockDef {
  id: string
  name: string
  description?: string
  icon?: string
  color?: string
  fields: CustomBlockField[]
  execution: {
    type: 'claude_prompt' | 'shell_script' | 'http_request'
    promptTemplate?: string
    inlineScript?: string
    inlineField?: string
    method?: string
    urlTemplate?: string
    bodyTemplate?: string
  }
}
export type SkillScope = 'global' | 'project' | 'library'

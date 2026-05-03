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
export type SkillScope = 'global' | 'project' | 'library'

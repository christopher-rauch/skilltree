export interface Skill {
  name: string
  description: string
  argumentHint: string
  allowedTools: string
  body: string
  scope: 'global' | 'project'
}

export interface FlowNodeData {
  skillName: string
  label: string
  description: string
  [key: string]: unknown
}

export interface Flow {
  id: string
  name: string
  description: string
  contentHash: string
  nodes: FlowNode[]
  edges: FlowEdge[]
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
export type SkillScope = 'global' | 'project'

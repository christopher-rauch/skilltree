import { create } from 'zustand'
import { Skill, Flow, View, SkillScope, CustomBlockDef } from './types'

interface AppState {
  view: View
  skills: Skill[]
  flows: Flow[]
  projectDir: string
  activeScope: SkillScope
  selectedFlowId: string | null
  loading: boolean
  error: string | null
  terminalOpen: boolean
  terminalHeight: number
  terminalAlive: boolean

  // Board dirty state — synced from NodeBoard so App.tsx can guard navigation
  boardDirty: boolean
  setBoardDirty: (b: boolean) => void
  // Callbacks registered by NodeBoard so App.tsx can trigger save/discard
  onSaveBoard: (() => Promise<void>) | null
  setOnSaveBoard: (fn: (() => Promise<void>) | null) => void
  onDiscardBoard: (() => void) | null
  setOnDiscardBoard: (fn: (() => void) | null) => void

  setView: (v: View) => void
  setSkills: (s: Skill[]) => void
  setFlows: (f: Flow[]) => void
  setProjectDir: (d: string) => void
  setActiveScope: (s: SkillScope) => void
  setSelectedFlowId: (id: string | null) => void
  setLoading: (b: boolean) => void
  setError: (e: string | null) => void
  setTerminalOpen: (b: boolean) => void
  setTerminalHeight: (h: number) => void
  setTerminalAlive: (b: boolean) => void
  previewSkill: { name: string; scope: SkillScope } | null
  setPreviewSkill: (s: { name: string; scope: SkillScope } | null) => void
  claudeAvailable: boolean
  setClaudeAvailable: (b: boolean) => void
  customBlocks: CustomBlockDef[]
  setCustomBlocks: (blocks: CustomBlockDef[]) => void
  updateFlowDescription: (id: string, description: string) => void

  upsertSkill: (skill: Skill) => void
  removeSkill: (name: string, scope: SkillScope) => void
  upsertFlow: (flow: Flow) => void
  removeFlow: (id: string) => void
}

export const useStore = create<AppState>((set) => ({
  view: 'skills',
  skills: [],
  flows: [],
  projectDir: '',
  activeScope: 'global',
  selectedFlowId: null,
  loading: false,
  error: null,
  terminalOpen: true,
  terminalHeight: 390,
  terminalAlive: false,

  boardDirty: false,
  setBoardDirty: (boardDirty) => set({ boardDirty }),
  onSaveBoard: null,
  setOnSaveBoard: (onSaveBoard) => set({ onSaveBoard }),
  onDiscardBoard: null,
  setOnDiscardBoard: (onDiscardBoard) => set({ onDiscardBoard }),

  setView: (view) => set({ view }),
  setSkills: (skills) => set({ skills }),
  setFlows: (flows) => set({ flows }),
  setProjectDir: (projectDir) => set({ projectDir }),
  setActiveScope: (activeScope) => set({ activeScope }),
  setSelectedFlowId: (selectedFlowId) => set({ selectedFlowId }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  setTerminalHeight: (terminalHeight) => set({ terminalHeight }),
  setTerminalAlive: (terminalAlive) => set({ terminalAlive }),
  previewSkill: null,
  setPreviewSkill: (previewSkill) => set({ previewSkill }),
  claudeAvailable: true,
  setClaudeAvailable: (claudeAvailable) => set({ claudeAvailable }),
  customBlocks: [],
  setCustomBlocks: (customBlocks) => set({ customBlocks }),
  updateFlowDescription: (id, description) =>
    set((state) => ({
      flows: state.flows.map((f) => f.id === id ? { ...f, description } : f),
    })),

  upsertSkill: (skill) =>
    set((state) => {
      const idx = state.skills.findIndex(
        (s) => s.name === skill.name && s.scope === skill.scope
      )
      const next = [...state.skills]
      if (idx >= 0) next[idx] = skill
      else next.push(skill)
      return { skills: next.sort((a, b) => a.name.localeCompare(b.name)) }
    }),

  removeSkill: (name, scope) =>
    set((state) => ({
      skills: state.skills.filter((s) => !(s.name === name && s.scope === scope)),
    })),

  upsertFlow: (flow) =>
    set((state) => {
      const idx = state.flows.findIndex((f) => f.id === flow.id)
      const next = [...state.flows]
      if (idx >= 0) next[idx] = flow
      else next.push(flow)
      return { flows: next.sort((a, b) => a.name.localeCompare(b.name)) }
    }),

  removeFlow: (id) =>
    set((state) => ({
      flows: state.flows.filter((f) => f.id !== id),
    })),
}))

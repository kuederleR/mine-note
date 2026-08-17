import type { WorldSnapshot } from './lib/world'
import type { DocObject, StructuredDoc } from './lib/structuredDoc'
export type { WorldSnapshot }

export type Note = {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  categoryId: string | null
  folderId: string | null
  categoryName?: string | null
  categoryIcon?: string | null
  categoryColor?: string | null
  categorySlug?: string | null
  componentCount?: number
  /** 0 = markdown-only legacy; 1+ = structured doc persisted */
  docVersion?: number
  doc?: StructuredDoc
  objects?: DocObject[]
}

export type Folder = {
  id: string
  name: string
  color: string
  parentId: string | null
  position: number
  createdAt: string
  updatedAt: string
  noteCount: number
}

export const FOLDER_COLORS = [
  '#0f3d38',
  '#c06a3a',
  '#2a8f80',
  '#d47848',
  '#8b6bb0',
  '#c4554d',
  '#9f6b53',
  '#3d6b73',
] as const

export type Category = {
  id: string
  name: string
  slug: string
  icon: string
  color: string
  description: string
  embedInstruction: string
  queryHints: string
  template: string
  tag: string
  position: number
  createdAt: string
  updatedAt: string
  noteCount: number
}

export type Component = {
  id: string
  noteId: string
  type: string
  content: string
  meta: Record<string, unknown>
  position: number
  hasEmbedding: boolean
}

export type GraphNode = {
  id: string
  label: string
  type: string
  noteId: string
  noteTitle: string
  content: string
  score: number
  kind: 'component' | 'note' | 'query'
  categoryId?: string | null
  categoryName?: string | null
  categoryColor?: string | null
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  relation: 'similar' | 'same_note' | 'wikilink' | 'mention' | 'query_match' | 'thread'
  weight: number
}

export type AnswerSource = {
  noteId: string
  noteTitle: string
  componentId: string
  snippet: string
  type: string
  score: number
  categoryName?: string | null
}

export type AnswerOption = {
  id: string
  label: string
  text: string
  bullets: string[]
  sources: AnswerSource[]
}

export type SynthesizedAnswer = {
  text: string
  bullets: string[]
  sources: AnswerSource[]
  alternatives: AnswerOption[]
}

export type EntityProposal = {
  id: string
  surface: string
  sourceNoteId: string
  sourceNoteTitle: string
  sourceComponentId: string | null
  candidates: Array<{
    noteId: string
    noteTitle: string
    categoryName: string | null
  }>
  message: string
}

export type DiscourseState = {
  focusEntities: Array<{ noteId: string; title: string; categoryName?: string | null }>
  focusNotes: Array<{
    noteId: string
    title: string
    role: 'person' | 'meeting' | 'project' | 'note'
    categoryName?: string | null
  }>
  excludeEntityIds: string[]
  lastOperator?: string
}

export type SearchResult = {
  query: string
  summary: string
  answer: SynthesizedAnswer
  nodes: GraphNode[]
  edges: GraphEdge[]
  followUp?: boolean
  proposals?: EntityProposal[]
  discourse?: DiscourseState
  operator?: string
  world?: WorldSnapshot | null
  matches: Array<{
    componentId: string
    noteId: string
    noteTitle: string
    type: string
    content: string
    score: number
  }>
}

export type ChatHistoryTurn = {
  query: string
  answer: string
  bullets: string[]
  sources: Array<{
    noteId: string
    noteTitle: string
    snippet: string
    categoryName?: string | null
  }>
  discourse?: DiscourseState | null
}

export type Health = {
  ok: boolean
  app: string
  embeddings: {
    ready: boolean
    warming: boolean
    error: string | null
    model: string
    worker?: boolean
  }
  generator?: {
    ready: boolean
    warming: boolean
    available: boolean
    pulling: boolean
    error: string | null
    model: string
  }
  search?: { vec: boolean; fts: boolean; hybrid: boolean }
  notes: number
  components: number
}

export type CategoryDraft = {
  name: string
  icon: string
  color: string
  description: string
  embedInstruction: string
  queryHints: string
  template: string
  tag: string
}

export type CategorizeResult = {
  match: { id: string; name: string; icon: string; color: string; score: number } | null
  suggestion: CategoryDraft | null
}

export type ThemeMode = 'system' | 'light' | 'dark'

export type SettingsSection = 'appearance' | 'categories' | 'models' | 'shortcuts' | 'reminders' | 'storage'

export type ReminderColumn = {
  id: string
  label: string
  done?: boolean
}

export type ObjectPasteMode = 'link' | 'content' | 'embed'

export type MineObjectRecord = {
  id: string
  type: string
  noteId: string
  noteTitle: string
  inner: string
  markdown: string
}

export type WorkspaceSettings = {
  aiShortcut: string
  reminderShortcut: string
  reservedShortcuts: string[]
  reminderColumns: ReminderColumn[]
  objectPasteMode: ObjectPasteMode
  theme: ThemeMode
}

export type StorageSettings = {
  notesDir: string
  dbPath: string
  defaultNotesDir: string
  gitEnabled: boolean
  configPath: string
}

export type GitStatus = {
  enabled: boolean
  isRepo: boolean
  branch: string | null
  remote: string | null
  dirty: boolean
  ahead: number
  behind: number
  lastMessage: string | null
  error: string | null
}

export type GitSyncResult = {
  ok: boolean
  pulled: boolean
  pushed: boolean
  committed: boolean
  message: string
  status: GitStatus
}

export type Reminder = {
  id: string
  noteId: string
  noteTitle: string
  title: string
  dueAt: string | null
  status: string
  position: number
  updatedAt: string
  objectId?: string | null
  objectType?: string | null
  objectNoteId?: string | null
  objectLabel?: string | null
}

export type AgentConnection = {
  id: string
  noteId: string
  noteTitle: string
  snippet: string
  categoryName?: string | null
}

export type AgentTurn = {
  id: string
  mode: 'explore' | 'create'
  query: string
  answer?: string
  connections?: AgentConnection[]
  createdAt: string
}

export type NoteAgent = {
  id: string
  noteId: string
  mode: 'explore' | 'create'
  thread: AgentTurn[]
  connections: AgentConnection[]
  output: string
  objects?: Array<Record<string, unknown>>
  createdAt: string
  updatedAt: string
}

export type AgentView =
  | { kind: 'settings'; section: 'categories'; categoryId: string }
  | { kind: 'note'; noteId: string; noteAgentId?: string }

export type AgentKind = 'category-build' | 'categorize' | 'note-create'

export type AgentStatus = 'running' | 'needs_response' | 'done' | 'error'

export type Agent = {
  id: string
  kind: AgentKind
  title: string
  status: AgentStatus
  progress: number
  message: string
  /** Live model output while running (create stream). */
  streamText?: string | null
  view: AgentView
  unread: boolean
  error?: string | null
  draft?: CategoryDraft | null
  lockedKeys?: string[]
  suggestion?: CategoryDraft | null
  matchName?: string | null
  noteAgentId?: string | null
  createdAt: string
  updatedAt: string
}

export type ChatTurn = {
  id: string
  query: string
  result: SearchResult | null
  error?: string
  createdAt: string
  world?: WorldSnapshot | null
}

export type SearchLiveNote = {
  noteId: string
  title: string
  categoryName?: string | null
  categoryColor?: string | null
}

export type SearchProgress = {
  status: string
  notes: SearchLiveNote[]
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export type SearchProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'note'; note: SearchLiveNote }
  | { type: 'graph'; nodes: GraphNode[]; edges: GraphEdge[] }
  | { type: 'done'; result: SearchResult }
  | { type: 'error'; error: string }

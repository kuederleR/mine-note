export type Note = {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  componentCount?: number
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
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  relation: 'similar' | 'same_note' | 'wikilink' | 'query_match'
  weight: number
}

export type SearchResult = {
  query: string
  summary: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  matches: Array<{
    componentId: string
    noteId: string
    noteTitle: string
    type: string
    content: string
    score: number
  }>
}

export type Health = {
  ok: boolean
  app: string
  embeddings: { ready: boolean; error: string | null; model: string }
  notes: number
  components: number
}

export type ChatTurn = {
  id: string
  query: string
  result: SearchResult | null
  error?: string
  createdAt: string
}

export type SearchLiveNote = {
  noteId: string
  title: string
  categoryName?: string | null
  categoryColor?: string | null
}

export type SearchProgressGraphNode = {
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

export type SearchProgressGraphEdge = {
  id: string
  source: string
  target: string
  relation: 'similar' | 'same_note' | 'wikilink' | 'mention' | 'query_match' | 'thread'
  weight: number
}

export type SearchProgressEvent =
  | { type: 'status'; message: string }
  | { type: 'note'; note: SearchLiveNote }
  | { type: 'graph'; nodes: SearchProgressGraphNode[]; edges: SearchProgressGraphEdge[] }
  | { type: 'done'; result: unknown }
  | { type: 'error'; error: string }

export type SearchProgressFn = (event: SearchProgressEvent) => void

export function yieldProgress(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function createSearchProgress(emit?: SearchProgressFn) {
  return {
    async status(message: string) {
      emit?.({ type: 'status', message })
      await yieldProgress()
    },
    async note(note: SearchLiveNote) {
      emit?.({ type: 'note', note })
      await yieldProgress()
    },
    graph(nodes: SearchProgressGraphNode[], edges: SearchProgressGraphEdge[]) {
      emit?.({ type: 'graph', nodes, edges })
    },
  }
}

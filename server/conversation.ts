import { cosineSimilarity, embedText } from './embeddings.js'

export type HistorySource = {
  noteId: string
  noteTitle: string
  snippet?: string
  categoryName?: string | null
}

export type HistoryTurn = {
  query: string
  answer?: string
  bullets?: string[]
  sources?: HistorySource[]
}

export type ResolvedConversation = {
  query: string
  searchQuery: string
  focusNoteIds: string[]
  focusTitles: string[]
  isFollowUp: boolean
  continuity: number
  novelty: number
  prevAnswerText: string
}

function lastTurn(history: HistoryTurn[]): HistoryTurn | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.query) return history[i]
  }
  return null
}

function sourcesFrom(turn: HistoryTurn): HistorySource[] {
  const seen = new Set<string>()
  const out: HistorySource[] = []
  for (const src of turn.sources || []) {
    if (!src.noteId || seen.has(src.noteId)) continue
    seen.add(src.noteId)
    out.push(src)
  }
  return out
}

function standalone(query: string): ResolvedConversation {
  return {
    query,
    searchQuery: query,
    focusNoteIds: [],
    focusTitles: [],
    isFollowUp: false,
    continuity: 0,
    novelty: 0,
    prevAnswerText: '',
  }
}

export async function resolveConversation(
  query: string,
  history: HistoryTurn[] = [],
): Promise<ResolvedConversation> {
  const q = query.trim()
  const last = lastTurn(history)
  if (!q || !last) return standalone(q)

  const sources = sourcesFrom(last)
  const titles = sources.map((src) => src.noteTitle).filter(Boolean)
  const prevAnswerText = [last.answer, ...(last.bullets || [])].filter(Boolean).join('\n')
  const grounded = [last.query, ...titles, q].filter(Boolean).join('\n')
  const context = [last.query, titles.join(', '), prevAnswerText].filter(Boolean).join('\n')

  const [qVec, ctxVec, ansVec] = await Promise.all([
    embedText(q),
    embedText(context || last.query),
    embedText(prevAnswerText || last.query),
  ])

  const continuity = cosineSimilarity(qVec, ctxVec)
  const sameFact = cosineSimilarity(qVec, ansVec)
  const novelty = Math.max(0, continuity - sameFact)

  return {
    query: q,
    searchQuery: grounded,
    focusNoteIds: sources.map((src) => src.noteId),
    focusTitles: titles,
    isFollowUp: sources.length > 0,
    continuity,
    novelty,
    prevAnswerText,
  }
}

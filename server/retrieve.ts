import { db, bufferToFloat32 } from './db.js'
import { cosineSimilarity, embedText } from './embeddings.js'
import { searchFts } from './fts.js'
import {
  listEntityNotes,
  noteIdsMentioningEntity,
  resolveEntitiesInText,
  type EntityRef,
} from './entities.js'
import { synthesizeAnswerWithGemma, type SynthesizedAnswer } from './answer.js'

type GraphNode = {
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

type GraphEdge = {
  id: string
  source: string
  target: string
  relation: 'similar' | 'same_note' | 'wikilink' | 'mention' | 'query_match' | 'thread'
  weight: number
}

type SearchMatch = {
  componentId: string
  noteId: string
  noteTitle: string
  type: string
  content: string
  score: number
  categoryId?: string | null
  categoryName?: string | null
}

export type RetrievePlan = {
  entities: EntityRef[]
  preferNoteIds: Set<string>
  ftsBoosts: Map<string, number>
}

export async function planRetrieval(
  query: string,
  focusNoteIds: string[] = [],
): Promise<RetrievePlan> {
  const entities = resolveEntitiesInText(query, focusNoteIds)
  // Pronoun follow-ups: keep focused entity notes if query has deixis
  if (!entities.length && focusNoteIds.length && /\b(she|he|her|him|they|them|their|this|that)\b/i.test(query)) {
    const all = listEntityNotes()
    for (const id of focusNoteIds) {
      const hit = all.find((e) => e.noteId === id)
      if (hit) entities.push(hit)
    }
  }

  const preferNoteIds = new Set<string>(focusNoteIds)
  for (const e of entities) {
    preferNoteIds.add(e.noteId)
    for (const id of noteIdsMentioningEntity(e.noteId)) preferNoteIds.add(id)
  }

  const ftsBoosts = new Map<string, number>()
  const ftsHits = searchFts(query, {
    limit: 20,
    noteIds: preferNoteIds.size ? [...preferNoteIds] : undefined,
  })
  const best = ftsHits[0]?.rank ?? 1
  for (const hit of ftsHits) {
    const norm = best > 0 ? hit.rank / best : 0
    ftsBoosts.set(hit.componentId, Math.min(0.25, 0.08 + norm * 0.17))
  }

  return {
    entities,
    preferNoteIds,
    ftsBoosts,
  }
}

function snippet(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Fast path: answer identity/attribute questions from the entity page itself. */
export async function tryEntityCardAnswer(
  query: string,
  entities: EntityRef[],
  world?: import('./world.js').WorldSnapshot | null,
): Promise<{
  answer: SynthesizedAnswer
  matches: SearchMatch[]
  nodes: GraphNode[]
  edges: GraphEdge[]
} | null> {
  if (!entities.length) return null

  const entity = entities[0]
  const rows = db
    .prepare(
      `SELECT c.*, n.title as note_title,
              n.category_id as category_id,
              cat.name as category_name,
              cat.color as category_color
       FROM components c
       JOIN notes n ON n.id = c.note_id
       LEFT JOIN categories cat ON cat.id = n.category_id
       WHERE c.note_id = ? AND c.type NOT IN ('divider', 'wikilink')
       ORDER BY c.position ASC
       LIMIT 20`,
    )
    .all(entity.noteId) as Array<{
    id: string
    note_id: string
    type: string
    content: string
    note_title: string
    category_id: string | null
    category_name: string | null
    category_color: string | null
    embedding: Buffer | null
  }>

  if (!rows.length) return null

  const qVec = await embedText(query)
  const scored = rows.map((row) => {
    const vec = bufferToFloat32(row.embedding)
    const sim = vec ? cosineSimilarity(qVec, vec) : 0
    let score = sim
    const blob = row.content.toLowerCase()
    if (/\b(phone|number|mobile|cell)\b/i.test(query) && /\d{7,}/.test(blob)) score += 0.4
    if (/\b(email)\b/i.test(query) && /@/.test(blob)) score += 0.4
    if (row.type === 'entity') score -= 0.05
    if (row.type === 'heading') score -= 0.02
    return { row, score }
  })
  scored.sort((a, b) => b.score - a.score)

  const matches: SearchMatch[] = scored.slice(0, 8).map(({ row, score }) => ({
    componentId: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title,
    type: row.type,
    content: row.content,
    score,
    categoryId: row.category_id,
    categoryName: row.category_name,
  }))

  const answer = await synthesizeAnswerWithGemma(query, matches, { world })
  if (/don’t see that in your notes/i.test(answer.text) && !answer.bullets.length) {
    return null
  }
  if (/couldn.?t extract a specific fact/i.test(answer.text)) return null

  const nodes: GraphNode[] = [
    {
      id: 'query',
      label: snippet(query),
      type: 'query',
      noteId: '',
      noteTitle: '',
      content: query,
      score: 1,
      kind: 'query',
    },
    {
      id: `note:${entity.noteId}`,
      label: entity.title,
      type: 'note',
      noteId: entity.noteId,
      noteTitle: entity.title,
      content: entity.title,
      score: 1,
      kind: 'note',
      categoryId: entity.categoryId,
      categoryName: entity.categoryName,
    },
  ]
  for (const m of matches.slice(0, 4)) {
    if (m.type === 'chunk' || m.type === 'entity') continue
    nodes.push({
      id: m.componentId,
      label: snippet(m.content, 42),
      type: m.type,
      noteId: m.noteId,
      noteTitle: m.noteTitle,
      content: m.content,
      score: m.score,
      kind: 'component',
      categoryId: m.categoryId,
      categoryName: m.categoryName,
    })
  }
  const edges: GraphEdge[] = matches.slice(0, 4).map((m) => ({
    id: `query_match:query|${m.type === 'chunk' ? `note:${m.noteId}` : m.componentId}`,
    source: 'query',
    target: m.type === 'chunk' ? `note:${m.noteId}` : m.componentId,
    relation: 'query_match',
    weight: m.score,
  }))
  for (const m of matches.slice(0, 4)) {
    if (m.type === 'chunk' || m.type === 'entity') continue
    edges.push({
      id: `same_note:${m.componentId}|note:${m.noteId}`,
      source: m.componentId,
      target: `note:${m.noteId}`,
      relation: 'same_note',
      weight: 0.55,
    })
  }

  return { answer, matches, nodes, edges }
}

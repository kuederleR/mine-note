import { db } from './db.js'
import { embedText } from './embeddings.js'
import { searchFts, type HighlightOffset } from './fts.js'
import { reciprocalRankFusion, RRF_K } from './rrf.js'
import { searchDense } from './vec.js'

export { reciprocalRankFusion, RRF_K }

export type HybridHit = {
  chunkId: string
  noteId: string
  noteTitle: string
  content: string
  contextPath: string
  type: string
  score: number
  denseScore: number | null
  lexicalScore: number | null
  denseRank: number | null
  lexicalRank: number | null
  highlights: HighlightOffset[]
  categoryId: string | null
  categoryName: string | null
  categoryColor: string | null
  metadata: Record<string, unknown>
}

type ComponentJoin = {
  id: string
  note_id: string
  type: string
  content: string
  meta_json: string
  context_path: string | null
  note_title: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
}

function mergeDenseHits(
  lists: Array<Array<{ componentId: string; score: number; distance: number }>>,
): Array<{ componentId: string; score: number; distance: number }> {
  const best = new Map<string, { componentId: string; score: number; distance: number }>()
  for (const list of lists) {
    for (const hit of list) {
      const prev = best.get(hit.componentId)
      if (!prev || hit.score > prev.score) best.set(hit.componentId, hit)
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

function loadComponents(ids: string[]): Map<string, ComponentJoin> {
  const map = new Map<string, ComponentJoin>()
  if (!ids.length) return map
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT c.id, c.note_id, c.type, c.content, c.meta_json, c.context_path,
              n.title as note_title, n.category_id,
              cat.name as category_name, cat.color as category_color
       FROM components c
       JOIN notes n ON n.id = c.note_id
       LEFT JOIN categories cat ON cat.id = n.category_id
       WHERE c.id IN (${placeholders})`,
    )
    .all(...ids) as ComponentJoin[]
  for (const row of rows) map.set(row.id, row)
  return map
}

export type HybridSearchOptions = {
  limit?: number
  noteIds?: string[]
  categoryId?: string | null
  /** Precomputed query vectors (skips embedding `query` for dense search). */
  queryVecs?: Float32Array[]
}

/**
 * Unified retrieval: dense KNN + BM25, fused with RRF.
 */
export async function hybridSearch(
  query: string,
  options: HybridSearchOptions = {},
): Promise<HybridHit[]> {
  const q = query.trim()
  if (!q) return []
  const limit = options.limit ?? 24
  const pool = Math.max(limit * 2, 32)

  const queryVecs =
    options.queryVecs?.length ? options.queryVecs : [await embedText(q)]
  const denseLists = queryVecs.map((vec) =>
    searchDense(vec, {
      limit: pool,
      noteIds: options.noteIds,
      categoryId: options.categoryId,
    }),
  )
  const dense = mergeDenseHits(denseLists)
  const lexical = searchFts(q, {
    limit: pool,
    noteIds: options.noteIds,
    categoryId: options.categoryId,
  })

  const fused = reciprocalRankFusion([
    ...denseLists.map((list) => list.map((h) => ({ id: h.componentId }))),
    lexical.map((h) => ({ id: h.componentId })),
  ])

  const denseRank = new Map(dense.map((h, i) => [h.componentId, i + 1] as const))
  const lexicalRank = new Map(lexical.map((h, i) => [h.componentId, i + 1] as const))
  const denseScore = new Map(dense.map((h) => [h.componentId, h.score] as const))
  const lexicalById = new Map(lexical.map((h) => [h.componentId, h] as const))

  const ids = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
  const comps = loadComponents(ids)

  const hits: HybridHit[] = []
  for (const id of ids) {
    const row = comps.get(id)
    const fts = lexicalById.get(id)
    if (!row && !fts) continue
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(row?.meta_json || '{}') as Record<string, unknown>
    } catch {
      meta = {}
    }
    const content = row?.content || fts?.content || ''
    hits.push({
      chunkId: id,
      noteId: row?.note_id || fts?.noteId || '',
      noteTitle: row?.note_title || fts?.noteTitle || '',
      content,
      contextPath: row?.context_path || fts?.contextPath || row?.note_title || '',
      type: row?.type || 'chunk',
      score: fused.get(id) || 0,
      denseScore: denseScore.get(id) ?? null,
      lexicalScore: fts?.rank ?? null,
      denseRank: denseRank.get(id) ?? null,
      lexicalRank: lexicalRank.get(id) ?? null,
      highlights: fts?.highlights?.length ? fts.highlights : [],
      categoryId: row?.category_id ?? null,
      categoryName: row?.category_name ?? null,
      categoryColor: row?.category_color ?? null,
      metadata: {
        ...meta,
        blockType: row?.type || 'chunk',
      },
    })
  }
  return hits
}

export type RetrieveResponse = {
  query: string
  hits: HybridHit[]
}

export async function retrieve(query: string, options: HybridSearchOptions = {}): Promise<RetrieveResponse> {
  return { query: query.trim(), hits: await hybridSearch(query, options) }
}

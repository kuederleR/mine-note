import {
  db,
  bufferToFloat32,
  type ComponentRow,
  type NoteRow,
} from './db.js'
import { cosineSimilarity, embedText } from './embeddings.js'

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

function snippet(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export async function searchConnectionGraph(
  query: string,
  options: { topK?: number; neighborThreshold?: number } = {},
): Promise<SearchResult> {
  const topK = options.topK ?? 12
  const neighborThreshold = options.neighborThreshold ?? 0.42
  const q = query.trim()
  if (!q) {
    return {
      query: q,
      summary: 'Ask Mine anything about your notes — it maps connections, it does not decide for you.',
      nodes: [],
      edges: [],
      matches: [],
    }
  }

  const queryVec = await embedText(q)
  const rows = db
    .prepare(
      `SELECT c.*, n.title as note_title
       FROM components c
       JOIN notes n ON n.id = c.note_id
       WHERE c.embedding IS NOT NULL AND c.type != 'divider'`,
    )
    .all() as Array<ComponentRow & { note_title: string }>

  const scored = rows
    .map((row) => {
      const vec = bufferToFloat32(row.embedding)
      const score = vec ? cosineSimilarity(queryVec, vec) : -1
      return { row, score }
    })
    .filter((x) => x.score > 0.15)
    .sort((a, b) => b.score - a.score)

  const seeds = scored.slice(0, topK)
  const seedIds = new Set(seeds.map((s) => s.row.id))
  const noteIds = new Set(seeds.map((s) => s.row.note_id))

  // Expand: other high-similarity components to seeds, plus siblings in same notes
  const neighborMap = new Map<string, { row: ComponentRow & { note_title: string }; score: number }>()
  for (const seed of seeds) {
    neighborMap.set(seed.row.id, seed)
  }

  for (const candidate of scored.slice(0, Math.min(80, scored.length))) {
    if (seedIds.has(candidate.row.id)) continue
    const cVec = bufferToFloat32(candidate.row.embedding)
    if (!cVec) continue
    let best = 0
    for (const seed of seeds.slice(0, 8)) {
      const sVec = bufferToFloat32(seed.row.embedding)
      if (!sVec) continue
      best = Math.max(best, cosineSimilarity(cVec, sVec))
    }
    if (best >= neighborThreshold || noteIds.has(candidate.row.note_id)) {
      if (!neighborMap.has(candidate.row.id)) {
        neighborMap.set(candidate.row.id, {
          row: candidate.row,
          score: Math.max(candidate.score * 0.85, best * 0.9),
        })
      }
    }
  }

  // Pull a few structural siblings from matched notes (headings/todos)
  for (const noteId of noteIds) {
    const siblings = db
      .prepare(
        `SELECT c.*, n.title as note_title
         FROM components c
         JOIN notes n ON n.id = c.note_id
         WHERE c.note_id = ? AND c.type IN ('heading','todo','callout','toggle')
         ORDER BY c.position ASC
         LIMIT 6`,
      )
      .all(noteId) as Array<ComponentRow & { note_title: string }>
    for (const sib of siblings) {
      if (!neighborMap.has(sib.id)) {
        neighborMap.set(sib.id, { row: sib, score: 0.22 })
      }
    }
  }

  const nodes: GraphNode[] = [
    {
      id: 'query',
      label: snippet(q, 48),
      type: 'query',
      noteId: '',
      noteTitle: '',
      content: q,
      score: 1,
      kind: 'query',
    },
  ]

  const noteTitleById = new Map<string, string>()
  for (const { row, score } of neighborMap.values()) {
    noteTitleById.set(row.note_id, row.note_title)
    nodes.push({
      id: row.id,
      label: snippet(row.content, 42) || row.type,
      type: row.type,
      noteId: row.note_id,
      noteTitle: row.note_title,
      content: row.content,
      score,
      kind: 'component',
    })
  }

  for (const [noteId, title] of noteTitleById) {
    nodes.push({
      id: `note:${noteId}`,
      label: title,
      type: 'note',
      noteId,
      noteTitle: title,
      content: title,
      score: 0.5,
      kind: 'note',
    })
  }

  const edges: GraphEdge[] = []
  const edgeKey = new Set<string>()
  const addEdge = (
    source: string,
    target: string,
    relation: GraphEdge['relation'],
    weight: number,
  ) => {
    const key = `${relation}:${[source, target].sort().join('|')}`
    if (edgeKey.has(key) || source === target) return
    edgeKey.add(key)
    edges.push({
      id: key,
      source,
      target,
      relation,
      weight,
    })
  }

  for (const seed of seeds) {
    addEdge('query', seed.row.id, 'query_match', seed.score)
  }

  for (const { row } of neighborMap.values()) {
    addEdge(row.id, `note:${row.note_id}`, 'same_note', 0.55)
    let meta: { wikiLinks?: string[]; targetTitle?: string } = {}
    try {
      meta = JSON.parse(row.meta_json || '{}')
    } catch {
      meta = {}
    }

    const targets = [
      ...(meta.wikiLinks || []),
      ...(row.type === 'wikilink' && meta.targetTitle ? [meta.targetTitle] : []),
    ]
    for (const title of targets) {
      const linked = db
        .prepare(`SELECT id, title FROM notes WHERE lower(title) = lower(?) LIMIT 1`)
        .get(title) as Pick<NoteRow, 'id' | 'title'> | undefined
      if (linked) {
        addEdge(row.id, `note:${linked.id}`, 'wikilink', 0.8)
        if (!nodes.some((n) => n.id === `note:${linked.id}`)) {
          nodes.push({
            id: `note:${linked.id}`,
            label: linked.title,
            type: 'note',
            noteId: linked.id,
            noteTitle: linked.title,
            content: linked.title,
            score: 0.4,
            kind: 'note',
          })
        }
      }
    }
  }

  // Similarity edges among top components
  const componentNodes = [...neighborMap.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 18)
  for (let i = 0; i < componentNodes.length; i += 1) {
    for (let j = i + 1; j < componentNodes.length; j += 1) {
      const a = componentNodes[i]
      const b = componentNodes[j]
      if (a.row.note_id === b.row.note_id) continue
      const va = bufferToFloat32(a.row.embedding)
      const vb = bufferToFloat32(b.row.embedding)
      if (!va || !vb) continue
      const sim = cosineSimilarity(va, vb)
      if (sim >= 0.55) {
        addEdge(a.row.id, b.row.id, 'similar', sim)
      }
    }
  }

  const matches = seeds.map(({ row, score }) => ({
    componentId: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title,
    type: row.type,
    content: row.content,
    score,
  }))

  const noteCount = noteTitleById.size
  const summary =
    matches.length === 0
      ? 'No strong connections yet. Save more notes — Mine indexes each component locally when you save.'
      : `Mapped ${matches.length} strong matches across ${noteCount} note${noteCount === 1 ? '' : 's'}. Explore the graph — Mine surfaces connections; you decide what matters.`

  return { query: q, summary, nodes, edges, matches }
}

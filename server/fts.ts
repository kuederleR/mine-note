import { db } from './db.js'

export type HighlightOffset = { start: number; end: number }

export type FtsHit = {
  componentId: string
  noteId: string
  noteTitle: string
  content: string
  contextPath: string
  rank: number
  highlights: HighlightOffset[]
}

function ftsTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/["']/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
}

export function escapeFtsQuery(query: string): string {
  const tokens = ftsTokens(query)
  if (!tokens.length) return ''
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ')
}

export function highlightOffsets(content: string, query: string): HighlightOffset[] {
  const tokens = [...new Set(ftsTokens(query))]
  const lower = content.toLowerCase()
  const out: HighlightOffset[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(token, from)
      if (at < 0) break
      const key = `${at}:${at + token.length}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ start: at, end: at + token.length })
      }
      from = at + token.length
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

export function syncNoteFts(
  noteId: string,
  title: string,
  rows?: Array<{ id: string; content: string; type: string; context_path?: string | null }>,
): void {
  db.prepare(`DELETE FROM components_fts WHERE note_id = ?`).run(noteId)
  const comps =
    rows ||
    (db
      .prepare(
        `SELECT id, content, type, context_path FROM components
         WHERE note_id = ? AND type NOT IN ('divider')`,
      )
      .all(noteId) as Array<{ id: string; content: string; type: string; context_path: string | null }>)
  const insert = db.prepare(
    `INSERT INTO components_fts (content, note_title, context_path, component_id, note_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const row of comps) {
    if (row.type === 'divider') continue
    const text = row.content.replace(/\s+/g, ' ').trim()
    if (!text) continue
    insert.run(text, title, row.context_path || title, row.id, noteId)
  }
}

export function deleteNoteFts(noteId: string): void {
  db.prepare(`DELETE FROM components_fts WHERE note_id = ?`).run(noteId)
}

/** Lexical search via FTS5 BM25. Higher rank is better. */
export function searchFts(
  query: string,
  options: { limit?: number; noteIds?: string[]; categoryId?: string | null } = {},
): FtsHit[] {
  const q = query.trim()
  if (!q) return []
  const match = escapeFtsQuery(q)
  if (!match) return []
  const limit = options.limit ?? 24
  try {
    const filters: string[] = ['components_fts MATCH ?']
    const params: Array<string | number> = [match]
    if (options.noteIds?.length) {
      filters.push(`note_id IN (${options.noteIds.map(() => '?').join(',')})`)
      params.push(...options.noteIds)
    }
    if (options.categoryId) {
      filters.push(
        `note_id IN (SELECT id FROM notes WHERE category_id = ?)`,
      )
      params.push(options.categoryId)
    }
    params.push(limit)
    const rows = db
      .prepare(
        `SELECT component_id as componentId, note_id as noteId, note_title as noteTitle,
                content, context_path as contextPath, bm25(components_fts) as rank
         FROM components_fts
         WHERE ${filters.join(' AND ')}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as Array<{
      componentId: string
      noteId: string
      noteTitle: string
      content: string
      contextPath: string | null
      rank: number
    }>
    return rows.map((h) => ({
      componentId: h.componentId,
      noteId: h.noteId,
      noteTitle: h.noteTitle,
      content: h.content,
      contextPath: h.contextPath || h.noteTitle,
      rank: -h.rank,
      highlights: highlightOffsets(h.content, q),
    }))
  } catch {
    return []
  }
}

export function rebuildAllFts(): number {
  db.prepare(`DELETE FROM components_fts`).run()
  const notes = db.prepare(`SELECT id, title FROM notes`).all() as Array<{ id: string; title: string }>
  for (const n of notes) syncNoteFts(n.id, n.title)
  return notes.length
}

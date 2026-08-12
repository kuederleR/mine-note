import { v4 as uuid } from 'uuid'
import {
  db,
  float32ToBuffer,
  type NoteRow,
  type ComponentRow,
} from './db.js'
import { parseNoteToComponents, componentSearchText } from './parser.js'
import { embedText } from './embeddings.js'

export type NoteDTO = {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  componentCount?: number
}

export type ComponentDTO = {
  id: string
  noteId: string
  type: string
  content: string
  meta: Record<string, unknown>
  position: number
  hasEmbedding: boolean
}

function toNoteDTO(row: NoteRow, componentCount?: number): NoteDTO {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    componentCount,
  }
}

export function listNotes(): NoteDTO[] {
  const rows = db
    .prepare(
      `SELECT n.*,
        (SELECT COUNT(*) FROM components c WHERE c.note_id = n.id) as component_count
       FROM notes n
       ORDER BY n.updated_at DESC`,
    )
    .all() as Array<NoteRow & { component_count: number }>
  return rows.map((r) => toNoteDTO(r, r.component_count))
}

export function getNote(id: string): NoteDTO | null {
  const row = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as NoteRow | undefined
  if (!row) return null
  const count = db
    .prepare(`SELECT COUNT(*) as c FROM components WHERE note_id = ?`)
    .get(id) as { c: number }
  return toNoteDTO(row, count.c)
}

export function getNoteComponents(noteId: string): ComponentDTO[] {
  const rows = db
    .prepare(`SELECT * FROM components WHERE note_id = ? ORDER BY position ASC`)
    .all(noteId) as ComponentRow[]
  return rows.map((r) => ({
    id: r.id,
    noteId: r.note_id,
    type: r.type,
    content: r.content,
    meta: JSON.parse(r.meta_json || '{}'),
    position: r.position,
    hasEmbedding: Boolean(r.embedding),
  }))
}

export async function createNote(input: {
  title?: string
  content?: string
}): Promise<NoteDTO> {
  const now = new Date().toISOString()
  const id = uuid()
  const title = (input.title || 'Untitled').trim() || 'Untitled'
  const content = input.content || ''
  db.prepare(
    `INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, title, content, now, now)
  await reindexNote(id)
  return getNote(id)!
}

export async function updateNote(
  id: string,
  input: { title?: string; content?: string },
): Promise<NoteDTO | null> {
  const existing = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as NoteRow | undefined
  if (!existing) return null
  const title = input.title !== undefined ? input.title.trim() || 'Untitled' : existing.title
  const content = input.content !== undefined ? input.content : existing.content
  const now = new Date().toISOString()
  db.prepare(`UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?`).run(
    title,
    content,
    now,
    id,
  )
  await reindexNote(id)
  return getNote(id)
}

export function deleteNote(id: string): boolean {
  const result = db.prepare(`DELETE FROM notes WHERE id = ?`).run(id)
  return result.changes > 0
}

export async function reindexNote(noteId: string): Promise<number> {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(noteId) as NoteRow | undefined
  if (!note) return 0

  const parsed = parseNoteToComponents(noteId, note.content)
  // Always include title as a heading-like component for searchability
  if (note.title.trim()) {
    parsed.unshift({
      id: `c_title_${noteId.slice(0, 8)}`,
      type: 'heading',
      content: note.title.trim(),
      meta: { level: 0, isTitle: true },
      position: -1,
    })
  }

  const now = new Date().toISOString()
  const prepared: Array<{
    comp: (typeof parsed)[number]
    embedding: Buffer | null
    dim: number | null
  }> = []

  for (const comp of parsed) {
    if (comp.type === 'divider') {
      prepared.push({ comp, embedding: null, dim: null })
      continue
    }
    const vector = await embedText(componentSearchText(comp))
    prepared.push({
      comp,
      embedding: float32ToBuffer(vector),
      dim: vector.length,
    })
  }

  const write = db.transaction(() => {
    db.prepare(`DELETE FROM components WHERE note_id = ?`).run(noteId)
    const insert = db.prepare(
      `INSERT INTO components
        (id, note_id, type, content, meta_json, position, embedding, embedding_dim, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of prepared) {
      insert.run(
        row.comp.id,
        noteId,
        row.comp.type,
        row.comp.content,
        JSON.stringify(row.comp.meta),
        row.comp.position,
        row.embedding,
        row.dim,
        now,
        now,
      )
    }
    return prepared.length
  })

  return write()
}

export async function reindexAll(): Promise<{ notes: number; components: number }> {
  const notes = db.prepare(`SELECT id FROM notes`).all() as Array<{ id: string }>
  let components = 0
  for (const n of notes) {
    components += await reindexNote(n.id)
  }
  return { notes: notes.length, components }
}

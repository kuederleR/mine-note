import { db } from './db.js'
import { updateNote } from './notes.js'
import {
  findCanonicalMineObject,
  formatMineBlock,
  replaceMineObjectInner,
  innerMineMarkdown,
  refreshEmbedSnapshots,
} from './mineFences.js'
import { getStoredMineObject } from './noteDoc.js'

export type MineObjectDTO = {
  id: string
  type: string
  noteId: string
  noteTitle: string
  inner: string
  markdown: string
}

function toDTO(
  noteId: string,
  noteTitle: string,
  found: NonNullable<ReturnType<typeof findCanonicalMineObject>>,
): MineObjectDTO {
  return {
    id: found.fence.id,
    type: found.fence.type,
    noteId,
    noteTitle,
    inner: found.inner,
    markdown: found.block,
  }
}

function noteTitle(noteId: string): string {
  const row = db.prepare(`SELECT title FROM notes WHERE id = ?`).get(noteId) as
    | { title: string }
    | undefined
  return row?.title || 'Untitled'
}

function searchNotes(id: string, preferredNoteId?: string) {
  const like = `%:${id}%`
  const preferred = preferredNoteId
    ? (db.prepare(`SELECT id, title, content FROM notes WHERE id = ?`).get(preferredNoteId) as
        | { id: string; title: string; content: string }
        | undefined)
    : undefined
  const rows = db
    .prepare(`SELECT id, title, content FROM notes WHERE content LIKE ?`)
    .all(like) as Array<{ id: string; title: string; content: string }>
  const ordered = preferred ? [preferred, ...rows.filter((row) => row.id !== preferred.id)] : rows
  for (const row of ordered) {
    const found = findCanonicalMineObject(row.content, id)
    if (found) return { row, found }
  }
  return null
}

export function getMineObject(id: string, noteId?: string): MineObjectDTO | null {
  const stored = getStoredMineObject(id, noteId)
  if (stored) {
    const obj = stored.object
    const markdown = stored.markdown
    return {
      id: obj.id,
      type: obj.type,
      noteId: stored.noteId,
      noteTitle: noteTitle(stored.noteId),
      inner:
        obj.body.kind === 'inline'
          ? obj.body.markdown
          : obj.body.kind === 'reminder'
            ? obj.body.markdown
            : innerMineMarkdown(markdown),
      markdown,
    }
  }
  const hit = searchNotes(id, noteId)
  if (!hit) return null
  return toDTO(hit.row.id, hit.row.title, hit.found)
}

export async function updateMineObjectInner(
  id: string,
  inner: string,
  noteId?: string,
): Promise<MineObjectDTO | null> {
  const stored = getStoredMineObject(id, noteId)
  const preferredNoteId = stored?.noteId || noteId
  const hit = searchNotes(id, preferredNoteId)
  if (!hit) return null
  const markdown = formatMineBlock(
    hit.found.fence.type,
    hit.found.fence.id,
    inner,
    hit.found.fence.agentId,
    hit.found.fence.attrs,
  )
  const replaced = replaceMineObjectInner(hit.row.content, id, inner)
  if (replaced == null) return null
  const next = refreshEmbedSnapshots(replaced, id, markdown)
  const updated = await updateNote(hit.row.id, { content: next })
  if (!updated) return null
  return getMineObject(id, updated.id)
}

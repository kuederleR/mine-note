import { db } from './db.js'
import {
  DOC_VERSION,
  docObjectToMarkdown,
  docToMarkdown,
  markdownToDoc,
  parseDocJson,
  stringifyDoc,
  type DocObject,
  type StructuredDoc,
} from '../src/lib/structuredDoc.ts'

export type NoteDocument = {
  doc: StructuredDoc
  objects: DocObject[]
  markdown: string
  version: number
}

/** Parse markdown into structured doc and persist alongside the note content cache. */
export function persistNoteDocument(noteId: string, markdown: string, updatedAt?: string): NoteDocument {
  const { doc, objects } = markdownToDoc(markdown)
  const projected = docToMarkdown(doc, objects)
  const now = updatedAt || new Date().toISOString()
  const tx = db.transaction(() => {
    if (updatedAt) {
      db.prepare(
        `UPDATE notes SET content = ?, doc_json = ?, doc_version = ?, updated_at = ? WHERE id = ?`,
      ).run(projected, stringifyDoc(doc), DOC_VERSION, updatedAt, noteId)
    } else {
      db.prepare(`UPDATE notes SET content = ?, doc_json = ?, doc_version = ? WHERE id = ?`).run(
        projected,
        stringifyDoc(doc),
        DOC_VERSION,
        noteId,
      )
    }
    db.prepare(`DELETE FROM mine_objects WHERE note_id = ?`).run(noteId)
    const insert = db.prepare(
      `INSERT INTO mine_objects (id, note_id, type, body_json, agent_id, attrs_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const obj of objects) {
      insert.run(
        obj.id,
        noteId,
        obj.type,
        JSON.stringify(obj.body),
        obj.agentId ?? null,
        JSON.stringify(obj.attrs || {}),
        now,
      )
    }
  })
  tx()
  return { doc, objects, markdown: projected, version: DOC_VERSION }
}

export function loadObjectsForNote(noteId: string): DocObject[] {
  const rows = db
    .prepare(
      `SELECT id, type, body_json, agent_id, attrs_json FROM mine_objects WHERE note_id = ?`,
    )
    .all(noteId) as Array<{
    id: string
    type: string
    body_json: string
    agent_id: string | null
    attrs_json: string
  }>
  return rows.map((row) => {
    let body: DocObject['body'] = { kind: 'inline', markdown: '' }
    let attrs: Record<string, string> | undefined
    try {
      body = JSON.parse(row.body_json) as DocObject['body']
    } catch {
      /* keep default */
    }
    try {
      const parsed = JSON.parse(row.attrs_json || '{}') as Record<string, string>
      if (parsed && Object.keys(parsed).length) attrs = parsed
    } catch {
      /* ignore */
    }
    return {
      id: row.id,
      type: row.type as DocObject['type'],
      agentId: row.agent_id,
      attrs,
      body,
    }
  })
}

/**
 * Load the structured document for a note. When doc_version >= 1 and doc_json is valid,
 * prefer projecting markdown from the doc (heal content drift). Otherwise parse content.
 */
export function loadNoteDocument(noteId: string): NoteDocument | null {
  const row = db
    .prepare(`SELECT content, doc_json, doc_version FROM notes WHERE id = ?`)
    .get(noteId) as
    | { content: string; doc_json: string | null; doc_version: number | null }
    | undefined
  if (!row) return null

  const version = row.doc_version ?? 0
  if (version >= DOC_VERSION && row.doc_json) {
    const doc = parseDocJson(row.doc_json)
    if (doc) {
      const objects = loadObjectsForNote(noteId)
      // If object bag is empty but doc references objects, rebuild from markdown cache
      if (!objects.length && row.content.trim()) {
        const rebuilt = markdownToDoc(row.content)
        return {
          doc: rebuilt.doc,
          objects: rebuilt.objects,
          markdown: row.content,
          version,
        }
      }
      const markdown = objects.length ? docToMarkdown(doc, objects) : row.content
      return { doc, objects, markdown, version }
    }
  }

  const rebuilt = markdownToDoc(row.content)
  return {
    doc: rebuilt.doc,
    objects: rebuilt.objects,
    markdown: row.content,
    version: 0,
  }
}

export function getStoredMineObject(
  id: string,
  preferredNoteId?: string,
): { noteId: string; object: DocObject; objects: DocObject[]; markdown: string } | null {
  const preferred = preferredNoteId
    ? (db
        .prepare(`SELECT note_id, id FROM mine_objects WHERE id = ? AND note_id = ?`)
        .get(id, preferredNoteId) as { note_id: string; id: string } | undefined)
    : undefined
  const hit =
    preferred ||
    (db.prepare(`SELECT note_id, id FROM mine_objects WHERE id = ?`).get(id) as
      | { note_id: string; id: string }
      | undefined)
  if (!hit) return null
  const objects = loadObjectsForNote(hit.note_id)
  const object = objects.find((obj) => obj.id === id)
  if (!object) return null
  return {
    noteId: hit.note_id,
    object,
    objects,
    markdown: docObjectToMarkdown(object, objects),
  }
}

/** Upgrade legacy markdown-only notes to doc_version 1. */
export function backfillNoteDocuments(): number {
  const rows = db
    .prepare(
      `SELECT id, content FROM notes WHERE COALESCE(doc_version, 0) < ? OR doc_json IS NULL OR doc_json = ''`,
    )
    .all(DOC_VERSION) as Array<{ id: string; content: string }>
  for (const row of rows) persistNoteDocument(row.id, row.content)
  return rows.length
}

/** Wipe all notes and derived object/index rows. Keeps categories, folders, settings. */
export function clearAllNotes(): { notes: number } {
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM notes`).get() as { n: number }
  ).n
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM components`).run()
    try {
      db.prepare(`DELETE FROM components_fts`).run()
    } catch {
      /* fts may be contentless / missing */
    }
    db.prepare(`DELETE FROM mine_objects`).run()
    db.prepare(`DELETE FROM reminders`).run()
    db.prepare(`DELETE FROM note_agents`).run()
    db.prepare(`DELETE FROM mentions`).run()
    db.prepare(`DELETE FROM entity_aliases`).run()
    db.prepare(`DELETE FROM entity_centroids`).run()
    try {
      db.prepare(`DELETE FROM vec_chunks`).run()
    } catch {
      /* vec optional */
    }
    try {
      db.prepare(`DELETE FROM vec_row_map`).run()
    } catch {
      /* optional */
    }
    db.prepare(`DELETE FROM notes`).run()
  })
  tx()
  return { notes: count }
}

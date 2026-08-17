import { v4 as uuid } from 'uuid'
import {
  db,
  bufferToFloat32,
  float32ToBuffer,
  getAppMeta,
  setAppMeta,
  FTS_SCHEMA,
  VEC_SCHEMA,
  type NoteRow,
  type ComponentRow,
} from './db.js'
import { parseNoteToComponents, componentSearchText } from './parser.js'
import { pruneNoteAgents } from './noteAgents.js'
import { embedText, hashEmbedInput } from './embeddings.js'
import { applyTemplate, buildEntityText, getCategoryRow } from './categories.js'
import { contextualizeComponents, wrapForEmbedding } from './embedContext.js'
import { syncRemindersFromNote } from './reminders.js'
import { deleteNoteFts, syncNoteFts } from './fts.js'
import { rebuildMentionsForNote, syncEntityAliases } from './entities.js'
import { collectCanonicalMineObjects, refreshEmbedSnapshots } from './mineFences.js'
import { composeWithLinks, linkedNoteIdsFromMeta, saveEntityCentroid } from './centroids.js'
import { deleteNoteVectors, upsertChunkVector } from './vec.js'
import { loadNoteDocument, persistNoteDocument, backfillNoteDocuments, clearAllNotes } from './noteDoc.js'
import { componentsFromDocument } from './structuredParse.js'
import { DOC_VERSION } from '../src/lib/structuredDoc.ts'
import type { DocObject, StructuredDoc } from '../src/lib/structuredDoc.ts'

export type NoteDTO = {
  id: string
  title: string
  content: string
  createdAt: string
  updatedAt: string
  categoryId: string | null
  folderId: string | null
  categoryName?: string | null
  categoryIcon?: string | null
  categoryColor?: string | null
  categorySlug?: string | null
  componentCount?: number
  docVersion?: number
  doc?: StructuredDoc
  objects?: DocObject[]
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

function toNoteDTO(
  row: NoteRow & {
    category_name?: string | null
    category_icon?: string | null
    category_color?: string | null
    category_slug?: string | null
  },
  componentCount?: number,
  extras?: { doc?: StructuredDoc; objects?: DocObject[]; content?: string },
): NoteDTO {
  return {
    id: row.id,
    title: row.title,
    content: extras?.content ?? row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categoryId: row.category_id,
    folderId: row.folder_id ?? null,
    categoryName: row.category_name ?? null,
    categoryIcon: row.category_icon ?? null,
    categoryColor: row.category_color ?? null,
    categorySlug: row.category_slug ?? null,
    componentCount,
    docVersion: row.doc_version ?? 0,
    doc: extras?.doc,
    objects: extras?.objects,
  }
}

const NOTE_SELECT = `SELECT n.*,
        cat.name as category_name,
        cat.icon as category_icon,
        cat.color as category_color,
        cat.slug as category_slug,
        (SELECT COUNT(*) FROM components c WHERE c.note_id = n.id) as component_count
       FROM notes n
       LEFT JOIN categories cat ON cat.id = n.category_id`

export function listNotes(): NoteDTO[] {
  const rows = db
    .prepare(`${NOTE_SELECT} ORDER BY n.updated_at DESC`)
    .all() as Array<
    NoteRow & {
      component_count: number
      category_name: string | null
      category_icon: string | null
      category_color: string | null
      category_slug: string | null
    }
  >
  return rows.map((r) => toNoteDTO(r, r.component_count))
}

export function getNote(id: string): NoteDTO | null {
  const row = db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id) as
    | (NoteRow & {
        component_count: number
        category_name: string | null
        category_icon: string | null
        category_color: string | null
        category_slug: string | null
      })
    | undefined
  if (!row) return null
  const document = loadNoteDocument(id)
  if (document && document.version >= DOC_VERSION) {
    return toNoteDTO(row, row.component_count, {
      doc: document.doc,
      objects: document.objects,
      content: document.markdown,
    })
  }
  if (document) {
    return toNoteDTO(row, row.component_count, {
      doc: document.doc,
      objects: document.objects,
    })
  }
  return toNoteDTO(row, row.component_count)
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
  categoryId?: string | null
  folderId?: string | null
}): Promise<NoteDTO> {
  const now = new Date().toISOString()
  const id = uuid()
  const title = (input.title || 'Untitled').trim() || 'Untitled'
  const categoryId = input.categoryId || null
  const folderId = input.folderId || null
  const category = categoryId ? getCategoryRow(categoryId) : null
  const content =
    input.content !== undefined
      ? input.content
      : category
        ? applyTemplate(category.template, title)
        : ''
  db.prepare(
    `INSERT INTO notes (id, title, content, category_id, folder_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, content, categoryId, folderId, now, now)
  persistNoteDocument(id, content, now)
  await reindexNote(id)
  syncRemindersFromNote(id, content)
  return getNote(id)!
}

export async function updateNote(
  id: string,
  input: {
    title?: string
    content?: string
    categoryId?: string | null
    folderId?: string | null
  },
): Promise<NoteDTO | null> {
  const existing = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as NoteRow | undefined
  if (!existing) return null
  const title = input.title !== undefined ? input.title.trim() || 'Untitled' : existing.title
  const content = input.content !== undefined ? input.content : existing.content
  const categoryId =
    input.categoryId !== undefined ? input.categoryId || null : existing.category_id
  const folderId =
    input.folderId !== undefined ? input.folderId || null : existing.folder_id ?? null
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE notes SET title = ?, content = ?, category_id = ?, folder_id = ?, updated_at = ? WHERE id = ?`,
  ).run(title, content, categoryId, folderId, now, id)
  if (input.content !== undefined) {
    persistNoteDocument(id, content, now)
    pruneNoteAgents(id, content)
  }
  await reindexNote(id)
  syncRemindersFromNote(id, content)
  if (input.content !== undefined) {
    await syncEmbedSnapshots(id, existing.content, content)
  }
  return getNote(id)
}

async function syncEmbedSnapshots(noteId: string, prevContent: string, nextContent: string) {
  const prev = collectCanonicalMineObjects(prevContent)
  const next = collectCanonicalMineObjects(nextContent)
  for (const [objectId, found] of next) {
    if (prev.get(objectId)?.block === found.block) continue
    const rows = db
      .prepare(`SELECT id, content FROM notes WHERE id != ? AND content LIKE ?`)
      .all(noteId, `%src=${objectId}%`) as Array<{ id: string; content: string }>
    for (const row of rows) {
      const updated = refreshEmbedSnapshots(row.content, objectId, found.block)
      if (updated === row.content) continue
      const now = new Date().toISOString()
      db.prepare(`UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`).run(updated, now, row.id)
      persistNoteDocument(row.id, updated, now)
      pruneNoteAgents(row.id, updated)
      await reindexNote(row.id)
      syncRemindersFromNote(row.id, updated)
    }
  }
}

export function deleteNote(id: string): boolean {
  deleteNoteVectors(id)
  deleteNoteFts(id)
  const result = db.prepare(`DELETE FROM notes WHERE id = ?`).run(id)
  return result.changes > 0
}

export async function reindexNote(noteId: string): Promise<number> {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(noteId) as NoteRow | undefined
  if (!note) return 0

  // Prefer structured flatten so nested table/embed objects are searchable
  let document = loadNoteDocument(noteId)
  if (!document || document.version < DOC_VERSION) {
    document = persistNoteDocument(noteId, note.content)
  }
  const fromDoc = componentsFromDocument(noteId, document.doc, document.objects)
  const fromMarkdown = parseNoteToComponents(noteId, document.markdown)
  // Structured components first; fill gaps from markdown parser (wikilinks, code fences, etc.)
  const seenContent = new Set(fromDoc.map((c) => `${c.type}:${c.content}`))
  const parsed = [
    ...fromDoc,
    ...fromMarkdown.filter((c) => !seenContent.has(`${c.type}:${c.content}`)),
  ]
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

  const category = note.category_id ? getCategoryRow(note.category_id) : null
  if (category) {
    parsed.push({
      id: `c_entity_${noteId.slice(0, 12)}`,
      type: 'entity',
      content: [note.title.trim(), document.markdown.trim()].filter(Boolean).join('\n').slice(0, 4000),
      meta: {
        categoryId: category.id,
        categoryName: category.name,
        categorySlug: category.slug,
        isEntity: true,
      },
      position: 10_000,
    })
  }

  const knownNames = (
    db.prepare(`SELECT title FROM notes WHERE id != ?`).all(noteId) as Array<{ title: string }>
  )
    .map((r) => r.title.trim())
    .filter((t) => t.length > 1)

  const titleToId = new Map(
    (
      db.prepare(`SELECT id, title FROM notes WHERE category_id IS NOT NULL`).all() as Array<{
        id: string
        title: string
      }>
    ).map((r) => [r.title.toLowerCase(), r.id] as const),
  )

  const priorByHash = new Map<string, Buffer>()
  const priorRows = db
    .prepare(
      `SELECT content_hash, embedding FROM components
       WHERE note_id = ? AND content_hash IS NOT NULL AND embedding IS NOT NULL`,
    )
    .all(noteId) as Array<{ content_hash: string; embedding: Buffer }>
  for (const row of priorRows) {
    if (!priorByHash.has(row.content_hash)) priorByHash.set(row.content_hash, row.embedding)
  }

  const contextualized = contextualizeComponents(note.title, category?.name || null, parsed, knownNames)

  const now = new Date().toISOString()
  const prepared: Array<{
    comp: (typeof parsed)[number]
    embedding: Buffer | null
    dim: number | null
    contentHash: string | null
    contextPath: string
  }> = []

  let entityCentroid: Float32Array | null = null

  for (const { comp, embedInput, contextPath } of contextualized) {
    if (comp.type === 'divider' || !embedInput.trim()) {
      prepared.push({
        comp,
        embedding: null,
        dim: null,
        contentHash: null,
        contextPath,
      })
      continue
    }
    const text =
      comp.type === 'entity' && category
        ? wrapForEmbedding(buildEntityText(category, note.title, document.markdown), {
            title: note.title,
            category: category.name,
            headingPath: [],
          })
        : embedInput
    const contentHash = hashEmbedInput(text)
    const linkIds =
      comp.type === 'entity'
        ? []
        : linkedNoteIdsFromMeta(comp.meta as Record<string, unknown>, titleToId).filter(
            (id) => id !== noteId,
          )
    const reused = !linkIds.length ? priorByHash.get(contentHash) : undefined
    let vector: Float32Array
    if (reused) {
      vector = bufferToFloat32(reused) || (await embedText(text))
    } else {
      vector = await embedText(text)
      if (linkIds.length) vector = composeWithLinks(vector, linkIds)
    }
    if (comp.type === 'entity') entityCentroid = vector
    prepared.push({
      comp,
      embedding: float32ToBuffer(vector),
      dim: vector.length,
      contentHash,
      contextPath,
    })
  }

  deleteNoteVectors(noteId)

  const write = db.transaction(() => {
    db.prepare(`DELETE FROM components WHERE note_id = ?`).run(noteId)
    const insert = db.prepare(
      `INSERT INTO components
        (id, note_id, type, content, meta_json, position, embedding, embedding_dim,
         content_hash, context_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.contentHash,
        row.contextPath,
        now,
        now,
      )
    }
    return prepared.length
  })

  const count = write()
  for (const row of prepared) {
    if (!row.embedding) continue
    const vec = bufferToFloat32(row.embedding)
    if (vec) upsertChunkVector(row.comp.id, vec)
  }
  if (entityCentroid && note.category_id) saveEntityCentroid(noteId, entityCentroid)
  syncNoteFts(
    noteId,
    note.title,
    prepared.map((row) => ({
      id: row.comp.id,
      content: componentSearchText(row.comp),
      type: row.comp.type,
      context_path: row.contextPath,
    })),
  )
  syncEntityAliases(noteId, note.title, document.markdown, note.category_id)
  rebuildMentionsForNote(noteId)
  return count
}

export function resetNotesWorkspace(): { notes: number } {
  return clearAllNotes()
}

export function ensureNoteDocuments(): number {
  return backfillNoteDocuments()
}

export async function reindexAll(): Promise<{ notes: number; components: number }> {
  const notes = db.prepare(`SELECT id, category_id FROM notes`).all() as Array<{
    id: string
    category_id: string | null
  }>
  let components = 0
  for (const n of notes.filter((x) => x.category_id)) components += await reindexNote(n.id)
  for (const n of notes) components += await reindexNote(n.id)
  setAppMeta(EMBED_SCHEMA_KEY, EMBED_SCHEMA)
  setAppMeta(GRAPH_SCHEMA_KEY, GRAPH_SCHEMA)
  setAppMeta('fts_schema', FTS_SCHEMA)
  setAppMeta('vec_schema', VEC_SCHEMA)
  return { notes: notes.length, components }
}

/** Rebuild embeddings, sqlite-vec, and FTS after a model or schema change. */
export const rebuildSearchIndex = reindexAll

const EMBED_SCHEMA_KEY = 'embed_schema'
const EMBED_SCHEMA = 'context-v5-typed-objects'
const GRAPH_SCHEMA_KEY = 'graph_schema'
const GRAPH_SCHEMA = 'entities-fts-ops-v2'

export async function ensureEmbedSchema(): Promise<void> {
  const backfilled = ensureNoteDocuments()
  if (backfilled > 0) {
    console.log(`Documents: backfilled structured docs for ${backfilled} notes`)
  }
  if (
    getAppMeta(EMBED_SCHEMA_KEY) === EMBED_SCHEMA &&
    getAppMeta(GRAPH_SCHEMA_KEY) === GRAPH_SCHEMA &&
    getAppMeta('fts_schema') === FTS_SCHEMA &&
    getAppMeta('vec_schema') === VEC_SCHEMA
  ) {
    return
  }
  console.log(`Embeddings: reindexing notes for ${EMBED_SCHEMA} / ${GRAPH_SCHEMA}`)
  await reindexAll()
}

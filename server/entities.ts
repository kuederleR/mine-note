import { v4 as uuid } from 'uuid'
import { db, type NoteRow } from './db.js'
import { getCategoryRow } from './categories.js'
import { alreadyLinked, entityLinkedInText, findUnlinkedSurfaces, surfaceIsAlreadyLinked } from './mentionText.js'

export type MentionStatus = 'linked' | 'candidate' | 'ambiguous' | 'rejected'

export type EntityRef = {
  noteId: string
  title: string
  categoryId: string | null
  categoryName: string | null
  categoryTag: string | null
  aliases: string[]
}

export type MentionRow = {
  id: string
  sourceNoteId: string
  sourceComponentId: string | null
  surface: string
  entityNoteId: string | null
  status: MentionStatus
  confidence: number
}

export type EntityProposal = {
  id: string
  surface: string
  sourceNoteId: string
  sourceNoteTitle: string
  sourceComponentId: string | null
  candidates: Array<{
    noteId: string
    noteTitle: string
    categoryName: string | null
  }>
  message: string
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

const WEAK_ALIASES = new Set([
  'meeting',
  'meetings',
  'notes',
  'note',
  'project',
  'projects',
  'draft',
  'untitled',
  'the',
  'a',
  'an',
])

/** Aliases from title + optional `aliases:` line in content. */
export function deriveAliases(title: string, content: string): string[] {
  const out = new Set<string>()
  const t = title.trim()
  if (t) out.add(t)
  const first = t.split(/\s+/)[0]
  if (first && first.length >= 3 && !WEAK_ALIASES.has(first.toLowerCase())) out.add(first)
  const aliasLine = content.match(/^\s*aliases?\s*:\s*(.+)$/im)
  if (aliasLine) {
    for (const part of aliasLine[1].split(/[,;/|]/)) {
      const a = part.trim()
      if (a.length >= 2 && !WEAK_ALIASES.has(a.toLowerCase())) out.add(a)
    }
  }
  return [...out]
}

export function listEntityNotes(): EntityRef[] {
  const rows = db
    .prepare(
      `SELECT n.id, n.title, n.content, n.category_id,
              c.name as category_name, c.tag as category_tag
       FROM notes n
       JOIN categories c ON c.id = n.category_id
       WHERE n.category_id IS NOT NULL`,
    )
    .all() as Array<{
    id: string
    title: string
    content: string
    category_id: string
    category_name: string
    category_tag: string
  }>

  return rows.map((r) => {
    const stored = db
      .prepare(`SELECT alias FROM entity_aliases WHERE entity_note_id = ?`)
      .all(r.id) as Array<{ alias: string }>
    const aliases = stored.length
      ? stored.map((a) => a.alias)
      : deriveAliases(r.title, r.content)
    return {
      noteId: r.id,
      title: r.title,
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryTag: r.category_tag || null,
      aliases,
    }
  })
}

export function syncEntityAliases(noteId: string, title: string, content: string, categoryId: string | null) {
  db.prepare(`DELETE FROM entity_aliases WHERE entity_note_id = ?`).run(noteId)
  if (!categoryId) return
  const aliases = deriveAliases(title, content)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO entity_aliases (entity_note_id, alias) VALUES (?, ?)`,
  )
  const seen = new Set<string>()
  for (const alias of aliases) {
    const key = normalizeAlias(alias)
    if (!key || seen.has(key)) continue
    seen.add(key)
    insert.run(noteId, alias.trim())
  }
}

type AliasHit = { entity: EntityRef; alias: string }

function entityNames(entity: EntityRef): string[] {
  return [entity.title, ...entity.aliases]
}

function buildAliasIndex(entities: EntityRef[]): AliasHit[] {
  const hits: AliasHit[] = []
  for (const entity of entities) {
    for (const alias of entity.aliases) {
      const a = alias.trim()
      if (a.length < 2) continue
      hits.push({ entity, alias: a })
    }
  }
  return hits.sort((a, b) => b.alias.length - a.alias.length)
}

function findSurfaces(text: string, alias: string): number[] {
  return findUnlinkedSurfaces(text, alias)
}

/** Rebuild mention rows for a note from its components + entity alias index. */
export function rebuildMentionsForNote(noteId: string): number {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(noteId) as NoteRow | undefined
  if (!note) return 0

  const entities = listEntityNotes().filter((e) => e.noteId !== noteId)
  const aliasHits = buildAliasIndex(entities)
  const noteLinkedNames = new Set(
    entities.filter((e) => entityLinkedInText(note.content, entityNames(e))).map((e) => e.noteId),
  )
  const components = db
    .prepare(
      `SELECT id, content, meta_json, type FROM components
       WHERE note_id = ? AND type NOT IN ('divider', 'entity', 'chunk', 'wikilink')`,
    )
    .all(noteId) as Array<{ id: string; content: string; meta_json: string; type: string }>

  const now = new Date().toISOString()
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM mentions WHERE source_note_id = ?`).run(noteId)
    const insert = db.prepare(
      `INSERT INTO mentions
        (id, source_note_id, source_component_id, surface, entity_note_id, status, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    let count = 0
    const seen = new Set<string>()

    for (const comp of components) {
      let meta: { wikiLinks?: string[]; taggedLinks?: Array<{ title?: string }> } = {}
      try {
        meta = JSON.parse(comp.meta_json || '{}')
      } catch {
        meta = {}
      }
      const linkedTitles = new Set<string>([
        ...(meta.wikiLinks || []).map((t) => t.split('|')[0].trim().toLowerCase()),
        ...((meta.taggedLinks || []).map((t) => String(t.title || '').toLowerCase()).filter(Boolean)),
      ])

      // Explicit links
      for (const title of linkedTitles) {
        const entity = entities.find(
          (e) =>
            e.title.toLowerCase() === title ||
            e.aliases.some((a) => normalizeAlias(a) === title),
        )
        if (!entity) continue
        const key = `${comp.id}|linked|${entity.noteId}`
        if (seen.has(key)) continue
        seen.add(key)
        insert.run(uuid(), noteId, comp.id, entity.title, entity.noteId, 'linked', 1, now, now)
        count += 1
      }

      // Plain-text alias candidates
      const matchedEntities = new Map<string, { surface: string; entities: EntityRef[] }>()
      for (const hit of aliasHits) {
        if (noteLinkedNames.has(hit.entity.noteId)) continue
        if (entityLinkedInText(comp.content, entityNames(hit.entity))) continue
        if (linkedTitles.has(hit.entity.title.toLowerCase())) continue
        if (hit.entity.aliases.some((a) => linkedTitles.has(normalizeAlias(a)))) continue
        if (alreadyLinked(comp.content, hit.entity.title)) continue
        if (!findSurfaces(comp.content, hit.alias).length) continue
        const surfaceKey = normalizeAlias(hit.alias)
        const bucket = matchedEntities.get(surfaceKey) || { surface: hit.alias, entities: [] }
        if (!bucket.entities.some((e) => e.noteId === hit.entity.noteId)) {
          bucket.entities.push(hit.entity)
        }
        matchedEntities.set(surfaceKey, bucket)
      }

      for (const { surface, entities: ents } of matchedEntities.values()) {
        if (ents.length === 1) {
          const entity = ents[0]
          const key = `${comp.id}|cand|${entity.noteId}|${normalizeAlias(surface)}`
          if (seen.has(key)) continue
          seen.add(key)
          insert.run(
            uuid(),
            noteId,
            comp.id,
            surface,
            entity.noteId,
            'candidate',
            surface.toLowerCase() === entity.title.toLowerCase() ? 0.9 : 0.7,
            now,
            now,
          )
          count += 1
        } else if (ents.length > 1) {
          const key = `${comp.id}|amb|${normalizeAlias(surface)}`
          if (seen.has(key)) continue
          seen.add(key)
          insert.run(uuid(), noteId, comp.id, surface, null, 'ambiguous', 0.4, now, now)
          count += 1
        }
      }
    }
    return count
  })

  return write()
}

export function resolveEntitiesInText(
  text: string,
  focusNoteIds: string[] = [],
  options: { preferPeople?: boolean } = {},
): EntityRef[] {
  const q = text.trim()
  if (!q) return []
  const entities = listEntityNotes()
  const hits: Array<{ entity: EntityRef; score: number }> = []
  const lower = q.toLowerCase()
  const askMeeting = /\bmeeting\b/i.test(q)

  for (const entity of entities) {
    let score = 0
    const cat = (entity.categoryName || '').toLowerCase()
    const isPerson = cat.includes('people') || cat.includes('person')
    const isMeeting = cat.includes('meeting') || /\bmeeting\b/i.test(entity.title)

    if (lower.includes(entity.title.toLowerCase())) score = Math.max(score, 1)
    for (const alias of entity.aliases) {
      const a = alias.toLowerCase()
      if (a.length < 2) continue
      if (!lower.includes(a)) continue
      // Don't let the word "meeting" bind to a Meetings page when asking about a meeting with someone.
      if (askMeeting && isMeeting && (a === 'meeting' || a.startsWith('meeting '))) continue
      score = Math.max(score, a === entity.title.toLowerCase() ? 1 : 0.85)
    }
    if (focusNoteIds.includes(entity.noteId)) score = Math.max(score, 0.6)
    if (options.preferPeople && isPerson) score += 0.15
    if (options.preferPeople && isMeeting) score -= 0.25
    if (score > 0) hits.push({ entity, score })
  }

  hits.sort((a, b) => b.score - a.score)
  const out: EntityRef[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (seen.has(h.entity.noteId)) continue
    seen.add(h.entity.noteId)
    out.push(h.entity)
    if (out.length >= 4) break
  }
  return out
}

export function noteIdsMentioningEntity(entityNoteId: string, statuses: MentionStatus[] = ['linked', 'candidate']): string[] {
  const placeholders = statuses.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT DISTINCT source_note_id as id FROM mentions
       WHERE entity_note_id = ? AND status IN (${placeholders})`,
    )
    .all(entityNoteId, ...statuses) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

export function proposalsForEntities(entities: EntityRef[], limit = 4): EntityProposal[] {
  if (!entities.length) return []
  const entityIds = entities.map((e) => e.noteId)
  const placeholders = entityIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT m.id, m.source_note_id, m.source_component_id, m.surface, m.entity_note_id, m.status,
              n.title as source_title, n.content as source_content
       FROM mentions m
       JOIN notes n ON n.id = m.source_note_id
       WHERE m.status IN ('candidate', 'ambiguous')
         AND (
           m.entity_note_id IN (${placeholders})
           OR m.status = 'ambiguous'
         )
         AND m.source_note_id NOT IN (${placeholders})
       ORDER BY m.confidence DESC
       LIMIT 24`,
    )
    .all(...entityIds, ...entityIds) as Array<{
    id: string
    source_note_id: string
    source_component_id: string | null
    surface: string
    entity_note_id: string | null
    status: MentionStatus
    source_title: string
    source_content: string
  }>

  const out: EntityProposal[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.source_note_id}|${normalizeAlias(row.surface)}`
    if (seen.has(key)) continue
    seen.add(key)

    let candidates: EntityProposal['candidates'] = []
    if (row.entity_note_id) {
      const ent = entities.find((e) => e.noteId === row.entity_note_id) || listEntityNotes().find((e) => e.noteId === row.entity_note_id)
      if (ent) {
        if (entityLinkedInText(row.source_content, entityNames(ent))) continue
        if (!findUnlinkedSurfaces(row.source_content, row.surface).length) continue
        candidates = [
          {
            noteId: ent.noteId,
            noteTitle: ent.title,
            categoryName: ent.categoryName,
          },
        ]
      }
    } else {
      // Ambiguous: find entities whose aliases match surface
      candidates = listEntityNotes()
        .filter((e) => e.aliases.some((a) => normalizeAlias(a) === normalizeAlias(row.surface)))
        .filter((e) => !entityLinkedInText(row.source_content, entityNames(e)))
        .slice(0, 4)
        .map((e) => ({
          noteId: e.noteId,
          noteTitle: e.title,
          categoryName: e.categoryName,
        }))
      if (!findUnlinkedSurfaces(row.source_content, row.surface).length) continue
    }
    if (!candidates.length) continue

    const primary = candidates[0]
    out.push({
      id: row.id,
      surface: row.surface,
      sourceNoteId: row.source_note_id,
      sourceNoteTitle: row.source_title,
      sourceComponentId: row.source_component_id,
      candidates,
      message:
        candidates.length === 1
          ? `“${row.surface}” in ${row.source_title} — same as ${primary.noteTitle}?`
          : `“${row.surface}” in ${row.source_title} could be ${candidates.map((c) => c.noteTitle).join(' or ')}.`,
    })
    if (out.length >= limit) break
  }
  return out
}

export function formatEntityLink(entity: EntityRef): string {
  const tag = (entity.categoryTag || '').trim()
  if (tag) return `:${tag}[${entity.title}]`
  return `[[${entity.title}]]`
}

/** Replace a plain surface form with a Mine/wiki link in the source note. */
export async function confirmMentionLink(input: {
  mentionId?: string
  sourceNoteId: string
  surface: string
  entityNoteId: string
}): Promise<{ ok: boolean; noteId: string; replaced: number; link: string }> {
  const note = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(input.sourceNoteId) as NoteRow | undefined
  if (!note) throw new Error('Source note not found')
  const entityNote = db.prepare(`SELECT * FROM notes WHERE id = ?`).get(input.entityNoteId) as NoteRow | undefined
  if (!entityNote) throw new Error('Entity note not found')

  const category = entityNote.category_id ? getCategoryRow(entityNote.category_id) : null
  const entity: EntityRef = {
    noteId: entityNote.id,
    title: entityNote.title,
    categoryId: entityNote.category_id,
    categoryName: category?.name ?? null,
    categoryTag: category?.tag ?? null,
    aliases: deriveAliases(entityNote.title, entityNote.content),
  }
  const link = formatEntityLink(entity)
  const surface = input.surface.trim()
  if (!surface) throw new Error('Missing surface form')

  const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}:\\[])(${escaped})(?![\\p{L}\\p{N}\\]])`, 'giu')
  let replaced = 0
  const nextContent = note.content.replace(re, (match, _g1, offset: number, full: string) => {
    if (surfaceIsAlreadyLinked(full, offset, match.length)) return match
    replaced += 1
    return link
  })

  if (replaced === 0) {
    // Still mark mention linked if present
    if (input.mentionId) {
      db.prepare(
        `UPDATE mentions SET status = 'linked', entity_note_id = ?, confidence = 1, updated_at = ?
         WHERE id = ?`,
      ).run(input.entityNoteId, new Date().toISOString(), input.mentionId)
    }
    return { ok: true, noteId: note.id, replaced: 0, link }
  }

  const now = new Date().toISOString()
  db.prepare(`UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`).run(nextContent, now, note.id)

  const { reindexNote } = await import('./notes.js')
  await reindexNote(note.id)

  return { ok: true, noteId: note.id, replaced, link }
}

export function dismissMention(mentionId: string): void {
  db.prepare(
    `UPDATE mentions SET status = 'rejected', updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), mentionId)
}

export function rebuildAllMentions(): number {
  const notes = db.prepare(`SELECT id, title, content, category_id FROM notes`).all() as NoteRow[]
  for (const n of notes) {
    syncEntityAliases(n.id, n.title, n.content, n.category_id)
  }
  let total = 0
  for (const n of notes) {
    total += rebuildMentionsForNote(n.id)
  }
  return total
}

export function isAttributeQuery(query: string): boolean {
  return /\b(phone|mobile|cell|email|e-mail|address|birthday|born|dob|number|title|role|boss|manager)\b/i.test(
    query,
  )
}

export function isIdentityQuery(query: string): boolean {
  return /\b(who is|who'?s|what is|what'?s)\b/i.test(query) || /\bwho\b.+\b\?/.test(query)
}

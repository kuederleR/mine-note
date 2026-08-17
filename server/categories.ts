import { v4 as uuid } from 'uuid'
import { db, type CategoryRow } from './db.js'
import { CATEGORY_COLORS, defaultLucideIcon } from './categoryIcons.js'
import { uniqueTag } from './categoryTags.js'
import { getWorkspaceSettings } from './workspaceSettings.js'

export type CategoryDTO = {
  id: string
  name: string
  slug: string
  icon: string
  color: string
  description: string
  embedInstruction: string
  queryHints: string
  template: string
  tag: string
  position: number
  createdAt: string
  updatedAt: string
  noteCount: number
}

export type CategoryInput = {
  name?: string
  icon?: string
  color?: string
  description?: string
  embedInstruction?: string
  queryHints?: string
  template?: string
  tag?: string
  position?: number
}

export function defaultIcon(name: string): string {
  return defaultLucideIcon(name)
}

function reservedTags(): string[] {
  return getWorkspaceSettings().reservedShortcuts
}

export function reassignCollidingTags(reserved: string[] = reservedTags()) {
  const rows = listCategories()
  const taken: string[] = []
  for (const row of rows) {
    const collide = reserved.some((item) => item.toLowerCase() === row.tag.toLowerCase())
    const tag = uniqueTag(row.name, taken, collide ? '' : row.tag, reserved)
    taken.push(tag)
    if (tag !== row.tag) {
      db.prepare(`UPDATE categories SET tag = ? WHERE id = ?`).run(tag, row.id)
    }
  }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48)
  return base || 'category'
}

function uniqueSlug(name: string, exceptId?: string): string {
  const base = slugify(name)
  let slug = base
  let n = 2
  for (;;) {
    const row = db
      .prepare(`SELECT id FROM categories WHERE slug = ?`)
      .get(slug) as { id: string } | undefined
    if (!row || row.id === exceptId) return slug
    slug = `${base}-${n}`
    n += 1
  }
}

export function defaultEmbedInstruction(name: string): string {
  return `This note is a ${name} entity. Represent who or what it is, key facts, relationships, and how it connects to other notes.`
}

export function defaultQueryHints(name: string): string {
  const n = name.trim().toLowerCase()
  const singular = n.replace(/s$/, '')
  if (n === 'people' || n === 'person') return 'who, person, people, someone, contact'
  if (n === 'places' || n === 'place') return 'where, place, location, somewhere'
  if (n === 'projects' || n === 'project') return 'project, workstream, effort'
  return [n, singular].filter((x, i, a) => x && a.indexOf(x) === i).join(', ')
}

function toDTO(row: CategoryRow, noteCount: number): CategoryDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    color: row.color,
    description: row.description,
    embedInstruction: row.embed_instruction,
    queryHints: row.query_hints,
    template: row.template,
    tag: row.tag,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    noteCount,
  }
}

export function listCategories(): CategoryDTO[] {
  const rows = db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM notes n WHERE n.category_id = c.id) as note_count
       FROM categories c
       ORDER BY c.position ASC, c.name ASC`,
    )
    .all() as Array<CategoryRow & { note_count: number }>
  return rows.map((r) => toDTO(r, r.note_count))
}

export function getCategory(id: string): CategoryDTO | null {
  const row = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as CategoryRow | undefined
  if (!row) return null
  const count = db
    .prepare(`SELECT COUNT(*) as c FROM notes WHERE category_id = ?`)
    .get(id) as { c: number }
  return toDTO(row, count.c)
}

export function getCategoryRow(id: string): CategoryRow | null {
  return (db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as CategoryRow | undefined) || null
}

export async function createCategory(input: CategoryInput = {}): Promise<CategoryDTO> {
  const now = new Date().toISOString()
  const id = uuid()
  const name = (input.name || 'New category').trim() || 'New category'
  const tag = uniqueTag(
    name,
    listCategories().map((c) => c.tag),
    input.tag,
    reservedTags(),
  )
  const maxPos = db.prepare(`SELECT COALESCE(MAX(position), 0) as p FROM categories`).get() as { p: number }
  db.prepare(
    `INSERT INTO categories
      (id, name, slug, icon, color, description, embed_instruction, query_hints, template, tag, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    uniqueSlug(name),
    (input.icon || defaultIcon(name)).trim() || defaultIcon(name),
    input.color || CATEGORY_COLORS[maxPos.p % CATEGORY_COLORS.length],
    input.description || '',
    input.embedInstruction || defaultEmbedInstruction(name),
    input.queryHints || defaultQueryHints(name),
    input.template ?? `# {{title}}\n\n`,
    tag,
    input.position ?? maxPos.p + 1,
    now,
    now,
  )
  return getCategory(id)!
}

export async function updateCategory(id: string, input: CategoryInput): Promise<CategoryDTO | null> {
  const existing = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as CategoryRow | undefined
  if (!existing) return null

  const name = input.name !== undefined ? input.name.trim() || existing.name : existing.name
  const slug = name !== existing.name ? uniqueSlug(name, id) : existing.slug
  const embedInstruction =
    input.embedInstruction !== undefined ? input.embedInstruction : existing.embed_instruction
  const tag = uniqueTag(
    name,
    listCategories()
      .filter((c) => c.id !== id)
      .map((c) => c.tag),
    input.tag !== undefined ? input.tag : existing.tag,
    reservedTags(),
  )
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE categories SET
      name = ?, slug = ?, icon = ?, color = ?, description = ?,
      embed_instruction = ?, query_hints = ?, template = ?, tag = ?, position = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    name,
    slug,
    input.icon !== undefined ? input.icon.trim() || existing.icon : existing.icon,
    input.color ?? existing.color,
    input.description ?? existing.description,
    embedInstruction,
    input.queryHints ?? existing.query_hints,
    input.template ?? existing.template,
    tag,
    input.position ?? existing.position,
    now,
    id,
  )

  const instructionChanged =
    name !== existing.name ||
    slug !== existing.slug ||
    embedInstruction !== existing.embed_instruction
  if (instructionChanged) {
    const { reindexNote } = await import('./notes.js')
    const notes = db.prepare(`SELECT id FROM notes WHERE category_id = ?`).all(id) as Array<{ id: string }>
    for (const n of notes) await reindexNote(n.id)
  }

  return getCategory(id)
}

export async function deleteCategory(id: string): Promise<boolean> {
  const existing = db.prepare(`SELECT id FROM categories WHERE id = ?`).get(id) as { id: string } | undefined
  if (!existing) return false
  const { reindexNote } = await import('./notes.js')
  const notes = db.prepare(`SELECT id FROM notes WHERE category_id = ?`).all(id) as Array<{ id: string }>
  db.prepare(`UPDATE notes SET category_id = NULL WHERE category_id = ?`).run(id)
  db.prepare(`DELETE FROM categories WHERE id = ?`).run(id)
  for (const n of notes) await reindexNote(n.id)
  return true
}

export function applyTemplate(template: string, title: string): string {
  if (!template) return ''
  return template.replaceAll('{{title}}', title)
}

export function parseQueryHints(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1)
}

export function categoriesMatchingQuery(query: string, categories: CategoryDTO[]): CategoryDTO[] {
  const q = query.toLowerCase()
  return categories.filter((c) => {
    const hints = [c.name.toLowerCase(), c.slug.toLowerCase(), ...parseQueryHints(c.queryHints)]
    return hints.some((h) => {
      if (h.length <= 4) return new RegExp(`\\b${escapeReg(h)}\\b`).test(q)
      return q.includes(h)
    })
  })
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildEntityText(category: CategoryRow, title: string, content: string): string {
  const instruction =
    category.embed_instruction.trim() || defaultEmbedInstruction(category.name)
  const body = content.replace(/\s+/g, ' ').trim().slice(0, 4000)
  return [`[${category.slug}]`, instruction, `Name: ${title}`, body].filter(Boolean).join('\n')
}

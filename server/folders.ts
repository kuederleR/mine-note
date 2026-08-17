import { v4 as uuid } from 'uuid'
import { db } from './db.js'

export type FolderDTO = {
  id: string
  name: string
  color: string
  parentId: string | null
  position: number
  createdAt: string
  updatedAt: string
  noteCount: number
}

const FOLDER_COLORS = [
  '#0f3d38',
  '#c06a3a',
  '#2a8f80',
  '#d47848',
  '#8b6bb0',
  '#c4554d',
  '#9f6b53',
  '#3d6b73',
]

export function defaultFolderColor() {
  return FOLDER_COLORS[0]
}

function toDTO(row: {
  id: string
  name: string
  color: string
  parent_id: string | null
  position: number
  created_at: string
  updated_at: string
  note_count?: number
}): FolderDTO {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    parentId: row.parent_id,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    noteCount: row.note_count ?? 0,
  }
}

export function listFolders(): FolderDTO[] {
  const rows = db
    .prepare(
      `SELECT f.*,
        (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id) as note_count
       FROM folders f
       ORDER BY f.position ASC, f.name COLLATE NOCASE ASC`,
    )
    .all() as Array<{
    id: string
    name: string
    color: string
    parent_id: string | null
    position: number
    created_at: string
    updated_at: string
    note_count: number
  }>
  return rows.map(toDTO)
}

export function getFolder(id: string): FolderDTO | null {
  return listFolders().find((folder) => folder.id === id) || null
}

function nextPosition(parentId: string | null): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) as m FROM folders WHERE parent_id IS ?`,
    )
    .get(parentId) as { m: number }
  return row.m + 1
}

function wouldCreateCycle(folderId: string, newParentId: string | null): boolean {
  if (!newParentId) return false
  if (newParentId === folderId) return true
  let current: string | null = newParentId
  const seen = new Set<string>()
  while (current) {
    if (current === folderId) return true
    if (seen.has(current)) return true
    seen.add(current)
    const row = db.prepare(`SELECT parent_id FROM folders WHERE id = ?`).get(current) as
      | { parent_id: string | null }
      | undefined
    current = row?.parent_id ?? null
  }
  return false
}

export function createFolder(input: {
  name?: string
  color?: string
  parentId?: string | null
}): FolderDTO {
  const now = new Date().toISOString()
  const id = uuid()
  const name = (input.name || 'Untitled folder').trim() || 'Untitled folder'
  const color = (input.color || defaultFolderColor()).trim() || defaultFolderColor()
  const parentId = input.parentId || null
  if (parentId && !getFolder(parentId)) {
    throw new Error('Parent folder not found')
  }
  const position = nextPosition(parentId)
  db.prepare(
    `INSERT INTO folders (id, name, color, parent_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, color, parentId, position, now, now)
  return getFolder(id)!
}

export function updateFolder(
  id: string,
  input: {
    name?: string
    color?: string
    parentId?: string | null
    position?: number
  },
): FolderDTO | null {
  const existing = db.prepare(`SELECT * FROM folders WHERE id = ?`).get(id) as
    | {
        id: string
        name: string
        color: string
        parent_id: string | null
        position: number
      }
    | undefined
  if (!existing) return null

  const name =
    input.name !== undefined ? input.name.trim() || 'Untitled folder' : existing.name
  const color =
    input.color !== undefined
      ? input.color.trim() || defaultFolderColor()
      : existing.color
  let parentId =
    input.parentId !== undefined ? input.parentId || null : existing.parent_id
  if (parentId && !getFolder(parentId)) {
    throw new Error('Parent folder not found')
  }
  if (wouldCreateCycle(id, parentId)) {
    throw new Error('Cannot move a folder into itself')
  }

  let position = existing.position
  const parentChanged = parentId !== existing.parent_id
  if (typeof input.position === 'number') {
    position = input.position
  } else if (parentChanged) {
    position = nextPosition(parentId)
  }

  const now = new Date().toISOString()
  db.prepare(
    `UPDATE folders SET name = ?, color = ?, parent_id = ?, position = ?, updated_at = ? WHERE id = ?`,
  ).run(name, color, parentId, position, now, id)
  return getFolder(id)
}

export function deleteFolder(id: string): boolean {
  const existing = db.prepare(`SELECT id FROM folders WHERE id = ?`).get(id)
  if (!existing) return false
  const parent = db.prepare(`SELECT parent_id FROM folders WHERE id = ?`).get(id) as {
    parent_id: string | null
  }
  // Move notes up to parent (or root), then delete folder (children cascade).
  db.prepare(`UPDATE notes SET folder_id = ? WHERE folder_id = ?`).run(parent.parent_id, id)
  db.prepare(`UPDATE folders SET parent_id = ? WHERE parent_id = ?`).run(parent.parent_id, id)
  db.prepare(`DELETE FROM folders WHERE id = ?`).run(id)
  return true
}

export function reorderFolders(
  parentId: string | null,
  orderedIds: string[],
): FolderDTO[] {
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.prepare(
        `UPDATE folders SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?`,
      ).run(parentId, index, now, id)
    })
  })
  tx()
  return listFolders()
}

export { FOLDER_COLORS }

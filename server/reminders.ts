import { v4 as uuid } from 'uuid'
import { db } from './db.js'
import { getWorkspaceSettings } from './workspaceSettings.js'

export type ReminderColumn = {
  id: string
  label: string
  done?: boolean
}

export type ReminderDTO = {
  id: string
  noteId: string
  noteTitle: string
  title: string
  dueAt: string | null
  status: string
  position: number
  updatedAt: string
  objectId: string | null
  objectType: string | null
  objectNoteId: string | null
  objectLabel: string | null
}

const OPEN_RE = /^<!--\s*mine:reminder:([A-Za-z0-9_-]+)((?:\s+[A-Za-z][\w-]*=\S+)*)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/mine:reminder\s*-->\s*$/

function normalizeDueAt(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const value = String(raw).trim()
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/)
  if (match) return `${match[1]}T${match[2]}:${match[3]}`
  return value
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z][\w-]*)=(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) out[match[1]] = match[2]
  return out
}

function formatAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([key, value]) => ` ${key}=${String(value).trim()}`)
    .join('')
}

function consumeReminder(lines: string[], start: number): number {
  let i = start + 1
  while (i < lines.length && !CLOSE_RE.test(lines[i].trim()) && !OPEN_RE.test(lines[i].trim())) i += 1
  if (i < lines.length && CLOSE_RE.test(lines[i].trim())) i += 1
  return i
}

type ParsedReminder = {
  id: string
  title: string
  dueAt: string | null
  status: string
  position: number
  agentId: string | null
  objectId: string | null
  objectType: string | null
  objectNoteId: string | null
  objectLabel: string | null
  start: number
  end: number
}

function decodeAttr(value: string | undefined): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseReminders(content: string): ParsedReminder[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const out: ParsedReminder[] = []
  let i = 0
  while (i < lines.length) {
    const match = lines[i].trim().match(OPEN_RE)
    if (!match) {
      i += 1
      continue
    }
    const start = i
    const end = consumeReminder(lines, i)
    const attrs = parseAttrs(match[2] || '')
    const inner = lines.slice(start + 1, CLOSE_RE.test(lines[end - 1]?.trim() || '') ? end - 1 : end)
      .join('\n')
      .trim()
    const pos = Number(attrs.pos)
    out.push({
      id: match[1],
      title: inner,
      dueAt: normalizeDueAt(attrs.due),
      status: attrs.status || 'todo',
      position: Number.isFinite(pos) ? pos : out.length,
      agentId: attrs.agent || null,
      objectId: attrs.obj || null,
      objectType: attrs.objtype || null,
      objectNoteId: attrs.objnote || null,
      objectLabel: attrs.obj ? decodeAttr(attrs.objlabel) || null : null,
      start,
      end,
    })
    i = end
  }
  return out
}

function formatReminder(item: {
  id: string
  title: string
  dueAt: string | null
  status: string
  position: number
  agentId?: string | null
  objectId?: string | null
  objectType?: string | null
  objectNoteId?: string | null
  objectLabel?: string | null
}): string {
  const attrs: Record<string, string> = {
    status: item.status || 'todo',
    pos: String(item.position || 0),
  }
  if (item.dueAt) attrs.due = normalizeDueAt(item.dueAt) || item.dueAt
  if (item.agentId) attrs.agent = item.agentId
  if (item.objectId) {
    attrs.obj = item.objectId
    if (item.objectType) attrs.objtype = item.objectType
    if (item.objectNoteId) attrs.objnote = item.objectNoteId
    if (item.objectLabel) attrs.objlabel = encodeURIComponent(item.objectLabel)
  }
  const open = `<!-- mine:reminder:${item.id}${formatAttrs(attrs)} -->`
  if (!item.title.trim()) return `${open}\n<!-- /mine:reminder -->`
  return `${open}\n${item.title}\n<!-- /mine:reminder -->`
}

export function syncRemindersFromNote(noteId: string, content: string) {
  const now = new Date().toISOString()
  const parsed = parseReminders(content)
  const keep = parsed.map((item) => item.id)
  const existing = db.prepare(`SELECT id FROM reminders WHERE note_id = ?`).all(noteId) as Array<{ id: string }>
  const tx = db.transaction(() => {
    for (const row of existing) {
      if (!keep.includes(row.id)) db.prepare(`DELETE FROM reminders WHERE id = ?`).run(row.id)
    }
    const upsert = db.prepare(
      `INSERT INTO reminders (id, note_id, title, due_at, status, position, object_id, object_type, object_note_id, object_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         note_id = excluded.note_id,
         title = excluded.title,
         due_at = excluded.due_at,
         status = excluded.status,
         position = excluded.position,
         object_id = excluded.object_id,
         object_type = excluded.object_type,
         object_note_id = excluded.object_note_id,
         object_label = excluded.object_label,
         updated_at = excluded.updated_at`,
    )
    parsed.forEach((item, index) => {
      upsert.run(
        item.id,
        noteId,
        item.title,
        item.dueAt,
        item.status,
        item.position || index,
        item.objectId,
        item.objectType,
        item.objectNoteId,
        item.objectLabel,
        now,
        now,
      )
    })
  })
  tx()
}

export function rebuildReminders() {
  const notes = db.prepare(`SELECT id, content FROM notes`).all() as Array<{ id: string; content: string }>
  db.prepare(`DELETE FROM reminders`).run()
  for (const note of notes) syncRemindersFromNote(note.id, note.content)
}

export function listReminders(): ReminderDTO[] {
  return (
    db
      .prepare(
        `SELECT r.id, r.note_id, n.title as note_title, r.title, r.due_at, r.status, r.position, r.updated_at,
                r.object_id, r.object_type, r.object_note_id, r.object_label
         FROM reminders r
         JOIN notes n ON n.id = r.note_id
         ORDER BY r.status, r.position, r.due_at IS NULL, r.due_at, r.updated_at DESC`,
      )
      .all() as Array<{
      id: string
      note_id: string
      note_title: string
      title: string
      due_at: string | null
      status: string
      position: number
      updated_at: string
      object_id: string | null
      object_type: string | null
      object_note_id: string | null
      object_label: string | null
    }>
  ).map((row) => ({
    id: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title,
    title: row.title,
    dueAt: row.due_at,
    status: row.status,
    position: row.position,
    updatedAt: row.updated_at,
    objectId: row.object_id,
    objectType: row.object_type,
    objectNoteId: row.object_note_id,
    objectLabel: row.object_label,
  }))
}

export type DueWindow = 'today' | 'tomorrow' | 'week' | 'weekend' | 'overdue'

export type DueDates = {
  today: string
  tomorrow: string
  weekStart: string
  weekEnd: string
  weekendStart: string
  weekendEnd: string
}

/** Saturday–Sunday containing or next after `today` (YYYY-MM-DD). */
export function weekendBounds(today: string): { weekendStart: string; weekendEnd: string } {
  const match = today.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return { weekendStart: today, weekendEnd: today }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  const weekday = date.getDay() // 0 Sun … 6 Sat
  const toSaturday = weekday === 0 ? -1 : weekday === 6 ? 0 : 6 - weekday
  const saturday = new Date(year, month - 1, day + toSaturday)
  const sunday = new Date(saturday.getFullYear(), saturday.getMonth(), saturday.getDate() + 1)
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { weekendStart: iso(saturday), weekendEnd: iso(sunday) }
}

export function dueWindowFromQuery(query: string): DueWindow | null {
  const q = query.trim().toLowerCase().replace(/[?!.,]+$/g, '')
  if (!q) return null
  if (/\boverdue\b/.test(q)) return 'overdue'

  const when =
    /\b(today|tonight|this evening|tomorrow|this week|this weekend|saturday|sunday)\b/.test(q) ||
    /\bdue\b/.test(q) ||
    /\boverdue\b/.test(q)

  const asksDue =
    /\bwhat(?:'s|s| is)? due\b/.test(q) ||
    /\banything due\b/.test(q) ||
    /\bdue (today|tomorrow|tonight|this week|this weekend|this evening|saturday|sunday)\b/.test(q) ||
    /\breminders?(?:\s+(for|due))?\s+(today|tomorrow|tonight|this evening|this week|this weekend|saturday|sunday)\b/.test(
      q,
    ) ||
    /\b(tasks?|todos?) due\b/.test(q) ||
    // Natural task language: "what do I have to do tonight", "what I need to do this weekend"
    /\bwhat(?:\s+do\s+i|\s+have\s+i(?:\s+got)?|\s+i\s+need)\s+(?:have\s+)?(?:to\s+)?do\b/.test(q) ||
    /\bwhat\s+i\s+need\s+to\s+do\b/.test(q) ||
    /\banything\s+(?:to\s+do|on\s+my\s+plate)\b/.test(q) ||
    /\b(tasks?|todos?|reminders?)\s+(for\s+)?(today|tonight|this evening|tomorrow|this week|this weekend|saturday|sunday)\b/.test(
      q,
    ) ||
    /\b(do|plan|schedule)\s+(?:i\s+have\s+)?(tonight|today|this evening|tomorrow|this weekend)\b/.test(q) ||
    /\bneed\s+to\s+do\b/.test(q)

  if (!asksDue) return null
  // Require a time window (or explicit "due"/"overdue") so identity questions stay open search.
  if (!when && !/\bdue\b/.test(q)) return null
  if (/\btomorrow\b/.test(q)) return 'tomorrow'
  if (/\bthis weekend\b/.test(q) || /\b(saturday|sunday)\b/.test(q)) return 'weekend'
  if (/\bthis week\b/.test(q)) return 'week'
  return 'today'
}

export function reminderInDueWindow(dueAt: string | null, window: DueWindow, dates: DueDates): boolean {
  if (!dueAt) return false
  const day = dueAt.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  if (window === 'today') return day === dates.today
  if (window === 'tomorrow') return day === dates.tomorrow
  if (window === 'weekend') return day >= dates.weekendStart && day <= dates.weekendEnd
  if (window === 'week') return day >= dates.weekStart && day <= dates.weekEnd
  return day < dates.today
}

export function listDueReminders(window: DueWindow, dates: DueDates): ReminderDTO[] {
  const columns = getWorkspaceSettings().reminderColumns
  const done = new Set(columns.filter((col) => col.done).map((col) => col.id))
  return listReminders().filter(
    (item) => !done.has(item.status) && reminderInDueWindow(item.dueAt, window, dates),
  )
}

export function getReminder(id: string): ReminderDTO | null {
  return listReminders().find((item) => item.id === id) || null
}

export function updateReminder(
  id: string,
  patch: {
    title?: string
    dueAt?: string | null
    status?: string
    position?: number
    objectId?: string | null
    objectType?: string | null
    objectNoteId?: string | null
    objectLabel?: string | null
  },
): { reminder: ReminderDTO; noteId: string; content: string } | null {
  const row = db
    .prepare(
      `SELECT r.*, n.content, n.title as note_title FROM reminders r JOIN notes n ON n.id = r.note_id WHERE r.id = ?`,
    )
    .get(id) as
    | {
        id: string
        note_id: string
        title: string
        due_at: string | null
        status: string
        position: number
        content: string
        note_title: string
        created_at: string
      }
    | undefined
  if (!row) return null

  const parsed = parseReminders(row.content)
  const current = parsed.find((item) => item.id === id)
  if (!current) return null

  const columns = getWorkspaceSettings().reminderColumns
  const nextStatus =
    patch.status && columns.some((col) => col.id === patch.status) ? patch.status : current.status
  let nextPos = patch.position != null ? patch.position : current.position
  if (patch.status && patch.status !== current.status && patch.position == null) {
    const max = (
      db
        .prepare(`SELECT MAX(position) as m FROM reminders WHERE note_id != '' AND status = ?`)
        .get(nextStatus) as { m: number | null }
    ).m
    nextPos = (max ?? -1) + 1
  }

  const clearObject = patch.objectId === null
  const next = {
    id,
    title: patch.title !== undefined ? patch.title : current.title,
    dueAt: patch.dueAt !== undefined ? normalizeDueAt(patch.dueAt) : current.dueAt,
    status: nextStatus,
    position: nextPos,
    agentId: current.agentId,
    objectId: clearObject ? null : patch.objectId !== undefined ? patch.objectId : current.objectId,
    objectType: clearObject ? null : patch.objectType !== undefined ? patch.objectType : current.objectType,
    objectNoteId: clearObject ? null : patch.objectNoteId !== undefined ? patch.objectNoteId : current.objectNoteId,
    objectLabel: clearObject ? null : patch.objectLabel !== undefined ? patch.objectLabel : current.objectLabel,
  }

  const start = current.start
  const end = current.end
  const lines = row.content.replace(/\r\n/g, '\n').split('\n')
  const content = [...lines.slice(0, start), ...formatReminder(next).split('\n'), ...lines.slice(end)].join('\n')
  const now = new Date().toISOString()
  db.prepare(`UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`).run(content, now, row.note_id)
  db.prepare(
    `UPDATE reminders SET title = ?, due_at = ?, status = ?, position = ?, object_id = ?, object_type = ?, object_note_id = ?, object_label = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.title,
    next.dueAt,
    next.status,
    next.position,
    next.objectId,
    next.objectType,
    next.objectNoteId,
    next.objectLabel,
    now,
    id,
  )
  const reminder = getReminder(id)
  if (!reminder) return null
  return { reminder, noteId: row.note_id, content }
}

export function createReminderInNote(
  noteId: string,
  input: { title?: string; dueAt?: string | null; status?: string } = {},
): { reminder: ReminderDTO; content: string } | null {
  const note = db.prepare(`SELECT id, title, content FROM notes WHERE id = ?`).get(noteId) as
    | { id: string; title: string; content: string }
    | undefined
  if (!note) return null
  const columns = getWorkspaceSettings().reminderColumns
  const status = input.status && columns.some((col) => col.id === input.status) ? input.status : columns[0]?.id || 'todo'
  const max = (
    db.prepare(`SELECT MAX(position) as m FROM reminders WHERE status = ?`).get(status) as { m: number | null }
  ).m
  const id = `rm_${uuid().replace(/-/g, '').slice(0, 12)}`
  const block = formatReminder({
    id,
    title: (input.title || '').trim(),
    dueAt: normalizeDueAt(input.dueAt),
    status,
    position: (max ?? -1) + 1,
  })
  const content = note.content.replace(/\s+$/, '')
  const next = content ? `${content}\n\n${block}\n` : `${block}\n`
  const now = new Date().toISOString()
  db.prepare(`UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`).run(next, now, noteId)
  syncRemindersFromNote(noteId, next)
  const reminder = getReminder(id)
  if (!reminder) return null
  return { reminder, content: next }
}

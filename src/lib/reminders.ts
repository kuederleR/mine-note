import {
  consumeMineBlock,
  formatMineBlock,
  innerMineMarkdown,
  parseMineFence,
  parseMineOpen,
} from './mineObjects'
import {
  objectLinkFromAttrs,
  objectLinkToAttrs,
  type ObjectLink,
} from './objectLink'

export const DEFAULT_REMINDER_SHORTCUT = '!'

export type ReminderColumn = {
  id: string
  label: string
  done?: boolean
}

export const DEFAULT_REMINDER_COLUMNS: ReminderColumn[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done', done: true },
]

export type ReminderDraft = {
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
}

export function newReminderId(): string {
  return `rm_${Math.random().toString(36).slice(2, 10)}`
}

export function parseReminder(block: string): ReminderDraft | null {
  const fence = parseMineFence(block)
  if (!fence || fence.type !== 'reminder') return null
  const due = fence.attrs.due || ''
  const pos = Number(fence.attrs.pos)
  const object = objectLinkFromAttrs(fence.attrs)
  return {
    id: fence.id,
    title: innerMineMarkdown(block),
    dueAt: normalizeDueAt(due),
    status: fence.attrs.status || 'todo',
    position: Number.isFinite(pos) ? pos : 0,
    agentId: fence.agentId,
    objectId: object?.id || null,
    objectType: object?.type || null,
    objectNoteId: object?.noteId || null,
    objectLabel: object?.label || null,
  }
}

export function formatReminder(reminder: ReminderDraft): string {
  const attrs: Record<string, string> = {
    status: reminder.status || 'todo',
    pos: String(reminder.position || 0),
  }
  const due = normalizeDueAt(reminder.dueAt)
  if (due) attrs.due = due
  if (reminder.objectId) {
    Object.assign(
      attrs,
      objectLinkToAttrs({
        id: reminder.objectId,
        type: reminder.objectType || 'paragraph',
        noteId: reminder.objectNoteId || '',
        noteTitle: '',
        label: reminder.objectLabel || '',
      }),
    )
  }
  return formatMineBlock('reminder', reminder.id, reminder.title, reminder.agentId, attrs)
}

export function patchReminderBlock(block: string, patch: Partial<ReminderDraft>): string {
  const current = parseReminder(block)
  if (!current) return block
  const next: ReminderDraft = {
    ...current,
    ...patch,
    id: current.id,
    agentId: patch.agentId === undefined ? current.agentId : patch.agentId,
  }
  if (patch.objectId === null) {
    next.objectId = null
    next.objectType = null
    next.objectNoteId = null
    next.objectLabel = null
  }
  return formatReminder(next)
}

export function reminderObjectLink(reminder: {
  objectId?: string | null
  objectType?: string | null
  objectNoteId?: string | null
  objectLabel?: string | null
}): ObjectLink | null {
  if (!reminder.objectId) return null
  return {
    id: reminder.objectId,
    type: reminder.objectType || 'paragraph',
    noteId: reminder.objectNoteId || '',
    noteTitle: '',
    label: reminder.objectLabel || '',
  }
}

export function replaceReminderInContent(
  content: string,
  id: string,
  patch: Partial<ReminderDraft>,
): string | null {
  const text = content.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const open = parseMineOpen(lines[i] || '')
    if (open?.type === 'reminder' && open.id === id) {
      const end = consumeMineBlock(lines, i)
      const block = lines.slice(i, end).join('\n')
      const next = patchReminderBlock(block, patch)
      return [...lines.slice(0, i), ...next.split('\n'), ...lines.slice(end)].join('\n')
    }
    if (open) {
      i = consumeMineBlock(lines, i)
      continue
    }
    i += 1
  }
  return null
}

export function doneColumnId(columns: ReminderColumn[]): string {
  return columns.find((col) => col.done)?.id || columns[columns.length - 1]?.id || 'done'
}

export function firstColumnId(columns: ReminderColumn[]): string {
  return columns.find((col) => !col.done)?.id || columns[0]?.id || 'todo'
}

export function isDoneStatus(status: string, columns: ReminderColumn[]): boolean {
  const col = columns.find((item) => item.id === status)
  return Boolean(col?.done)
}

export function localDateISO(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Store as `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (local). */
export function normalizeDueAt(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const value = String(raw).trim()
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/)
  if (match) return `${match[1]}T${match[2]}:${match[3]}`
  return value
}

export function dueAtForInput(dueAt: string | null | undefined): string {
  const value = normalizeDueAt(dueAt)
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T09:00`
  return value.slice(0, 16)
}

export function dueDatePart(dueAt: string | null | undefined): string | null {
  const value = normalizeDueAt(dueAt)
  if (!value) return null
  return value.slice(0, 10)
}

export function parseDueDate(dueAt: string): Date | null {
  const value = normalizeDueAt(dueAt)
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    return new Date(y, m - 1, d, 23, 59, 59, 999)
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return null
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    0,
    0,
  )
}

export function formatDueDisplay(dueAt: string | null | undefined): string {
  const value = normalizeDueAt(dueAt)
  if (!value) return 'No date'
  const date = parseDueDate(value)
  if (!date) return value
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function reminderDueGroup(dueAt: string | null, done: boolean): string {
  if (done) return 'done'
  const day = dueDatePart(dueAt)
  if (!day) return 'none'
  const today = localDateISO()
  if (day < today) return 'overdue'
  if (day === today) return 'today'
  const t = new Date()
  t.setDate(t.getDate() + 1)
  if (day === localDateISO(t)) return 'tomorrow'
  return 'upcoming'
}

export function isDueOverdue(dueAt: string | null | undefined, done = false): boolean {
  if (done || !dueAt) return false
  const date = parseDueDate(dueAt)
  if (!date) return false
  return date.getTime() < Date.now()
}

export function isDueToday(dueAt: string | null | undefined): boolean {
  const day = dueDatePart(dueAt)
  return Boolean(day && day === localDateISO())
}

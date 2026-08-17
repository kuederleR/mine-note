import { getAppMeta, setAppMeta } from './db.js'

export const DEFAULT_AI_SHORTCUT = '>'
export const DEFAULT_REMINDER_SHORTCUT = '!'

export type ReminderColumn = {
  id: string
  label: string
  done?: boolean
}

export type ObjectPasteMode = 'link' | 'content' | 'embed'

export type ThemeMode = 'system' | 'light' | 'dark'

export const DEFAULT_OBJECT_PASTE_MODE: ObjectPasteMode = 'link'
export const DEFAULT_THEME_MODE: ThemeMode = 'system'

export const DEFAULT_REMINDER_COLUMNS: ReminderColumn[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done', done: true },
]

export type WorkspaceSettings = {
  aiShortcut: string
  reminderShortcut: string
  reservedShortcuts: string[]
  reminderColumns: ReminderColumn[]
  objectPasteMode: ObjectPasteMode
  theme: ThemeMode
}

function normalizeShortcut(raw: string): string {
  return raw.replace(/[:\[\]\s]/g, '').slice(0, 8)
}

function newColumnId(): string {
  return `col_${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeReminderColumns(raw: unknown): ReminderColumn[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_REMINDER_COLUMNS.map((col) => ({ ...col }))
  const used = new Set<string>()
  const columns: ReminderColumn[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const label = String(row.label || '').trim() || 'Column'
    let id = String(row.id || '')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 24)
    if (!id || used.has(id)) id = newColumnId()
    used.add(id)
    columns.push({ id, label, done: Boolean(row.done) })
  }
  if (!columns.length) return DEFAULT_REMINDER_COLUMNS.map((col) => ({ ...col }))
  if (!columns.some((col) => col.done)) columns[columns.length - 1].done = true
  return columns
}

function parsePasteMode(value: unknown, fallback: ObjectPasteMode = DEFAULT_OBJECT_PASTE_MODE): ObjectPasteMode {
  return value === 'link' || value === 'content' || value === 'embed' ? value : fallback
}

function parseThemeMode(value: unknown, fallback: ThemeMode = DEFAULT_THEME_MODE): ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark' ? value : fallback
}

export function parseSettings(raw: string | null): WorkspaceSettings {
  let aiShortcut = DEFAULT_AI_SHORTCUT
  let reminderShortcut = DEFAULT_REMINDER_SHORTCUT
  let extra: string[] = []
  let reminderColumns = DEFAULT_REMINDER_COLUMNS.map((col) => ({ ...col }))
  let objectPasteMode = DEFAULT_OBJECT_PASTE_MODE
  let theme = DEFAULT_THEME_MODE
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<WorkspaceSettings>
      const ai = normalizeShortcut(String(parsed.aiShortcut || ''))
      if (ai) aiShortcut = ai
      const rem = normalizeShortcut(String(parsed.reminderShortcut || ''))
      if (rem) reminderShortcut = rem
      if (Array.isArray(parsed.reservedShortcuts)) {
        extra = parsed.reservedShortcuts.map((item) => normalizeShortcut(String(item))).filter(Boolean)
      }
      reminderColumns = normalizeReminderColumns(parsed.reminderColumns)
      objectPasteMode = parsePasteMode(parsed.objectPasteMode)
      theme = parseThemeMode(parsed.theme)
    } catch {
      /* keep defaults */
    }
  }
  if (reminderShortcut.toLowerCase() === aiShortcut.toLowerCase()) reminderShortcut = DEFAULT_REMINDER_SHORTCUT
  if (reminderShortcut.toLowerCase() === aiShortcut.toLowerCase()) reminderShortcut = 'r'
  const reserved = [...new Set([aiShortcut, reminderShortcut, ...extra])]
  return {
    aiShortcut,
    reminderShortcut,
    reservedShortcuts: reserved,
    reminderColumns,
    objectPasteMode,
    theme,
  }
}

export function getWorkspaceSettings(): WorkspaceSettings {
  return parseSettings(getAppMeta('shortcuts'))
}

export function setWorkspaceSettings(input: Partial<WorkspaceSettings>): WorkspaceSettings {
  const current = getWorkspaceSettings()
  const aiShortcut = normalizeShortcut(input.aiShortcut ?? current.aiShortcut) || DEFAULT_AI_SHORTCUT
  let reminderShortcut =
    normalizeShortcut(input.reminderShortcut ?? current.reminderShortcut) || DEFAULT_REMINDER_SHORTCUT
  if (reminderShortcut.toLowerCase() === aiShortcut.toLowerCase()) reminderShortcut = DEFAULT_REMINDER_SHORTCUT
  if (reminderShortcut.toLowerCase() === aiShortcut.toLowerCase()) reminderShortcut = 'r'
  const extra = (input.reservedShortcuts ?? current.reservedShortcuts)
    .map((item) => normalizeShortcut(item))
    .filter((item) => item && item !== aiShortcut && item !== reminderShortcut)
  const reminderColumns = normalizeReminderColumns(input.reminderColumns ?? current.reminderColumns)
  const objectPasteMode = parsePasteMode(input.objectPasteMode ?? current.objectPasteMode)
  const theme = parseThemeMode(input.theme ?? current.theme)
  const next: WorkspaceSettings = {
    aiShortcut,
    reminderShortcut,
    reservedShortcuts: [...new Set([aiShortcut, reminderShortcut, ...extra])],
    reminderColumns,
    objectPasteMode,
    theme,
  }
  setAppMeta('shortcuts', JSON.stringify(next))
  return next
}

export function reservedShortcutSet(settings = getWorkspaceSettings()): Set<string> {
  return new Set(settings.reservedShortcuts.map((item) => item.toLowerCase()))
}

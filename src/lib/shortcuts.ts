import type { ObjectPasteMode, ReminderColumn, ThemeMode, WorkspaceSettings } from '../types'
import { DEFAULT_THEME_MODE } from './theme'

export const DEFAULT_AI_SHORTCUT = '>'
export const DEFAULT_REMINDER_SHORTCUT = '!'
export type { WorkspaceSettings, ThemeMode }

export const DEFAULT_OBJECT_PASTE_MODE: ObjectPasteMode = 'link'

export const DEFAULT_REMINDER_COLUMNS: ReminderColumn[] = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'Doing' },
  { id: 'done', label: 'Done', done: true },
]

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  aiShortcut: DEFAULT_AI_SHORTCUT,
  reminderShortcut: DEFAULT_REMINDER_SHORTCUT,
  reservedShortcuts: [DEFAULT_AI_SHORTCUT, DEFAULT_REMINDER_SHORTCUT],
  reminderColumns: DEFAULT_REMINDER_COLUMNS,
  objectPasteMode: DEFAULT_OBJECT_PASTE_MODE,
  theme: DEFAULT_THEME_MODE,
}

export function normalizeShortcut(raw: string): string {
  return raw.replace(/[:\[\]\s]/g, '').slice(0, 8)
}

export function allReserved(settings: WorkspaceSettings): string[] {
  return [
    ...new Set(
      [settings.aiShortcut, settings.reminderShortcut, ...settings.reservedShortcuts]
        .map(normalizeShortcut)
        .filter(Boolean),
    ),
  ]
}

export function isReservedShortcut(tag: string, settings: WorkspaceSettings): boolean {
  const needle = normalizeShortcut(tag).toLowerCase()
  return allReserved(settings).some((item) => item.toLowerCase() === needle)
}

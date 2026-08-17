import type { Category, WorkspaceSettings } from '../types'
import { DEFAULT_WORKSPACE_SETTINGS, normalizeShortcut } from './shortcuts'

export const TAG_LINK_RE = /:([^\s:\[\]]{1,8})\[([^\]]+)\]/g

export function normalizeTag(raw: string): string {
  return raw.replace(/[:\[\]\s]/g, '').slice(0, 8)
}

export function formatTagLink(tag: string, title: string): string {
  return `:${normalizeTag(tag)}[${title.trim()}]`
}

export function extractTagLinks(text: string): Array<{ tag: string; title: string }> {
  const out: Array<{ tag: string; title: string }> = []
  const re = new RegExp(TAG_LINK_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const tag = m[1].trim()
    const title = m[2].trim()
    if (tag && title) out.push({ tag, title })
  }
  return out
}

export type TagTrigger = {
  from: number
  to: number
  category: Category | null
  query: string
  categoryChoices: Category[]
  showAi: boolean
  aiMatch: boolean
  showReminder: boolean
  reminderMatch: boolean
}

function colonIndex(text: string, caret: number): number {
  const slice = text.slice(0, caret)
  const i = slice.lastIndexOf(':')
  if (i < 0) return -1
  if (i > 0 && !/[\s([{'">*_~]/.test(text[i - 1])) return -1
  if (text.slice(i + 1, caret).includes('\n')) return -1
  return i
}

export function findTagTrigger(
  text: string,
  caret: number,
  categories: Category[],
  settings: WorkspaceSettings = DEFAULT_WORKSPACE_SETTINGS,
): TagTrigger | null {
  const from = colonIndex(text, caret)
  if (from < 0) return null
  const rest = text.slice(from + 1, caret)
  if (/\[.*\]/.test(rest)) return null

  const ai = normalizeShortcut(settings.aiShortcut) || '>'
  const reminder = normalizeShortcut(settings.reminderShortcut) || '!'
  const tagged = categories.filter((c) => c.tag && c.tag !== ai && c.tag !== reminder)
  const bracket = rest.indexOf('[')
  const tagPart = bracket >= 0 ? rest.slice(0, bracket) : rest
  const typedQuery = bracket >= 0 ? rest.slice(bracket + 1) : null
  const aiMatch = typedQuery == null && tagPart === ai
  const reminderMatch = typedQuery == null && tagPart === reminder
  const aiPrefix = typedQuery == null && Boolean(tagPart) && ai.startsWith(tagPart)
  const reminderPrefix = typedQuery == null && Boolean(tagPart) && reminder.startsWith(tagPart)

  const empty = {
    from,
    to: caret,
    category: null as Category | null,
    query: '',
    categoryChoices: [] as Category[],
    showAi: false,
    aiMatch: false,
    showReminder: false,
    reminderMatch: false,
  }

  if (aiMatch) return { ...empty, showAi: true, aiMatch: true }
  if (reminderMatch) return { ...empty, showReminder: true, reminderMatch: true }

  if (!tagPart && typedQuery == null) {
    return { ...empty, categoryChoices: tagged, showAi: true, showReminder: true }
  }

  const sorted = [...tagged].sort((a, b) => b.tag.length - a.tag.length)
  const continuing = tagged.filter((c) => c.tag.startsWith(tagPart) && c.tag !== tagPart)
  const exact = tagged.find((c) => c.tag === tagPart)

  if (typedQuery != null) {
    if (!exact) {
      return continuing.length
        ? {
            ...empty,
            query: tagPart,
            categoryChoices: continuing,
          }
        : null
    }
    return {
      ...empty,
      category: exact,
      query: typedQuery,
    }
  }

  if (continuing.length) {
    const choices = exact ? [exact, ...continuing.filter((c) => c.id !== exact.id)] : continuing
    return {
      ...empty,
      query: tagPart,
      categoryChoices: choices,
      showAi: aiPrefix && !exact,
      showReminder: reminderPrefix && !exact,
    }
  }

  if (exact) {
    return { ...empty, category: exact }
  }

  const withQuery = sorted.find((c) => tagPart.startsWith(c.tag))
  if (withQuery) {
    return {
      ...empty,
      category: withQuery,
      query: tagPart.slice(withQuery.tag.length),
    }
  }

  const prefixes = tagged.filter((c) => c.tag.startsWith(tagPart))
  if (!prefixes.length && !aiPrefix && !reminderPrefix) return null
  return {
    ...empty,
    query: tagPart,
    categoryChoices: prefixes,
    showAi: aiPrefix,
    showReminder: reminderPrefix,
  }
}

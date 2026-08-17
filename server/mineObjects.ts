import { v4 as uuid } from 'uuid'
import { listCategories } from './categories.js'
import { buildCreateSystemPrompt, isCreatableMineType } from './objectSpecs.js'

export const MINE_OBJECT_TYPES = [
  'heading',
  'paragraph',
  'list',
  'numbered-list',
  'todo',
  'table',
  'callout',
  'quote',
  'toggle',
  'divider',
  'reminder',
] as const

export type MineObjectType = (typeof MINE_OBJECT_TYPES)[number]

export type MineDraftItem = {
  text: string
  checked?: boolean
  children?: MineDraft[]
}

export type MineDraft = {
  type: MineObjectType
  text?: string
  level?: number
  kind?: string
  title?: string
  headers?: string[]
  rows?: string[][]
  items?: Array<string | MineDraftItem>
  children?: MineDraft[]
  due?: string
  status?: string
}

/** @deprecated Prefer buildCreateSystemPrompt() — kept as alias for callers. */
export const MINE_OBJECT_CATALOG = buildCreateSystemPrompt()

function isType(value: string): value is MineObjectType {
  return (MINE_OBJECT_TYPES as readonly string[]).includes(value) && isCreatableMineType(value)
}

function asText(value: unknown): string {
  return String(value ?? '').trim()
}

function newId(): string {
  return `mo_${uuid().replace(/-/g, '').slice(0, 12)}`
}

function normalizeItem(raw: unknown): MineDraftItem | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { text } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const text = asText(row.text)
  if (!text) return null
  const children = Array.isArray(row.children) ? normalizeDrafts(row.children) : undefined
  const checked = typeof row.checked === 'boolean' ? row.checked : undefined
  return { text, checked, children }
}

export function normalizeDrafts(raw: unknown): MineDraft[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { objects?: unknown }).objects)
      ? (raw as { objects: unknown[] }).objects
      : []
  const out: MineDraft[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const type = String(row.type || '')
    if (!isType(type)) continue
    const draft: MineDraft = { type }
    if (type === 'heading') {
      draft.level = Math.min(4, Math.max(1, Number(row.level) || 2))
      draft.text = asText(row.text)
    } else if (type === 'table') {
      draft.headers = Array.isArray(row.headers) ? row.headers.map((cell) => asText(cell)) : []
      draft.rows = Array.isArray(row.rows)
        ? row.rows.map((line) => (Array.isArray(line) ? line.map((cell) => asText(cell)) : [asText(line)]))
        : []
    } else if (type === 'list' || type === 'numbered-list' || type === 'todo') {
      const items = Array.isArray(row.items) ? row.items.map(normalizeItem).filter(Boolean) : []
      draft.items = items as MineDraftItem[]
    } else if (type === 'callout') {
      const kind = String(row.kind || 'NOTE').toUpperCase().replace('WARNING', 'WARN')
      draft.kind = ['NOTE', 'TIP', 'WARN', 'IDEA', 'IMPORTANT'].includes(kind) ? kind : 'NOTE'
      draft.text = asText(row.text)
    } else if (type === 'toggle') {
      draft.title = asText(row.title) || 'Details'
      draft.children = Array.isArray(row.children) ? normalizeDrafts(row.children) : []
    } else if (type === 'reminder') {
      draft.text = asText(row.text)
      draft.due = asText(row.due)
      draft.status = asText(row.status) || 'todo'
    } else if (type === 'divider') {
      /* empty */
    } else {
      draft.text = asText(row.text)
    }
    out.push(draft)
  }
  return out
}

function fence(type: MineObjectType, inner: string, agentId: string): string {
  const id = newId()
  const open = `<!-- mine:${type}:${id} agent=${agentId} -->`
  const body = inner.trim()
  return body ? `${open}\n${body}\n<!-- /mine:${type} -->` : `${open}\n<!-- /mine:${type} -->`
}

function serializeItemPrefix(type: MineObjectType, item: MineDraftItem, index: number): string {
  if (type === 'todo') return `- [${item.checked ? 'x' : ' '}] ${item.text}`
  if (type === 'numbered-list') return `${index + 1}. ${item.text}`
  return `- ${item.text}`
}

function serializeDraft(draft: MineDraft, agentId: string): string {
  if (draft.type === 'reminder') {
    const id = newId().replace(/^mo_/, 'rm_')
    const dueRaw = (draft.due || '').trim().replace(' ', 'T')
    const dueMatch = dueRaw.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/)
    const due = dueMatch
      ? dueMatch[2]
        ? `${dueMatch[1]}T${dueMatch[2]}:${dueMatch[3]}`
        : dueMatch[1]
      : ''
    const status = (draft.status || 'todo').trim() || 'todo'
    const attrs = [`status=${status}`, 'pos=0', agentId ? `agent=${agentId}` : '']
      .concat(due ? [`due=${due}`] : [])
      .filter(Boolean)
      .join(' ')
    const open = `<!-- mine:reminder:${id} ${attrs} -->`
    const body = (draft.text || '').trim()
    return body ? `${open}\n${body}\n<!-- /mine:reminder -->` : `${open}\n<!-- /mine:reminder -->`
  }
  if (draft.type === 'heading') {
    const level = Math.min(4, Math.max(1, draft.level || 2))
    return fence('heading', `${'#'.repeat(level)} ${draft.text || ''}`.trim(), agentId)
  }
  if (draft.type === 'divider') return fence('divider', '---', agentId)
  if (draft.type === 'callout') {
    const kind = draft.kind || 'NOTE'
    const body = (draft.text || '')
      .split('\n')
      .map((line, i) => (i === 0 ? `> [!${kind}] ${line}` : `> ${line}`))
      .join('\n')
    return fence('callout', body, agentId)
  }
  if (draft.type === 'quote') {
    const body = (draft.text || '')
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    return fence('quote', body, agentId)
  }
  if (draft.type === 'toggle') {
    const kids = (draft.children || []).map((child) => serializeDraft(child, agentId)).join('\n\n')
    const body = [`:::toggle ${draft.title || 'Details'}`, kids, ':::'].filter(Boolean).join('\n')
    return fence('toggle', body, agentId)
  }
  if (draft.type === 'table') {
    const headers = draft.headers?.length ? draft.headers : ['']
    const rows = draft.rows?.length ? draft.rows : []
    const width = Math.max(headers.length, ...rows.map((row) => row.length), 1)
    const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] || '')
    const line = (row: string[]) => `| ${pad(row).join(' | ')} |`
    const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
    const table = [line(pad(headers)), sep, ...rows.map((row) => line(pad(row)))].join('\n')
    return fence('table', table, agentId)
  }
  if (draft.type === 'list' || draft.type === 'numbered-list' || draft.type === 'todo') {
    const items = (draft.items || []).map((item) =>
      typeof item === 'string' ? { text: item } : item,
    )
    const lines: string[] = []
    items.forEach((item, index) => {
      lines.push(serializeItemPrefix(draft.type, item, index))
      if (item.children?.length) {
        for (const child of item.children) {
          lines.push(serializeDraft(child, agentId))
        }
      }
    })
    return fence(draft.type, lines.join('\n'), agentId)
  }
  return fence('paragraph', draft.text || '', agentId)
}

export function serializeMineObjects(drafts: MineDraft[], agentId: string): string {
  return drafts.map((draft) => serializeDraft(draft, agentId)).join('\n\n')
}

export function connectionLinkHints(connections: Array<{ noteTitle: string; categoryName?: string | null }>): string {
  const categories = listCategories()
  if (!connections.length) return ''
  return connections
    .map((c) => {
      const tag = categories.find((cat) => cat.name === c.categoryName)?.tag
      const link = tag ? `:${tag}[${c.noteTitle}]` : `[[${c.noteTitle}]]`
      return `- ${c.noteTitle}${c.categoryName ? ` (${c.categoryName})` : ''} → ${link}`
    })
    .join('\n')
}

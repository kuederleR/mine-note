import {
  duplicateMineObject,
  formatEmbedBlock,
  formatMineBlock,
  innerMineMarkdown,
  isMineObjectType,
  parseMineFence,
  unwrapEmbed,
  type MineObjectType,
} from './mineObjects'

export const OBJECT_LINK_STORAGE = 'mine.objectLink'
export const OBJECT_CLIPBOARD_STORAGE = 'mine.objectClipboard'

export type ObjectPasteMode = 'link' | 'content' | 'embed'

export const OBJECT_PASTE_MODES: ObjectPasteMode[] = ['link', 'content', 'embed']

export function isObjectPasteMode(value: unknown): value is ObjectPasteMode {
  return value === 'link' || value === 'content' || value === 'embed'
}

export type ObjectLink = {
  id: string
  type: string
  noteId: string
  noteTitle: string
  label: string
}

const CHIP_RE = /::obj\[([A-Za-z0-9_-]+)\|([a-z0-9-]*)\|([A-Za-z0-9_-]*)\|([^\]]*)\]/g

export function newObjectId(): string {
  return `obj_${Math.random().toString(36).slice(2, 10)}`
}

export function kindToMineType(kind: string): MineObjectType {
  if (kind === 'ul') return 'list'
  if (kind === 'ol') return 'numbered-list'
  if (kind === 'todo') return 'todo'
  if (kind === 'table') return 'table'
  if (kind === 'quote') return 'quote'
  if (kind === 'callout') return 'callout'
  if (kind === 'toggle') return 'toggle'
  if (kind === 'hr') return 'divider'
  if (kind === 'h1' || kind === 'h2' || kind === 'h3' || kind === 'h4') return 'heading'
  if (kind === 'reminder') return 'reminder'
  return 'paragraph'
}

export function objectLabelFromMarkdown(markdown: string): string {
  const inner = parseMineFence(markdown) ? innerMineMarkdown(markdown) : markdown
  const line =
    inner
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item && !item.startsWith('<!--') && !item.startsWith('|') && !item.startsWith('::obj[')) || ''
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/::obj\[[^\]]+\]/g, '')
    .replace(/[|[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
}

export function ensureMineObject(
  markdown: string,
  kind: string,
): { markdown: string; id: string; type: MineObjectType } {
  const fence = parseMineFence(markdown)
  if (fence) return { markdown, id: fence.id, type: fence.type }
  const type = kindToMineType(kind)
  const id = newObjectId()
  return { markdown: formatMineBlock(type, id, markdown), id, type }
}

export function serializeObjectChip(link: ObjectLink): string {
  const label = (link.label || '').replace(/]/g, '')
  return `::obj[${link.id}|${link.type || 'paragraph'}|${link.noteId}|${label}]`
}

export function parseObjectChip(raw: string): ObjectLink | null {
  const match = raw.trim().match(/^::obj\[([A-Za-z0-9_-]+)\|([a-z0-9-]*)\|([A-Za-z0-9_-]*)\|([^\]]*)\]$/)
  if (!match) return null
  return {
    id: match[1],
    type: match[2] || 'paragraph',
    noteId: match[3] || '',
    noteTitle: '',
    label: match[4] || '',
  }
}

export function parseObjectLinks(md: string): ObjectLink[] {
  const out: ObjectLink[] = []
  const re = new RegExp(CHIP_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(md))) {
    out.push({
      id: match[1],
      type: match[2] || 'paragraph',
      noteId: match[3] || '',
      noteTitle: '',
      label: match[4] || '',
    })
  }
  return out
}

export function insertObjectChip(text: string, caret: number | null, link: ObjectLink): string {
  const chip = serializeObjectChip(link)
  if (caret == null || caret < 0 || caret > text.length) {
    const trimmed = text.replace(/\s+$/, '')
    return trimmed ? `${trimmed} ${chip}` : chip
  }
  const before = text.slice(0, caret)
  const after = text.slice(caret)
  const left = before.length && !/\s$/.test(before) ? ' ' : ''
  const right = after.length && !/^\s/.test(after) ? ' ' : ''
  return `${before}${left}${chip}${right}${after}`
}

export function peekObjectLink(): ObjectLink | null {
  return peekObjectClipboard()?.link || null
}

export function writeObjectLink(link: ObjectLink) {
  writeObjectClipboard({ link, markdown: '' }, 'link')
}

export async function readObjectLink(): Promise<ObjectLink | null> {
  const clip = await readObjectClipboard()
  return clip?.link || null
}

export type ObjectClipboard = {
  link: ObjectLink
  markdown: string
}

function decodeAttrLabel(raw: string): string {
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export function canonicalObjectFromBlock(
  block: string,
  kind: string,
  noteId: string,
  noteTitle: string,
): ObjectClipboard {
  const ensured = ensureMineObject(block, kind)
  const source = unwrapEmbed(ensured.markdown)
  const fence = parseMineFence(source)
  const embed = parseMineFence(ensured.markdown)
  const note = embed?.type === 'embed' && embed.attrs.note ? embed.attrs.note : noteId
  const label =
    (embed?.type === 'embed' ? decodeAttrLabel(embed.attrs.label || '') : '') ||
    objectLabelFromMarkdown(source)
  return {
    markdown: source,
    link: {
      id: fence?.id || newObjectId(),
      type: fence?.type || kindToMineType(kind),
      noteId: note,
      noteTitle,
      label,
    },
  }
}

export function writeObjectClipboard(clip: ObjectClipboard, pasteAs: 'link' | 'content' = 'link') {
  try {
    sessionStorage.setItem(OBJECT_CLIPBOARD_STORAGE, JSON.stringify(clip))
    sessionStorage.setItem(OBJECT_LINK_STORAGE, JSON.stringify(clip.link))
  } catch {
    /* ignore */
  }
  const text =
    pasteAs === 'link' ? serializeObjectChip(clip.link) : innerMineMarkdown(clip.markdown) || clip.markdown
  void navigator.clipboard?.writeText(text).catch(() => {})
}

export function peekObjectClipboard(): ObjectClipboard | null {
  try {
    const stored = sessionStorage.getItem(OBJECT_CLIPBOARD_STORAGE)
    if (stored) {
      const parsed = JSON.parse(stored) as ObjectClipboard
      if (parsed?.link?.id) return parsed
    }
    const legacy = sessionStorage.getItem(OBJECT_LINK_STORAGE)
    if (!legacy) return null
    const link = JSON.parse(legacy) as ObjectLink
    return link?.id ? { link, markdown: '' } : null
  } catch {
    return null
  }
}

export async function readObjectClipboard(): Promise<ObjectClipboard | null> {
  const stored = peekObjectClipboard()
  if (stored) return stored
  try {
    const text = (await navigator.clipboard.readText()).trim()
    const chip = parseObjectChip(text) || parseObjectLinks(text)[0]
    return chip ? { link: chip, markdown: '' } : null
  } catch {
    return null
  }
}

export function clipboardMatchesObject(text: string, clip: ObjectClipboard | null): boolean {
  if (!clip) return Boolean(parseObjectChip(text.trim()))
  const value = text.trim()
  if (!value) return true
  if (parseObjectChip(value)?.id === clip.link.id) return true
  if (value === serializeObjectChip(clip.link)) return true
  if (value === clip.markdown.trim()) return true
  const inner = innerMineMarkdown(clip.markdown).trim()
  return Boolean(inner) && value === inner
}

export function pasteObjectMarkdown(clip: ObjectClipboard, mode: ObjectPasteMode): string {
  if (mode === 'link') return serializeObjectChip(clip.link)
  const type =
    isMineObjectType(clip.link.type) && clip.link.type !== 'embed' ? clip.link.type : 'paragraph'
  const source =
    clip.markdown.trim() || formatMineBlock(type, clip.link.id, clip.link.label || '')
  if (mode === 'embed') return formatEmbedBlock(source, clip.link.noteId, clip.link.label)
  return duplicateMineObject(source)
}

export function objectLinkToAttrs(link: ObjectLink): Record<string, string> {
  const attrs: Record<string, string> = {
    obj: link.id,
    objtype: link.type || 'paragraph',
  }
  if (link.noteId) attrs.objnote = link.noteId
  if (link.label) attrs.objlabel = encodeURIComponent(link.label)
  return attrs
}

export function objectLinkFromAttrs(attrs: Record<string, string>): ObjectLink | null {
  const id = attrs.obj
  if (!id) return null
  let label = attrs.objlabel || ''
  try {
    label = decodeURIComponent(label)
  } catch {
    /* keep raw */
  }
  return {
    id,
    type: attrs.objtype || 'paragraph',
    noteId: attrs.objnote || '',
    noteTitle: '',
    label,
  }
}

export function sameObjectLink(a: ObjectLink, b: ObjectLink): boolean {
  return a.id === b.id && a.noteId === b.noteId
}

export function renderObjectChips(src: string): string {
  CHIP_RE.lastIndex = 0
  return src.replace(CHIP_RE, (_m, id: string, type: string, noteId: string, label: string) => {
    const title = escapeHtml(label || type || 'Object')
    const kind = escapeHtml(type || 'paragraph')
    const note = escapeHtml(noteId || '')
    const obj = escapeHtml(id)
    return `<button type="button" class="obj-chip" data-obj="${obj}" data-obj-type="${kind}" data-obj-note="${note}" title="${title}"><span class="obj-chip-icon" data-obj-type="${kind}"></span>${label ? `<span class="obj-chip-label">${title}</span>` : ''}</button>`
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}


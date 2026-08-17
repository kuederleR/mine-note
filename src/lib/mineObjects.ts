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
  'embed',
] as const

export type MineObjectType = (typeof MINE_OBJECT_TYPES)[number]

export type MineFence = {
  type: MineObjectType
  id: string
  agentId: string | null
  attrs: Record<string, string>
}

const OPEN_RE = /^<!--\s*mine:([a-z0-9-]+):([A-Za-z0-9_-]+)((?:\s+[A-Za-z][\w-]*=\S+)*)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/mine:([a-z0-9-]+)\s*-->\s*$/

export function isMineObjectType(value: string): value is MineObjectType {
  return (MINE_OBJECT_TYPES as readonly string[]).includes(value)
}

export function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z][\w-]*)=(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) out[match[1]] = match[2]
  return out
}

export function formatAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([key, value]) => ` ${key}=${String(value).trim()}`)
    .join('')
}

export function parseMineOpen(line: string): MineFence | null {
  const match = line.trim().match(OPEN_RE)
  if (!match || !isMineObjectType(match[1])) return null
  const attrs = parseAttrs(match[3] || '')
  return { type: match[1], id: match[2], agentId: attrs.agent || null, attrs }
}

export function parseMineClose(line: string): { type: string } | null {
  const match = line.trim().match(CLOSE_RE)
  if (!match) return null
  return { type: match[1] }
}

export function consumeMineBlock(lines: string[], start: number): number {
  const open = parseMineOpen(lines[start] || '')
  if (!open) return start + 1
  const stack = [open.type]
  let i = start + 1
  while (i < lines.length && stack.length) {
    const nextOpen = parseMineOpen(lines[i])
    const nextClose = parseMineClose(lines[i])
    if (nextOpen) stack.push(nextOpen.type)
    else if (nextClose && stack[stack.length - 1] === nextClose.type) stack.pop()
    i += 1
  }
  return i
}

export function innerMineMarkdown(block: string): string {
  const lines = block.replace(/\r\n/g, '\n').split('\n')
  if (!parseMineOpen(lines[0] || '')) return block
  if (parseMineClose(lines[lines.length - 1] || '')) {
    return lines.slice(1, -1).join('\n').replace(/^\n+|\n+$/g, '')
  }
  return lines.slice(1).join('\n').replace(/^\n+|\n+$/g, '')
}

export function formatMineBlock(
  type: MineObjectType,
  id: string,
  inner: string,
  agentId?: string | null,
  attrs: Record<string, string> = {},
): string {
  const next = { ...attrs }
  if (agentId) next.agent = agentId
  else delete next.agent
  const open = `<!-- mine:${type}:${id}${formatAttrs(next)} -->`
  // Preserve internal/trailing spaces (needed while typing titles); only treat
  // all-whitespace as empty so we don't emit a blank body line.
  if (!inner.trim()) return `${open}\n<!-- /mine:${type} -->`
  return `${open}\n${inner}\n<!-- /mine:${type} -->`
}

export function parseBlockAgentId(block: string): string | null {
  const agent = block.match(/<!--\s*mine-agent:([A-Za-z0-9_-]+)\s*-->/)
  if (agent) return agent[1]
  const first = block.replace(/\r\n/g, '\n').split('\n')[0] || ''
  return parseMineOpen(first)?.agentId || null
}

export function parseMineFence(block: string): MineFence | null {
  const first = block.replace(/\r\n/g, '\n').split('\n')[0] || ''
  return parseMineOpen(first)
}

export function mineTypeToBlockKind(
  type: MineObjectType,
): 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'ul' | 'ol' | 'todo' | 'table' | 'callout' | 'quote' | 'toggle' | 'hr' | 'reminder' {
  if (type === 'list') return 'ul'
  if (type === 'numbered-list') return 'ol'
  if (type === 'todo') return 'todo'
  if (type === 'table') return 'table'
  if (type === 'callout') return 'callout'
  if (type === 'quote') return 'quote'
  if (type === 'toggle') return 'toggle'
  if (type === 'divider') return 'hr'
  if (type === 'heading') return 'h2'
  if (type === 'reminder') return 'reminder'
  if (type === 'embed') return 'p'
  return 'p'
}

export function stripMineComments(src: string): string {
  return src
    .replace(/<!--\s*mine-agent:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine-agent\s*-->/gi, '')
    .replace(/<!--\s*mine-row:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine-row\s*-->/gi, '')
    .replace(/<!--\s*mine-col:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine-col\s*-->/gi, '')
    .replace(/<!--\s*mine:[a-z0-9-]+:[A-Za-z0-9_-]+(?:\s+[A-Za-z][\w-]*=\S+)*\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine:[a-z0-9-]+\s*-->/gi, '')
}

export function replaceAgentRegion(content: string, agentId: string, nextMarkdown: string): string {
  const text = content.replace(/\r\n/g, '\n')
  const wrapped = new RegExp(
    `<!--\\s*mine-agent:${agentId}\\s*-->[\\s\\S]*?<!--\\s*/mine-agent\\s*-->`,
    'i',
  )
  if (wrapped.test(text)) return text.replace(wrapped, nextMarkdown.trim())

  const lines = text.split('\n')
  let start = -1
  let end = -1
  let i = 0
  while (i < lines.length) {
    const open = parseMineOpen(lines[i])
    if (open) {
      const blockEnd = consumeMineBlock(lines, i)
      if (open.agentId === agentId) {
        if (start < 0) start = i
        end = blockEnd
      } else if (start >= 0) {
        break
      }
      i = blockEnd
      continue
    }
    if (start >= 0 && lines[i].trim() !== '') break
    i += 1
  }
  if (start < 0) {
    const trimmed = text.replace(/\s+$/, '')
    return trimmed ? `${trimmed}\n\n${nextMarkdown.trim()}\n` : `${nextMarkdown.trim()}\n`
  }
  const before = lines.slice(0, start).join('\n').replace(/\s+$/, '')
  const after = lines.slice(end).join('\n').replace(/^\s+/, '')
  return [before, nextMarkdown.trim(), after].filter((part, index, all) => part || (index > 0 && index < all.length - 1)).join('\n\n')
}

export function newMineId(prefix = 'obj'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export type FoundMineObject = {
  fence: MineFence
  block: string
  inner: string
  startLine: number
  endLine: number
}

function walkMineBlocks(content: string, visit: (found: FoundMineObject) => boolean | void) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const walkRange = (from: number, to: number): boolean => {
    let i = from
    while (i < to) {
      const open = parseMineOpen(lines[i] || '')
      if (open) {
        const end = consumeMineBlock(lines, i)
        const stop = visit({
          fence: open,
          block: lines.slice(i, end).join('\n'),
          inner: innerMineMarkdown(lines.slice(i, end).join('\n')),
          startLine: i,
          endLine: end,
        })
        if (stop) return true
        if (open.type !== 'embed') {
          const closeAt = parseMineClose(lines[end - 1] || '') ? end - 1 : end
          if (walkRange(i + 1, closeAt)) return true
        }
        i = end
        continue
      }
      i += 1
    }
    return false
  }
  walkRange(0, lines.length)
}

export function findCanonicalMineObject(content: string, id: string): FoundMineObject | null {
  let found: FoundMineObject | null = null
  walkMineBlocks(content, (item) => {
    if (item.fence.id === id && item.fence.type !== 'embed') {
      found = item
      return true
    }
  })
  return found
}

export function replaceMineObjectInner(content: string, id: string, inner: string): string | null {
  const found = findCanonicalMineObject(content, id)
  if (!found) return null
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const next = formatMineBlock(found.fence.type, found.fence.id, inner, found.fence.agentId, found.fence.attrs)
  return [...lines.slice(0, found.startLine), ...next.split('\n'), ...lines.slice(found.endLine)].join('\n')
}

export function unwrapEmbed(block: string): string {
  const fence = parseMineFence(block)
  if (!fence || fence.type !== 'embed') return block
  const inner = innerMineMarkdown(block)
  const nested = parseMineFence(inner)
  if (nested && nested.type !== 'embed') return inner
  const type =
    fence.attrs.type && isMineObjectType(fence.attrs.type) && fence.attrs.type !== 'embed'
      ? fence.attrs.type
      : 'paragraph'
  const id = fence.attrs.src || fence.id
  return formatMineBlock(type, id, inner)
}

export function duplicateMineObject(markdown: string): string {
  const source = unwrapEmbed(markdown)
  const fence = parseMineFence(source)
  if (!fence || fence.type === 'embed') {
    return formatMineBlock('paragraph', newMineId(), source)
  }
  const attrs = { ...fence.attrs }
  delete attrs.agent
  const prefix = fence.type === 'reminder' ? 'rm' : 'obj'
  return formatMineBlock(fence.type, newMineId(prefix), innerMineMarkdown(source), null, attrs)
}

export function formatEmbedBlock(sourceMarkdown: string, noteId: string, label = ''): string {
  const source = unwrapEmbed(sourceMarkdown)
  const fence = parseMineFence(source)
  const type = fence && fence.type !== 'embed' ? fence.type : 'paragraph'
  const src = fence?.id || newMineId()
  const attrs: Record<string, string> = { src, type }
  if (noteId) attrs.note = noteId
  const trimmed = label.trim()
  if (trimmed) attrs.label = encodeURIComponent(trimmed)
  return formatMineBlock('embed', newMineId('emb'), source, null, attrs)
}

export function refreshEmbedSnapshots(content: string, srcId: string, sourceMarkdown: string): string {
  const source = unwrapEmbed(sourceMarkdown)
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const open = parseMineOpen(lines[i] || '')
    if (open) {
      const end = consumeMineBlock(lines, i)
      if (open.type === 'embed' && open.attrs.src === srcId) {
        const block = formatMineBlock(open.type, open.id, source, open.agentId, open.attrs)
        out.push(...block.split('\n'))
      } else {
        out.push(...lines.slice(i, end))
      }
      i = end
      continue
    }
    out.push(lines[i])
    i += 1
  }
  return out.join('\n')
}

export function collectAgentIds(content: string): Set<string> {
  const ids = new Set<string>()
  const agent = /<!--\s*mine-agent:([A-Za-z0-9_-]+)\s*-->/g
  const owned = /agent=([A-Za-z0-9_-]+)/g
  let match: RegExpExecArray | null
  while ((match = agent.exec(content))) ids.add(match[1])
  while ((match = owned.exec(content))) ids.add(match[1])
  return ids
}

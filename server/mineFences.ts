const OPEN_RE = /^<!--\s*mine:([a-z0-9-]+):([A-Za-z0-9_-]+)((?:\s+[A-Za-z][\w-]*=\S+)*)\s*-->\s*$/
const CLOSE_RE = /^<!--\s*\/mine:([a-z0-9-]+)\s*-->\s*$/

export type MineFence = {
  type: string
  id: string
  agentId: string | null
  attrs: Record<string, string>
}

export type FoundMineObject = {
  fence: MineFence
  block: string
  inner: string
  startLine: number
  endLine: number
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

export function parseMineOpen(line: string): MineFence | null {
  const match = line.trim().match(OPEN_RE)
  if (!match) return null
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
  type: string,
  id: string,
  inner: string,
  agentId: string | null,
  attrs: Record<string, string>,
): string {
  const next = { ...attrs }
  if (agentId) next.agent = agentId
  else delete next.agent
  const open = `<!-- mine:${type}:${id}${formatAttrs(next)} -->`
  if (!inner.trim()) return `${open}\n<!-- /mine:${type} -->`
  return `${open}\n${inner}\n<!-- /mine:${type} -->`
}

function walkMineBlocks(content: string, visit: (found: FoundMineObject) => boolean | void) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const walkRange = (from: number, to: number): boolean => {
    let i = from
    while (i < to) {
      const open = parseMineOpen(lines[i] || '')
      if (open) {
        const end = consumeMineBlock(lines, i)
        const block = lines.slice(i, end).join('\n')
        const stop = visit({
          fence: open,
          block,
          inner: innerMineMarkdown(block),
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

export function collectCanonicalMineObjects(content: string): Map<string, FoundMineObject> {
  const out = new Map<string, FoundMineObject>()
  walkMineBlocks(content, (item) => {
    if (item.fence.type !== 'embed') out.set(item.fence.id, item)
  })
  return out
}

export function replaceMineObjectInner(content: string, id: string, inner: string): string | null {
  const found = findCanonicalMineObject(content, id)
  if (!found) return null
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const next = formatMineBlock(found.fence.type, found.fence.id, inner, found.fence.agentId, found.fence.attrs)
  return [...lines.slice(0, found.startLine), ...next.split('\n'), ...lines.slice(found.endLine)].join('\n')
}

export function unwrapEmbed(block: string): string {
  const fence = parseMineOpen((block.replace(/\r\n/g, '\n').split('\n')[0] || '').trim())
  if (!fence || fence.type !== 'embed') return block
  const inner = innerMineMarkdown(block)
  const nested = parseMineOpen((inner.split('\n')[0] || '').trim())
  if (nested && nested.type !== 'embed') return inner
  const type = fence.attrs.type && fence.attrs.type !== 'embed' ? fence.attrs.type : 'paragraph'
  const id = fence.attrs.src || fence.id
  return formatMineBlock(type, id, inner, null, {})
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

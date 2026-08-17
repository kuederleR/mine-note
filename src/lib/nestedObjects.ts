import {
  serializeMdTable,
  DEFAULT_TABLE,
  parseMdTable,
  setTableCell,
  getTableCell,
  type MdTable,
} from './mdTable'
import {
  consumeMineBlock,
  formatMineBlock,
  innerMineMarkdown,
  newMineId,
  parseMineFence,
  parseMineOpen,
  unwrapEmbed,
  type MineObjectType,
} from './mineObjects'

export const MAX_OBJECT_NEST_DEPTH = 6

export function defaultObjectInner(type: MineObjectType, existing = ''): string {
  const text = existing.trim()
  if (type === 'list') return text ? `- ${text}` : '- '
  if (type === 'numbered-list') return text ? `1. ${text}` : '1. '
  if (type === 'todo') return text ? `- [ ] ${text}` : '- [ ] '
  if (type === 'table') {
    const table = {
      ...DEFAULT_TABLE,
      rows: [
        [text, '', ''],
        ['', '', ''],
      ],
    }
    return serializeMdTable(table)
  }
  if (type === 'quote') return text ? `> ${text}` : '> '
  if (type === 'callout') return text ? `> [!NOTE] ${text}` : '> [!NOTE] '
  if (type === 'toggle') return `:::toggle \n${text}\n:::`
  if (type === 'heading') return text ? `## ${text}` : '## '
  if (type === 'reminder') return text || ''
  if (type === 'divider') return '---'
  return text
}

export function nestedObjectForInsert(type: MineObjectType, existing = ''): string {
  return formatMineBlock(type, newMineId(), defaultObjectInner(type, existing))
}

export function appendNestedObject(inner: string, child: string): string {
  const trimmed = inner.replace(/\s+$/, '')
  return trimmed ? `${trimmed}\n\n${child}` : child
}

export function innerHasNestedFence(inner: string): boolean {
  return inner.replace(/\r\n/g, '\n').split('\n').some((line) => Boolean(parseMineOpen(line)))
}

export function isCompleteMineFence(markdown: string): boolean {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  if (!text) return false
  const lines = text.split('\n')
  if (!parseMineOpen(lines[0] || '')) return false
  return consumeMineBlock(lines, 0) >= lines.length
}

export function cellHasNestedObject(cell: string): boolean {
  return isCompleteMineFence(cell) || innerHasNestedFence(cell)
}

function wrapFence(markdown: string, inner: string): string {
  const fence = parseMineFence(markdown)
  if (!fence) return inner
  return formatMineBlock(fence.type, fence.id, inner, fence.agentId, fence.attrs)
}

export function insertNestedIntoMarkdown(markdown: string, type: MineObjectType): string {
  const child = nestedObjectForInsert(type)
  if (!isCompleteMineFence(markdown)) {
    const host = markdown.trim()
    return host ? `${host}\n\n${child}` : child
  }
  const fence = parseMineFence(markdown)
  if (!fence || fence.type === 'embed') {
    const host = markdown.trim()
    return host ? `${host}\n\n${child}` : child
  }
  if (fence.type === 'table') {
    const table = parseMdTable(innerMineMarkdown(markdown))
    if (table) {
      const next = setTableCell(table, 0, 0, insertNestedIntoCell(getTableCell(table, 0, 0), type))
      return wrapFence(markdown, serializeMdTable(next))
    }
  }
  return wrapFence(markdown, appendNestedObject(innerMineMarkdown(markdown), child))
}

export function insertNestedIntoCell(cell: string, type: MineObjectType): string {
  if (isCompleteMineFence(cell) && parseMineFence(cell)?.type !== 'embed') {
    return insertNestedIntoMarkdown(cell, type)
  }
  return nestedObjectForInsert(type, cell)
}

export function pasteIntoMarkdown(markdown: string, pasted: string): string {
  if (!isCompleteMineFence(markdown)) return appendNestedObject(markdown, pasted)
  const fence = parseMineFence(markdown)
  if (!fence || fence.type === 'embed') return appendNestedObject(markdown, pasted)
  if (fence.type === 'table') {
    const table = parseMdTable(innerMineMarkdown(markdown))
    if (table) {
      const next = setTableCell(table, 0, 0, pasteIntoCell(getTableCell(table, 0, 0), pasted))
      return wrapFence(markdown, serializeMdTable(next))
    }
  }
  return wrapFence(markdown, appendNestedObject(innerMineMarkdown(markdown), pasted))
}

export function pasteIntoCell(cell: string, pasted: string): string {
  if (isCompleteMineFence(cell) && parseMineFence(cell)?.type !== 'embed') {
    return pasteIntoMarkdown(cell, pasted)
  }
  if (!cell.trim()) return pasted
  // Pasting a complete object into plain cell text should become that object
  // (otherwise the cell shows raw fence markdown in the empty-slot editor).
  if (isCompleteMineFence(pasted) && !isCompleteMineFence(cell)) return pasted
  return appendNestedObject(cell, pasted)
}

export function unwrapNestedMarkdown(markdown: string): string {
  const fence = parseMineFence(markdown)
  if (!fence) return markdown
  return innerMineMarkdown(markdown)
}

export function moveInnerSegment(inner: string, from: number, to: number): string {
  const segments = splitInnerSegments(inner)
  if (from < 0 || from >= segments.length) return inner
  const target = Math.max(0, Math.min(to, segments.length))
  if (target === from || target === from + 1) return inner
  const next = [...segments]
  const [item] = next.splice(from, 1)
  const insertAt = target > from ? target - 1 : target
  next.splice(insertAt, 0, item)
  return next.join('\n\n')
}

export function clearMarkdownFromTable(table: MdTable, markdown: string): { table: MdTable; found: boolean } {
  let next = table
  let found = false
  const matches = (cell: string) => {
    if (cell === markdown) return true
    const cellFence = parseMineFence(cell.trim())
    const dragFence = parseMineFence(markdown.trim())
    if (cellFence && dragFence && cellFence.id === dragFence.id) return true
    if (cellFence?.type === 'embed') {
      if (unwrapEmbed(cell) === markdown) return true
      if (dragFence && cellFence.attrs.src === dragFence.id) return true
    }
    return false
  }
  for (let col = 0; col < next.headers.length; col++) {
    if (matches(next.headers[col] || '')) {
      next = setTableCell(next, -1, col, '')
      found = true
    }
  }
  for (let row = 0; row < next.rows.length; row++) {
    for (let col = 0; col < next.rows[row].length; col++) {
      if (matches(next.rows[row][col] || '')) {
        next = setTableCell(next, row, col, '')
        found = true
      }
    }
  }
  return { table: next, found }
}

export type SlashNestResult = {
  text: string
  caret: number
  hostType?: MineObjectType
}

export function applySlashAsNested(
  text: string,
  slash: { from: number; to: number; query: string },
  cmd: { id: string; markdown: string; caret: number; special?: string },
  mineType: MineObjectType | null,
): SlashNestResult {
  const before = text.slice(0, slash.from).replace(/[ \t]+$/g, '')
  const after = text.slice(slash.to).replace(/^[ \t]+/g, '')
  if (!mineType) {
    const inserted = cmd.markdown
    const next = `${before}${before && inserted ? '\n\n' : ''}${inserted}${after && inserted ? '\n\n' : ''}${after}`
    return { text: next || inserted, caret: (before ? before.length + 2 : 0) + cmd.caret }
  }
  const childInner = cmd.markdown.replace(/\n+$/g, '') || defaultObjectInner(mineType)
  if (!before.trim() && !after.trim()) {
    return { text: childInner, caret: cmd.caret, hostType: mineType }
  }
  const child = formatMineBlock(mineType, newMineId(), childInner)
  const parts = [before, child, after].filter((part) => part.trim())
  return {
    text: parts.join('\n\n'),
    caret: before.trim() ? before.length + 2 + child.length : cmd.caret,
  }
}

export function replaceInnerSegment(inner: string, index: number, next: string): string {
  const segments = splitInnerSegments(inner)
  if (!segments.length) return next.trim()
  const copy = [...segments]
  if (!next.trim()) copy.splice(index, 1)
  else copy[index] = next
  return copy.join('\n\n')
}

export function splitInnerSegments(inner: string): string[] {
  const text = inner.replace(/\r\n/g, '\n').trim()
  if (!text) return []
  const lines = text.split('\n')
  const blocks: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i += 1
      continue
    }
    if (parseMineOpen(lines[i])) {
      const end = consumeMineBlock(lines, i)
      blocks.push(lines.slice(i, end).join('\n'))
      i = end
      continue
    }
    const start = i
    i += 1
    while (i < lines.length && !parseMineOpen(lines[i])) i += 1
    blocks.push(lines.slice(start, i).join('\n').replace(/\s+$/, ''))
  }
  return blocks.filter(Boolean)
}

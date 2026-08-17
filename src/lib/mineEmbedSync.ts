import { parseMdTable, serializeMdTable, setTableCell, type MdTable } from './mdTable'
import {
  consumeMineBlock,
  formatMineBlock,
  innerMineMarkdown,
  parseMineFence,
  parseMineOpen,
  replaceMineObjectInner,
  unwrapEmbed,
  type MineFence,
} from './mineObjects'
import { isCompleteMineFence, splitInnerSegments } from './nestedObjects'
import { joinMarkdownBlocks, splitMarkdownBlocks } from './liveMarkdown'

export const MINE_EMBED_CHANGE = 'mine-embed-change'
export const MINE_SLOT_INSERT = 'mine-slot-insert'

export type MineEmbedChangeDetail = {
  srcId: string
  sourceMarkdown: string
  noteId?: string
}

export type MineSlotInsertDetail = {
  markdown: string
}

export function dispatchMineEmbedChange(detail: MineEmbedChangeDetail) {
  window.dispatchEvent(new CustomEvent<MineEmbedChangeDetail>(MINE_EMBED_CHANGE, { detail }))
}

export function dispatchMineSlotInsert(target: HTMLElement, detail: MineSlotInsertDetail) {
  target.dispatchEvent(
    new CustomEvent<MineSlotInsertDetail>(MINE_SLOT_INSERT, {
      detail,
      bubbles: false,
    }),
  )
}

/** True when a cell/slot value is the dragged object (exact text or same fence id). */
export function cellMatchesDrag(cell: string, dragMarkdown: string): boolean {
  if (cell === dragMarkdown) return true
  const cellFence = parseMineFence(cell.trim())
  const dragFence = parseMineFence(dragMarkdown.trim())
  if (cellFence && dragFence && cellFence.id === dragFence.id) return true
  if (cellFence?.type === 'embed') {
    if (unwrapEmbed(cell) === dragMarkdown) return true
    if (dragFence && cellFence.attrs.src === dragFence.id) return true
  }
  if (dragFence?.type === 'embed' && cellFence && dragFence.attrs.src === cellFence.id) return true
  return false
}

function mapTableCells(table: MdTable, map: (cell: string) => string): { table: MdTable; changed: boolean } {
  let next = table
  let changed = false
  for (let col = 0; col < next.headers.length; col++) {
    const cell = next.headers[col] || ''
    const mapped = map(cell)
    if (mapped !== cell) {
      next = setTableCell(next, -1, col, mapped)
      changed = true
    }
  }
  for (let row = 0; row < next.rows.length; row++) {
    for (let col = 0; col < (next.rows[row]?.length || 0); col++) {
      const cell = next.rows[row][col] || ''
      const mapped = map(cell)
      if (mapped !== cell) {
        next = setTableCell(next, row, col, mapped)
        changed = true
      }
    }
  }
  return { table: next, changed }
}

function wrapFence(markdown: string, inner: string): string {
  const fence = parseMineFence(markdown)
  if (!fence) return inner
  return formatMineBlock(fence.type, fence.id, inner, fence.agentId, fence.attrs)
}

/** Map each top-level markdown block independently (docs are multi-block). */
function mapDocumentBlocks(content: string, map: (block: string) => string): string {
  const blocks = splitMarkdownBlocks(content)
  if (blocks.length <= 1) return map(content)
  return joinMarkdownBlocks(blocks.map((block) => map(block)))
}

/** Refresh embed snapshots inside a single top-level block (and nested cells/stacks). */
function refreshEmbedsInBlock(content: string, srcId: string, sourceMarkdown: string): string {
  const source = unwrapEmbed(sourceMarkdown)
  const fence = parseMineFence(content.trim())

  if (fence?.type === 'embed') {
    if (fence.attrs.src === srcId) {
      return formatMineBlock(fence.type, fence.id, source, fence.agentId, fence.attrs)
    }
    return content
  }

  if (fence?.type === 'table') {
    const table = parseMdTable(innerMineMarkdown(content))
    if (!table) return content
    const mapped = mapTableCells(table, (cell) => refreshEmbedsInBlock(cell, srcId, source))
    return mapped.changed ? wrapFence(content, serializeMdTable(mapped.table)) : content
  }

  if (fence) {
    const inner = innerMineMarkdown(content)
    const segments = splitInnerSegments(inner)
    if (segments.length > 1 || segments.some((segment) => Boolean(parseMineFence(segment)))) {
      const mapped = segments.map((segment) => refreshEmbedsInBlock(segment, srcId, source))
      const joined = mapped.join('\n\n')
      return joined !== inner ? wrapFence(content, joined) : content
    }
    if (inner.includes('<!-- mine:')) {
      const refreshed = refreshEmbedsInBlock(inner, srcId, source)
      if (refreshed !== inner) return wrapFence(content, refreshed)
    }
    return content
  }

  const table = parseMdTable(content)
  if (table) {
    const mapped = mapTableCells(table, (cell) => refreshEmbedsInBlock(cell, srcId, source))
    if (mapped.changed) return serializeMdTable(mapped.table)
  }
  return content
}

/** Refresh embed snapshots including objects nested inside table cells / multi-block docs. */
export function refreshEmbedsDeep(content: string, srcId: string, sourceMarkdown: string): string {
  return mapDocumentBlocks(content, (block) => refreshEmbedsInBlock(block, srcId, sourceMarkdown))
}

export function findCanonicalInMarkdown(markdown: string, id: string): string | null {
  const blocks = splitMarkdownBlocks(markdown)
  if (blocks.length > 1) {
    for (const block of blocks) {
      const found = findCanonicalInMarkdown(block, id)
      if (found) return found
    }
    return null
  }

  const trimmed = markdown.trim()
  if (!trimmed) return null
  const fence = parseMineFence(trimmed)
  if (fence && fence.id === id && fence.type !== 'embed') return trimmed

  if (fence?.type === 'table') {
    const table = parseMdTable(innerMineMarkdown(trimmed))
    if (!table) return null
    for (const header of table.headers) {
      const found = findCanonicalInMarkdown(header, id)
      if (found) return found
    }
    for (const row of table.rows) {
      for (const cell of row) {
        const found = findCanonicalInMarkdown(cell, id)
        if (found) return found
      }
    }
    return null
  }

  if (fence && fence.type !== 'embed') {
    for (const segment of splitInnerSegments(innerMineMarkdown(trimmed))) {
      const found = findCanonicalInMarkdown(segment, id)
      if (found) return found
    }
    return null
  }

  const table = parseMdTable(trimmed)
  if (table) {
    for (const header of table.headers) {
      const found = findCanonicalInMarkdown(header, id)
      if (found) return found
    }
    for (const row of table.rows) {
      for (const cell of row) {
        const found = findCanonicalInMarkdown(cell, id)
        if (found) return found
      }
    }
  }

  const lines = trimmed.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = parseMineOpen(lines[i] || '')
    if (!open) continue
    const end = consumeMineBlock(lines, i)
    const block = lines.slice(i, end).join('\n')
    if (open.id === id && open.type !== 'embed') return block
    if (open.type === 'table' || open.type !== 'embed') {
      const found = findCanonicalInMarkdown(innerMineMarkdown(block), id)
      if (found) return found
    }
    i = end - 1
  }
  return null
}

function replaceCanonicalInBlock(
  markdown: string,
  id: string,
  sourceMarkdown: string,
): string | null {
  const source = unwrapEmbed(sourceMarkdown)
  const fence = parseMineFence(markdown.trim())

  if (fence && fence.id === id && fence.type !== 'embed') return source

  if (fence?.type === 'table') {
    const table = parseMdTable(innerMineMarkdown(markdown))
    if (!table) return null
    let changed = false
    const mapped = mapTableCells(table, (cell) => {
      const next = replaceCanonicalInBlock(cell, id, source)
      if (next == null) return cell
      changed = true
      return next
    })
    if (!changed) return null
    return wrapFence(markdown, serializeMdTable(mapped.table))
  }

  if (fence && fence.type !== 'embed') {
    const inner = innerMineMarkdown(markdown)
    const segments = splitInnerSegments(inner)
    let changed = false
    const nextSegments = segments.map((segment) => {
      const replaced = replaceCanonicalInBlock(segment, id, source)
      if (replaced == null) return segment
      changed = true
      return replaced
    })
    if (changed) return wrapFence(markdown, nextSegments.join('\n\n'))
  }

  const table = parseMdTable(markdown)
  if (table) {
    let changed = false
    const mapped = mapTableCells(table, (cell) => {
      const next = replaceCanonicalInBlock(cell, id, source)
      if (next == null) return cell
      changed = true
      return next
    })
    if (changed) return serializeMdTable(mapped.table)
  }

  return replaceMineObjectInner(markdown, id, innerMineMarkdown(source))
}

export function replaceCanonicalInMarkdown(
  markdown: string,
  id: string,
  sourceMarkdown: string,
): string | null {
  const blocks = splitMarkdownBlocks(markdown)
  if (blocks.length <= 1) return replaceCanonicalInBlock(markdown, id, sourceMarkdown)

  let changed = false
  const next = blocks.map((block) => {
    const replaced = replaceCanonicalInBlock(block, id, sourceMarkdown)
    if (replaced == null) return block
    changed = true
    return replaced
  })
  return changed ? joinMarkdownBlocks(next) : null
}

export function resolveEmbedDisplay(
  markdown: string,
  lookup: (srcId: string) => string | null | undefined,
): string {
  if (!isCompleteMineFence(markdown)) return markdown
  const fence = parseMineFence(markdown)
  if (!fence || fence.type !== 'embed' || !fence.attrs.src) {
    return fence?.type === 'embed' ? unwrapEmbed(markdown) : markdown
  }
  const resolved = lookup(fence.attrs.src)
  if (resolved) return unwrapEmbed(resolved)
  return unwrapEmbed(markdown)
}

export function embedFenceOf(markdown: string): MineFence | null {
  const fence = parseMineFence(markdown.trim())
  return fence?.type === 'embed' ? fence : null
}

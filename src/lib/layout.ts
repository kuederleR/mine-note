import { joinMarkdownBlocks, splitMarkdownBlocks } from './liveMarkdown'
import { parseAgentId } from './agentBlock'
import { parseMineFence } from './mineObjects'

export const MAX_ROW_COLUMNS = 4

const ROW_OPEN = /^<!--\s*mine-row:([A-Za-z0-9_-]+)\s*-->\s*$/
const ROW_CLOSE = /^<!--\s*\/mine-row\s*-->\s*$/
const COL_OPEN = /^<!--\s*mine-col:([A-Za-z0-9_-]+)\s*-->\s*$/
const COL_CLOSE = /^<!--\s*\/mine-col\s*-->\s*$/

export type Leaf = {
  id: string
  markdown: string
}

export type Column = {
  id: string
  leaves: Leaf[]
}

export type BlockNode = {
  type: 'block'
  leaf: Leaf
}

export type RowNode = {
  type: 'row'
  id: string
  columns: Column[]
}

export type DocNode = BlockNode | RowNode

export type DropTarget =
  | { type: 'before'; id: string }
  | { type: 'after'; id: string }
  | { type: 'left'; id: string }
  | { type: 'right'; id: string }
  | { type: 'end' }

export type FlatLeaf = {
  id: string
  markdown: string
  nodeIndex: number
  colIndex: number | null
  leafIndex: number | null
}

export function isRowOpen(line: string): boolean {
  return ROW_OPEN.test(line.trim())
}

export function isRowClose(line: string): boolean {
  return ROW_CLOSE.test(line.trim())
}

export function newLayoutId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function leafIdFor(markdown: string, fallback: string): string {
  return parseMineFence(markdown)?.id || parseAgentId(markdown) || fallback
}

export function flattenLeaves(nodes: DocNode[]): FlatLeaf[] {
  const out: FlatLeaf[] = []
  nodes.forEach((node, nodeIndex) => {
    if (node.type === 'block') {
      out.push({
        id: node.leaf.id,
        markdown: node.leaf.markdown,
        nodeIndex,
        colIndex: null,
        leafIndex: null,
      })
      return
    }
    node.columns.forEach((col, colIndex) => {
      col.leaves.forEach((leaf, leafIndex) => {
        out.push({
          id: leaf.id,
          markdown: leaf.markdown,
          nodeIndex,
          colIndex,
          leafIndex,
        })
      })
    })
  })
  return out
}

export function parseDocument(src: string): DocNode[] {
  let n = 0
  return splitMarkdownBlocks(src).map((chunk) => {
    const row = parseRowChunk(chunk)
    if (row) return row
    return {
      type: 'block',
      leaf: { id: leafIdFor(chunk, `lf_${n++}`), markdown: chunk },
    }
  })
}

export function serializeDocument(nodes: DocNode[]): string {
  const chunks = nodes.map((node) =>
    node.type === 'block' ? node.leaf.markdown : formatRow(node),
  )
  return joinMarkdownBlocks(chunks)
}

export function parseRowChunk(chunk: string): RowNode | null {
  const lines = chunk.replace(/\r\n/g, '\n').split('\n')
  const open = lines[0]?.trim().match(ROW_OPEN)
  if (!open) return null
  const columns: Column[] = []
  let i = 1
  while (i < lines.length) {
    const line = lines[i].trim()
    if (ROW_CLOSE.test(line)) break
    const col = line.match(COL_OPEN)
    if (!col) {
      i += 1
      continue
    }
    const start = i + 1
    i += 1
    while (i < lines.length && !COL_CLOSE.test(lines[i].trim()) && !COL_OPEN.test(lines[i].trim()) && !ROW_CLOSE.test(lines[i].trim())) {
      i += 1
    }
    const inner = lines.slice(start, i).join('\n').replace(/^\n+|\n+$/g, '')
    const leaves = splitMarkdownBlocks(inner).map((md, index) => ({
      id: leafIdFor(md, `${col[1]}_${index}`),
      markdown: md,
    }))
    columns.push({ id: col[1], leaves: leaves.length ? leaves : [{ id: `${col[1]}_empty`, markdown: '' }] })
    if (i < lines.length && COL_CLOSE.test(lines[i].trim())) i += 1
  }
  if (!columns.length) return null
  return { type: 'row', id: open[1], columns }
}

export function formatRow(row: RowNode): string {
  const cols = row.columns
    .map((col) => {
      const inner = joinMarkdownBlocks(col.leaves.map((leaf) => leaf.markdown)).trim()
      return inner
        ? `<!-- mine-col:${col.id} -->\n${inner}\n<!-- /mine-col -->`
        : `<!-- mine-col:${col.id} -->\n<!-- /mine-col -->`
    })
    .join('\n')
  return `<!-- mine-row:${row.id} -->\n${cols}\n<!-- /mine-row -->`
}

export function cloneNodes(nodes: DocNode[]): DocNode[] {
  return nodes.map((node) =>
    node.type === 'block'
      ? { type: 'block', leaf: { ...node.leaf } }
      : {
          type: 'row',
          id: node.id,
          columns: node.columns.map((col) => ({
            id: col.id,
            leaves: col.leaves.map((leaf) => ({ ...leaf })),
          })),
        },
  )
}

export function normalizeDocument(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = []
  for (const node of nodes) {
    if (node.type === 'block') {
      out.push(node)
      continue
    }
    const columns = node.columns.filter((col) => col.leaves.length)
    if (columns.length === 0) continue
    if (columns.length === 1) {
      for (const leaf of columns[0].leaves) out.push({ type: 'block', leaf })
      continue
    }
    out.push({ ...node, columns })
  }
  return out.length ? out : [{ type: 'block', leaf: { id: leafIdFor('', 'lf_0'), markdown: '' } }]
}

function makeLeaf(markdown: string): Leaf {
  return { id: leafIdFor(markdown, newLayoutId('lf')), markdown }
}

export function updateLeaf(nodes: DocNode[], id: string, markdown: string): DocNode[] {
  const next = cloneNodes(nodes)
  for (const node of next) {
    if (node.type === 'block' && node.leaf.id === id) {
      node.leaf = { id: leafIdFor(markdown, node.leaf.id), markdown }
      return next
    }
    if (node.type === 'row') {
      for (const col of node.columns) {
        const index = col.leaves.findIndex((leaf) => leaf.id === id)
        if (index >= 0) {
          col.leaves[index] = { id: leafIdFor(markdown, col.leaves[index].id), markdown }
          return next
        }
      }
    }
  }
  return next
}

export function spliceLeaves(
  nodes: DocNode[],
  start: number,
  deleteCount: number,
  inserts: string[],
): DocNode[] {
  const next = cloneNodes(nodes)
  const flat = flattenLeaves(next)
  if (!flat.length) {
    return normalizeDocument(inserts.map((md) => ({ type: 'block' as const, leaf: makeLeaf(md) })))
  }
  const from = Math.max(0, Math.min(start, flat.length))
  const to = Math.max(from, Math.min(from + deleteCount, flat.length))
  const removeIds = new Set(flat.slice(from, to).map((item) => item.id))
  const added = inserts.map(makeLeaf)
  const after = flat.slice(to).find((item) => !removeIds.has(item.id))
  const before = [...flat.slice(0, from)].reverse().find((item) => !removeIds.has(item.id))
  const stripped = removeLeafIds(next, removeIds)
  if (!added.length) return normalizeDocument(stripped)
  if (after) return normalizeDocument(insertLeavesAt(stripped, after.id, added, 'before'))
  if (before) return normalizeDocument(insertLeavesAt(stripped, before.id, added, 'after'))
  return normalizeDocument(added.map((leaf) => ({ type: 'block' as const, leaf })))
}

function removeLeafIds(nodes: DocNode[], ids: Set<string>): DocNode[] {
  const out: DocNode[] = []
  for (const node of nodes) {
    if (node.type === 'block') {
      if (!ids.has(node.leaf.id)) out.push(node)
      continue
    }
    out.push({
      ...node,
      columns: node.columns.map((col) => ({
        ...col,
        leaves: col.leaves.filter((leaf) => !ids.has(leaf.id)),
      })),
    })
  }
  return out
}

function insertLeavesAt(nodes: DocNode[], anchorId: string, leaves: Leaf[], where: 'before' | 'after'): DocNode[] {
  const loc = findLeaf(nodes, anchorId)
  if (!loc) return [...nodes, ...leaves.map((leaf) => ({ type: 'block' as const, leaf }))]
  if (loc.colIndex == null) {
    const items: DocNode[] = leaves.map((leaf) => ({ type: 'block', leaf }))
    const at = where === 'before' ? loc.nodeIndex : loc.nodeIndex + 1
    return [...nodes.slice(0, at), ...items, ...nodes.slice(at)]
  }
  const node = nodes[loc.nodeIndex]
  if (!node || node.type !== 'row') return nodes
  const col = node.columns[loc.colIndex]
  if (!col) return nodes
  const at = where === 'before' ? loc.leafIndex : loc.leafIndex + 1
  col.leaves.splice(at, 0, ...leaves)
  return nodes
}

type LeafLoc = {
  nodeIndex: number
  colIndex: number | null
  leafIndex: number
}

export function findLeaf(nodes: DocNode[], id: string): LeafLoc | null {
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex]
    if (node.type === 'block' && node.leaf.id === id) {
      return { nodeIndex, colIndex: null, leafIndex: 0 }
    }
    if (node.type === 'row') {
      for (let colIndex = 0; colIndex < node.columns.length; colIndex++) {
        const leafIndex = node.columns[colIndex].leaves.findIndex((leaf) => leaf.id === id)
        if (leafIndex >= 0) return { nodeIndex, colIndex, leafIndex }
      }
    }
  }
  return null
}

function extractLeaf(nodes: DocNode[], id: string): { nodes: DocNode[]; leaf: Leaf } | null {
  const loc = findLeaf(nodes, id)
  if (!loc) return null
  const next = cloneNodes(nodes)
  const node = next[loc.nodeIndex]
  if (!node) return null
  if (node.type === 'block') {
    const leaf = node.leaf
    next.splice(loc.nodeIndex, 1)
    return { nodes: next, leaf }
  }
  if (loc.colIndex == null) return null
  const col = node.columns[loc.colIndex]
  const leaf = col.leaves[loc.leafIndex]
  col.leaves.splice(loc.leafIndex, 1)
  return { nodes: next, leaf }
}

function insertRelative(nodes: DocNode[], loc: LeafLoc, leaf: Leaf, where: 'before' | 'after'): DocNode[] {
  return insertLeavesAt(nodes, locId(nodes, loc), [leaf], where)
}

function locId(nodes: DocNode[], loc: LeafLoc): string {
  const node = nodes[loc.nodeIndex]
  if (!node) return ''
  if (node.type === 'block') return node.leaf.id
  return node.columns[loc.colIndex ?? 0]?.leaves[loc.leafIndex]?.id || ''
}

function insertAsColumn(nodes: DocNode[], loc: LeafLoc, leaf: Leaf, side: 'left' | 'right'): DocNode[] {
  const next = cloneNodes(nodes)
  const node = next[loc.nodeIndex]
  if (!node) return [...next, { type: 'block', leaf }]
  if (node.type === 'block') {
    const target = node.leaf
    const left = side === 'left' ? leaf : target
    const right = side === 'left' ? target : leaf
    const row: RowNode = {
      type: 'row',
      id: newLayoutId('rw'),
      columns: [
        { id: newLayoutId('cl'), leaves: [{ ...left }] },
        { id: newLayoutId('cl'), leaves: [{ ...right }] },
      ],
    }
    next[loc.nodeIndex] = row
    return next
  }
  if (node.columns.length >= MAX_ROW_COLUMNS) {
    return insertRelative(next, loc, leaf, side === 'left' ? 'before' : 'after')
  }
  const at = (loc.colIndex ?? 0) + (side === 'right' ? 1 : 0)
  node.columns.splice(at, 0, { id: newLayoutId('cl'), leaves: [leaf] })
  return next
}

export function applyDrop(nodes: DocNode[], fromId: string, target: DropTarget): DocNode[] {
  if (target.type !== 'end' && fromId === target.id) return nodes
  const extracted = extractLeaf(nodes, fromId)
  if (!extracted) return nodes
  let tree = normalizeDocument(extracted.nodes)
  const { leaf } = extracted
  if (target.type === 'end') {
    return normalizeDocument([...tree, { type: 'block', leaf }])
  }
  const loc = findLeaf(tree, target.id)
  if (!loc) return normalizeDocument([...tree, { type: 'block', leaf }])
  if (target.type === 'before' || target.type === 'after') {
    return normalizeDocument(insertRelative(tree, loc, leaf, target.type))
  }
  return normalizeDocument(insertAsColumn(tree, loc, leaf, target.type))
}

function topLevelShiftId(node: DocNode): string {
  return node.type === 'block' ? node.leaf.id : `row:${node.id}`
}

export function verticalShifts(
  nodes: DocNode[],
  fromId: string,
  target: DropTarget | null,
  height: number,
): Record<string, number> {
  const shifts: Record<string, number> = {}
  if (!target || target.type === 'left' || target.type === 'right') return shifts
  const fromLoc = findLeaf(nodes, fromId)
  if (!fromLoc) return shifts

  if (target.type !== 'end') {
    const targetLoc = findLeaf(nodes, target.id)
    if (!targetLoc) return shifts
    const sameColumn =
      fromLoc.colIndex != null &&
      targetLoc.colIndex != null &&
      fromLoc.nodeIndex === targetLoc.nodeIndex &&
      fromLoc.colIndex === targetLoc.colIndex
    if (sameColumn) {
      const node = nodes[fromLoc.nodeIndex]
      const colIndex = fromLoc.colIndex
      if (node.type !== 'row' || colIndex == null) return shifts
      const col = node.columns[colIndex]
      const remaining = col.leaves.filter((leaf) => leaf.id !== fromId)
      const fromIndex = col.leaves.findIndex((leaf) => leaf.id === fromId)
      let insertAt = Math.min(Math.max(fromIndex, 0), remaining.length)
      const idx = remaining.findIndex((leaf) => leaf.id === target.id)
      if (idx >= 0) insertAt = target.type === 'before' ? idx : idx + 1
      remaining.forEach((leaf, index) => {
        if (index >= insertAt) shifts[leaf.id] = height
      })
      return shifts
    }
    if (fromLoc.colIndex !== targetLoc.colIndex) return shifts
  }

  const remaining = nodes.filter((_, index) => index !== fromLoc.nodeIndex)
  let insertAt = Math.min(fromLoc.nodeIndex, remaining.length)
  if (target.type === 'end') insertAt = remaining.length
  else {
    const targetLoc = findLeaf(nodes, target.id)
    if (targetLoc) {
      const targetRemainingIndex = remaining.findIndex((_, index) => {
        const originalIndex = index < fromLoc.nodeIndex ? index : index + 1
        return originalIndex === targetLoc.nodeIndex
      })
      if (targetRemainingIndex >= 0) {
        insertAt = target.type === 'before' ? targetRemainingIndex : targetRemainingIndex + 1
      }
    }
  }
  remaining.forEach((node, index) => {
    if (index >= insertAt) shifts[topLevelShiftId(node)] = height
  })
  return shifts
}

export function stripLayoutComments(src: string): string {
  return src
    .replace(/<!--\s*mine-row:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine-row\s*-->/gi, '')
    .replace(/<!--\s*mine-col:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine-col\s*-->/gi, '')
}

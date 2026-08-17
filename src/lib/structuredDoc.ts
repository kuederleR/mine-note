import {
  formatRow,
  leafIdFor,
  parseDocument,
  type Column as LayoutColumn,
  type DocNode as LayoutDocNode,
  type Leaf as LayoutLeaf,
} from './layout'
import {
  formatMineBlock,
  innerMineMarkdown,
  parseMineFence,
  unwrapEmbed,
  type MineObjectType,
} from './mineObjects'
import {
  parseMdTable,
  serializeMdTable,
  type MdAlign,
  type MdTable,
  type TableMerge,
} from './mdTable'
import { isCompleteMineFence, splitInnerSegments, innerHasNestedFence, pasteIntoCell } from './nestedObjects'
import { joinMarkdownBlocks } from './liveMarkdown'
import type { ObjectLink } from './objectLink'
import { refreshEmbedsDeep, replaceCanonicalInMarkdown } from './mineEmbedSync'

/** Schema version written into StructuredDoc.version */
export const DOC_VERSION = 1 as const

export type Slot =
  | { kind: 'empty' }
  | { kind: 'text'; markdown: string }
  | { kind: 'object'; objectId: string }

export type StructuredTable = {
  headers: Slot[]
  rows: Slot[][]
  aligns?: MdAlign[]
  colWidths?: number[]
  rowHeights?: number[]
  merges?: TableMerge[]
  refs?: ObjectLink[]
}

export type ObjectBody =
  | { kind: 'inline'; markdown: string }
  | { kind: 'table'; table: StructuredTable }
  | { kind: 'embed'; srcId: string; noteId?: string; snapshotMarkdown?: string }
  | { kind: 'reminder'; reminderId: string; markdown: string }
  | { kind: 'stack'; children: Slot[] }

/** Canonical mine object in the structured document model (not the client cache record). */
export type DocObject = {
  id: string
  type: MineObjectType
  agentId?: string | null
  attrs?: Record<string, string>
  body: ObjectBody
}

export type StructuredBlock = {
  type: 'block'
  id: string
  slot: Slot
}

export type StructuredColumn = {
  id: string
  blocks: StructuredBlock[]
}

export type StructuredRow = {
  type: 'row'
  id: string
  columns: StructuredColumn[]
}

export type StructuredDocNode = StructuredBlock | StructuredRow

export type StructuredDoc = {
  version: typeof DOC_VERSION
  nodes: StructuredDocNode[]
}

export type MarkdownToDocResult = {
  doc: StructuredDoc
  objects: DocObject[]
}

type ObjectBag = Map<string, DocObject>

function addObject(bag: ObjectBag, obj: DocObject): void {
  if (bag.has(obj.id)) return
  bag.set(obj.id, obj)
}

function markdownToSlot(markdown: string, bag: ObjectBag): Slot {
  const text = markdown.replace(/\r\n/g, '\n')
  if (!text.trim()) return { kind: 'empty' }
  if (isCompleteMineFence(text)) {
    const obj = fenceToObject(text, bag)
    return { kind: 'object', objectId: obj.id }
  }
  return { kind: 'text', markdown: text }
}

function fenceToObject(markdown: string, bag: ObjectBag): DocObject {
  const trimmed = markdown.replace(/\r\n/g, '\n').trim()
  const fence = parseMineFence(trimmed)
  if (!fence) {
    const fallback: DocObject = {
      id: leafIdFor(trimmed, `obj_${bag.size}`),
      type: 'paragraph',
      body: { kind: 'inline', markdown: trimmed },
    }
    addObject(bag, fallback)
    return fallback
  }
  if (bag.has(fence.id)) return bag.get(fence.id)!

  const attrs = { ...fence.attrs }
  delete attrs.agent
  const agentId = fence.agentId
  const inner = innerMineMarkdown(trimmed)

  let body: ObjectBody
  if (fence.type === 'embed') {
    const srcId = fence.attrs.src || fence.id
    const noteId = fence.attrs.note || undefined
    const snapshot = unwrapEmbed(trimmed)
    if (isCompleteMineFence(snapshot)) {
      fenceToObject(snapshot, bag)
    }
    body = {
      kind: 'embed',
      srcId,
      noteId,
      snapshotMarkdown: snapshot,
    }
  } else if (fence.type === 'reminder') {
    body = { kind: 'reminder', reminderId: fence.id, markdown: inner }
  } else if (fence.type === 'table') {
    const table = parseMdTable(inner)
    body = table
      ? { kind: 'table', table: mdTableToStructured(table, bag) }
      : { kind: 'inline', markdown: inner }
  } else if (innerHasNestedFence(inner)) {
    const children = splitInnerSegments(inner).map((segment) => markdownToSlot(segment, bag))
    body = { kind: 'stack', children }
  } else {
    body = { kind: 'inline', markdown: inner }
  }

  const obj: DocObject = {
    id: fence.id,
    type: fence.type,
    agentId,
    attrs: Object.keys(attrs).length ? attrs : undefined,
    body,
  }
  addObject(bag, obj)
  return obj
}

function mdTableToStructured(table: MdTable, bag: ObjectBag): StructuredTable {
  return {
    headers: table.headers.map((cell) => markdownToSlot(cell, bag)),
    rows: table.rows.map((row) => row.map((cell) => markdownToSlot(cell, bag))),
    aligns: table.aligns,
    colWidths: table.colWidths,
    rowHeights: table.rowHeights,
    merges: table.merges,
    refs: table.refs,
  }
}

function structuredTableToMd(table: StructuredTable, bag: ObjectBag): MdTable {
  return {
    headers: table.headers.map((slot) => slotToMarkdown(slot, bag)),
    rows: table.rows.map((row) => row.map((slot) => slotToMarkdown(slot, bag))),
    aligns: table.aligns || table.headers.map(() => '' as MdAlign),
    colWidths: table.colWidths,
    rowHeights: table.rowHeights,
    merges: table.merges,
    refs: table.refs,
  }
}

function leafToBlock(leaf: LayoutLeaf, bag: ObjectBag): StructuredBlock {
  return {
    type: 'block',
    id: leaf.id,
    slot: markdownToSlot(leaf.markdown, bag),
  }
}

function layoutNodeToStructured(node: LayoutDocNode, bag: ObjectBag): StructuredDocNode {
  if (node.type === 'block') return leafToBlock(node.leaf, bag)
  return {
    type: 'row',
    id: node.id,
    columns: node.columns.map(
      (col: LayoutColumn): StructuredColumn => ({
        id: col.id,
        blocks: col.leaves.map((leaf) => leafToBlock(leaf, bag)),
      }),
    ),
  }
}

/** Parse legacy markdown note content into a structured document + object bag. */
export function markdownToDoc(markdown: string): MarkdownToDocResult {
  const bag: ObjectBag = new Map()
  const layout = parseDocument(markdown)
  const nodes = layout.map((node) => layoutNodeToStructured(node, bag))
  return {
    doc: { version: DOC_VERSION, nodes },
    objects: [...bag.values()],
  }
}

function slotToMarkdown(slot: Slot, bag: ObjectBag): string {
  if (slot.kind === 'empty') return ''
  if (slot.kind === 'text') return slot.markdown
  const obj = bag.get(slot.objectId)
  if (!obj) return `<!-- missing object ${slot.objectId} -->`
  return objectToMarkdown(obj, bag)
}

function objectToMarkdown(obj: DocObject, bag: ObjectBag): string {
  const attrs = { ...(obj.attrs || {}) }
  if (obj.body.kind === 'embed') {
    const snapshot =
      obj.body.snapshotMarkdown ||
      (bag.has(obj.body.srcId) ? objectToMarkdown(bag.get(obj.body.srcId)!, bag) : '')
    const embedAttrs: Record<string, string> = { ...attrs, src: obj.body.srcId }
    if (obj.body.noteId) embedAttrs.note = obj.body.noteId
    return formatMineBlock('embed', obj.id, snapshot, obj.agentId, embedAttrs)
  }
  if (obj.body.kind === 'reminder') {
    return formatMineBlock('reminder', obj.id, obj.body.markdown, obj.agentId, attrs)
  }
  if (obj.body.kind === 'table') {
    return formatMineBlock(
      'table',
      obj.id,
      serializeMdTable(structuredTableToMd(obj.body.table, bag)),
      obj.agentId,
      attrs,
    )
  }
  if (obj.body.kind === 'stack') {
    const inner = obj.body.children
      .map((child) => slotToMarkdown(child, bag))
      .filter((part, index, all) => part.trim() || (index > 0 && index < all.length - 1))
      .join('\n\n')
    return formatMineBlock(obj.type, obj.id, inner, obj.agentId, attrs)
  }
  return formatMineBlock(obj.type, obj.id, obj.body.markdown, obj.agentId, attrs)
}

function blockToLeaf(block: StructuredBlock, bag: ObjectBag): LayoutLeaf {
  const markdown = slotToMarkdown(block.slot, bag)
  return { id: leafIdFor(markdown, block.id), markdown }
}

function structuredNodeToLayout(node: StructuredDocNode, bag: ObjectBag): LayoutDocNode {
  if (node.type === 'block') {
    return { type: 'block', leaf: blockToLeaf(node, bag) }
  }
  return {
    type: 'row',
    id: node.id,
    columns: node.columns.map((col) => ({
      id: col.id,
      leaves: col.blocks.map((block) => blockToLeaf(block, bag)),
    })),
  }
}

function objectsToMap(objects: DocObject[] | ObjectBag): ObjectBag {
  if (objects instanceof Map) return objects
  return new Map(objects.map((obj) => [obj.id, obj]))
}

/** Project a structured document back to markdown (export / dual-write cache). */
export function docToMarkdown(
  doc: StructuredDoc,
  objects: DocObject[] | ObjectBag,
): string {
  const bag = objectsToMap(objects)
  const chunks = doc.nodes.map((node) => {
    const layout = structuredNodeToLayout(node, bag)
    return layout.type === 'block' ? layout.leaf.markdown : formatRow(layout)
  })
  return joinMarkdownBlocks(chunks)
}

export function stringifyDoc(doc: StructuredDoc): string {
  return JSON.stringify(doc)
}

export function parseDocJson(raw: string | null | undefined): StructuredDoc | null {
  if (!raw?.trim()) return null
  try {
    const parsed = JSON.parse(raw) as StructuredDoc
    if (!parsed || parsed.version !== DOC_VERSION || !Array.isArray(parsed.nodes)) return null
    return parsed
  } catch {
    return null
  }
}

export function stringifyObjects(objects: DocObject[]): string {
  return JSON.stringify(objects)
}

export function parseObjectsJson(raw: string | null | undefined): DocObject[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as DocObject[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Collect every object id referenced by slots (and nested object bodies). */
export function collectObjectIdsDeep(doc: StructuredDoc, objects: DocObject[] | ObjectBag): string[] {
  const bag = objectsToMap(objects)
  const ids = new Set<string>()
  const walkSlot = (slot: Slot) => {
    if (slot.kind !== 'object') return
    ids.add(slot.objectId)
    const obj = bag.get(slot.objectId)
    if (!obj) return
    walkBody(obj.body)
  }
  const walkBody = (body: ObjectBody) => {
    if (body.kind === 'stack') body.children.forEach(walkSlot)
    if (body.kind === 'table') {
      body.table.headers.forEach(walkSlot)
      body.table.rows.forEach((row) => row.forEach(walkSlot))
    }
    if (body.kind === 'embed' && body.srcId) ids.add(body.srcId)
  }
  for (const node of doc.nodes) {
    if (node.type === 'block') walkSlot(node.slot)
    else {
      for (const col of node.columns) {
        for (const block of col.blocks) walkSlot(block.slot)
      }
    }
  }
  return [...ids]
}

/** Project a single object to fenced markdown (needs the full object bag for nests/embeds). */
export function docObjectToMarkdown(
  obj: DocObject,
  objects: DocObject[] | ObjectBag,
): string {
  return objectToMarkdown(obj, objectsToMap(objects))
}

/**
 * Tree-style move within a markdown table: clear the object by id from every cell,
 * then place it at the destination. `external` is true when the object was not in this table.
 */
export function moveObjectInMdTable(
  table: MdTable,
  objectMarkdown: string,
  row: number,
  col: number,
): { table: MdTable; moved: boolean; external: boolean } {
  const bag: ObjectBag = new Map()
  const structured = mdTableToStructured(table, bag)
  const dragFence = parseMineFence(objectMarkdown.trim())
  const objectId = dragFence?.id

  let found = false
  const clearSlot = (slot: Slot): Slot => {
    if (slot.kind !== 'object') return slot
    if (objectId && slot.objectId === objectId) {
      found = true
      return { kind: 'empty' }
    }
    if (!objectId && slotToMarkdown(slot, bag) === objectMarkdown) {
      found = true
      return { kind: 'empty' }
    }
    return slot
  }

  structured.headers = structured.headers.map(clearSlot)
  structured.rows = structured.rows.map((r) => r.map(clearSlot))

  let placed = markdownToSlot(objectMarkdown, bag)
  const dest =
    row < 0
      ? structured.headers[col]
      : structured.rows[row]?.[col]
  if (
    dest &&
    dest.kind !== 'empty' &&
    !(dest.kind === 'object' && objectId && dest.objectId === objectId)
  ) {
    const existing = slotToMarkdown(dest, bag)
    placed = markdownToSlot(pasteIntoCell(existing, objectMarkdown), bag)
  }

  if (row < 0) {
    if (col >= 0 && col < structured.headers.length) structured.headers[col] = placed
  } else if (structured.rows[row] && col >= 0 && col < structured.rows[row].length) {
    structured.rows[row][col] = placed
  }

  return {
    table: structuredTableToMd(structured, bag),
    moved: true,
    external: !found,
  }
}

/** Rebuild doc + objects from markdown (editor session sync). */
export function syncDocFromMarkdown(content: string): MarkdownToDocResult {
  return markdownToDoc(content)
}

/**
 * Apply a canonical object update and refresh embed snapshots in one markdown pass.
 * Nested table cells are included via deep replace/refresh.
 */
export function applyCanonicalObjectUpdate(
  markdown: string,
  srcId: string,
  sourceMarkdown: string,
): string {
  const source = unwrapEmbed(sourceMarkdown)
  const replaced = replaceCanonicalInMarkdown(markdown, srcId, source) ?? markdown
  return refreshEmbedsDeep(replaced, srcId, source)
}

/** @deprecated Prefer collectObjectIdsDeep when an object bag is available */
export function collectObjectIds(doc: StructuredDoc): string[] {
  const ids = new Set<string>()
  const walkSlot = (slot: Slot) => {
    if (slot.kind === 'object') ids.add(slot.objectId)
  }
  for (const node of doc.nodes) {
    if (node.type === 'block') walkSlot(node.slot)
    else {
      for (const col of node.columns) {
        for (const block of col.blocks) walkSlot(block.slot)
      }
    }
  }
  return [...ids]
}

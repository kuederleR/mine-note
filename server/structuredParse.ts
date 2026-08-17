import { createHash } from 'node:crypto'
import type { ParsedComponent } from './parser.js'
import type { DocObject, Slot, StructuredDoc } from '../src/lib/structuredDoc.ts'
import { innerMineMarkdown } from '../src/lib/mineObjects.ts'

function stableId(noteId: string, type: string, content: string, position: number): string {
  const hash = createHash('sha1')
    .update(`${noteId}|${type}|${position}|${content.trim()}`)
    .digest('hex')
    .slice(0, 16)
  return `c_${hash}`
}

function mapObjectType(type: string): ParsedComponent['type'] {
  if (type === 'list' || type === 'numbered-list') return 'list'
  if (type === 'todo') return 'todo'
  if (type === 'heading') return 'heading'
  if (type === 'callout') return 'callout'
  if (type === 'quote') return 'quote'
  if (type === 'toggle') return 'toggle'
  if (type === 'divider') return 'divider'
  if (type === 'reminder') return 'reminder'
  if (type === 'table') return 'paragraph'
  return 'paragraph'
}

function bodySearchText(obj: DocObject, bag: Map<string, DocObject>): string {
  const body = obj.body
  if (body.kind === 'inline') return body.markdown
  if (body.kind === 'reminder') return body.markdown
  if (body.kind === 'embed') {
    const src = bag.get(body.srcId)
    if (src) return bodySearchText(src, bag)
    return body.snapshotMarkdown ? innerMineMarkdown(body.snapshotMarkdown) : ''
  }
  if (body.kind === 'stack') {
    return body.children
      .map((slot) => slotSearchText(slot, bag))
      .filter(Boolean)
      .join('\n')
  }
  if (body.kind === 'table') {
    const cells = [...body.table.headers, ...body.table.rows.flat()]
    return cells
      .map((slot) => slotSearchText(slot, bag))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function slotSearchText(slot: Slot, bag: Map<string, DocObject>): string {
  if (slot.kind === 'empty') return ''
  if (slot.kind === 'text') return slot.markdown
  const obj = bag.get(slot.objectId)
  return obj ? bodySearchText(obj, bag) : ''
}

function calloutParts(raw: string, attrs?: Record<string, string>): { kind: string; body: string } {
  const match = raw.match(/^>\s*\[!(NOTE|TIP|WARN|WARNING|IDEA|IMPORTANT)\]\s*([\s\S]*)$/i)
  const kind = (match?.[1] || attrs?.kind || 'NOTE').toUpperCase().replace('WARNING', 'WARN')
  const body = (match?.[2] ?? raw).replace(/^>\s?/gm, '').trim() || kind
  return { kind, body }
}

/**
 * Index a structured document into search components without relying on
 * fence-scraping of `<br>`-encoded table cells.
 */
export function componentsFromDocument(
  noteId: string,
  doc: StructuredDoc,
  objects: DocObject[],
): ParsedComponent[] {
  const bag = new Map(objects.map((obj) => [obj.id, obj]))
  const out: ParsedComponent[] = []
  let position = 0
  const seen = new Set<string>()

  const push = (
    type: ParsedComponent['type'],
    content: string,
    meta: Record<string, unknown> = {},
  ) => {
    const text = content.trim()
    if (!text) return
    out.push({
      id: stableId(noteId, type, `${meta.objectId || ''}|${text}`, position),
      type,
      content: text,
      meta,
      position,
    })
    position += 1
  }

  const walkObject = (obj: DocObject, path: string) => {
    if (seen.has(obj.id)) return
    seen.add(obj.id)

    if (obj.type === 'embed' && obj.body.kind === 'embed') {
      const src = bag.get(obj.body.srcId)
      if (src) {
        walkObject(src, path)
        return
      }
      const snap = obj.body.snapshotMarkdown || ''
      push(mapObjectType(obj.attrs?.type || 'paragraph'), innerMineMarkdown(snap) || snap, {
        objectId: obj.id,
        embedSrc: obj.body.srcId,
        path,
      })
      return
    }

    if (obj.body.kind === 'table') {
      const cells = [...obj.body.table.headers, ...obj.body.table.rows.flat()]
      cells.forEach((slot, index) => walkSlot(slot, `${path}/cell:${index}`))
      const summary = bodySearchText(obj, bag)
      if (summary.trim()) {
        push('paragraph', summary.slice(0, 2000), { objectId: obj.id, path, isTable: true })
      }
      return
    }

    if (obj.body.kind === 'stack') {
      obj.body.children.forEach((slot, index) => walkSlot(slot, `${path}/stack:${index}`))
      return
    }

    if (obj.body.kind === 'reminder') {
      push('reminder', obj.body.markdown || 'Reminder', {
        objectId: obj.id,
        reminderId: obj.body.reminderId,
        due: obj.attrs.due || undefined,
        status: obj.attrs.status || undefined,
        path,
      })
      return
    }

    if (obj.type === 'divider') {
      push('divider', '---', { objectId: obj.id, path })
      return
    }

    if (obj.type === 'callout') {
      const { kind, body } = calloutParts(bodySearchText(obj, bag), obj.attrs)
      push('callout', body, { objectId: obj.id, path, kind })
      return
    }

    push(mapObjectType(obj.type), bodySearchText(obj, bag), { objectId: obj.id, path })
  }

  const walkSlot = (slot: Slot, path: string) => {
    if (slot.kind === 'empty') return
    if (slot.kind === 'text') {
      push('paragraph', slot.markdown, { path })
      return
    }
    const obj = bag.get(slot.objectId)
    if (obj) walkObject(obj, path)
    else push('paragraph', `missing:${slot.objectId}`, { path })
  }

  doc.nodes.forEach((node, nodeIndex) => {
    if (node.type === 'block') {
      walkSlot(node.slot, `block:${nodeIndex}`)
      return
    }
    node.columns.forEach((col) => {
      col.blocks.forEach((block, blockIndex) => {
        walkSlot(block.slot, `row:${node.id}/col:${col.id}/${blockIndex}`)
      })
    })
  })

  for (const obj of objects) {
    if (seen.has(obj.id)) continue
    walkObject(obj, `orphan:${obj.id}`)
  }

  return out
}

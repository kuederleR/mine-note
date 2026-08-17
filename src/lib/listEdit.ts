export type LineBounds = {
  start: number
  end: number
  line: string
  lineIndex: number
}

export type ListItem = {
  indent: string
  marker: string
  gap: string
  check: string
  text: string
}

export type BlockEdit =
  | { type: 'replace'; text: string; caret: number }
  | { type: 'split'; blocks: string[]; focus: number; caret: number }

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+\.)(\s+)(?:(\[[ xX]\])\s*)?(.*)$/

export function lineBounds(text: string, caret: number): LineBounds {
  const safe = Math.max(0, Math.min(caret, text.length))
  const start = text.lastIndexOf('\n', Math.max(0, safe - 1)) + 1
  const nl = text.indexOf('\n', safe)
  const end = nl < 0 ? text.length : nl
  const lineIndex = text.slice(0, start).split('\n').length - 1
  return { start, end, line: text.slice(start, end), lineIndex }
}

export function parseListItem(line: string): ListItem | null {
  const m = line.match(LIST_ITEM_RE)
  if (!m) return null
  return {
    indent: m[1],
    marker: m[2],
    gap: m[3],
    check: m[4] ? `${m[4]} ` : '',
    text: m[5],
  }
}

export function formatListItem(item: ListItem): string {
  return `${item.indent}${item.marker}${item.gap}${item.check}${item.text}`
}

export function isListBlockKind(kind: string): boolean {
  return kind === 'ul' || kind === 'ol' || kind === 'todo'
}

function outdentPrefix(indent: string): string {
  if (indent.endsWith('\t')) return indent.slice(0, -1)
  if (indent.endsWith('  ')) return indent.slice(0, -2)
  if (indent.endsWith(' ')) return indent.slice(0, -1)
  return ''
}

function indentPrefix(indent: string): string {
  return `${indent}  `
}

function nextMarker(marker: string): string {
  const n = marker.match(/^(\d+)\./)
  if (!n) return marker
  return `${Number(n[1]) + 1}.`
}

function replaceLine(text: string, start: number, end: number, nextLine: string): string {
  return text.slice(0, start) + nextLine + text.slice(end)
}

export function handlePlainEnter(text: string, caret: number): BlockEdit {
  const { start, end, line } = lineBounds(text, caret)
  if (line.trim() === '') {
    const before = text.slice(0, start).replace(/\n+$/, '')
    const after = text.slice(end).replace(/^\n+/, '')
    return { type: 'split', blocks: [before, after], focus: 1, caret: 0 }
  }
  const next = `${text.slice(0, caret)}\n${text.slice(caret)}`
  return { type: 'replace', text: next, caret: caret + 1 }
}

export function handleHeadingEnter(text: string, caret: number): BlockEdit {
  const before = text.slice(0, caret).replace(/\n+$/, '')
  const after = text.slice(caret).replace(/^\n+/, '')
  return { type: 'split', blocks: [before, after], focus: 1, caret: 0 }
}

export function handleListEnter(text: string, caret: number): BlockEdit | null {
  const { start, end, line, lineIndex } = lineBounds(text, caret)
  const item = parseListItem(line)
  if (!item) return handlePlainEnter(text, caret)

  const prefixLen = item.indent.length + item.marker.length + item.gap.length + item.check.length
  const contentStart = start + prefixLen
  const atEmpty = item.text.trim() === '' && caret <= Math.max(contentStart, end)

  if (atEmpty) {
    if (item.indent) {
      const nextItem = { ...item, indent: outdentPrefix(item.indent) }
      const nextLine = formatListItem(nextItem)
      const next = replaceLine(text, start, end, nextLine)
      return { type: 'replace', text: next, caret: start + nextLine.length - nextItem.text.length }
    }
    const lines = text.split('\n')
    const before = lines.slice(0, lineIndex).join('\n')
    const after = lines.slice(lineIndex + 1).join('\n')
    const blocks: string[] = []
    if (before) blocks.push(before)
    blocks.push('')
    if (after) blocks.push(after)
    const focus = before ? 1 : 0
    return { type: 'split', blocks, focus, caret: 0 }
  }

  const left = text.slice(contentStart, Math.max(contentStart, caret))
  const right = text.slice(Math.max(contentStart, caret), end)
  const leftItem = { ...item, text: left }
  const rightItem: ListItem = {
    indent: item.indent,
    marker: nextMarker(item.marker),
    gap: item.gap,
    check: item.check ? '[ ] ' : '',
    text: right,
  }
  const leftLine = formatListItem(leftItem)
  const rightLine = formatListItem(rightItem)
  const next = text.slice(0, start) + `${leftLine}\n${rightLine}` + text.slice(end)
  const rightPrefix = rightItem.indent.length + rightItem.marker.length + rightItem.gap.length + rightItem.check.length
  return { type: 'replace', text: next, caret: start + leftLine.length + 1 + rightPrefix }
}

export function handleListTab(text: string, caret: number, shift: boolean): BlockEdit | null {
  const { start, end, line } = lineBounds(text, caret)
  const item = parseListItem(line)
  if (!item) return null
  if (shift && !item.indent) return { type: 'replace', text, caret }
  const nextItem = { ...item, indent: shift ? outdentPrefix(item.indent) : indentPrefix(item.indent) }
  const nextLine = formatListItem(nextItem)
  const delta = nextLine.length - line.length
  const next = replaceLine(text, start, end, nextLine)
  return { type: 'replace', text: next, caret: Math.max(start, caret + delta) }
}

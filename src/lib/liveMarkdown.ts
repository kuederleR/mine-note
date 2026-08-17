import { AGENT_CLOSE, AGENT_OPEN, isAgentBlock } from './agentBlock'
import {
  consumeMineBlock,
  formatMineBlock,
  innerMineMarkdown,
  isMineObjectType,
  mineTypeToBlockKind,
  parseMineFence,
  parseMineOpen,
} from './mineObjects'

export type BlockKind =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'ul'
  | 'ol'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'code'
  | 'toggle'
  | 'hr'
  | 'table'
  | 'agent'
  | 'reminder'

function isFence(line: string): boolean {
  return line.trimStart().startsWith('```')
}

function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s/.test(line)
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line)
}

function isHr(line: string): boolean {
  return /^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)
}

function isTableLine(line: string): boolean {
  return /^\s*\|.+\|\s*$/.test(line)
}

function isAgentOpen(line: string): boolean {
  return AGENT_OPEN.test(line.trim())
}

function isAgentClose(line: string): boolean {
  return AGENT_CLOSE.test(line.trim())
}

function isRowOpen(line: string): boolean {
  return /^<!--\s*mine-row:[A-Za-z0-9_-]+\s*-->\s*$/.test(line.trim())
}

function isRowClose(line: string): boolean {
  return /^<!--\s*\/mine-row\s*-->\s*$/.test(line.trim())
}

function isSpecialStart(line: string): boolean {
  return (
    isFence(line) ||
    isAgentOpen(line) ||
    isRowOpen(line) ||
    Boolean(parseMineOpen(line)) ||
    line.startsWith('>') ||
    isHeading(line) ||
    isListItem(line) ||
    isTableLine(line) ||
    line.trimStart().startsWith(':::') ||
    isHr(line)
  )
}

export function detectBlockKind(text: string): BlockKind {
  const fence = parseMineFence(text)
  if (fence) {
    if (fence.type === 'embed') {
      const nested = innerMineMarkdown(text)
      if (parseMineFence(nested)) return detectBlockKind(nested)
      const srcType = fence.attrs.type
      if (srcType && isMineObjectType(srcType) && srcType !== 'embed') {
        return detectBlockKind(formatMineBlock(srcType, fence.attrs.src || fence.id, nested))
      }
      return detectBlockKind(nested)
    }
    if (fence.type === 'heading') {
      const inner = innerMineMarkdown(text).trimStart()
      if (/^#\s/.test(inner)) return 'h1'
      if (/^##\s/.test(inner)) return 'h2'
      if (/^###\s/.test(inner)) return 'h3'
      return 'h4'
    }
    return mineTypeToBlockKind(fence.type)
  }
  const t = text.trimStart()
  if (isAgentBlock(text)) return 'agent'
  if (t.startsWith('```')) return 'code'
  if (t.startsWith(':::toggle')) return 'toggle'
  if (/^>\s*\[!/i.test(t)) return 'callout'
  if (t.startsWith('>')) return 'quote'
  if (/^#{1}\s/.test(t)) return 'h1'
  if (/^#{2}\s/.test(t)) return 'h2'
  if (/^#{3}\s/.test(t)) return 'h3'
  if (/^#{4,6}\s/.test(t)) return 'h4'
  if (isHr(t)) return 'hr'
  if (/^\s*([-*+]|\d+\.)\s+\[[ xX]\]/.test(t)) return 'todo'
  if (/^\s*[-*+]\s/.test(t)) return 'ul'
  if (/^\s*\d+\.\s/.test(t)) return 'ol'
  if (isTableLine(t.split('\n')[0] || '')) return 'table'
  return 'p'
}

export function splitMarkdownBlocks(src: string): string[] {
  const text = src.replace(/\r\n/g, '\n')
  if (text === '') return ['']

  const lines = text.split('\n')
  const blocks: string[] = []
  let i = 0

  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i += 1
      continue
    }

    const line = lines[i]

    if (isAgentOpen(line)) {
      const start = i
      i += 1
      while (i < lines.length && !isAgentClose(lines[i]) && !isAgentOpen(lines[i])) i += 1
      if (i < lines.length && isAgentClose(lines[i])) i += 1
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    if (isRowOpen(line)) {
      const start = i
      i += 1
      while (i < lines.length && !isRowClose(lines[i]) && !isRowOpen(lines[i])) i += 1
      if (i < lines.length && isRowClose(lines[i])) i += 1
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    if (parseMineOpen(line)) {
      const end = consumeMineBlock(lines, i)
      blocks.push(lines.slice(i, end).join('\n'))
      i = end
      continue
    }

    if (isFence(line)) {
      const start = i
      i += 1
      while (i < lines.length && !isFence(lines[i])) i += 1
      if (i < lines.length) i += 1
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    if (line.trimStart().startsWith(':::toggle')) {
      const start = i
      i += 1
      while (i < lines.length && lines[i].trim() !== ':::') i += 1
      if (i < lines.length) i += 1
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    if (line.startsWith('>')) {
      const start = i
      while (
        i < lines.length &&
        (lines[i].startsWith('>') || (lines[i].trim() === '' && lines[i + 1]?.startsWith('>')))
      ) {
        i += 1
      }
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    if (isHeading(line) || isHr(line)) {
      blocks.push(line)
      i += 1
      continue
    }

    if (isTableLine(line)) {
      const start = i
      i += 1
      while (i < lines.length && (isTableLine(lines[i]) || /^[\s|:\-]+$/.test(lines[i]))) i += 1
      if (i < lines.length && /^\s*<!--\s*mine-table:/.test(lines[i])) i += 1
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    if (isListItem(line)) {
      const start = i
      i += 1
      while (i < lines.length) {
        const next = lines[i]
        if (isListItem(next)) {
          i += 1
          continue
        }
        if (
          next.trim() !== '' &&
          !isSpecialStart(next) &&
          (/^\s{2,}/.test(next) || next.startsWith('\t'))
        ) {
          i += 1
          continue
        }
        break
      }
      blocks.push(lines.slice(start, i).join('\n'))
      continue
    }

    const start = i
    i += 1
    while (i < lines.length && lines[i].trim() !== '' && !isSpecialStart(lines[i])) {
      i += 1
    }
    blocks.push(lines.slice(start, i).join('\n'))
  }

  return blocks.length ? blocks : ['']
}

export function joinMarkdownBlocks(blocks: string[]): string {
  if (blocks.length === 0) return ''
  if (blocks.length === 1) return blocks[0]

  let out = blocks[0]
  for (let i = 1; i < blocks.length; i++) {
    const prevKind = detectBlockKind(blocks[i - 1])
    const kind = detectBlockKind(blocks[i])
    const tight =
      (prevKind === 'ul' || prevKind === 'ol' || prevKind === 'todo') &&
      (kind === 'ul' || kind === 'ol' || kind === 'todo')
    out += tight ? '\n' : '\n\n'
    out += blocks[i]
  }
  return out
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function highlightInline(s: string): string {
  const slots: string[] = []
  const park = (html: string) => {
    slots.push(html)
    return `@@MD${slots.length - 1}@@`
  }

  s = s.replace(/`([^`]+)`/g, (_m, code: string) =>
    park(
      `<span class="md-mark">\`</span><code>${code}</code><span class="md-mark">\`</span>`,
    ),
  )

  s = s.replace(/:([^\s:\[\]]{1,8})\[([^\]]+)\]/g, (_m, tag: string, title: string) =>
    park(
      `<span class="md-mark">:${tag}[</span><span class="md-wiki">${title}</span><span class="md-mark">]</span>`,
    ),
  )

  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, title: string) =>
    park(
      `<span class="md-mark">[[</span><span class="md-wiki">${title}</span><span class="md-mark">]]</span>`,
    ),
  )

  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) =>
    park(
      `<span class="md-mark">[</span><a class="md-link">${label}</a><span class="md-mark">](${href})</span>`,
    ),
  )

  s = s.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) =>
    park(
      `<span class="md-mark">**</span><strong>${inner}</strong><span class="md-mark">**</span>`,
    ),
  )

  s = s.replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, (_m, pre: string, inner: string) =>
    `${pre}<span class="md-mark">*</span><em>${inner}</em><span class="md-mark">*</span>`,
  )

  return s.replace(/@@MD(\d+)@@/g, (_m, idx: string) => slots[Number(idx)] ?? '')
}

function highlightLine(line: string): string {
  const heading = line.match(/^(#{1,6})(\s+)(.*)$/)
  if (heading) {
    return `<span class="md-mark">${heading[1]}</span>${heading[2]}${highlightInline(heading[3])}`
  }

  const list = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/)
  if (list) {
    const check = list[4].match(/^(\[[ xX]\])(\s*)(.*)$/)
    if (check) {
      return `${list[1]}<span class="md-mark">${list[2]}</span>${list[3]}<span class="md-check">${check[1]}</span>${check[2]}${highlightInline(check[3])}`
    }
    return `${list[1]}<span class="md-mark">${list[2]}</span>${list[3]}${highlightInline(list[4])}`
  }

  if (/^(---+|\*\*\*+)$/.test(line)) {
    return `<span class="md-hr">${line}</span>`
  }

  if (line.startsWith('```') || line.startsWith(':::')) {
    return `<span class="md-mark">${line}</span>`
  }

  if (line.startsWith('&gt;')) {
    const rest = line.slice(4)
    if (rest.startsWith(' ')) {
      return `<span class="md-mark">&gt;</span> ${highlightInline(rest.slice(1))}`
    }
    return `<span class="md-mark">&gt;</span>${highlightInline(rest)}`
  }

  return highlightInline(line)
}

export function highlightMarkdownSource(src: string): string {
  return escapeHtml(src).split('\n').map(highlightLine).join('\n')
}

export function toggleNthCheckbox(md: string, index: number): string {
  let n = 0
  return md.replace(/\[([ xX])\]/g, (match, inner: string) => {
    if (n++ !== index) return match
    return inner.trim() === '' ? '[x]' : '[ ]'
  })
}

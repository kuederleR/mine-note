import { createHash } from 'node:crypto'

export type ParsedComponent = {
  id: string
  type:
    | 'heading'
    | 'paragraph'
    | 'list'
    | 'todo'
    | 'code'
    | 'callout'
    | 'toggle'
    | 'quote'
    | 'divider'
    | 'wikilink'
  content: string
  meta: Record<string, unknown>
  position: number
}

function stableId(noteId: string, type: string, content: string, position: number): string {
  const hash = createHash('sha1')
    .update(`${noteId}|${type}|${position}|${content.trim()}`)
    .digest('hex')
    .slice(0, 16)
  return `c_${hash}`
}

function extractWikiLinks(text: string): string[] {
  const links: string[] = []
  const re = /\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    links.push(m[1].trim())
  }
  return links
}

/**
 * Break a markdown note into searchable structural components.
 * Special blocks:
 *   > [!NOTE] / [!TIP] / [!WARN] / [!IDEA]  — callouts
 *   :::toggle Title ... :::                 — toggles
 *   - [ ] / - [x]                           — todos
 *   [[Wiki Link]]                           — wiki links (also extracted as edges)
 */
export function parseNoteToComponents(noteId: string, content: string): ParsedComponent[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const components: ParsedComponent[] = []
  let i = 0
  let position = 0

  const push = (
    type: ParsedComponent['type'],
    text: string,
    meta: Record<string, unknown> = {},
  ) => {
    const trimmed = text.trim()
    if (!trimmed && type !== 'divider') return
    const wikiLinks = extractWikiLinks(trimmed)
    components.push({
      id: stableId(noteId, type, trimmed, position),
      type,
      content: trimmed,
      meta: { ...meta, wikiLinks },
      position,
    })
    position += 1
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }

    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      push('divider', '—', {})
      i += 1
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      push('heading', heading[2], { level: heading[1].length })
      i += 1
      continue
    }

    if (line.trim() === ':::toggle' || line.trim().startsWith(':::toggle ')) {
      const title = line.trim().slice(':::toggle'.length).trim() || 'Toggle'
      const body: string[] = []
      i += 1
      while (i < lines.length && lines[i].trim() !== ':::') {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      push('toggle', `${title}\n${body.join('\n')}`.trim(), { title })
      continue
    }

    const calloutStart = line.match(/^>\s*\[!(NOTE|TIP|WARN|WARNING|IDEA|IMPORTANT)\]\s*(.*)$/i)
    if (calloutStart) {
      const kind = calloutStart[1].toUpperCase().replace('WARNING', 'WARN')
      const body: string[] = []
      if (calloutStart[2]) body.push(calloutStart[2])
      i += 1
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      push('callout', body.join('\n').trim() || kind, { kind })
      continue
    }

    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, '').trim()
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      push('code', body.join('\n'), { language: lang || 'text' })
      continue
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      push('quote', body.join('\n').trim())
      continue
    }

    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      const items: { text: string; checked: boolean }[] = []
      while (i < lines.length && /^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/)
        if (m) items.push({ text: m[2], checked: m[1].toLowerCase() === 'x' })
        i += 1
      }
      push(
        'todo',
        items.map((it) => `${it.checked ? '[x]' : '[ ]'} ${it.text}`).join('\n'),
        { items },
      )
      continue
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const body: string[] = []
      while (
        i < lines.length &&
        (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))
      ) {
        body.push(lines[i].trim())
        i += 1
      }
      push('list', body.join('\n'))
      continue
    }

    const body: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !lines[i].trim().startsWith(':::') &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      body.push(lines[i])
      i += 1
    }
    push('paragraph', body.join('\n'))
  }

  // Standalone wiki-link components for graph edges when a line is mostly links
  for (const c of [...components]) {
    const links = (c.meta.wikiLinks as string[]) || []
    for (const target of links) {
      const already = components.some(
        (x) => x.type === 'wikilink' && x.content === target && x.meta.fromComponent === c.id,
      )
      if (!already) {
        components.push({
          id: stableId(noteId, 'wikilink', `${c.id}->${target}`, position),
          type: 'wikilink',
          content: target,
          meta: { fromComponent: c.id, targetTitle: target },
          position,
        })
        position += 1
      }
    }
  }

  return components
}

export function componentSearchText(c: ParsedComponent): string {
  if (c.type === 'heading') return c.content
  if (c.type === 'callout') return `${c.meta.kind || 'NOTE'}: ${c.content}`
  if (c.type === 'toggle') return `Toggle ${c.meta.title || ''}: ${c.content}`
  if (c.type === 'code') return `Code (${c.meta.language || 'text'}): ${c.content}`
  if (c.type === 'wikilink') return `Link to ${c.content}`
  return c.content
}

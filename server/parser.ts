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
    | 'entity'
    | 'chunk'
    | 'reminder'
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
  const wiki = /\[\[([^\]]+)\]\]/g
  let m: RegExpExecArray | null
  while ((m = wiki.exec(text))) {
    links.push(m[1].trim())
  }
  const tagged = /:([^\s:\[\]]{1,8})\[([^\]]+)\]/g
  while ((m = tagged.exec(text))) {
    links.push(m[2].trim())
  }
  return links
}

function extractTaggedLinks(text: string): Array<{ tag: string; title: string }> {
  const out: Array<{ tag: string; title: string }> = []
  const re = /:([^\s:\[\]]{1,8})\[([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const tag = m[1].trim()
    const title = m[2].trim()
    if (tag && title) out.push({ tag, title })
  }
  return out
}

function unwrapMineComments(src: string): string {
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

/**
 * Break a markdown note into searchable structural components.
 * Special blocks:
 *   > [!NOTE] / [!TIP] / [!WARN] / [!IDEA]  — callouts
 *   :::toggle Title ... :::                 — toggles
 *   - [ ] / - [x]                           — todos
 *   [[Wiki Link]]                           — wiki links (also extracted as edges)
   :@[Name]                               — category tag links (People uses @)
 */
function parseFenceAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z][\w-]*)=(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) out[match[1]] = match[2]
  return out
}

function extractReminderComponents(noteId: string, content: string): ParsedComponent[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const out: ParsedComponent[] = []
  const openRe = /^<!--\s*mine:reminder:([A-Za-z0-9_-]+)((?:\s+[A-Za-z][\w-]*=\S+)*)\s*-->\s*$/
  const closeRe = /^<!--\s*\/mine:reminder\s*-->\s*$/
  let i = 0
  let position = 0
  while (i < lines.length) {
    const match = (lines[i] || '').trim().match(openRe)
    if (!match) {
      i += 1
      continue
    }
    const start = i + 1
    i += 1
    while (i < lines.length && !closeRe.test(lines[i].trim()) && !openRe.test(lines[i].trim())) i += 1
    const title = lines.slice(start, i).join('\n').trim() || 'Reminder'
    const attrs = parseFenceAttrs(match[2] || '')
    out.push({
      id: stableId(noteId, 'reminder', `${match[1]}|${title}|${attrs.due || ''}`, position),
      type: 'reminder',
      content: title,
      meta: { reminderId: match[1], due: attrs.due || '', status: attrs.status || 'todo' },
      position,
    })
    position += 1
    if (i < lines.length && closeRe.test(lines[i].trim())) i += 1
  }
  return out
}

export function parseNoteToComponents(noteId: string, content: string): ParsedComponent[] {
  const reminders = extractReminderComponents(noteId, content)
  const lines = unwrapMineComments(content).replace(/\r\n/g, '\n').split('\n')
  const components: ParsedComponent[] = []
  let i = 0
  let position = reminders.length

  const push = (
    type: ParsedComponent['type'],
    text: string,
    meta: Record<string, unknown> = {},
  ) => {
    const trimmed = text.trim()
    if (!trimmed && type !== 'divider') return
    const wikiLinks = extractWikiLinks(trimmed)
    const taggedLinks = extractTaggedLinks(trimmed)
    components.push({
      id: stableId(noteId, type, trimmed, position),
      type,
      content: trimmed,
      meta: { ...meta, wikiLinks, taggedLinks },
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

    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const body: string[] = []
      const items: { text: string; checked: boolean }[] = []
      let todos = 0
      let total = 0
      while (
        i < lines.length &&
        (/^\s*[-*+]\s+\[[ xX]\]/.test(lines[i]) ||
          /^\s*[-*+]\s+/.test(lines[i]) ||
          /^\s*\d+\.\s+/.test(lines[i]))
      ) {
        const raw = lines[i]
        body.push(raw)
        const todo = raw.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/)
        if (todo) {
          todos += 1
          items.push({ text: todo[2], checked: todo[1].toLowerCase() === 'x' })
        }
        total += 1
        i += 1
      }
      if (todos === total && todos > 0) {
        push('todo', body.join('\n'), { items })
      } else {
        push('list', body.join('\n'))
      }
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

  return [...reminders, ...components]
}

import { formatComponentForSearch } from './objectContext.js'

export function componentSearchText(c: ParsedComponent): string {
  return formatComponentForSearch({ type: c.type, content: c.content, meta: c.meta })
}

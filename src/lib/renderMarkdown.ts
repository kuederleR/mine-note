import { marked } from 'marked'
import type { Category } from '../types'
import { renderObjectChips } from './objectLink'

marked.setOptions({
  gfm: true,
  breaks: true,
})

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderSpecialBlocks(src: string, categories: Category[] = []): string {
  let text = src.replace(/\r\n/g, '\n')

  // Toggles :::toggle Title ... :::
  text = text.replace(
    /:::toggle\s*([^\n]*)\n([\s\S]*?):::/g,
    (_m, title: string, body: string) => {
      const t = escapeHtml(title.trim() || 'Details')
      const inner = marked.parse(body.trim()) as string
      return `<details class="mine-toggle"><summary>${t}</summary><div class="mine-toggle-body">${inner}</div></details>\n\n`
    },
  )

  // Callouts > [!NOTE]
  text = text.replace(
    /^>\s*\[!(NOTE|TIP|WARN|WARNING|IDEA|IMPORTANT)\]\s*(.*)$(?:\n^>\s?(.*)$)*/gm,
    (match, kindRaw: string) => {
      const kind = kindRaw.toUpperCase().replace('WARNING', 'WARN')
      const lines = match.split('\n').map((l) => l.replace(/^>\s?/, ''))
      lines[0] = lines[0].replace(/^\[![^\]]+\]\s*/, '')
      const body = marked.parse(lines.join('\n').trim() || kind) as string
      return `<aside class="mine-callout mine-callout-${kind.toLowerCase()}" data-kind="${kind}"><div class="mine-callout-label">${kind}</div><div class="mine-callout-body">${body}</div></aside>\n\n`
    },
  )

  text = renderObjectChips(text)

  text = text.replace(/:([^\s:\[\]]{1,8})\[([^\]]+)\]/g, (_m, tag: string, title: string) => {
    const t = title.trim()
    const category = categories.find((c) => c.tag === tag)
    const color = category?.color || '#c06a3a'
    const cat = category?.id ? ` data-cat="${escapeHtml(category.id)}"` : ''
    return `<button type="button" class="wiki-link tag-link" data-wiki="${escapeHtml(t)}" data-tag="${escapeHtml(tag)}"${cat} style="--tag-color:${escapeHtml(color)}"><span class="tag-sigil">${escapeHtml(tag)}</span>${escapeHtml(t)}</button>`
  })

  // Wiki links
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_m, title: string) => {
    const t = title.trim()
    return `<button type="button" class="wiki-link" data-wiki="${escapeHtml(t)}">${escapeHtml(t)}</button>`
  })

  return text
}

export function renderNoteHtml(content: string, categories: Category[] = []): string {
  const prepared = renderSpecialBlocks(
    content
      .replace(/<!--\s*mine-agent:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
      .replace(/\s*<!--\s*\/mine-agent\s*-->/gi, '')
      .replace(/<!--\s*mine:[a-z0-9-]+:[A-Za-z0-9_-]+(?:\s+[A-Za-z][\w-]*=\S+)*\s*-->\s*/gi, '')
      .replace(/\s*<!--\s*\/mine:[a-z0-9-]+\s*-->/gi, ''),
    categories,
  )
  return enableTaskCheckboxes(marked.parse(prepared) as string)
}

function enableTaskCheckboxes(html: string): string {
  return html.replace(/<input([^>]*?)\sdisabled(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '<input$1')
}

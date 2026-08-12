import { marked } from 'marked'

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

function renderSpecialBlocks(src: string): string {
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

  // Wiki links
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_m, title: string) => {
    const t = title.trim()
    return `<button type="button" class="wiki-link" data-wiki="${escapeHtml(t)}">${escapeHtml(t)}</button>`
  })

  return text
}

export function renderNoteHtml(content: string): string {
  const prepared = renderSpecialBlocks(content)
  return marked.parse(prepared) as string
}

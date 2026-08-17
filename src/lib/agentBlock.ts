export const AGENT_OPEN = /^<!--\s*mine-agent:([A-Za-z0-9_-]+)\s*-->\s*$/
export const AGENT_CLOSE = /^<!--\s*\/mine-agent\s*-->\s*$/

export function parseAgentId(block: string): string | null {
  const match = block.match(/<!--\s*mine-agent:([A-Za-z0-9_-]+)\s*-->/)
  return match?.[1] || null
}

export function isAgentBlock(block: string): boolean {
  return Boolean(parseAgentId(block))
}

export function innerAgentMarkdown(block: string): string {
  return block
    .replace(/<!--\s*mine-agent:[A-Za-z0-9_-]+\s*-->\s*/i, '')
    .replace(/\s*<!--\s*\/mine-agent\s*-->\s*/i, '')
    .replace(/^\n+|\n+$/g, '')
}

export function formatAgentBlock(id: string, inner = ''): string {
  const body = inner.trim()
  return body
    ? `<!-- mine-agent:${id} -->\n${body}\n<!-- /mine-agent -->`
    : `<!-- mine-agent:${id} -->\n<!-- /mine-agent -->`
}

export function stripAgentComments(src: string): string {
  return src
    .replace(/<!--\s*mine-agent:[A-Za-z0-9_-]+\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*\/mine-agent\s*-->/gi, '')
}

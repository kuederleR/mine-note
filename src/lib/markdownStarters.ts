import type { MineObjectType } from './mineObjects'

export type MarkdownStarterMatch = {
  /** Mine object type; null means a plain markdown block (e.g. code fence). */
  type: MineObjectType | null
  inner: string
  caret: number
}

type StarterRule = {
  re: RegExp
  type: MineObjectType | null
  inner: string | ((match: RegExpMatchArray) => string)
  caret: number | ((inner: string) => number)
}

/** Exact block text patterns that should become objects when typed. */
const STARTERS: StarterRule[] = [
  { re: /^```$/, type: null, inner: '```\n\n```', caret: 4 },
  { re: /^- \[ \] $/, type: 'todo', inner: '- [ ] ', caret: 6 },
  { re: /^> \[!NOTE\] $/i, type: 'callout', inner: '> [!NOTE] ', caret: 10 },
  { re: /^:::toggle $/, type: 'toggle', inner: ':::toggle \n\n:::', caret: 10 },
  { re: /^---$/, type: 'divider', inner: '---', caret: 3 },
  {
    re: /^(#{1,6}) $/,
    type: 'heading',
    inner: (match) => `${match[1]} `,
    caret: (inner) => inner.length,
  },
  {
    re: /^(\d+)\. $/,
    type: 'numbered-list',
    inner: (match) => `${match[1]}. `,
    caret: (inner) => inner.length,
  },
  {
    re: /^[-*+] $/,
    type: 'list',
    inner: '- ',
    caret: 2,
  },
  { re: /^> $/, type: 'quote', inner: '> ', caret: 2 },
]

/**
 * If the block text is exactly a markdown object starter and the caret is at
 * the end, return the object/block that should replace it.
 */
export function matchMarkdownStarter(text: string, caret: number): MarkdownStarterMatch | null {
  if (caret !== text.length) return null
  const value = text.replace(/\r\n/g, '\n')
  if (!value || /^<!--\s*mine:/.test(value.trimStart())) return null

  for (const rule of STARTERS) {
    const match = value.match(rule.re)
    if (!match) continue
    const inner = typeof rule.inner === 'function' ? rule.inner(match) : rule.inner
    const nextCaret = typeof rule.caret === 'function' ? rule.caret(inner) : rule.caret
    return { type: rule.type, inner, caret: nextCaret }
  }
  return null
}

/** Caret for a freshly created object body (after the markdown prefix). */
export function defaultInnerCaret(inner: string): number {
  const normalized = inner.replace(/\r\n/g, '\n')
  const starter = matchMarkdownStarter(normalized, normalized.length)
  if (starter) return starter.caret
  if (/^```\n/.test(normalized)) return 4
  return normalized.length
}

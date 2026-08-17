function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function wikiTarget(raw: string): string {
  return raw.split('|')[0].trim()
}

/** Titles already linked as `[[Title]]` or `:tag[Title]`. */
export function extractLinkTitles(text: string): string[] {
  const titles: string[] = []
  const wiki = /\[\[([^\]]+)\]\]/g
  const tagged = /:([^\s:\[\]]{1,8})\[([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = wiki.exec(text))) {
    const title = wikiTarget(m[1])
    if (title) titles.push(title)
  }
  while ((m = tagged.exec(text))) {
    const title = m[2].trim()
    if (title) titles.push(title)
  }
  return titles
}

/** True when `title` already appears as a wiki or tagged Mine link. */
export function alreadyLinked(text: string, title: string): boolean {
  const t = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:\\[\\[${t}(?:\\|[^\\]]+)?\\]\\]|:[^\\s:\\[\\]]{1,8}\\[${t}\\])`, 'iu')
  return re.test(text)
}

function namesOverlap(linkedTitle: string, name: string): boolean {
  const a = normalizeName(linkedTitle)
  const b = normalizeName(name)
  if (!a || !b) return false
  if (a === b) return true
  const aFirst = a.split(/\s+/)[0] || ''
  const bFirst = b.split(/\s+/)[0] || ''
  if (aFirst.length >= 3 && aFirst === bFirst) return true
  if (a.startsWith(`${b} `) || b.startsWith(`${a} `)) return true
  return false
}

/** True when this entity (title or alias) is already linked anywhere in the text. */
export function entityLinkedInText(text: string, names: string[]): boolean {
  const linked = extractLinkTitles(text)
  if (!linked.length) return false
  const wanted = names.map(normalizeName).filter((n) => n.length >= 2)
  for (const title of linked) {
    for (const name of wanted) {
      if (namesOverlap(title, name)) return true
    }
  }
  return false
}

/** True when the span at `start` sits inside `[[…]]` or `:tag[…]`. */
export function surfaceIsAlreadyLinked(text: string, start: number, length: number): boolean {
  if (start < 0 || length <= 0 || start + length > text.length) return false
  const before = text.slice(0, start)

  const wikiOpen = before.lastIndexOf('[[')
  const wikiClose = before.lastIndexOf(']]')
  if (wikiOpen > wikiClose) return true

  const lastOpen = before.lastIndexOf('[')
  const lastClose = before.lastIndexOf(']')
  if (lastOpen > lastClose) {
    const colon = before.lastIndexOf(':')
    if (colon >= 0 && colon < lastOpen) {
      const tag = before.slice(colon + 1, lastOpen)
      if (tag.length > 0 && tag.length <= 8 && !/[\s:\[]/.test(tag)) return true
    }
    if (before.slice(Math.max(0, lastOpen - 1), lastOpen) === '[') return true
  }

  return alreadyLinked(text, text.slice(start, start + length))
}

/** Offsets of `alias` that are not already inside a Mine/wiki link. */
export function findUnlinkedSurfaces(text: string, alias: string): number[] {
  const indices: number[] = []
  const needle = alias.trim()
  if (needle.length < 2) return indices
  const lower = text.toLowerCase()
  const want = needle.toLowerCase()
  let from = 0
  while (from < lower.length) {
    const at = lower.indexOf(want, from)
    if (at < 0) break
    const before = at === 0 ? ' ' : lower[at - 1]
    const after = at + want.length >= lower.length ? ' ' : lower[at + want.length]
    if (
      !/\p{L}|\p{N}/u.test(before) &&
      !/\p{L}|\p{N}/u.test(after) &&
      !surfaceIsAlreadyLinked(text, at, want.length)
    ) {
      indices.push(at)
    }
    from = at + want.length
  }
  return indices
}

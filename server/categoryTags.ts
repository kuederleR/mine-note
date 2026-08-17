const SYMBOLS = ['@', '#', '&', '*', '+', '~', '%', '!']

export function normalizeTag(raw: string): string {
  return raw.replace(/[:\[\]\s]/g, '').slice(0, 8)
}

export function preferredTag(name: string): string {
  const n = name.trim().toLowerCase()
  if (n === 'people' || n === 'person') return '@'
  return ''
}

export function uniqueTag(
  name: string,
  taken: Iterable<string>,
  requested?: string | null,
  reserved: Iterable<string> = ['>'],
): string {
  const used = new Set(
    [...taken, ...reserved]
      .map((tag) => normalizeTag(tag).toLowerCase())
      .filter(Boolean),
  )
  const claim = (value: string) => {
    const tag = normalizeTag(value)
    if (!tag) return null
    if (used.has(tag.toLowerCase())) return null
    return tag
  }

  const hit =
    (requested ? claim(requested) : null) ||
    claim(preferredTag(name)) ||
    [...name.toLowerCase().replace(/[^a-z0-9]/g, '')].reduce<string | null>(
      (found, ch) => found || claim(ch),
      null,
    ) ||
    SYMBOLS.reduce<string | null>((found, ch) => found || claim(ch), null)

  if (hit) return hit

  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 3) || 'tag'
  let n = 2
  let candidate = base
  for (;;) {
    const next = claim(candidate)
    if (next) return next
    candidate = `${base}${n}`
    n += 1
  }
}

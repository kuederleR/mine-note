import type { ParsedComponent } from './parser.js'
import { formatComponentForSearch } from './objectContext.js'

export function splitPassages(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\n+/)) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trim()
    if (!line) continue
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/).map((s) => s.trim()).filter((s) => s.length > 2)
    if (parts.length) out.push(...parts)
    else if (line.length > 2) out.push(line)
  }
  return out
}

export function namesMentionedIn(text: string, knownNames: string[]): string[] {
  const lower = text.toLowerCase()
  return knownNames
    .filter((n) => n.trim().length > 1 && lower.includes(n.trim().toLowerCase()))
    .sort((a, b) => b.length - a.length)
}

export type EmbedContext = {
  title: string
  category?: string | null
  headingPath?: string[]
  mentions?: string[]
}

/** Hierarchical path used for both display metadata and embedding prefix. */
export function formatContextPath(title: string, headingPath: string[] = []): string {
  const parts: string[] = []
  const push = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim()
    if (!v) return
    if (parts[parts.length - 1]?.toLowerCase() === v.toLowerCase()) return
    parts.push(v)
  }
  push(title)
  for (const h of headingPath) push(h)
  return parts.join(' > ')
}

/** Text sent to the embedder. Raw note content stays untouched in `content`. */
export function wrapForEmbedding(passage: string, ctx: EmbedContext): string {
  const path = formatContextPath(ctx.title, ctx.headingPath ?? [])
  const prefix = ctx.category?.trim() ? `[${ctx.category.trim()}] ` : ''
  const body = passage.replace(/\s+/g, ' ').trim()
  const line = `${prefix}${path}: ${body}`
  if (!ctx.mentions?.length) return line
  return `${line}\nEntities: ${ctx.mentions.slice(0, 6).join(', ')}`
}

export type ContextualizedComponent = {
  comp: ParsedComponent
  embedInput: string
  contextPath: string
}

const CHUNKABLE = new Set(['paragraph', 'list', 'todo', 'quote', 'callout', 'toggle'])

export function contextualizeComponents(
  noteTitle: string,
  categoryName: string | null,
  components: ParsedComponent[],
  knownNames: string[] = [],
): ContextualizedComponent[] {
  const wikiMentions = [
    ...new Set(
      components.flatMap((c) => (Array.isArray(c.meta.wikiLinks) ? (c.meta.wikiLinks as string[]) : [])),
    ),
  ]
  const whole = [noteTitle, ...components.map((c) => c.content)].join('\n')
  const mentionedNames = namesMentionedIn(whole, knownNames)
  const mentions = [...new Set([...mentionedNames, ...wikiMentions])]

  const headingStack: Array<{ level: number; text: string }> = []
  const out: ContextualizedComponent[] = []
  let extraPos = 20_000

  const headingPath = () => headingStack.map((h) => h.text)

  const pack = (comp: ParsedComponent, passage: string): ContextualizedComponent => {
    const ctx: EmbedContext = {
      title: noteTitle,
      category: categoryName,
      headingPath: headingPath(),
      mentions,
    }
    const contextPath = formatContextPath(noteTitle, ctx.headingPath)
    const meta = {
      ...comp.meta,
      mentions,
      contextPath,
      searchText: wrapForEmbedding(passage, ctx),
    }
    return {
      comp: { ...comp, meta },
      embedInput: wrapForEmbedding(passage, ctx),
      contextPath,
    }
  }

  for (const comp of components) {
    if (comp.type === 'heading') {
      const level = typeof comp.meta.level === 'number' ? comp.meta.level : 1
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
        headingStack.pop()
      }
      if (!comp.meta.isTitle) headingStack.push({ level, text: comp.content })
    }

    if (comp.type === 'divider') {
      out.push({ comp, embedInput: '', contextPath: formatContextPath(noteTitle, headingPath()) })
      continue
    }

    const typed =
      comp.type === 'entity'
        ? comp.content
        : formatComponentForSearch({ type: comp.type, content: comp.content, meta: comp.meta }) ||
          comp.content ||
          noteTitle
    out.push(pack(comp, typed))

    if (CHUNKABLE.has(comp.type)) {
      const passages = splitPassages(comp.content)
      const skipWhole = passages.length === 1 && passages[0] === comp.content.trim()
      if (!skipWhole) {
        for (const passage of passages) {
          extraPos += 1
          out.push(
            pack(
              {
                id: `${comp.id}_p${extraPos}`,
                type: 'chunk',
                content: passage,
                meta: { fromComponent: comp.id, heading: headingPath().at(-1) || noteTitle, isChunk: true },
                position: extraPos,
              },
              passage,
            ),
          )
        }
      }
    }
  }

  return out
}

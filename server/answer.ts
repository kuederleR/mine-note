import { generateJson, getGeneratorStatus } from './generate.js'
import { formatWorldPrompt, type WorldSnapshot } from './world.js'
import { formatEvidenceBlock } from './objectContext.js'
import { buildObjectLegend } from './objectSpecs.js'

export type AnswerSource = {
  noteId: string
  noteTitle: string
  componentId: string
  snippet: string
  type: string
  score: number
  categoryName?: string | null
}

export type AnswerOption = {
  id: string
  label: string
  text: string
  bullets: string[]
  sources: AnswerSource[]
}

export type SynthesizedAnswer = {
  text: string
  bullets: string[]
  sources: AnswerSource[]
  alternatives: AnswerOption[]
}

export type AnswerMatch = {
  componentId: string
  noteId: string
  noteTitle: string
  type: string
  content: string
  score: number
  categoryName?: string | null
  meta?: Record<string, unknown>
}

export function cleanText(text: string): string {
  return text
    .replace(/^\[[a-z0-9-]+\]\s*/gim, '')
    .replace(/^this note is a .+? entity\.?\s*/gim, '')
    .replace(/^represent who or what it is.*$/gim, '')
    .replace(/^name:\s*/gim, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*\[!\w+\]\s*/gim, '')
    .replace(/^>\s?/gm, '')
    .replace(/^:::toggle\s*/gm, '')
    .replace(/^:::\s*$/gm, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isBoilerplate(text: string): boolean {
  const s = text.toLowerCase()
  if (!s) return true
  if (/^this note is a .+ entity/.test(s)) return true
  if (/^represent who or what/.test(s)) return true
  if (/^key facts, relationships/.test(s)) return true
  if (/^\[[a-z0-9-]+\]$/.test(s)) return true
  return false
}

function snippet(text: string, max = 160): string {
  const one = cleanText(text)
  if (isBoilerplate(one)) return ''
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function toSource(m: AnswerMatch): AnswerSource {
  return {
    noteId: m.noteId,
    noteTitle: m.noteTitle,
    componentId: m.componentId,
    snippet: snippet(m.content, 140),
    type: m.type,
    score: m.score,
    categoryName: m.categoryName,
  }
}

export type AnswerOptions = {
  world?: WorldSnapshot | null
  /**
   * Excerpts are approximate vector hits (below the usual score bar).
   * Trust Gemma's unknown flag; do not invent an extractive answer from weak matches.
   */
  softEvidence?: boolean
}

function uniqueSources(matches: AnswerMatch[], limit = 5): AnswerSource[] {
  const seen = new Set<string>()
  const out: AnswerSource[] = []
  const ranked = [...matches].sort((a, b) => b.score - a.score)
  for (const m of ranked) {
    if (seen.has(m.noteId)) continue
    const source = toSource(m)
    seen.add(m.noteId)
    if (!source.snippet) source.snippet = m.noteTitle
    out.push(source)
    if (out.length >= limit) break
  }
  return out
}

function splitUnits(text: string): string[] {
  const units: string[] = []
  for (const line of text.split(/\n+/)) {
    const cleaned = cleanText(line)
    if (!cleaned) continue
    const bits = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    for (const bit of bits) {
      const t = bit.trim()
      if (t) units.push(t)
    }
  }
  return units
}

const SKIP_TYPES = new Set(['entity', 'wikilink', 'divider', 'code'])

function evidencePassages(matches: AnswerMatch[]): Array<{ text: string; noteId: string; noteTitle: string }> {
  const seen = new Set<string>()
  const out: Array<{ text: string; noteId: string; noteTitle: string }> = []
  for (const m of matches) {
    if (SKIP_TYPES.has(m.type)) continue
    const parts = m.type === 'chunk' || m.type === 'heading' ? [cleanText(m.content)] : splitUnits(m.content)
    for (const unit of parts) {
      if (!unit || isBoilerplate(unit)) continue
      if (unit.toLowerCase() === m.noteTitle.toLowerCase()) continue
      const key = unit.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ text: unit, noteId: m.noteId, noteTitle: m.noteTitle })
    }
  }
  return out
}

function ensurePeriod(text: string): string {
  if (/[.!?]$/.test(text)) return text
  return `${text}.`
}

function composeFrom(matches: AnswerMatch[], query = ''): { text: string; bullets: string[] } {
  const passages = evidencePassages(matches)
  if (!passages.length) {
    const titles = [...new Set(matches.map((m) => m.noteTitle))]
    return {
      text:
        titles.length === 1
          ? `${titles[0]} is in your notes, but I couldn’t extract a specific fact from the matching lines.`
          : `I found related pages (${titles.slice(0, 3).join(', ')}), but not a clear fact.`,
      bullets: [],
    }
  }

  const ranked = [...passages].sort((a, b) => {
    const aq = attributeBoostLocal(query, a.text)
    const bq = attributeBoostLocal(query, b.text)
    return bq - aq
  })
  const lead = ranked[0]
  const sameNote = ranked.filter((p) => p.noteId === lead.noteId)
  const leadText = ensurePeriod(lead.text)
  const text =
    lead.noteTitle && lead.text.toLowerCase() !== lead.noteTitle.toLowerCase()
      ? `${leadText} (${lead.noteTitle})`
      : leadText
  return { text, bullets: sameNote.slice(1, 3).map((p) => p.text) }
}

function attributeBoostLocal(query: string, content: string): number {
  const q = query.toLowerCase()
  const blob = content.toLowerCase()
  if (!q) return 0
  if (/\b(phone|mobile|cell|telephone|number)\b/.test(q)) {
    if (/(?:\b(?:c|phone|tel|mobile|cell)\b\s*:?\s*)?\+?\d[\d\s().-]{6,}\d/.test(blob)) return 2
    if (/\b(?:c|phone|tel|mobile|cell)\s*:/.test(blob)) return 1
  }
  if (/\b(email|e-mail)\b/.test(q) && /\b\S+@\S+\.\S+\b/.test(blob)) return 2
  return 0
}

function byNote(matches: AnswerMatch[]): Map<string, AnswerMatch[]> {
  const map = new Map<string, AnswerMatch[]>()
  for (const m of matches) {
    const list = map.get(m.noteId) || []
    list.push(m)
    map.set(m.noteId, list)
  }
  return map
}

export function synthesizeAnswer(
  query: string,
  matches: AnswerMatch[],
  options: AnswerOptions = {},
): SynthesizedAnswer {
  const empty: SynthesizedAnswer = {
    text: 'I don’t see that in your notes.',
    bullets: [],
    sources: [],
    alternatives: [],
  }

  if (!query.trim() || matches.length === 0) return empty

  const ranked = [...matches].sort((a, b) => b.score - a.score)
  const best = ranked[0].score
  const near = ranked.filter((m) => m.score >= best - 0.08)
  const attr = ranked.filter((m) => attributeBoostLocal(query, m.content) > 0)
  const evidenceMap = new Map<string, AnswerMatch>()
  for (const m of [...attr, ...near, ...ranked.slice(0, 6)]) evidenceMap.set(m.componentId, m)
  const evidence = [...evidenceMap.values()]
  const composed = composeFrom(evidence, query)
  const sources = uniqueSources(evidence)

  const alternatives: AnswerOption[] = []
  const grouped = byNote(ranked)
  const primaryNote = evidence[0]?.noteId
  for (const [noteId, items] of grouped) {
    if (noteId === primaryNote) continue
    const top = items[0]
    if (!top || top.score < best - 0.1) continue
    const option = composeFrom(items.slice(0, 3), query)
    alternatives.push({
      id: noteId,
      label: `From ${top.noteTitle}`,
      text: option.text,
      bullets: option.bullets,
      sources: uniqueSources(items, 3),
    })
    if (alternatives.length >= 2) break
  }

  return {
    text: composed.text,
    bullets: composed.bullets,
    sources,
    alternatives,
  }
}

type GemmaAnswerRaw = {
  text?: string
  bullets?: string[]
  sourceNoteIds?: string[]
  unknown?: boolean
}

const GROUNDING_SYSTEM = `Answer using only the note excerpts and optional World context. JSON only:
{"text":"1-2 sentence answer","bullets":[],"sourceNoteIds":["..."],"unknown":false}
Rules: decide from the question whether a short fact, a how-to tip, or a list of pages/items fits best; put enumerations in bullets (page titles or items); use only excerpt facts for notes; treat lines like "c: 614…" as phone/contact numbers when asked; prefer meeting/date excerpts for when/last questions; respect typed object lines (Reminder due=, Todo open=, Table, List, Callout, etc.); World context may be used for now/today/timezone/locale (do not invent other world facts); unknown=true only if nothing answers; cite noteIds; max 4 bullets.`

const SOFT_GROUNDING_SYSTEM = `These note excerpts are the closest vector matches — they may be unrelated to the question. JSON only:
{"text":"1-2 sentence answer","bullets":[],"sourceNoteIds":["..."],"unknown":false}
Rules: answer ONLY if an excerpt clearly helps; shape the reply to the question (fact, tip, or short list in bullets); set unknown=true if they are off-topic or insufficient (say you don't see it in the notes); never invent facts or stretch a weak match; use only excerpt facts when answering; World context may be used for now/today/timezone/locale; cite sourceNoteIds when useful; max 4 bullets.`

function formatEvidence(matches: AnswerMatch[], limit = 6): string {
  const ranked = [...matches].sort((a, b) => b.score - a.score)
  const out: string[] = []
  const perNote = new Map<string, number>()
  const types: string[] = []
  for (const m of ranked) {
    if (out.length >= limit) break
    const used = perNote.get(m.noteId) || 0
    if (used >= 2) continue
    const body = cleanText(m.content).slice(0, 280)
    if (!body || isBoilerplate(body)) continue
    perNote.set(m.noteId, used + 1)
    types.push(m.type)
    out.push(
      formatEvidenceBlock({
        index: out.length + 1,
        type: m.type,
        content: m.content,
        meta: m.meta,
        noteId: m.noteId,
        noteTitle: m.noteTitle,
      }),
    )
  }
  const legend = buildObjectLegend(types)
  return [legend, out.join('\n\n')].filter(Boolean).join('\n\n')
}

function sourcesForIds(matches: AnswerMatch[], ids: string[]): AnswerSource[] {
  if (!ids.length) return uniqueSources(matches)
  const byId = new Map(matches.map((m) => [m.noteId, m]))
  const out: AnswerSource[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    const m = byId.get(id)
    if (!m) continue
    seen.add(id)
    const source = toSource(m)
    if (!source.snippet) source.snippet = m.noteTitle
    out.push(source)
    if (out.length >= 5) break
  }
  return out.length ? out : uniqueSources(matches)
}

function emptyUnknown(relatedTitle?: string): SynthesizedAnswer {
  return {
    text: relatedTitle
      ? `I don’t see that in your notes about ${relatedTitle}.`
      : 'I don’t see that in your notes.',
    bullets: [],
    sources: [],
    alternatives: [],
  }
}

/** Gemma grounded answer; falls back to extractive synthesizeAnswer. */
export async function synthesizeAnswerWithGemma(
  query: string,
  matches: AnswerMatch[],
  options: AnswerOptions & { timeoutMs?: number } = {},
): Promise<SynthesizedAnswer> {
  const soft = Boolean(options.softEvidence)
  const fallback = soft
    ? emptyUnknown()
    : synthesizeAnswer(query, matches, options)
  if (!query.trim() || matches.length === 0) return fallback
  if (!getGeneratorStatus().ready) return fallback

  const evidence = formatEvidence(matches, soft ? 5 : 6)
  if (!evidence) return fallback

  try {
    const raw = await generateJson<GemmaAnswerRaw>(
      [
        options.world ? formatWorldPrompt(options.world) : '',
        soft
          ? 'These are approximate nearest matches, not confirmed hits. Prefer unknown=true when unsure.'
          : '',
        `Question:\n${query.trim()}`,
        `Excerpts:\n${evidence}`,
        'JSON only.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      {
        system: soft ? SOFT_GROUNDING_SYSTEM : GROUNDING_SYSTEM,
        timeoutMs: options.timeoutMs ?? 20_000,
        numPredict: 220,
        numCtx: 4096,
        temperature: 0.2,
      },
    )
    if (raw.unknown) {
      if (soft) {
        return {
          text: String(raw.text || '').trim() || emptyUnknown().text,
          bullets: [],
          sources: [],
          alternatives: [],
        }
      }
      // Prefer extractive answer when Gemma abstains but passages exist.
      const refused =
        /don’t see that in your notes/i.test(fallback.text) && fallback.bullets.length === 0
      if (!refused) return fallback
      return {
        text: String(raw.text || '').trim() || 'I don’t see that in your notes.',
        bullets: [],
        sources: uniqueSources(matches, 3),
        alternatives: fallback.alternatives,
      }
    }
    const text = String(raw.text || '').trim()
    if (!text) return fallback
    const bullets = Array.isArray(raw.bullets)
      ? raw.bullets.map((b) => String(b || '').trim()).filter(Boolean).slice(0, 4)
      : []
    const ids = Array.isArray(raw.sourceNoteIds)
      ? raw.sourceNoteIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
    return {
      text,
      bullets,
      sources: sourcesForIds(matches, ids),
      alternatives: soft ? [] : fallback.alternatives,
    }
  } catch {
    return fallback
  }
}

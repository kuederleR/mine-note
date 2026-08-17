import { generateJson, getGeneratorStatus } from './generate.js'
import type { HistoryTurn } from './conversation.js'

export type QueryRewrite = {
  searchQuery: string
  aliases: string[]
}

const DEIXIS = /\b(she|he|her|him|they|them|their|this|that|those|these|it|we|our)\b/i

/** Cheap local rewrite: inject focus names for pronouns; no Gemma. */
export function cheapRewrite(
  query: string,
  focusTitles: string[] = [],
): QueryRewrite {
  const q = query.trim()
  const focus = focusTitles.map((t) => t.trim()).filter(Boolean).slice(0, 6)
  const needsNames = focus.length > 0 && DEIXIS.test(q)
  const searchQuery = needsNames ? `${q} ${focus.join(' ')}` : q
  return {
    searchQuery,
    aliases: focus.filter((t) => t.toLowerCase() !== searchQuery.toLowerCase()),
  }
}

function needsLlmRewrite(query: string, history?: HistoryTurn[]): boolean {
  if (!DEIXIS.test(query)) return false
  // Pronouns with no history can't be resolved usefully by Gemma either.
  return Boolean(history?.some((t) => t.query || t.sources?.length))
}

const SYSTEM = `You prepare private note search queries.
Given a user question, return JSON only:
{
  "searchQuery": "short phrase in the language of personal notes (names, topics, facts)",
  "aliases": ["alternate names or key terms to search", "..."]
}
Rules:
- searchQuery should help find matching note passages, not answer the question.
- Resolve pronouns using people/pages in the conversation.
- Keep searchQuery under 12 words. aliases: 0-4 short strings.
- Do not invent note content. Do not answer the question. Do not classify intent.`

function normalizeRewrite(raw: Partial<QueryRewrite>, fallback: string): QueryRewrite {
  const searchQuery = String(raw.searchQuery || '').trim() || fallback
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .map((item) => String(item || '').trim())
        .filter((item) => item && item.toLowerCase() !== searchQuery.toLowerCase())
        .slice(0, 4)
    : []
  return { searchQuery, aliases }
}

/**
 * Prefer a free local rewrite. Only call Gemma for pronoun follow-ups when
 * Ollama is already warm — otherwise fall back to cheapRewrite.
 */
export async function rewriteQuery(
  query: string,
  options: {
    history?: HistoryTurn[]
    focusTitles?: string[]
    timeoutMs?: number
    /** Force skipping the LLM even for deixis. */
    cheapOnly?: boolean
  } = {},
): Promise<QueryRewrite> {
  const q = query.trim()
  const focus = (options.focusTitles || []).filter(Boolean).slice(0, 6)
  const local = cheapRewrite(q, focus)
  if (!q || options.cheapOnly || !needsLlmRewrite(q, options.history)) return local
  if (!getGeneratorStatus().ready) return local

  const history = (options.history || [])
    .slice(-3)
    .map((turn) => {
      const titles = (turn.sources || [])
        .map((s) => s.noteTitle)
        .filter(Boolean)
        .slice(0, 3)
      const cited = titles.length ? `\nCited: ${titles.join(', ')}` : ''
      return `Q: ${turn.query}${cited}`
    })
    .join('\n')

  try {
    const raw = await generateJson<Partial<QueryRewrite>>(
      [
        history ? `Conversation:\n${history}` : '',
        focus.length ? `Focus: ${focus.join(', ')}` : '',
        `Question: ${q}`,
        'JSON only.',
      ]
        .filter(Boolean)
        .join('\n'),
      {
        system: SYSTEM,
        timeoutMs: options.timeoutMs ?? 12_000,
        numPredict: 120,
        numCtx: 2048,
        temperature: 0.1,
      },
    )
    const normalized = normalizeRewrite(raw, local.searchQuery)
    const extra = focus.filter(
      (t) =>
        t.toLowerCase() !== normalized.searchQuery.toLowerCase() &&
        !normalized.aliases.some((a) => a.toLowerCase() === t.toLowerCase()),
    )
    return {
      ...normalized,
      aliases: [...normalized.aliases, ...extra].slice(0, 6),
    }
  } catch {
    return local
  }
}

/** Texts to embed for retrieval: rewritten query + aliases + original. */
export function retrievalTexts(
  query: string,
  rewrite: QueryRewrite | null,
  extra: string[] = [],
): string[] {
  const q = query.trim()
  const out = rewrite
    ? [rewrite.searchQuery, q, ...rewrite.aliases, ...extra]
    : [q, ...extra]
  const seen = new Set<string>()
  return out.filter((text) => {
    const key = text.trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 6)
}

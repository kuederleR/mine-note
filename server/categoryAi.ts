import { cosineSimilarity, embedText } from './embeddings.js'
import { buildEntityText, getCategoryRow, listCategories, type CategoryDTO, type CategoryInput } from './categories.js'
import { CATEGORY_COLORS, defaultLucideIcon, isLucideIconName, LUCIDE_ICON_NAMES } from './categoryIcons.js'
import { uniqueTag, preferredTag } from './categoryTags.js'
import { getWorkspaceSettings } from './workspaceSettings.js'
import { db } from './db.js'
import { wrapForEmbedding } from './embedContext.js'
import { generateJson, streamChat, warmGenerator } from './generate.js'

export type CategoryDraft = {
  name: string
  icon: string
  color: string
  description: string
  embedInstruction: string
  queryHints: string
  template: string
  tag: string
}

export type CategoryMatch = {
  id: string
  name: string
  icon: string
  color: string
  score: number
}

const MATCH_MIN = 0.32
const LEAD_GAP = 0.04
const SAME_KIND_MIN = 0.62

function pickColor(value: unknown, fallbackIndex = 0): string {
  if (typeof value === 'string' && CATEGORY_COLORS.includes(value)) return value
  return CATEGORY_COLORS[fallbackIndex % CATEGORY_COLORS.length]
}

function pickIcon(value: unknown, name: string): string {
  if (typeof value === 'string' && isLucideIconName(value)) return value
  return defaultLucideIcon(name)
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

export function draftToInput(draft: CategoryDraft): CategoryInput {
  return {
    name: draft.name,
    icon: draft.icon,
    color: draft.color,
    description: draft.description,
    embedInstruction: draft.embedInstruction,
    queryHints: draft.queryHints,
    template: draft.template,
    tag: draft.tag,
  }
}

function normalizeDraft(raw: Record<string, unknown>, fallbackName: string): CategoryDraft {
  const name = asString(raw.name, fallbackName) || fallbackName
  const taken = listCategories().map((c) => c.tag)
  return {
    name,
    icon: pickIcon(raw.icon, name),
    color: pickColor(raw.color),
    description: asString(raw.description),
    embedInstruction:
      asString(raw.embedInstruction) ||
      `This note is a ${name} page. Represent the kind of thing it is, key facts, and how it connects to other notes.`,
    queryHints: asString(raw.queryHints),
    template: asString(raw.template) || `# {{title}}\n\n`,
    tag: uniqueTag(name, taken, preferredTag(name) || asString(raw.tag), getWorkspaceSettings().reservedShortcuts),
  }
}

function existingSummary(categories: CategoryDTO[]): string {
  if (!categories.length) return '(none yet)'
  return categories.map((c) => `- ${c.name} (:${c.tag}): ${c.description || c.embedInstruction || 'no description'}`).join('\n')
}

const SETUP_SYSTEM = `You set up categories for Mine, a local-first notes app.
Each category has an embedding instruction. That instruction is prepended when a page in the category is indexed, so search can tell people from meetings from projects.
Write embedInstruction as a short, concrete representation guide (2-3 sentences). Do not mention embeddings or models.
queryHints are comma-separated phrases someone might ask.
template is markdown for a new page. Use {{title}} for the page name.
tag is a short inline shortcut (1-4 characters, no spaces or colons). Typing :{tag} in a note links to a page in this category. People use @. Must be unique vs existing tags and must not use reserved shortcuts (especially > for inline AI).
icon must be one of: ${LUCIDE_ICON_NAMES.join(', ')}
color must be one of: ${CATEGORY_COLORS.join(', ')}
Return JSON only with keys: name, icon, color, description, embedInstruction, queryHints, template, tag.`

const ASSIGN_SYSTEM = `You assign notes to categories in Mine, a local-first notes app.
Prefer an existing category whenever the note is the same kind of page — including synonyms, narrower names, and overlapping ideas.
Only create a new category when this note is a different kind of page than every existing category.
Return JSON only.
If it belongs in an existing category: {"action":"existing","name":"<exact existing category name>"}
If it needs a new category: {"action":"new","name":"...","icon":"...","color":"...","description":"...","embedInstruction":"...","queryHints":"...","template":"...","tag":"..."}
icon must be one of: ${LUCIDE_ICON_NAMES.join(', ')}
color must be one of: ${CATEGORY_COLORS.join(', ')}`

export type CategoryDraftEvent = {
  type: 'status' | 'partial' | 'done' | 'error'
  status?: string
  progress?: number
  draft?: CategoryDraft
  error?: string
}

const FIELD_STATUS: Array<{ key: keyof CategoryDraft; status: string; progress: number }> = [
  { key: 'description', status: 'Writing what belongs here…', progress: 0.42 },
  { key: 'icon', status: 'Choosing an icon…', progress: 0.52 },
  { key: 'color', status: 'Picking a color…', progress: 0.58 },
  { key: 'tag', status: 'Choosing a :tag shortcut…', progress: 0.64 },
  { key: 'embedInstruction', status: 'Writing embedding instructions…', progress: 0.72 },
  { key: 'queryHints', status: 'Adding query hints…', progress: 0.82 },
  { key: 'template', status: 'Building the page template…', progress: 0.9 },
]

function extractPartial(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'icon', 'color', 'tag', 'description', 'embedInstruction', 'queryHints', 'template']) {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`))
    if (!match) continue
    try {
      out[key] = JSON.parse(`"${match[1]}"`)
    } catch {
      out[key] = match[1]
    }
  }
  return out
}

function latestStatus(partial: Record<string, unknown>): { status: string; progress: number } {
  let status = 'Asking Gemma to draft this category…'
  let progress = 0.32
  for (const field of FIELD_STATUS) {
    if (asString(partial[field.key])) {
      status = field.status
      progress = field.progress
    }
  }
  return { status, progress }
}

export async function draftCategoryWithProgress(
  input: { name?: string; prompt?: string },
  emit: (event: CategoryDraftEvent) => void,
): Promise<CategoryDraft> {
  const name = (input.name || '').trim()
  const prompt = (input.prompt || '').trim()
  if (!name && !prompt) throw new Error('Give a category name or a short description of what belongs in it.')

  emit({ type: 'status', status: 'Checking Gemma…', progress: 0.08 })
  await warmGenerator()
  emit({ type: 'status', status: 'Looking at existing categories…', progress: 0.18 })
  const categories = listCategories()
  emit({ type: 'status', status: 'Asking Gemma to draft this category…', progress: 0.28 })

  let lastStatus = ''
  const text = await streamChat(
    `Existing categories:\n${existingSummary(categories)}

Requested name: ${name || '(choose a clear plural or collective name)'}
What belongs here: ${prompt || '(infer from the name)'}

Propose a category that does not duplicate an existing one.`,
    {
      system: SETUP_SYSTEM,
      json: true,
      onContent: (full) => {
        const partial = extractPartial(full)
        const next = latestStatus(partial)
        const draft = normalizeDraft({ ...partial, name: name || partial.name }, name || 'Category')
        if (next.status !== lastStatus) {
          lastStatus = next.status
          emit({ type: 'status', status: next.status, progress: next.progress, draft })
        } else {
          emit({ type: 'partial', status: next.status, progress: next.progress, draft })
        }
      },
    },
  )

  emit({ type: 'status', status: 'Finishing up…', progress: 0.96 })
  let raw: Record<string, unknown>
  try {
    raw = extractPartial(text)
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Record<string, unknown>
    raw = { ...raw, ...parsed }
  } catch {
    raw = extractPartial(text)
  }
  const draft = normalizeDraft(raw, name || 'Category')
  emit({ type: 'done', status: 'Category ready.', progress: 1, draft })
  return draft
}

export async function draftCategory(input: {
  name?: string
  prompt?: string
}): Promise<CategoryDraft> {
  return draftCategoryWithProgress(input, () => {})
}

function categoryEmbedText(category: CategoryDTO): string {
  return [category.name, category.description, category.embedInstruction, category.queryHints]
    .filter(Boolean)
    .join('\n')
}

function meanVec(vecs: Float32Array[]): Float32Array | null {
  if (!vecs.length) return null
  const out = new Float32Array(vecs[0].length)
  for (const vec of vecs) {
    for (let i = 0; i < out.length; i += 1) out[i] += vec[i]
  }
  let n = 0
  for (let i = 0; i < out.length; i += 1) n += out[i] * out[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i += 1) out[i] /= n
  return out
}

function categoryTitleGroups(): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT category_id as id, title FROM notes
       WHERE category_id IS NOT NULL AND trim(title) != ''`,
    )
    .all() as Array<{ id: string; title: string }>
  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    const list = grouped.get(row.id) || []
    list.push(row.title.trim())
    grouped.set(row.id, list)
  }
  return grouped
}

function toMatch(category: CategoryDTO, score: number): CategoryMatch {
  return {
    id: category.id,
    name: category.name,
    icon: category.icon,
    color: category.color,
    score,
  }
}

export async function matchNoteCategory(
  title: string,
  content: string,
): Promise<{ match: CategoryMatch | null; bestScore: number; ranked: Array<{ name: string; score: number }> }> {
  const categories = listCategories()
  if (!categories.length) return { match: null, bestScore: -1, ranked: [] }

  const titleVec = await embedText(title.trim() || content.slice(0, 80) || 'note')
  const titleGroups = categoryTitleGroups()

  const scored = await Promise.all(
    categories.map(async (category) => {
      const defVec = await embedText(categoryEmbedText(category))
      const row = getCategoryRow(category.id)
      const wrapped = row
        ? await embedText(
            wrapForEmbedding(buildEntityText(row, title, content), {
              title,
              category: category.name,
            }),
          )
        : titleVec
      const kindFit = cosineSimilarity(wrapped, defVec)
      const memberTitles = titleGroups.get(category.id) || []
      let titleFit = -1
      if (memberTitles.length) {
        const memberVecs = await Promise.all(memberTitles.map((item) => embedText(item)))
        const nearest = memberVecs.reduce((max, vec) => Math.max(max, cosineSimilarity(titleVec, vec)), -1)
        const centroid = meanVec(memberVecs)
        const center = centroid ? cosineSimilarity(titleVec, centroid) : -1
        titleFit = Math.max(nearest, center)
      }
      const score = kindFit + 0.28 * Math.max(0, titleFit)
      return { category, score, kindFit, titleFit }
    }),
  )
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const second = scored[1]
  const ranked = scored.slice(0, 4).map((row) => ({ name: row.category.name, score: row.score }))
  if (!best) return { match: null, bestScore: -1, ranked }

  const kindLeader = [...scored].sort((a, b) => b.kindFit - a.kindFit)[0]
  const kindGap = best.kindFit - (second?.kindFit ?? -1)
  const scoreGap = best.score - (second?.score ?? -1)
  const sameKind = kindLeader?.category.id === best.category.id
  const confident =
    best.kindFit >= MATCH_MIN &&
    scoreGap >= LEAD_GAP &&
    sameKind &&
    (kindGap >= LEAD_GAP * 0.5 || best.titleFit >= 0.4)

  if (confident) {
    return { match: toMatch(best.category, best.score), bestScore: best.score, ranked }
  }
  return { match: null, bestScore: best.score, ranked }
}

async function existingSameKind(name: string, description: string): Promise<CategoryDTO | null> {
  const categories = listCategories()
  if (!categories.length) return null
  const needle = name.trim().toLowerCase()
  const exact = categories.find((c) => c.name.toLowerCase() === needle)
  if (exact) return exact
  const probe = await embedText([name.trim(), description.trim()].filter(Boolean).join('\n') || name)
  let best: CategoryDTO | null = null
  let bestScore = -1
  for (const category of categories) {
    const score = cosineSimilarity(probe, await embedText(categoryEmbedText(category)))
    if (score > bestScore) {
      best = category
      bestScore = score
    }
  }
  return best && bestScore >= SAME_KIND_MIN ? best : null
}

export async function suggestCategoryForNote(
  title: string,
  content: string,
  ranked: Array<{ name: string; score: number }> = [],
): Promise<{ match: CategoryMatch | null; suggestion: CategoryDraft | null }> {
  const categories = listCategories()
  const body = content.replace(/\s+/g, ' ').trim().slice(0, 1800)
  const closest = ranked.length
    ? ranked.map((row) => `- ${row.name} (${row.score.toFixed(2)})`).join('\n')
    : '(none scored)'
  const raw = await generateJson<Record<string, unknown>>(
    `Existing categories:\n${existingSummary(categories)}

Closest by kind of page:\n${closest}

Title: ${title.trim() || 'Untitled'}
Note:\n${body || '(empty)'}

Assign this note. Prefer an existing category if it is the same kind of page.`,
    { system: ASSIGN_SYSTEM },
  )
  const action = asString(raw.action).toLowerCase()
  if (action !== 'new') {
    const name = asString(raw.name)
    const existing = name ? await existingSameKind(name, asString(raw.description)) : null
    if (existing) return { match: toMatch(existing, 1), suggestion: null }
  }
  const draft = normalizeDraft(raw, title.trim() || 'Category')
  const same = await existingSameKind(draft.name, draft.description)
  if (same) return { match: toMatch(same, 1), suggestion: null }
  return { match: null, suggestion: draft }
}

export async function categorizeNote(
  title: string,
  content: string,
): Promise<{ match: CategoryMatch | null; suggestion: CategoryDraft | null }> {
  const { match, ranked } = await matchNoteCategory(title, content)
  if (match) return { match, suggestion: null }
  try {
    return await suggestCategoryForNote(title, content, ranked)
  } catch {
    const closest = ranked[0]
    const existing = closest ? listCategories().find((c) => c.name === closest.name) : null
    if (existing && closest.score >= MATCH_MIN) {
      return { match: toMatch(existing, closest.score), suggestion: null }
    }
    const fallback = (title.trim().split(/\s+/).slice(0, 3).join(' ') || 'Notes').replace(/s$/i, '') + 's'
    const same = await existingSameKind(fallback, `Pages like “${title.trim() || 'this note'}”.`)
    if (same) return { match: toMatch(same, closest?.score ?? 0), suggestion: null }
    return {
      match: null,
      suggestion: {
        name: fallback,
        icon: defaultLucideIcon(fallback),
        color: pickColor(null, listCategories().length),
        description: `Pages like “${title.trim() || 'this note'}”.`,
        embedInstruction: `This note is a ${fallback} page. Represent what kind of thing it is, the main facts, and how it connects to other notes.`,
        queryHints: fallback.toLowerCase(),
        template: `# {{title}}\n\n`,
        tag: uniqueTag(fallback, listCategories().map((c) => c.tag), null, getWorkspaceSettings().reservedShortcuts),
      },
    }
  }
}

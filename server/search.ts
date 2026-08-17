import {
  db,
  bufferToFloat32,
  type ComponentRow,
  type NoteRow,
} from './db.js'
import { cosineSimilarity, embedText } from './embeddings.js'
import { hybridSearch } from './hybrid.js'
import { synthesizeAnswerWithGemma, type SynthesizedAnswer } from './answer.js'
import { resolveConversation, type HistoryTurn } from './conversation.js'
import { retrievalTexts, rewriteQuery } from './queryRewrite.js'
import { planRetrieval, tryEntityCardAnswer } from './retrieve.js'
import { proposalsForEntities } from './entities.js'
import { resolveReferents, mergeDiscourseAfterAnswer, type HistoryTurnWithDiscourse } from './discourse.js'
import { tryOperatorAnswer } from './operators.js'
import {
  ANSWER_WRAP_MIN,
  IDENTITY_FIT_MIN,
  SUBJECT_TITLE_MIN,
  identityFit,
  unknownAnswer,
} from './grounding.js'
import { createSearchProgress, type SearchProgressFn } from './searchProgress.js'
import {
  expandQueryWithWorld,
  isWorldQuestion,
  worldOnlyAnswer,
  type WorldSnapshot,
} from './world.js'

function maxCosine(vecs: Float32Array[], target: Float32Array | null): number {
  if (!target || !vecs.length) return -1
  let best = -1
  for (const v of vecs) best = Math.max(best, cosineSimilarity(v, target))
  return best
}

/** Stay inside prior notes only when the user clearly means this thread's page. */
const SAME_THREAD_SCOPE =
  /\b((what|anything) else|in this (meeting|note|call|page)|this (meeting|note|call|page)|that (meeting|note|call)|the (same )?meeting)\b/i

const MAX_GRAPH_NOTES = 8
const MAX_GRAPH_COMPONENTS = 14

function focusMentionBoost(row: { note_title: string; content: string }, focusTitles: string[]): number {
  if (!focusTitles.length) return 0
  const hay = `${row.note_title}\n${row.content}`.toLowerCase()
  let best = 0
  for (const title of focusTitles) {
    const t = title.toLowerCase().trim()
    if (!t) continue
    if (t.length >= 3 && hay.includes(t)) best = Math.max(best, 0.16)
    for (const part of t.split(/\s+/)) {
      if (part.length >= 4 && hay.includes(part)) best = Math.max(best, 0.12)
    }
  }
  return best
}

/** Notes that mention a focus person/page — for fast local retrieval. */
function noteIdsMentioningTitles(titles: string[], limit = 24): Set<string> {
  const ids = new Set<string>()
  const terms = new Set<string>()
  for (const title of titles) {
    const t = title.trim().toLowerCase()
    if (t.length >= 3) terms.add(t)
    for (const part of t.split(/\s+/)) {
      if (part.length >= 4) terms.add(part)
    }
  }
  for (const term of [...terms].slice(0, 6)) {
    if (ids.size >= limit) break
    const found = db
      .prepare(
        `SELECT DISTINCT c.note_id as id
         FROM components c
         JOIN notes n ON n.id = c.note_id
         WHERE lower(c.content) LIKE ? OR lower(n.title) LIKE ?
         LIMIT 40`,
      )
      .all(`%${term}%`, `%${term}%`) as Array<{ id: string }>
    for (const row of found) {
      ids.add(row.id)
      if (ids.size >= limit) break
    }
  }
  return ids
}

function attributeBoost(query: string, content: string): number {
  const q = query.toLowerCase()
  const blob = content.toLowerCase()
  let boost = 0
  if (/\b(phone|mobile|cell|telephone|number|call)\b/.test(q)) {
    if (/(?:\b(?:c|phone|tel|mobile|cell)\b\s*:?\s*)?\+?\d[\d\s().-]{6,}\d/.test(blob)) boost += 0.35
    if (/\b(?:c|phone|tel|mobile|cell)\s*:/.test(blob)) boost += 0.2
  }
  if (/\b(email|e-mail)\b/.test(q) && /\b\S+@\S+\.\S+\b/.test(blob)) boost += 0.35
  if (/\b(address|lives?|street)\b/.test(q) && /\d+\s+\w+/.test(blob)) boost += 0.2
  if (/\b(birthday|born|dob)\b/.test(q) && /\b(\d{1,2}[\/\-]\d{1,2}|\d{4}|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(blob)) {
    boost += 0.25
  }
  return boost
}

function loadFocusNoteRows(focusIds: Set<string>): SearchRow[] {
  if (!focusIds.size) return []
  const placeholders = [...focusIds].map(() => '?').join(',')
  return db
    .prepare(
      `${COMPONENT_SELECT}
       WHERE c.note_id IN (${placeholders})
         AND c.type NOT IN ('divider', 'wikilink', 'chunk')
       ORDER BY c.position ASC`,
    )
    .all(...focusIds) as SearchRow[]
}

function isWeakAnswer(answer: SynthesizedAnswer): boolean {
  if (!answer.text.trim()) return true
  if (/don’t see that in your notes/i.test(answer.text) && answer.bullets.length === 0) return true
  if (/couldn.?t extract a specific fact/i.test(answer.text)) return true
  return false
}

export type GraphNode = {
  id: string
  label: string
  type: string
  noteId: string
  noteTitle: string
  content: string
  score: number
  kind: 'component' | 'note' | 'query'
  categoryId?: string | null
  categoryName?: string | null
  categoryColor?: string | null
}

export type GraphEdge = {
  id: string
  source: string
  target: string
  relation: 'similar' | 'same_note' | 'wikilink' | 'mention' | 'query_match' | 'thread'
  weight: number
}

function pruneConnectionGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  keepNoteIds: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const noteNodes = nodes
    .filter((n) => n.kind === 'note')
    .sort((a, b) => {
      const ak = keepNoteIds.has(a.noteId) ? 1 : 0
      const bk = keepNoteIds.has(b.noteId) ? 1 : 0
      if (ak !== bk) return bk - ak
      return b.score - a.score
    })
  const allowedNotes = new Set<string>()
  for (const id of keepNoteIds) {
    if (allowedNotes.size >= MAX_GRAPH_NOTES) break
    allowedNotes.add(id)
  }
  for (const n of noteNodes) {
    if (allowedNotes.size >= MAX_GRAPH_NOTES) break
    allowedNotes.add(n.noteId)
  }

  const components = nodes
    .filter((n) => n.kind === 'component' && allowedNotes.has(n.noteId))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_GRAPH_COMPONENTS)

  const prunedNodes = [
    ...nodes.filter((n) => n.kind === 'query'),
    ...nodes.filter((n) => n.kind === 'note' && allowedNotes.has(n.noteId)),
    ...components,
  ]
  const nodeIds = new Set(prunedNodes.map((n) => n.id))
  const prunedEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
  return { nodes: prunedNodes, edges: prunedEdges }
}

export type SearchMatch = {
  componentId: string
  noteId: string
  noteTitle: string
  type: string
  content: string
  score: number
  categoryId?: string | null
  categoryName?: string | null
  meta?: Record<string, unknown>
}

export type SearchResult = {
  query: string
  summary: string
  answer: SynthesizedAnswer
  nodes: GraphNode[]
  edges: GraphEdge[]
  matches: SearchMatch[]
  followUp?: boolean
  proposals?: import('./entities.js').EntityProposal[]
  discourse?: import('./discourse.js').DiscourseState
  operator?: string
  world?: WorldSnapshot | null
}

type SearchRow = ComponentRow & {
  note_title: string
  category_id: string | null
  category_name: string | null
  category_color: string | null
  category_slug: string | null
}

const COMPONENT_SELECT = `SELECT c.*, n.title as note_title,
        n.category_id as category_id,
        cat.name as category_name,
        cat.color as category_color,
        cat.slug as category_slug
       FROM components c
       JOIN notes n ON n.id = c.note_id
       LEFT JOIN categories cat ON cat.id = n.category_id`

const HYBRID_CANDIDATE_NOTES = 48
const FULL_SCAN_COMPONENT_CAP = 2000

function loadTitleRows(categoryId?: string | null): SearchRow[] {
  let sql = `${COMPONENT_SELECT} WHERE c.position = -1 AND c.type = 'heading'`
  const params: string[] = []
  if (categoryId) {
    sql += ` AND n.category_id = ?`
    params.push(categoryId)
  }
  return db.prepare(sql).all(...params) as SearchRow[]
}

function loadRowsForNotes(noteIds: string[], categoryId?: string | null): SearchRow[] {
  if (!noteIds.length) return []
  const unique = [...new Set(noteIds)]
  let sql = `${COMPONENT_SELECT}
    WHERE c.embedding IS NOT NULL AND c.type != 'divider'
      AND c.note_id IN (${unique.map(() => '?').join(',')})`
  const params: string[] = [...unique]
  if (categoryId) {
    sql += ` AND n.category_id = ?`
    params.push(categoryId)
  }
  return db.prepare(sql).all(...params) as SearchRow[]
}

function loadAllEmbeddedRows(categoryId?: string | null): SearchRow[] {
  let sql = `${COMPONENT_SELECT} WHERE c.embedding IS NOT NULL AND c.type != 'divider'`
  const params: string[] = []
  if (categoryId) {
    sql += ` AND n.category_id = ?`
    params.push(categoryId)
  }
  return db.prepare(sql).all(...params) as SearchRow[]
}

function mergeSearchRows(...lists: SearchRow[][]): SearchRow[] {
  const map = new Map<string, SearchRow>()
  for (const list of lists) {
    for (const row of list) map.set(row.id, row)
  }
  return [...map.values()]
}

function isTitleRow(row: SearchRow): boolean {
  try {
    return Boolean(JSON.parse(row.meta_json || '{}').isTitle)
  } catch {
    return false
  }
}

function snippet(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function queryNode(q: string): GraphNode {
  return {
    id: 'query',
    label: snippet(q, 48),
    type: 'query',
    noteId: '',
    noteTitle: '',
    content: q,
    score: 1,
    kind: 'query',
  }
}

function unknownResult(
  q: string,
  related?: { id: string; title: string; score: number },
  followUp = false,
): SearchResult {
  const nodes: GraphNode[] = [queryNode(q)]
  const edges: GraphEdge[] = []
  if (related) {
    nodes.push({
      id: `note:${related.id}`,
      label: related.title,
      type: 'note',
      noteId: related.id,
      noteTitle: related.title,
      content: related.title,
      score: related.score,
      kind: 'note',
    })
    edges.push({
      id: `query_match:${['query', `note:${related.id}`].sort().join('|')}`,
      source: 'query',
      target: `note:${related.id}`,
      relation: 'query_match',
      weight: related.score,
    })
  }
  return {
    query: q,
    summary: 'Nothing in your notes answered this.',
    answer: unknownAnswer(related?.title),
    nodes,
    edges,
    matches: [],
    followUp,
  }
}

type LinkMeta = { wikiLinks?: string[]; targetTitle?: string; mentions?: string[] }

function parseLinkMeta(metaJson: string): LinkMeta {
  try {
    return JSON.parse(metaJson || '{}')
  } catch {
    return {}
  }
}

function referencedTitles(row: { meta_json: string; type: string }): Array<{
  title: string
  relation: 'wikilink' | 'mention'
}> {
  const meta = parseLinkMeta(row.meta_json)
  const out: Array<{ title: string; relation: 'wikilink' | 'mention' }> = []
  const seen = new Set<string>()
  const push = (title: string | undefined, relation: 'wikilink' | 'mention') => {
    const t = title?.trim()
    if (!t) return
    const key = t.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ title: t, relation })
  }
  for (const title of meta.wikiLinks || []) push(title, 'wikilink')
  if (row.type === 'wikilink') push(meta.targetTitle, 'wikilink')
  for (const title of meta.mentions || []) push(title, 'mention')
  return out
}

function noteNodeFrom(
  row: Pick<SearchRow, 'note_id' | 'note_title' | 'category_id' | 'category_name' | 'category_color'>,
  score: number,
): GraphNode {
  return {
    id: `note:${row.note_id}`,
    label: row.note_title,
    type: 'note',
    noteId: row.note_id,
    noteTitle: row.note_title,
    content: row.note_title,
    score,
    kind: 'note',
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
  }
}

function createEdgeSet() {
  const edges: GraphEdge[] = []
  const edgeKey = new Set<string>()
  const addEdge = (
    source: string,
    target: string,
    relation: GraphEdge['relation'],
    weight: number,
  ) => {
    const key = `${relation}:${[source, target].sort().join('|')}`
    if (edgeKey.has(key) || source === target) return
    edgeKey.add(key)
    edges.push({ id: key, source, target, relation, weight })
  }
  return { edges, addEdge }
}

export async function searchConnectionGraph(
  query: string,
  options: {
    topK?: number
    neighborThreshold?: number
    categoryId?: string | null
    history?: HistoryTurnWithDiscourse[]
    onProgress?: SearchProgressFn
    world?: WorldSnapshot | null
  } = {},
): Promise<SearchResult> {
  const topK = options.topK ?? 12
  const neighborThreshold = options.neighborThreshold ?? 0.42
  const q = query.trim()
  const history = options.history || []
  const progress = createSearchProgress(options.onProgress)
  const liveNodes = new Map<string, GraphNode>()
  const liveEdge = createEdgeSet()

  const publish = () => progress.graph([...liveNodes.values()], liveEdge.edges)
  const showNote = async (
    row: {
      noteId: string
      title: string
      categoryId?: string | null
      categoryName?: string | null
      categoryColor?: string | null
    },
    score = 0.5,
  ) => {
    const node: GraphNode = {
      id: `note:${row.noteId}`,
      label: row.title,
      type: 'note',
      noteId: row.noteId,
      noteTitle: row.title,
      content: row.title,
      score,
      kind: 'note',
      categoryId: row.categoryId ?? null,
      categoryName: row.categoryName ?? null,
      categoryColor: row.categoryColor ?? null,
    }
    liveNodes.set(node.id, node)
    liveEdge.addEdge('query', node.id, 'query_match', score)
    publish()
    await progress.note({
      noteId: row.noteId,
      title: row.title,
      categoryName: row.categoryName ?? null,
      categoryColor: row.categoryColor ?? null,
    })
  }

  const refs = resolveReferents(q, history)
  const convo = await resolveConversation(q, history as HistoryTurn[])
  const world = options.world || null
  if (!q) {
    if (world) {
      const only = worldOnlyAnswer(world)
      return {
        query: q,
        summary: only.text,
        answer: { ...only, sources: [], alternatives: [] },
        nodes: [],
        edges: [],
        matches: [],
        discourse: refs.discourse,
        world,
        operator: 'world',
      }
    }
    return {
      query: q,
      summary: 'Ask a question about your notes.',
      answer: {
        text: 'Ask a question about your notes. Mine will answer in plain language and cite the pages it used.',
        bullets: [],
        sources: [],
        alternatives: [],
      },
      nodes: [],
      edges: [],
      matches: [],
      discourse: refs.discourse,
    }
  }

  if (world && isWorldQuestion(q)) {
    const only = worldOnlyAnswer(world)
    return {
      query: q,
      summary: only.text,
      answer: { ...only, sources: [], alternatives: [] },
      nodes: [],
      edges: [],
      matches: [],
      discourse: refs.discourse,
      world,
      operator: 'world',
    }
  }

  liveNodes.set('query', queryNode(q))
  publish()
  await progress.status('Looking through your notes…')

  for (const entity of refs.entities.slice(0, 4)) {
    await showNote(
      {
        noteId: entity.noteId,
        title: entity.title,
        categoryId: entity.categoryId,
        categoryName: entity.categoryName,
      },
      0.8,
    )
  }

  // Structured reasoning path: bind referents → operator → verify.
  await progress.status('Checking related facts…')
  const operated = await tryOperatorAnswer(q, refs, world)
  if (operated) {
    for (const node of operated.nodes) liveNodes.set(node.id, node)
    for (const edge of operated.edges) {
      liveEdge.addEdge(edge.source, edge.target, edge.relation, edge.weight)
    }
    publish()
    for (const node of operated.nodes.filter((n) => n.kind === 'note')) {
      await progress.note({
        noteId: node.noteId,
        title: node.noteTitle || node.label,
        categoryName: node.categoryName,
        categoryColor: node.categoryColor,
      })
    }
    await progress.status('Writing an answer…')
    return { ...operated, world }
  }

  const focusTitlesEarly = [
    ...convo.focusTitles,
    ...refs.discourse.focusEntities.map((e) => e.title),
  ].filter(Boolean)
  const planPromise = planRetrieval(q, [
    ...convo.focusNoteIds,
    ...refs.discourse.focusNotes.map((n) => n.noteId),
    ...refs.entities.map((e) => e.noteId),
  ])
  // Default to cheap local rewrite; Gemma only for pronoun follow-ups (and capped).
  const rewritePromise = rewriteQuery(q, {
    history: options.history,
    focusTitles: focusTitlesEarly,
    cheapOnly: true,
  })
  const [rewrite, plan] = await Promise.all([rewritePromise, planPromise])

  for (const entity of plan.entities.slice(0, 4)) {
    await showNote(
      {
        noteId: entity.noteId,
        title: entity.title,
        categoryId: entity.categoryId,
        categoryName: entity.categoryName,
      },
      0.85,
    )
  }

  // If the question names an entity page, try answering from that page first; Gemma decides relevance.
  if (plan.entities.length) {
    await progress.status(`Reading ${plan.entities[0].title}…`)
    const card = await tryEntityCardAnswer(q, plan.entities, world)
    if (card) {
      const proposals = proposalsForEntities(plan.entities)
      for (const node of card.nodes) liveNodes.set(node.id, node)
      for (const edge of card.edges) {
        liveEdge.addEdge(edge.source, edge.target, edge.relation, edge.weight)
      }
      publish()
      await progress.status('Writing an answer…')
      return {
        query: q,
        summary: `From ${plan.entities[0].title}.`,
        answer: card.answer,
        nodes: card.nodes,
        edges: card.edges,
        matches: card.matches,
        followUp: convo.focusNoteIds.length > 0 || refs.isFollowUp,
        proposals,
        discourse: mergeDiscourseAfterAnswer(refs.discourse, {
          operator: 'entity_card',
          answerNoteIds: [
            {
              noteId: plan.entities[0].noteId,
              title: plan.entities[0].title,
              categoryName: plan.entities[0].categoryName,
            },
          ],
          entities: plan.entities,
        }),
        operator: 'entity_card',
        world,
      }
    }
  }

  await progress.status('Searching your notes…')

  const groundedExtras =
    focusTitlesEarly.length > 0
      ? focusTitlesEarly.slice(0, 2).flatMap((name) => [name, `${q} ${name}`])
      : plan.entities.slice(0, 2).flatMap((e) => [e.title, ...e.aliases.slice(0, 2)])
  const retrievalTextsList = retrievalTexts(
    world ? expandQueryWithWorld(q, world) : q,
    rewrite,
    groundedExtras,
  )
  const [queryVec, ...retrievalVecs] = await Promise.all([
    embedText(world ? expandQueryWithWorld(q, world) : q),
    ...retrievalTextsList.map((t) => embedText(t)),
  ])

  const hybridHits = await hybridSearch(world ? expandQueryWithWorld(q, world) : q, {
    limit: HYBRID_CANDIDATE_NOTES,
    categoryId: options.categoryId,
    queryVecs: [queryVec, ...retrievalVecs],
  })
  const seenHybridNotes = new Set<string>()
  for (const hit of hybridHits) {
    if (!hit.noteId || seenHybridNotes.has(hit.noteId)) continue
    seenHybridNotes.add(hit.noteId)
    await progress.status(`Opening ${hit.noteTitle}…`)
    await showNote(
      {
        noteId: hit.noteId,
        title: hit.noteTitle,
        categoryId: hit.categoryId,
        categoryName: hit.categoryName,
        categoryColor: hit.categoryColor,
      },
      hit.score,
    )
    if (seenHybridNotes.size >= 8) break
  }
  const candidateNoteIds = new Set(hybridHits.map((h) => h.noteId).filter(Boolean))
  const titleRows = loadTitleRows(options.categoryId)
  const totalComponents = (
    db.prepare(`SELECT COUNT(*) as c FROM components WHERE embedding IS NOT NULL`).get() as {
      c: number
    }
  ).c
  const rows =
    candidateNoteIds.size === 0 && totalComponents <= FULL_SCAN_COMPONENT_CAP
      ? loadAllEmbeddedRows(options.categoryId)
      : mergeSearchRows(titleRows, loadRowsForNotes([...candidateNoteIds], options.categoryId))

  const notesById = new Map<string, string>()
  for (const row of rows) notesById.set(row.note_id, row.note_title)

  // Use stored title-component embeddings instead of re-embedding every title.
  const titleByNote = new Map<string, { id: string; title: string; vec: Float32Array }>()
  for (const row of rows) {
    if (!isTitleRow(row)) continue
    const vec = bufferToFloat32(row.embedding)
    if (!vec) continue
    titleByNote.set(row.note_id, { id: row.note_id, title: row.note_title, vec })
  }
  const titleHits = [...notesById].map(([id, title]) => {
    const stored = titleByNote.get(id)
    return {
      id,
      title,
      vec: stored?.vec || new Float32Array(0),
      score: 0,
      hasVec: Boolean(stored),
    }
  })
  // Only embed missing titles (uncached notes without a title component).
  await Promise.all(
    titleHits
      .filter((hit) => !hit.hasVec)
      .map(async (hit) => {
        hit.vec = await embedText(hit.title)
        hit.hasVec = true
      }),
  )
  for (const hit of titleHits) hit.score = maxCosine(retrievalVecs, hit.vec)
  const rankedTitles = [...titleHits].sort((a, b) => b.score - a.score)
  const subject = rankedTitles[0]
  const focusSet = new Set(convo.focusNoteIds.filter((id) => notesById.has(id)))
  const bestFocus = rankedTitles.find((hit) => focusSet.has(hit.id))
  const namedOther =
    Boolean(subject) &&
    !focusSet.has(subject.id) &&
    subject.score >= SUBJECT_TITLE_MIN &&
    subject.score > (bestFocus?.score ?? 0) + 0.08
  const followUp = focusSet.size > 0 && !namedOther
  const scopeToFocus = followUp && SAME_THREAD_SCOPE.test(q)
  const contextVecs = followUp
    ? await Promise.all(
        retrievalTexts(convo.searchQuery, null, focusTitlesEarly.slice(0, 2)).map((t) =>
          embedText(t),
        ),
      )
    : retrievalVecs
  const prevAnswerVec =
    followUp && convo.prevAnswerText
      ? await embedText(convo.prevAnswerText.slice(0, 400))
      : null
  // Keep prior context light on detail follow-ups so "phone number" isn't drowned by "who is".
  const mix = followUp
    ? scopeToFocus
      ? Math.max(convo.continuity, 0.5)
      : Math.min(Math.max(convo.continuity, 0.12), 0.28)
    : 0
  const relatedSubject = followUp
    ? titleHits.find((hit) => focusSet.has(hit.id)) || {
        id: [...focusSet][0],
        title: notesById.get([...focusSet][0]) || convo.focusTitles[0] || '',
        vec: new Float32Array(),
        score: 1,
        hasVec: false,
      }
    : subject && subject.score >= SUBJECT_TITLE_MIN
      ? subject
      : undefined
  const identFit = relatedSubject && !followUp ? await identityFit(queryVec, relatedSubject.title) : 0
  const identityAsk = identFit >= IDENTITY_FIT_MIN

  const simToQuery = (vec: Float32Array | null) => {
    if (!vec) return -1
    const direct = maxCosine(retrievalVecs, vec)
    if (!followUp) return direct
    return (1 - mix) * direct + mix * maxCosine(contextVecs, vec)
  }

  const subjectVecs =
    identityAsk || followUp
      ? []
      : titleHits.filter((hit) => hit.score >= SUBJECT_TITLE_MIN && hit.score < 0.88).map((hit) => hit.vec)

  const mentionIds =
    focusTitlesEarly.length > 0 ? noteIdsMentioningTitles(focusTitlesEarly) : new Set<string>()
  const preferIds = new Set<string>([...focusSet, ...mentionIds, ...plan.preferNoteIds])
  for (const e of plan.entities) preferIds.add(e.noteId)

  const extraPreferRows =
    preferIds.size > 0 ? loadRowsForNotes([...preferIds], options.categoryId) : []
  if (extraPreferRows.length) {
    for (const row of extraPreferRows) {
      if (!rows.some((r) => r.id === row.id)) rows.push(row)
    }
  }

  // Context-first: answer from focus + notes that mention them; expand to full library only if weak.
  const scopedRows = (() => {
    if (scopeToFocus) return rows.filter((row) => focusSet.has(row.note_id))
    if (identityAsk && relatedSubject && !followUp) {
      return rows.filter((row) => row.note_id === relatedSubject.id)
    }
    if (preferIds.size > 0 && (followUp || focusSet.size > 0 || plan.entities.length > 0)) {
      return rows.filter((row) => preferIds.has(row.note_id))
    }
    return null
  })()

  const novelty = followUp ? Math.max(convo.novelty, 0.45) : 0
  const focusTitles = convo.focusTitles.filter(Boolean)
  const minWrap = followUp ? 0.16 : 0.2
  // On attribute follow-ups, don't bury new facts from the same focused note.
  const softNovelty = followUp && !scopeToFocus

  const rankRows = (searchRows: SearchRow[]) => {
    const wrapRanked = searchRows
      .map((row) => {
        const vec = bufferToFloat32(row.embedding)
        const directWrap = vec ? maxCosine(retrievalVecs, vec) : -1
        const groundedWrap = followUp && vec ? maxCosine(contextVecs, vec) : directWrap
        let wrapSim = simToQuery(vec)
        if (focusSet.has(row.note_id)) wrapSim += (followUp ? 0.06 : 0) * Math.max(mix, 0.4)
        wrapSim += focusMentionBoost(row, focusTitles)
        wrapSim += attributeBoost(q, `${row.note_title}\n${row.content}`)
        wrapSim += plan.ftsBoosts.get(row.id) || 0
        if (plan.entities.some((e) => e.noteId === row.note_id)) wrapSim += 0.06
        if (prevAnswerVec && vec && novelty > 0) {
          const penalty = novelty * Math.max(0, cosineSimilarity(vec, prevAnswerVec) - 0.2)
          wrapSim -= softNovelty ? penalty * 0.35 : penalty
        }
        if (row.type === 'chunk' || row.type === 'paragraph') wrapSim += 0.02
        return {
          row,
          wrapSim,
          score: wrapSim,
          rawSim: directWrap,
          directWrap,
          groundedWrap,
          stick: 0,
          vec,
        }
      })
      .filter((x) => x.wrapSim > minWrap)
      .sort((a, b) => b.wrapSim - a.wrapSim)

    const rerankPool = wrapRanked.slice(0, 16)
    for (const item of rerankPool) {
      let stick = 0
      if (item.vec) {
        for (const sv of subjectVecs) stick = Math.max(stick, cosineSimilarity(item.vec, sv))
      }
      item.stick = stick
      item.score = item.wrapSim - 0.45 * stick + 0.15 * item.rawSim
      if (!followUp && item.rawSim < 0.1) item.score -= 0.35
    }
    rerankPool.sort((a, b) => b.score - a.score)
    return rerankPool
  }

  let scored = rankRows(scopedRows ?? rows)
  let lead = scored[0]
  let answerWrap = lead ? Math.max(lead.directWrap, lead.groundedWrap) : -1
  // Expand to full corpus only when the focused slice can't support an answer.
  if (scopedRows && scopedRows.length < rows.length && (!lead || answerWrap < ANSWER_WRAP_MIN)) {
    scored = rankRows(rows)
    lead = scored[0]
    answerWrap = lead ? Math.max(lead.directWrap, lead.groundedWrap) : -1
  }
  if ((!lead || answerWrap < ANSWER_WRAP_MIN) && totalComponents <= FULL_SCAN_COMPONENT_CAP) {
    const allRows = loadAllEmbeddedRows(options.categoryId)
    if (allRows.length > rows.length) {
      scored = rankRows(allRows)
      lead = scored[0]
      answerWrap = lead ? Math.max(lead.directWrap, lead.groundedWrap) : -1
    }
  }

  if (!lead || answerWrap < ANSWER_WRAP_MIN) {
    const softMatches: SearchMatch[] = []
    const seenSoft = new Set<string>()
    for (const hit of hybridHits.slice(0, 6)) {
      if (!hit.noteId || !String(hit.content || '').trim()) continue
      if (seenSoft.has(hit.chunkId)) continue
      seenSoft.add(hit.chunkId)
      softMatches.push({
        componentId: hit.chunkId,
        noteId: hit.noteId,
        noteTitle: hit.noteTitle,
        type: hit.type,
        content: hit.content,
        score: hit.score,
        categoryId: hit.categoryId,
        categoryName: hit.categoryName,
        meta: hit.metadata,
      })
    }
    // Hybrid empty (or only titles): fall back to raw top cosine on candidate rows.
    if (softMatches.length < 3) {
      const softRanked = [...(scopedRows ?? rows)]
        .map((row) => {
          const vec = bufferToFloat32(row.embedding)
          const directWrap = vec ? maxCosine(retrievalVecs, vec) : -1
          return { row, directWrap }
        })
        .filter((x) => x.directWrap > 0.05)
        .sort((a, b) => b.directWrap - a.directWrap)
        .slice(0, 6)
      for (const { row, directWrap } of softRanked) {
        if (seenSoft.has(row.id)) continue
        seenSoft.add(row.id)
        softMatches.push({
          componentId: row.id,
          noteId: row.note_id,
          noteTitle: row.note_title,
          type: row.type,
          content: row.content,
          score: directWrap,
          categoryId: row.category_id,
          categoryName: row.category_name,
        })
        if (softMatches.length >= 6) break
      }
    }

    if (softMatches.length) {
      await progress.status('Checking closest matches with Gemma…')
      for (const m of softMatches.slice(0, 4)) {
        await showNote(
          {
            noteId: m.noteId,
            title: m.noteTitle,
            categoryId: m.categoryId,
            categoryName: m.categoryName,
          },
          m.score,
        )
      }
      const softAnswer = await synthesizeAnswerWithGemma(q, softMatches, {
        world,
        softEvidence: true,
      })
      if (!isWeakAnswer(softAnswer)) {
        const nodes: GraphNode[] = [queryNode(q)]
        const { edges, addEdge } = createEdgeSet()
        const seenNotes = new Set<string>()
        const keep = new Set(softAnswer.sources.map((s) => s.noteId))
        if (!keep.size) {
          for (const m of softMatches.slice(0, 3)) keep.add(m.noteId)
        }
        for (const m of softMatches) {
          if (!keep.has(m.noteId) || seenNotes.has(m.noteId)) continue
          seenNotes.add(m.noteId)
          const row = rows.find((r) => r.note_id === m.noteId)
          nodes.push(
            noteNodeFrom(
              row || {
                note_id: m.noteId,
                note_title: m.noteTitle,
                category_id: m.categoryId ?? null,
                category_name: m.categoryName ?? null,
                category_color: null,
              },
              m.score,
            ),
          )
          addEdge('query', `note:${m.noteId}`, 'query_match', m.score)
        }
        const noteCount = seenNotes.size
        return {
          query: q,
          summary: `Answered from nearby matches (${noteCount} page${noteCount === 1 ? '' : 's'}).`,
          answer: softAnswer,
          nodes,
          edges,
          matches: softMatches.filter((m) => keep.has(m.noteId)),
          followUp,
          discourse: mergeDiscourseAfterAnswer(refs.discourse, {
            operator: 'soft_retrieve',
            answerNoteIds: [...keep].map((id) => ({
              noteId: id,
              title: softMatches.find((m) => m.noteId === id)?.noteTitle || notesById.get(id) || '',
              categoryName: softMatches.find((m) => m.noteId === id)?.categoryName ?? null,
            })),
            entities: plan.entities,
          }),
          operator: 'soft_retrieve',
          world,
        }
      }
      if (softAnswer.text.trim()) {
        return {
          ...unknownResult(q, relatedSubject, followUp),
          answer: softAnswer,
          summary: 'Closest matches weren’t useful.',
        }
      }
    }

    await progress.status('Nothing quite matched…')
    return unknownResult(q, relatedSubject, followUp)
  }
  if (
    !followUp &&
    !identityAsk &&
    relatedSubject &&
    lead.row.note_id === relatedSubject.id &&
    lead.stick > 0.4
  ) {
    const idVec = await embedText(`who is ${relatedSubject.title}`)
    const wrapVec = bufferToFloat32(lead.row.embedding)
    const surplus = lead.directWrap - (wrapVec ? cosineSimilarity(idVec, wrapVec) : 0)
    if (surplus < 0.02) return unknownResult(q, relatedSubject)
  }

  const seeds = scored.slice(0, Math.min(topK, 8))
  const seedIds = new Set(seeds.map((s) => s.row.id))
  const noteIds = new Set(seeds.map((s) => s.row.note_id))

  // Expand: other high-similarity components to seeds, plus siblings in same notes
  const neighborMap = new Map<string, { row: SearchRow; score: number }>()
  for (const seed of seeds) {
    neighborMap.set(seed.row.id, seed)
  }

  for (const candidate of scored.slice(0, Math.min(24, scored.length))) {
    if (seedIds.has(candidate.row.id)) continue
    const cVec = candidate.vec || bufferToFloat32(candidate.row.embedding)
    if (!cVec) continue
    let best = 0
    for (const seed of seeds.slice(0, 6)) {
      const sVec = seed.vec || bufferToFloat32(seed.row.embedding)
      if (!sVec) continue
      best = Math.max(best, cosineSimilarity(cVec, sVec))
    }
    if (best >= neighborThreshold || noteIds.has(candidate.row.note_id)) {
      if (!neighborMap.has(candidate.row.id)) {
        neighborMap.set(candidate.row.id, {
          row: candidate.row,
          score: Math.max(candidate.score * 0.85, best * 0.9),
        })
      }
    }
  }

  // Pull a few structural siblings from matched notes (headings/todos)
  for (const noteId of noteIds) {
    const siblings = db
      .prepare(
        `SELECT c.*, n.title as note_title,
                n.category_id as category_id,
                cat.name as category_name,
                cat.color as category_color,
                cat.slug as category_slug
         FROM components c
         JOIN notes n ON n.id = c.note_id
         LEFT JOIN categories cat ON cat.id = n.category_id
         WHERE c.note_id = ? AND c.type IN ('heading','todo','callout','toggle','entity')
         ORDER BY c.position ASC
         LIMIT 4`,
      )
      .all(noteId) as SearchRow[]
    for (const sib of siblings) {
      if (!neighborMap.has(sib.id)) {
        neighborMap.set(sib.id, { row: sib, score: 0.22 })
      }
    }
  }

  const nodes: GraphNode[] = [
    {
      id: 'query',
      label: snippet(q, 48),
      type: 'query',
      noteId: '',
      noteTitle: '',
      content: q,
      score: 1,
      kind: 'query',
    },
  ]

  const noteTitleById = new Map<string, string>()
  const noteCategory = new Map<string, { id: string | null; name: string | null; color: string | null }>()
  for (const { row, score } of neighborMap.values()) {
    noteTitleById.set(row.note_id, row.note_title)
    noteCategory.set(row.note_id, {
      id: row.category_id ?? null,
      name: row.category_name ?? null,
      color: row.category_color ?? null,
    })
    if (row.type === 'chunk') continue
    nodes.push({
      id: row.id,
      label: row.type === 'entity' ? row.note_title : snippet(row.content, 42) || row.type,
      type: row.type,
      noteId: row.note_id,
      noteTitle: row.note_title,
      content: row.content,
      score,
      kind: 'component',
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryColor: row.category_color,
    })
  }

  for (const [noteId, title] of noteTitleById) {
    const cat = noteCategory.get(noteId)
    nodes.push({
      id: `note:${noteId}`,
      label: title,
      type: 'note',
      noteId,
      noteTitle: title,
      content: title,
      score: 0.5,
      kind: 'note',
      categoryId: cat?.id,
      categoryName: cat?.name,
      categoryColor: cat?.color,
    })
  }

  const { edges, addEdge } = createEdgeSet()

  for (const seed of seeds) {
    const target = seed.row.type === 'chunk' ? `note:${seed.row.note_id}` : seed.row.id
    addEdge('query', target, 'query_match', seed.score)
  }

  for (const { row } of neighborMap.values()) {
    if (row.type === 'chunk') continue
    addEdge(row.id, `note:${row.note_id}`, 'same_note', 0.55)
    for (const ref of referencedTitles(row)) {
      if (ref.title.toLowerCase() === row.note_title.toLowerCase()) continue
      // Only link out to notes already in the relevant set (seeds / mentions), not the whole vault.
      const linked = db
        .prepare(`SELECT id, title FROM notes WHERE lower(title) = lower(?) LIMIT 1`)
        .get(ref.title) as Pick<NoteRow, 'id' | 'title'> | undefined
      if (!linked || linked.id === row.note_id) continue
      if (!noteIds.has(linked.id) && !preferIds.has(linked.id) && !noteTitleById.has(linked.id)) {
        // Allow one-hop links only when the target is already a seed/mention candidate.
        if (!mentionIds.has(linked.id)) continue
      }
      const source = ref.relation === 'mention' ? `note:${row.note_id}` : row.id
      addEdge(source, `note:${linked.id}`, ref.relation, ref.relation === 'wikilink' ? 0.8 : 0.75)
      if (!nodes.some((n) => n.id === `note:${linked.id}`)) {
        const linkedRow = rows.find((r) => r.note_id === linked.id)
        nodes.push(
          linkedRow
            ? noteNodeFrom(linkedRow, 0.4)
            : {
                id: `note:${linked.id}`,
                label: linked.title,
                type: 'note',
                noteId: linked.id,
                noteTitle: linked.title,
                content: linked.title,
                score: 0.4,
                kind: 'note',
              },
        )
        noteTitleById.set(linked.id, linked.title)
      }
    }
  }

  // Similarity edges among top components
  const componentNodes = [...neighborMap.values()]
    .filter((x) => x.row.type !== 'chunk')
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
  for (let i = 0; i < componentNodes.length; i += 1) {
    for (let j = i + 1; j < componentNodes.length; j += 1) {
      const a = componentNodes[i]
      const b = componentNodes[j]
      if (a.row.note_id === b.row.note_id) continue
      const va = bufferToFloat32(a.row.embedding)
      const vb = bufferToFloat32(b.row.embedding)
      if (!va || !vb) continue
      const sim = cosineSimilarity(va, vb)
      if (sim >= 0.6) {
        addEdge(a.row.id, b.row.id, 'similar', sim)
      }
    }
  }

  for (const node of nodes) liveNodes.set(node.id, node)
  for (const edge of edges) liveEdge.addEdge(edge.source, edge.target, edge.relation, edge.weight)
  publish()
  await progress.status('Connecting pages…')

  const matches = seeds.map(({ row, score }) => ({
    componentId: row.id,
    noteId: row.note_id,
    noteTitle: row.note_title,
    type: row.type,
    content: row.content,
    score,
    categoryId: row.category_id,
    categoryName: row.category_name,
  }))

  const answerFit = (item: {
    score: number
    rawSim: number
    directWrap: number
    row: SearchRow
  }) => {
    let fit = 0.45 * item.rawSim + 0.35 * item.directWrap + 0.2 * item.score
    fit += focusMentionBoost(item.row, focusTitles)
    fit += attributeBoost(q, `${item.row.note_title}\n${item.row.content}`)
    const blob = `${item.row.note_title}\n${item.row.content}`.toLowerCase()
    if (/\b(when|last|date|meeting|met|schedule)\b/i.test(q) && /\b(meeting|met|call|sync)\b/i.test(blob)) {
      fit += 0.1
    }
    return fit
  }

  const answerPool = new Map<string, { row: SearchRow; score: number; fit: number }>()
  const consider = (row: SearchRow, score: number, rawSim: number, directWrap: number) => {
    if (row.type === 'entity' || row.type === 'heading') {
      // Still allow headings, but entity blobs are noisy duplicates.
      if (row.type === 'entity') return
    }
    const fit = answerFit({ row, score, rawSim, directWrap })
    const prev = answerPool.get(row.id)
    if (!prev || fit > prev.fit) answerPool.set(row.id, { row, score: Math.max(score, fit), fit })
  }

  for (const item of scored.slice(0, 16)) {
    consider(item.row, item.score, item.rawSim, item.directWrap)
  }
  for (const { row, score } of neighborMap.values()) {
    if (answerPool.has(row.id)) continue
    if (!noteIds.has(row.note_id) && !focusSet.has(row.note_id) && focusMentionBoost(row, focusTitles) <= 0) {
      continue
    }
    const vec = bufferToFloat32(row.embedding)
    const directWrap = vec ? maxCosine(retrievalVecs, vec) : -1
    if (directWrap < 0.18 && attributeBoost(q, row.content) <= 0 && focusMentionBoost(row, focusTitles) <= 0) {
      continue
    }
    consider(row, score, directWrap, directWrap)
  }

  // Always read the focused note body on follow-ups — vector rank alone often keeps only the prior fact.
  if (followUp && focusSet.size) {
    for (const row of loadFocusNoteRows(focusSet)) {
      const vec = bufferToFloat32(row.embedding)
      const directWrap = vec ? maxCosine(retrievalVecs, vec) : 0.3
      consider(row, 0.55 + attributeBoost(q, row.content), directWrap, directWrap)
    }
  }

  const answerRanked = [...answerPool.values()].sort((a, b) => b.fit - a.fit)
  const answerMatches: SearchMatch[] = []
  const notesUsed = new Map<string, number>()
  for (const item of answerRanked) {
    if (answerMatches.length >= 10) break
    const used = notesUsed.get(item.row.note_id) || 0
    const perNoteCap = focusSet.has(item.row.note_id) ? 6 : 3
    if (used >= perNoteCap) continue
    notesUsed.set(item.row.note_id, used + 1)
    answerMatches.push({
      componentId: item.row.id,
      noteId: item.row.note_id,
      noteTitle: item.row.note_title,
      type: item.row.type,
      content: item.row.content,
      score: item.fit,
      categoryId: item.row.category_id,
      categoryName: item.row.category_name,
      meta: (() => {
        try {
          return JSON.parse(item.row.meta_json || '{}') as Record<string, unknown>
        } catch {
          return {}
        }
      })(),
    })
  }

  const readingTitles = [
    ...new Set((answerMatches.length ? answerMatches : matches).map((m) => m.noteTitle).filter(Boolean)),
  ].slice(0, 3)
  await progress.status(
    readingTitles.length ? `Reading ${readingTitles.join(', ')}…` : 'Writing an answer…',
  )

  let answer = await synthesizeAnswerWithGemma(
    q,
    answerMatches.length ? answerMatches : matches,
    { world },
  )

  // If focused context couldn't answer, one expand+retry on the full corpus.
  if (
    isWeakAnswer(answer) &&
    scopedRows &&
    scopedRows.length < rows.length &&
    scored.length &&
    scored[0] &&
    preferIds.has(scored[0].row.note_id)
  ) {
    const expanded = rankRows(rows)
    const expLead = expanded[0]
    const expWrap = expLead ? Math.max(expLead.directWrap, expLead.groundedWrap) : -1
    if (expLead && expWrap >= ANSWER_WRAP_MIN) {
      scored = expanded
      const retryMatches = expanded.slice(0, 8).map(({ row, score, rawSim, directWrap }) => ({
        componentId: row.id,
        noteId: row.note_id,
        noteTitle: row.note_title,
        type: row.type,
        content: row.content,
        score: answerFit({ row, score, rawSim, directWrap }),
        categoryId: row.category_id,
        categoryName: row.category_name,
      }))
      const retry = await synthesizeAnswerWithGemma(q, retryMatches, { world })
      if (!isWeakAnswer(retry)) {
        answer = retry
        // Rebuild a tight graph from the expanded seeds used for the answer.
        const keep = new Set(retry.sources.map((s) => s.noteId))
        for (const m of retryMatches.slice(0, 5)) keep.add(m.noteId)
        const pruned = pruneConnectionGraph(nodes, edges, keep)
        const noteCount = keep.size
        return {
          query: q,
          summary: `Answered from ${noteCount} page${noteCount === 1 ? '' : 's'}.`,
          answer,
          nodes: pruned.nodes,
          edges: pruned.edges,
          matches: retryMatches.slice(0, 8),
          followUp,
          discourse: mergeDiscourseAfterAnswer(refs.discourse, {
            operator: 'open_search',
            answerNoteIds: [...keep].map((id) => ({
              noteId: id,
              title: notesById.get(id) || id,
            })),
            entities: plan.entities.length ? plan.entities : refs.entities,
          }),
          operator: 'open_search',
          world,
        }
      }
    }
  }

  const keepNoteIds = new Set<string>()
  for (const s of answer.sources) keepNoteIds.add(s.noteId)
  for (const m of (answerMatches.length ? answerMatches : matches).slice(0, 6)) {
    keepNoteIds.add(m.noteId)
  }
  for (const id of noteIds) keepNoteIds.add(id)

  const pruned = pruneConnectionGraph(nodes, edges, keepNoteIds)
  for (const node of pruned.nodes) liveNodes.set(node.id, node)
  progress.graph(pruned.nodes, pruned.edges)

  const noteCount = pruned.nodes.filter((n) => n.kind === 'note').length
  const summary =
    matches.length === 0
      ? answer.text
      : followUp
        ? `Follow-up from ${noteCount} page${noteCount === 1 ? '' : 's'}.`
        : `Answered from ${noteCount} page${noteCount === 1 ? '' : 's'}.`

  const proposals = proposalsForEntities(plan.entities)

  return {
    query: q,
    summary,
    answer,
    nodes: pruned.nodes,
    edges: pruned.edges,
    matches,
    followUp,
    proposals: proposals.length ? proposals : undefined,
    discourse: mergeDiscourseAfterAnswer(refs.discourse, {
      operator: 'open_search',
      answerNoteIds: [...keepNoteIds].map((id) => ({
        noteId: id,
        title: notesById.get(id) || id,
      })),
      entities: plan.entities.length ? plan.entities : refs.entities,
    }),
    operator: 'open_search',
    world,
  }
}

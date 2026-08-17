import { db } from './db.js'
import { synthesizeAnswerWithGemma, type SynthesizedAnswer } from './answer.js'
import {
  isAttributeQuery,
  isIdentityQuery,
  listEntityNotes,
  noteIdsMentioningEntity,
  proposalsForEntities,
  type EntityRef,
} from './entities.js'
import { tryEntityCardAnswer } from './retrieve.js'
import {
  mergeDiscourseAfterAnswer,
  type DiscourseState,
  type ResolvedReferents,
} from './discourse.js'
import type { WorldSnapshot } from './world.js'
import {
  dueWindowFromQuery,
  listDueReminders,
  weekendBounds,
  type DueDates,
  type DueWindow,
} from './reminders.js'
import { classifyDueIntent } from './operatorIntent.js'

type GraphNode = {
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

type GraphEdge = {
  id: string
  source: string
  target: string
  relation: 'similar' | 'same_note' | 'wikilink' | 'mention' | 'query_match' | 'thread'
  weight: number
}

type SearchMatch = {
  componentId: string
  noteId: string
  noteTitle: string
  type: string
  content: string
  score: number
  categoryId?: string | null
  categoryName?: string | null
}

export type OperatorSearchResult = {
  query: string
  summary: string
  answer: SynthesizedAnswer
  nodes: GraphNode[]
  edges: GraphEdge[]
  matches: SearchMatch[]
  followUp?: boolean
  proposals?: import('./entities.js').EntityProposal[]
  discourse?: DiscourseState
  operator?: string
}

export type OperatorKind =
  | 'identify'
  | 'attribute'
  | 'find_event'
  | 'list_participants'
  | 'list_due'
  | 'open_search'

export type QueryPlan = {
  op: OperatorKind
  entityIds: string[]
  noteId: string | null
  excludeEntityIds: string[]
  rawQuery: string
  /** Set when op is list_due — from embedding classifier (or regex fallback). */
  dueWindow?: DueWindow
}

const LAST_EVENT =
  /\b(last|latest|recent|when|what meeting|which meeting)\b/i
const WHO_ELSE =
  /\b((who|what) else|anyone else|anybody else|who (was|were) (also )?in|who attended|who else was)\b/i
const PARTICIPANTS = /\b(who (was|were) in|attendees|participants|who else)\b/i

export async function planOperator(query: string, refs: ResolvedReferents): Promise<QueryPlan> {
  const q = query.trim()
  const entityIds = refs.entities.map((e) => e.noteId)

  // Prefer semantic due/reminder routing over phrase lists.
  const dueIntent = await classifyDueIntent(q)
  const regexWindow = dueWindowFromQuery(q)
  if (dueIntent.isDueQuestion || regexWindow) {
    return {
      op: 'list_due',
      entityIds,
      noteId: null,
      excludeEntityIds: [],
      rawQuery: q,
      dueWindow: regexWindow || dueIntent.window,
    }
  }

  if (WHO_ELSE.test(q) || (PARTICIPANTS.test(q) && (refs.meetingNoteId || refs.wantsElse))) {
    return {
      op: 'list_participants',
      entityIds,
      noteId: refs.meetingNoteId,
      excludeEntityIds: [
        ...refs.discourse.excludeEntityIds,
        ...entityIds,
      ].filter((id, i, arr) => arr.indexOf(id) === i),
      rawQuery: q,
    }
  }

  if (
    (LAST_EVENT.test(q) || /\bmeeting\b/i.test(q)) &&
    (entityIds.length > 0 || refs.hasPronoun) &&
    !/\bwho is\b/i.test(q)
  ) {
    return {
      op: 'find_event',
      entityIds,
      noteId: null,
      excludeEntityIds: [],
      rawQuery: q,
    }
  }

  if (isAttributeQuery(q) && (entityIds.length || refs.hasPronoun)) {
    return {
      op: 'attribute',
      entityIds,
      noteId: entityIds[0] || null,
      excludeEntityIds: [],
      rawQuery: q,
    }
  }

  if (isIdentityQuery(q) && (entityIds.length || refs.hasPronoun)) {
    return {
      op: 'identify',
      entityIds,
      noteId: entityIds[0] || null,
      excludeEntityIds: [],
      rawQuery: q,
    }
  }

  return {
    op: 'open_search',
    entityIds,
    noteId: refs.meetingNoteId,
    excludeEntityIds: [],
    rawQuery: q,
  }
}

function snippet(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function queryNode(q: string): GraphNode {
  return {
    id: 'query',
    label: snippet(q),
    type: 'query',
    noteId: '',
    noteTitle: '',
    content: q,
    score: 1,
    kind: 'query',
  }
}

function noteMeta(noteId: string): {
  title: string
  categoryId: string | null
  categoryName: string | null
  categoryColor: string | null
} | null {
  const row = db
    .prepare(
      `SELECT n.title, n.category_id, c.name as category_name, c.color as category_color
       FROM notes n LEFT JOIN categories c ON c.id = n.category_id WHERE n.id = ?`,
    )
    .get(noteId) as
    | {
        title: string
        category_id: string | null
        category_name: string | null
        category_color: string | null
      }
    | undefined
  if (!row) return null
  return {
    title: row.title,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryColor: row.category_color,
  }
}

function packResult(input: {
  query: string
  summary: string
  answer: SynthesizedAnswer
  matches: SearchMatch[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  followUp: boolean
  discourse: DiscourseState
  entities: EntityRef[]
  operator: string
}): OperatorSearchResult {
  const proposals = proposalsForEntities(input.entities)
  return {
    query: input.query,
    summary: input.summary,
    answer: input.answer,
    matches: input.matches,
    nodes: input.nodes,
    edges: input.edges,
    followUp: input.followUp,
    proposals: proposals.length ? proposals : undefined,
    discourse: input.discourse,
    operator: input.operator,
  }
}

function verifyAnswer(op: OperatorKind, answer: SynthesizedAnswer, matches: SearchMatch[]): boolean {
  if (!answer.text.trim()) return false
  if (/don’t see that in your notes/i.test(answer.text) && !answer.bullets.length) return false
  if (/couldn.?t extract a specific fact/i.test(answer.text)) return false
  if (op === 'list_participants') {
    return answer.bullets.length > 0 || matches.some((m) => /was in|attended|said/i.test(m.content))
  }
  if (op === 'attribute') {
    const blob = matches.map((m) => m.content).join('\n')
    if (/\b(phone|mobile|cell|number)\b/i.test(answer.text) || /\d{7,}/.test(blob)) return true
    if (/\b(email)\b/i.test(answer.text) || /@/.test(blob)) return true
    return matches.length > 0 && !/don’t see/i.test(answer.text)
  }
  if (op === 'find_event') {
    return matches.some((m) => /meeting|call|sync/i.test(m.noteTitle) || /meeting|call/i.test(m.content))
  }
  return matches.length > 0
}

function parseMeetingSortKey(title: string, content: string): number {
  const blob = `${title}\n${content}`
  const iso = blob.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  if (iso) return Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}`) || 0
  const md = title.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
  if (md) {
    const year = md[3] ? (md[3].length === 2 ? 2000 + Number(md[3]) : Number(md[3])) : new Date().getFullYear()
    return Date.parse(`${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`) || 0
  }
  return 0
}

async function execIdentifyOrAttribute(
  plan: QueryPlan,
  refs: ResolvedReferents,
  world?: WorldSnapshot | null,
): Promise<OperatorSearchResult | null> {
  const entities =
    refs.entities.length > 0
      ? refs.entities
      : listEntityNotes().filter((e) => plan.entityIds.includes(e.noteId))
  if (!entities.length) return null
  const card = await tryEntityCardAnswer(plan.rawQuery, entities, world)
  if (!card) return null
  if (!verifyAnswer(plan.op, card.answer, card.matches)) return null

  const discourse = mergeDiscourseAfterAnswer(refs.discourse, {
    operator: plan.op,
    answerNoteIds: [
      {
        noteId: entities[0].noteId,
        title: entities[0].title,
        categoryName: entities[0].categoryName,
      },
    ],
    entities,
  })

  return packResult({
    query: plan.rawQuery,
    summary: `From ${entities[0].title}.`,
    answer: card.answer,
    matches: card.matches,
    nodes: card.nodes,
    edges: card.edges,
    followUp: refs.isFollowUp,
    discourse,
    entities,
    operator: plan.op,
  })
}

async function execFindEvent(
  plan: QueryPlan,
  refs: ResolvedReferents,
  world?: WorldSnapshot | null,
): Promise<OperatorSearchResult | null> {
  const person =
    refs.entities.find((e) => /people|person/i.test(e.categoryName || '')) ||
    listEntityNotes().find(
      (e) =>
        plan.entityIds.includes(e.noteId) && /people|person/i.test(e.categoryName || ''),
    ) ||
    refs.entities[0] ||
    listEntityNotes().find((e) => e.noteId === refs.discourse.focusEntities[0]?.noteId)

  const entityId = person?.noteId
  if (!entityId || !person) return null
  const entity = person

  const mentionNoteIds = noteIdsMentioningEntity(entityId, ['linked', 'candidate'])
  if (!mentionNoteIds.length) return null

  const placeholders = mentionNoteIds.map(() => '?').join(',')
  const notes = db
    .prepare(
      `SELECT n.id, n.title, n.content, n.category_id, c.name as category_name, c.color as category_color,
              c.slug as category_slug
       FROM notes n
       LEFT JOIN categories c ON c.id = n.category_id
       WHERE n.id IN (${placeholders}) AND n.id != ?`,
    )
    .all(...mentionNoteIds, entityId) as Array<{
    id: string
    title: string
    content: string
    category_id: string | null
    category_name: string | null
    category_color: string | null
    category_slug: string | null
  }>

  const meetings = notes
    .map((n) => ({
      ...n,
      score:
        (/meeting|call|sync|standup/i.test(n.title) || /meeting|call/i.test(n.category_name || '')
          ? 2
          : 0) +
        (/meeting|call/i.test(n.content) ? 1 : 0) +
        parseMeetingSortKey(n.title, n.content) / 1e13,
    }))
    .filter((n) => n.score >= 1 || /meeting|call/i.test(n.title) || /meeting/i.test(n.category_name || ''))
    .sort((a, b) => {
      const da = parseMeetingSortKey(a.title, a.content)
      const db_ = parseMeetingSortKey(b.title, b.content)
      if (da !== db_) return db_ - da
      return b.score - a.score
    })

  const best = meetings[0] || notes.sort((a, b) => parseMeetingSortKey(b.title, b.content) - parseMeetingSortKey(a.title, a.content))[0]
  if (!best) return null

  const comps = db
    .prepare(
      `SELECT id, type, content, position FROM components
       WHERE note_id = ? AND type NOT IN ('divider', 'entity')
       ORDER BY position ASC LIMIT 12`,
    )
    .all(best.id) as Array<{ id: string; type: string; content: string }>

  const matches: SearchMatch[] = comps.slice(0, 6).map((c, i) => ({
    componentId: c.id,
    noteId: best.id,
    noteTitle: best.title,
    type: c.type,
    content: c.content,
    score: 1 - i * 0.05,
    categoryId: best.category_id,
    categoryName: best.category_name,
  }))

  const whenLine =
    comps.find((c) => /meeting|with|told|said/i.test(c.content) && c.type !== 'heading') ||
    comps[0]
  const answer: SynthesizedAnswer = {
    text: whenLine
      ? `${whenLine.content.replace(/\s+/g, ' ').trim()} (${best.title})`
      : `Your last noted meeting with ${entity.title} is ${best.title}.`,
    bullets: comps
      .filter((c) => c.id !== whenLine?.id && c.type !== 'heading')
      .slice(0, 2)
      .map((c) => c.content.replace(/\s+/g, ' ').trim()),
    sources: [
      {
        noteId: best.id,
        noteTitle: best.title,
        componentId: whenLine?.id || `note:${best.id}`,
        snippet: (whenLine?.content || best.title).slice(0, 140),
        type: whenLine?.type || 'note',
        score: 1,
        categoryName: best.category_name,
      },
      {
        noteId: entity.noteId,
        noteTitle: entity.title,
        componentId: `note:${entity.noteId}`,
        snippet: entity.title,
        type: 'note',
        score: 0.7,
        categoryName: entity.categoryName,
      },
    ],
    alternatives: [],
  }

  // Optional polish via Gemma, but keep structured fallback if it goes vague
  const polished = await synthesizeAnswerWithGemma(plan.rawQuery, matches, { world })
  const usePolished =
    verifyAnswer('find_event', polished, matches) &&
    !/a lot happened/i.test(polished.text) &&
    polished.sources.some((s) => s.noteId === best.id)
      ? polished
      : answer

  const nodes: GraphNode[] = [
    queryNode(plan.rawQuery),
    {
      id: `note:${best.id}`,
      label: best.title,
      type: 'note',
      noteId: best.id,
      noteTitle: best.title,
      content: best.title,
      score: 1,
      kind: 'note',
      categoryId: best.category_id,
      categoryName: best.category_name,
      categoryColor: best.category_color,
    },
    {
      id: `note:${entity.noteId}`,
      label: entity.title,
      type: 'note',
      noteId: entity.noteId,
      noteTitle: entity.title,
      content: entity.title,
      score: 0.8,
      kind: 'note',
      categoryId: entity.categoryId,
      categoryName: entity.categoryName,
    },
  ]
  const edges: GraphEdge[] = [
    {
      id: `query_match:query|note:${best.id}`,
      source: 'query',
      target: `note:${best.id}`,
      relation: 'query_match',
      weight: 1,
    },
    {
      id: `mention:note:${best.id}|note:${entity.noteId}`,
      source: `note:${best.id}`,
      target: `note:${entity.noteId}`,
      relation: 'mention',
      weight: 0.9,
    },
  ]

  const discourse = mergeDiscourseAfterAnswer(refs.discourse, {
    operator: 'find_event',
    answerNoteIds: [
      { noteId: best.id, title: best.title, categoryName: best.category_name },
      { noteId: entity.noteId, title: entity.title, categoryName: entity.categoryName },
    ],
    entities: [entity],
  })

  return packResult({
    query: plan.rawQuery,
    summary: `Meeting with ${entity.title}: ${best.title}.`,
    answer: usePolished,
    matches,
    nodes,
    edges,
    followUp: refs.isFollowUp,
    discourse,
    entities: [entity],
    operator: 'find_event',
  })
}

function extractParticipants(
  noteId: string,
  excludeIds: Set<string>,
): Array<{ noteId: string; title: string; categoryName: string | null; evidence: string; componentId: string }> {
  const entities = listEntityNotes().filter((e) => !excludeIds.has(e.noteId))
  const meta = noteMeta(noteId)
  if (!meta) return []

  const linked = db
    .prepare(
      `SELECT m.entity_note_id as id, m.surface, m.source_component_id as componentId, m.status
       FROM mentions m
       WHERE m.source_note_id = ? AND m.status IN ('linked', 'candidate') AND m.entity_note_id IS NOT NULL`,
    )
    .all(noteId) as Array<{ id: string; surface: string; componentId: string | null; status: string }>

  const out: Array<{
    noteId: string
    title: string
    categoryName: string | null
    evidence: string
    componentId: string
  }> = []
  const seen = new Set<string>()

  for (const row of linked) {
    if (!row.id || excludeIds.has(row.id) || seen.has(row.id)) continue
    const ent = entities.find((e) => e.noteId === row.id) || listEntityNotes().find((e) => e.noteId === row.id)
    if (!ent) continue
    const cat = (ent.categoryName || '').toLowerCase()
    if (cat.includes('meeting') || cat.includes('project')) continue
    seen.add(row.id)
    out.push({
      noteId: ent.noteId,
      title: ent.title,
      categoryName: ent.categoryName,
      evidence: row.surface,
      componentId: row.componentId || `note:${noteId}`,
    })
  }

  const comps = db
    .prepare(
      `SELECT id, content FROM components WHERE note_id = ? AND type NOT IN ('divider', 'entity', 'heading') ORDER BY position`,
    )
    .all(noteId) as Array<{ id: string; content: string }>

  for (const ent of entities) {
    if (seen.has(ent.noteId)) continue
    for (const alias of ent.aliases) {
      const a = alias.trim()
      if (a.length < 3) continue
      const hit = comps.find((c) => {
        const lower = c.content.toLowerCase()
        return (
          lower.includes(a.toLowerCase()) &&
          /\b(was in|were in|attended|joined|said|told|with)\b/i.test(c.content)
        )
      })
      if (hit) {
        seen.add(ent.noteId)
        out.push({
          noteId: ent.noteId,
          title: ent.title,
          categoryName: ent.categoryName,
          evidence: hit.content.replace(/\s+/g, ' ').trim(),
          componentId: hit.id,
        })
        break
      }
    }
  }

  // Bare "Eric was in this meeting" without entity page: surface as text participant
  const STOP_NAMES = new Set([
    'she', 'he', 'they', 'we', 'i', 'the', 'a', 'an', 'this', 'that', 'there', 'here',
    'today', 'yesterday', 'meeting', 'call', 'notes', 'note', 'eric', // eric allowed - remove eric from stop
  ])
  STOP_NAMES.delete('eric')

  for (const c of comps) {
    const m = c.content.match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:was|were|is)\s+(?:also\s+)?(?:in|at|on)\b/,
    )
    if (!m) continue
    const name = m[1]
    if (STOP_NAMES.has(name.toLowerCase())) continue
    if (name.toLowerCase() === meta.title.toLowerCase()) continue
    const ent = entities.find(
      (e) =>
        e.title.toLowerCase() === name.toLowerCase() ||
        e.aliases.some((al) => al.toLowerCase() === name.toLowerCase()),
    )
    if (ent) {
      if (seen.has(ent.noteId) || excludeIds.has(ent.noteId)) continue
      seen.add(ent.noteId)
      out.push({
        noteId: ent.noteId,
        title: ent.title,
        categoryName: ent.categoryName,
        evidence: c.content.replace(/\s+/g, ' ').trim(),
        componentId: c.id,
      })
    } else {
      const synthId = `text:${name.toLowerCase()}`
      if (seen.has(synthId)) continue
      if (
        [...excludeIds].some((id) => {
          const ex = listEntityNotes().find((e) => e.noteId === id)
          return ex && ex.aliases.some((al) => al.toLowerCase() === name.toLowerCase())
        })
      ) {
        continue
      }
      seen.add(synthId)
      out.push({
        noteId: synthId,
        title: name,
        categoryName: null,
        evidence: c.content.replace(/\s+/g, ' ').trim(),
        componentId: c.id,
      })
    }
  }

  // Drop self / meeting page / non-people linked noise
  return out.filter((p) => {
    if (p.noteId === noteId) return false
    if (p.title.toLowerCase() === meta.title.toLowerCase()) return false
    if (STOP_NAMES.has(p.title.toLowerCase())) return false
    if (/meeting|call|sync/i.test(p.title) && !/people|person/i.test(p.categoryName || '')) return false
    return true
  })
}

async function execListParticipants(
  plan: QueryPlan,
  refs: ResolvedReferents,
): Promise<OperatorSearchResult | null> {
  const noteId =
    plan.noteId ||
    refs.meetingNoteId ||
    [...refs.discourse.focusNotes].reverse().find((n) => n.role === 'meeting')?.noteId
  if (!noteId) return null
  const meta = noteMeta(noteId)
  if (!meta) return null

  const exclude = new Set(plan.excludeEntityIds)
  const people = extractParticipants(noteId, exclude)
  if (!people.length) {
    const answer: SynthesizedAnswer = {
      text: `I don’t see other people listed in ${meta.title}.`,
      bullets: [],
      sources: [
        {
          noteId,
          noteTitle: meta.title,
          componentId: `note:${noteId}`,
          snippet: meta.title,
          type: 'note',
          score: 0.5,
          categoryName: meta.categoryName,
        },
      ],
      alternatives: [],
    }
    const discourse = mergeDiscourseAfterAnswer(refs.discourse, {
      operator: 'list_participants',
      answerNoteIds: [{ noteId, title: meta.title, categoryName: meta.categoryName }],
      entities: refs.entities,
    })
    return packResult({
      query: plan.rawQuery,
      summary: `Checked ${meta.title}.`,
      answer,
      matches: [],
      nodes: [
        queryNode(plan.rawQuery),
        {
          id: `note:${noteId}`,
          label: meta.title,
          type: 'note',
          noteId,
          noteTitle: meta.title,
          content: meta.title,
          score: 1,
          kind: 'note',
          categoryId: meta.categoryId,
          categoryName: meta.categoryName,
          categoryColor: meta.categoryColor,
        },
      ],
      edges: [
        {
          id: `query_match:query|note:${noteId}`,
          source: 'query',
          target: `note:${noteId}`,
          relation: 'query_match',
          weight: 1,
        },
      ],
      followUp: true,
      discourse,
      entities: refs.entities,
      operator: 'list_participants',
    })
  }

  const names = [...new Set(people.map((p) => p.title))]
  const answer: SynthesizedAnswer = {
    text:
      names.length === 1
        ? `${names[0]} was also in ${meta.title}.`
        : `In ${meta.title}, also: ${names.join(', ')}.`,
    bullets: people.slice(0, 4).map((p) => p.evidence),
    sources: people.slice(0, 5).map((p) => ({
      noteId: p.noteId.startsWith('text:') ? noteId : p.noteId,
      noteTitle: p.noteId.startsWith('text:') ? meta.title : p.title,
      componentId: p.componentId,
      snippet: p.evidence.slice(0, 140),
      type: 'paragraph',
      score: 1,
      categoryName: p.categoryName,
    })),
    alternatives: [],
  }

  const matches: SearchMatch[] = people.map((p, i) => ({
    componentId: p.componentId,
    noteId,
    noteTitle: meta.title,
    type: 'paragraph',
    content: p.evidence,
    score: 1 - i * 0.05,
    categoryId: meta.categoryId,
    categoryName: meta.categoryName,
  }))

  if (!verifyAnswer('list_participants', answer, matches)) return null

  const nodes: GraphNode[] = [
    queryNode(plan.rawQuery),
    {
      id: `note:${noteId}`,
      label: meta.title,
      type: 'note',
      noteId,
      noteTitle: meta.title,
      content: meta.title,
      score: 1,
      kind: 'note',
      categoryId: meta.categoryId,
      categoryName: meta.categoryName,
      categoryColor: meta.categoryColor,
    },
  ]
  const edges: GraphEdge[] = [
    {
      id: `query_match:query|note:${noteId}`,
      source: 'query',
      target: `note:${noteId}`,
      relation: 'query_match',
      weight: 1,
    },
  ]
  for (const p of people) {
    if (p.noteId.startsWith('text:') || p.noteId === noteId) continue
    const id = `note:${p.noteId}`
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        label: p.title,
        type: 'note',
        noteId: p.noteId,
        noteTitle: p.title,
        content: p.title,
        score: 0.85,
        kind: 'note',
        categoryName: p.categoryName,
      })
    }
    edges.push({
      id: `mention:note:${noteId}|${id}`,
      source: `note:${noteId}`,
      target: id,
      relation: 'mention',
      weight: 0.85,
    })
  }

  const discourse = mergeDiscourseAfterAnswer(refs.discourse, {
    operator: 'list_participants',
    answerNoteIds: [
      { noteId, title: meta.title, categoryName: meta.categoryName },
      ...people
        .filter((p) => !p.noteId.startsWith('text:') && p.noteId !== noteId)
        .map((p) => ({ noteId: p.noteId, title: p.title, categoryName: p.categoryName })),
    ],
    entities: refs.entities,
  })

  return packResult({
    query: plan.rawQuery,
    summary: `People in ${meta.title}.`,
    answer,
    matches,
    nodes,
    edges,
    followUp: true,
    discourse,
    entities: refs.entities,
    operator: 'list_participants',
  })
}

function dueDatesFromWorld(world?: WorldSnapshot | null): DueDates {
  if (world?.today) {
    const weekend = weekendBounds(world.today)
    return {
      today: world.today,
      tomorrow: world.tomorrow || world.today,
      weekStart: world.weekStart || world.today,
      weekEnd: world.weekEnd || world.today,
      weekendStart: weekend.weekendStart,
      weekendEnd: weekend.weekendEnd,
    }
  }
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = iso(now)
  const tomorrow = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const weekend = weekendBounds(today)
  return {
    today,
    tomorrow,
    weekStart: today,
    weekEnd: tomorrow,
    weekendStart: weekend.weekendStart,
    weekendEnd: weekend.weekendEnd,
  }
}

function windowPhrase(window: DueWindow, dates: DueDates): string {
  if (window === 'today') return `today (${dates.today})`
  if (window === 'tomorrow') return `tomorrow (${dates.tomorrow})`
  if (window === 'weekend') return `this weekend (${dates.weekendStart} to ${dates.weekendEnd})`
  if (window === 'week') return `this week (${dates.weekStart} to ${dates.weekEnd})`
  return `before today (${dates.today})`
}

function formatDueLabel(dueAt: string | null): string {
  if (!dueAt) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) return dueAt
  const match = dueAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/)
  if (!match) return dueAt
  const hour = Number(match[2])
  const suffix = hour >= 12 ? 'pm' : 'am'
  const h12 = ((hour + 11) % 12) + 1
  return `${match[1]} ${h12}:${match[3]} ${suffix}`
}

function execListDue(
  plan: QueryPlan,
  refs: ResolvedReferents,
  world?: WorldSnapshot | null,
): OperatorSearchResult {
  const window = plan.dueWindow || dueWindowFromQuery(plan.rawQuery) || 'today'
  const dates = dueDatesFromWorld(world)
  const items = listDueReminders(window, dates)
  const when = windowPhrase(window, dates)
  const bullets = items.map((item) => {
    const due = formatDueLabel(item.dueAt)
    const note = item.noteTitle ? ` — ${item.noteTitle}` : ''
    return due ? `${item.title} (${due})${note}` : `${item.title}${note}`
  })
  const answer: SynthesizedAnswer = items.length
    ? {
        text:
          items.length === 1
            ? `1 reminder is due ${when}.`
            : `${items.length} reminders are due ${when}.`,
        bullets,
        sources: items.slice(0, 8).map((item) => ({
          noteId: item.noteId,
          noteTitle: item.noteTitle,
          componentId: item.id,
          snippet: item.title,
          type: 'reminder',
          score: 1,
        })),
        alternatives: [],
      }
    : {
        text: `Nothing is due ${when}.`,
        bullets: [],
        sources: [],
        alternatives: [],
      }

  const nodes: GraphNode[] = [queryNode(plan.rawQuery)]
  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.noteId)) continue
    seen.add(item.noteId)
    const meta = noteMeta(item.noteId)
    nodes.push({
      id: `note:${item.noteId}`,
      label: item.noteTitle,
      type: 'note',
      noteId: item.noteId,
      noteTitle: item.noteTitle,
      content: item.title,
      score: 1,
      kind: 'note',
      categoryId: meta?.categoryId,
      categoryName: meta?.categoryName,
      categoryColor: meta?.categoryColor,
    })
    edges.push({
      id: `query|note:${item.noteId}`,
      source: 'query',
      target: `note:${item.noteId}`,
      relation: 'query_match',
      weight: 1,
    })
  }
  const matches: SearchMatch[] = items.map((item) => ({
    componentId: item.id,
    noteId: item.noteId,
    noteTitle: item.noteTitle,
    type: 'reminder',
    content: item.dueAt ? `${item.title} due ${item.dueAt}` : item.title,
    score: 1,
    categoryName: noteMeta(item.noteId)?.categoryName,
  }))

  return packResult({
    query: plan.rawQuery,
    summary: answer.text,
    answer,
    matches,
    nodes,
    edges,
    followUp: refs.isFollowUp,
    discourse: refs.discourse,
    entities: refs.entities,
    operator: 'list_due',
  })
}

/** Try structured operator path. Returns null to fall back to vector search. */
export async function tryOperatorAnswer(
  query: string,
  refs: ResolvedReferents,
  world?: WorldSnapshot | null,
): Promise<OperatorSearchResult | null> {
  const plan = await planOperator(query, refs)
  if (plan.op === 'open_search') return null

  if (plan.op === 'identify' || plan.op === 'attribute') {
    return execIdentifyOrAttribute(plan, refs, world)
  }
  if (plan.op === 'find_event') {
    return execFindEvent(plan, refs, world)
  }
  if (plan.op === 'list_participants') {
    return execListParticipants(plan, refs)
  }
  if (plan.op === 'list_due') {
    return execListDue(plan, refs, world)
  }
  return null
}

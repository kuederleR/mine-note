import { listEntityNotes, resolveEntitiesInText, type EntityRef } from './entities.js'
import type { HistoryTurn } from './conversation.js'

export type FocusNoteRole = 'person' | 'meeting' | 'project' | 'note'

export type FocusNote = {
  noteId: string
  title: string
  role: FocusNoteRole
  categoryName?: string | null
}

export type DiscourseState = {
  focusEntities: Array<{ noteId: string; title: string; categoryName?: string | null }>
  focusNotes: FocusNote[]
  excludeEntityIds: string[]
  lastOperator?: string
}

export type HistoryTurnWithDiscourse = HistoryTurn & {
  discourse?: DiscourseState | null
}

const PRONOUN = /\b(she|he|her|him|they|them|their|this|that|those|these)\b/i
const ELSE = /\b((who|what) else|anyone else|anybody else|others?)\b/i
const MEETINGISH = /\b(meeting|call|standup|sync|huddle|session)\b/i

function roleFromCategory(categoryName?: string | null, title?: string): FocusNoteRole {
  const c = (categoryName || '').toLowerCase()
  const t = (title || '').toLowerCase()
  if (c.includes('people') || c.includes('person')) return 'person'
  if (c.includes('meeting') || MEETINGISH.test(t)) return 'meeting'
  if (c.includes('project')) return 'project'
  return 'note'
}

export function emptyDiscourse(): DiscourseState {
  return { focusEntities: [], focusNotes: [], excludeEntityIds: [] }
}

/** Rebuild discourse from the last turn that carried state, else from sources. */
export function discourseFromHistory(history: HistoryTurnWithDiscourse[] = []): DiscourseState {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const d = history[i]?.discourse
    if (d && (d.focusEntities?.length || d.focusNotes?.length)) {
      return {
        focusEntities: [...(d.focusEntities || [])],
        focusNotes: [...(d.focusNotes || [])],
        excludeEntityIds: [...(d.excludeEntityIds || [])],
        lastOperator: d.lastOperator,
      }
    }
  }

  const last = [...history].reverse().find((t) => t.query)
  if (!last?.sources?.length) return emptyDiscourse()

  const entities = listEntityNotes()
  const byId = new Map(entities.map((e) => [e.noteId, e]))
  const state = emptyDiscourse()
  for (const src of last.sources) {
    const ent = byId.get(src.noteId)
    if (ent) {
      state.focusEntities.push({
        noteId: ent.noteId,
        title: ent.title,
        categoryName: ent.categoryName,
      })
    }
    state.focusNotes.push({
      noteId: src.noteId,
      title: src.noteTitle,
      role: roleFromCategory(src.categoryName, src.noteTitle),
      categoryName: src.categoryName,
    })
  }
  return state
}

export type ResolvedReferents = {
  discourse: DiscourseState
  entities: EntityRef[]
  meetingNoteId: string | null
  meetingTitle: string | null
  isFollowUp: boolean
  wantsElse: boolean
  hasPronoun: boolean
}

export function resolveReferents(
  query: string,
  history: HistoryTurnWithDiscourse[] = [],
): ResolvedReferents {
  const q = query.trim()
  const prior = discourseFromHistory(history)
  const hasPronoun = PRONOUN.test(q)
  const wantsElse = ELSE.test(q)
  const named = resolveEntitiesInText(q, prior.focusEntities.map((e) => e.noteId), {
    preferPeople: hasPronoun || ELSE.test(q) || /\bwith\b/i.test(q),
  })

  const entities: EntityRef[] = [...named]
  if (!entities.length && hasPronoun && prior.focusEntities.length) {
    const all = listEntityNotes()
    for (const fe of prior.focusEntities) {
      const hit = all.find((e) => e.noteId === fe.noteId)
      if (hit && !entities.some((e) => e.noteId === hit.noteId)) entities.push(hit)
    }
  }

  // Prefer people over meeting pages when pronouns/"with her" are in play.
  entities.sort((a, b) => {
    const ap = /people|person/i.test(a.categoryName || '') ? 1 : 0
    const bp = /people|person/i.test(b.categoryName || '') ? 1 : 0
    return bp - ap
  })

  let meetingNoteId: string | null = null
  let meetingTitle: string | null = null
  const meetingFocus = [...prior.focusNotes].reverse().find((n) => n.role === 'meeting')
  if (/\b(this|that|the)\s+meeting\b/i.test(q) || (wantsElse && meetingFocus) || (MEETINGISH.test(q) && hasPronoun && meetingFocus)) {
    if (meetingFocus) {
      meetingNoteId = meetingFocus.noteId
      meetingTitle = meetingFocus.title
    }
  } else if (meetingFocus && wantsElse) {
    meetingNoteId = meetingFocus.noteId
    meetingTitle = meetingFocus.title
  }

  // Explicit meeting title in query
  if (!meetingNoteId) {
    for (const n of prior.focusNotes) {
      if (n.role === 'meeting' && q.toLowerCase().includes(n.title.toLowerCase())) {
        meetingNoteId = n.noteId
        meetingTitle = n.title
        break
      }
    }
  }

  const discourse: DiscourseState = {
    focusEntities: entities.length
      ? entities.map((e) => ({
          noteId: e.noteId,
          title: e.title,
          categoryName: e.categoryName,
        }))
      : [...prior.focusEntities],
    focusNotes: [...prior.focusNotes],
    excludeEntityIds: wantsElse
      ? [
          ...prior.excludeEntityIds,
          ...entities.map((e) => e.noteId),
          ...prior.focusEntities.map((e) => e.noteId),
        ].filter((id, i, arr) => arr.indexOf(id) === i)
      : [],
    lastOperator: prior.lastOperator,
  }

  return {
    discourse,
    entities,
    meetingNoteId,
    meetingTitle,
    isFollowUp: Boolean(history.some((t) => t.query)),
    wantsElse,
    hasPronoun,
  }
}

export function mergeDiscourseAfterAnswer(
  base: DiscourseState,
  opts: {
    operator: string
    answerNoteIds: Array<{ noteId: string; title: string; categoryName?: string | null }>
    entities?: EntityRef[]
  },
): DiscourseState {
  const focusNotes = [...base.focusNotes]
  for (const n of opts.answerNoteIds) {
    const role = roleFromCategory(n.categoryName, n.title)
    const idx = focusNotes.findIndex((x) => x.noteId === n.noteId)
    const entry: FocusNote = {
      noteId: n.noteId,
      title: n.title,
      role,
      categoryName: n.categoryName,
    }
    if (idx >= 0) focusNotes[idx] = entry
    else focusNotes.push(entry)
  }
  // Keep last 6 notes, prefer meetings/people at end
  const trimmed = focusNotes.slice(-6)

  const focusEntities = opts.entities?.length
    ? opts.entities.map((e) => ({
        noteId: e.noteId,
        title: e.title,
        categoryName: e.categoryName,
      }))
    : base.focusEntities

  return {
    focusEntities,
    focusNotes: trimmed,
    excludeEntityIds: opts.operator === 'list_participants' ? base.excludeEntityIds : [],
    lastOperator: opts.operator,
  }
}

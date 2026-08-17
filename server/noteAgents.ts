import { v4 as uuid } from 'uuid'
import { db } from './db.js'
import { searchConnectionGraph } from './search.js'
import { generateJson, streamJson } from './generate.js'
import { formatWorldPrompt, isWorldQuestion, worldOnlyAnswer, type WorldSnapshot } from './world.js'
import {
  connectionLinkHints,
  normalizeDrafts,
  serializeMineObjects,
  type MineDraft,
} from './mineObjects.js'
import { getCreateSystemPrompt } from './objectSpecs.js'

export type AgentConnection = {
  id: string
  noteId: string
  noteTitle: string
  snippet: string
  categoryName?: string | null
}

export type AgentTurn = {
  id: string
  mode: 'explore' | 'create'
  query: string
  answer?: string
  connections?: AgentConnection[]
  createdAt: string
}

export type NoteAgent = {
  id: string
  noteId: string
  mode: 'explore' | 'create'
  thread: AgentTurn[]
  connections: AgentConnection[]
  output: string
  objects: MineDraft[]
  createdAt: string
  updatedAt: string
}

type AgentRow = {
  id: string
  note_id: string
  mode: string
  thread_json: string
  connections_json: string
  objects_json: string
  output: string
  created_at: string
  updated_at: string
}

function nowIso() {
  return new Date().toISOString()
}

function toAgent(row: AgentRow): NoteAgent {
  return {
    id: row.id,
    noteId: row.note_id,
    mode: row.mode === 'create' ? 'create' : 'explore',
    thread: JSON.parse(row.thread_json || '[]') as AgentTurn[],
    connections: JSON.parse(row.connections_json || '[]') as AgentConnection[],
    objects: JSON.parse(row.objects_json || '[]') as MineDraft[],
    output: row.output || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function save(agent: NoteAgent) {
  db.prepare(
    `UPDATE note_agents
     SET mode = ?, thread_json = ?, connections_json = ?, objects_json = ?, output = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    agent.mode,
    JSON.stringify(agent.thread),
    JSON.stringify(agent.connections),
    JSON.stringify(agent.objects || []),
    agent.output,
    agent.updatedAt,
    agent.id,
  )
}

export function getNoteAgent(id: string): NoteAgent | null {
  const row = db.prepare(`SELECT * FROM note_agents WHERE id = ?`).get(id) as AgentRow | undefined
  return row ? toAgent(row) : null
}

export function listNoteAgents(noteId: string): NoteAgent[] {
  const rows = db
    .prepare(`SELECT * FROM note_agents WHERE note_id = ? ORDER BY created_at ASC`)
    .all(noteId) as AgentRow[]
  return rows.map(toAgent)
}

export function createNoteAgent(noteId: string): NoteAgent {
  const now = nowIso()
  const id = `na_${uuid().slice(0, 12)}`
  db.prepare(
    `INSERT INTO note_agents (id, note_id, mode, thread_json, connections_json, objects_json, output, created_at, updated_at)
     VALUES (?, ?, 'explore', '[]', '[]', '[]', '', ?, ?)`,
  ).run(id, noteId, now, now)
  return getNoteAgent(id)!
}

export function updateNoteAgent(
  id: string,
  patch: Partial<Pick<NoteAgent, 'mode' | 'thread' | 'connections' | 'output' | 'objects'>>,
): NoteAgent | null {
  const agent = getNoteAgent(id)
  if (!agent) return null
  const next: NoteAgent = {
    ...agent,
    ...(patch.mode === 'explore' || patch.mode === 'create' ? { mode: patch.mode } : {}),
    ...(patch.thread ? { thread: patch.thread } : {}),
    ...(patch.connections ? { connections: patch.connections } : {}),
    ...(patch.objects ? { objects: patch.objects } : {}),
    ...(patch.output !== undefined ? { output: patch.output } : {}),
    updatedAt: nowIso(),
  }
  save(next)
  return next
}

export function deleteNoteAgent(id: string): boolean {
  const result = db.prepare(`DELETE FROM note_agents WHERE id = ?`).run(id)
  return result.changes > 0
}

function mergeConnections(existing: AgentConnection[], incoming: AgentConnection[]): AgentConnection[] {
  const out = [...existing]
  for (const item of incoming) {
    if (out.some((row) => row.noteId === item.noteId && row.snippet === item.snippet)) continue
    out.push(item)
  }
  return out
}

export function pruneNoteAgents(noteId: string, content: string) {
  const keep = new Set<string>()
  const agent = /<!--\s*mine-agent:([A-Za-z0-9_-]+)\s*-->/g
  const owned = /agent=([A-Za-z0-9_-]+)/g
  let match: RegExpExecArray | null
  while ((match = agent.exec(content))) keep.add(match[1])
  while ((match = owned.exec(content))) keep.add(match[1])
  const rows = db.prepare(`SELECT id FROM note_agents WHERE note_id = ?`).all(noteId) as Array<{ id: string }>
  for (const row of rows) {
    if (!keep.has(row.id)) db.prepare(`DELETE FROM note_agents WHERE id = ?`).run(row.id)
  }
}

export async function exploreNoteAgent(
  id: string,
  query: string,
  world?: WorldSnapshot | null,
): Promise<NoteAgent> {
  const agent = getNoteAgent(id)
  if (!agent) throw new Error('Agent block not found')
  const q = query.trim()
  if (!q && !world) return agent
  if (world && isWorldQuestion(q)) {
    const only = worldOnlyAnswer(world)
    const turn: AgentTurn = {
      id: `t_${Date.now().toString(36)}`,
      mode: 'explore',
      query: q || 'World',
      answer: [only.text, ...only.bullets].join(' '),
      connections: [],
      createdAt: nowIso(),
    }
    return updateNoteAgent(id, {
      mode: 'explore',
      thread: [...agent.thread, turn],
    })!
  }
  const history = agent.thread
    .filter((turn) => turn.mode === 'explore' && turn.answer)
    .slice(-4)
    .map((turn) => ({
      query: turn.query,
      answer: turn.answer || '',
      bullets: [],
      sources: (turn.connections || []).map((c) => ({
        noteId: c.noteId,
        noteTitle: c.noteTitle,
        snippet: c.snippet,
        categoryName: c.categoryName,
      })),
    }))
  const result = await searchConnectionGraph(q, { history, world })
  const connections: AgentConnection[] = result.answer.sources.map((src) => ({
    id: src.componentId || src.noteId,
    noteId: src.noteId,
    noteTitle: src.noteTitle,
    snippet: src.snippet,
    categoryName: src.categoryName,
  }))
  const turn: AgentTurn = {
    id: `t_${Date.now().toString(36)}`,
    mode: 'explore',
    query: q,
    answer: result.answer.text,
    connections,
    createdAt: nowIso(),
  }
  return updateNoteAgent(id, {
    mode: 'explore',
    thread: [...agent.thread, turn],
    connections: mergeConnections(agent.connections, connections),
  })!
}

export type CreateAgentEvent = {
  type: 'status' | 'partial' | 'done' | 'error'
  status?: string
  progress?: number
  text?: string
  agent?: NoteAgent
  error?: string
}

export async function createFromAgentWithProgress(
  id: string,
  prompt: string,
  noteTitle = '',
  world: WorldSnapshot | null | undefined,
  emit: (event: CreateAgentEvent) => void,
): Promise<NoteAgent> {
  const agent = getNoteAgent(id)
  if (!agent) throw new Error('Agent block not found')
  const q = prompt.trim()
  if (!q) return agent
  if (!noteTitle) {
    const row = db.prepare(`SELECT title FROM notes WHERE id = ?`).get(agent.noteId) as { title: string } | undefined
    noteTitle = row?.title || ''
  }
  const evidence = agent.connections
    .slice(0, 8)
    .map((c) => `- ${c.noteTitle}${c.categoryName ? ` (${c.categoryName})` : ''}: ${c.snippet.slice(0, 180)}`)
    .join('\n')
  const exploration = agent.thread
    .filter((turn) => turn.mode === 'explore' && turn.answer)
    .slice(-3)
    .map((turn) => `Q: ${turn.query}\nA: ${(turn.answer || '').slice(0, 500)}`)
    .join('\n\n')
  const links = connectionLinkHints(agent.connections.slice(0, 8))

  emit({ type: 'status', status: 'Starting Gemma…', progress: 0.12, text: '' })
  let objects: MineDraft[] = []
  try {
    const promptBody = [
      noteTitle ? `Current note title: ${noteTitle}` : '',
      world ? formatWorldPrompt(world) : '',
      `The user wants: ${q}`,
      exploration ? `What we already learned from the notes:\n${exploration}` : '',
      evidence
        ? `Use only these connections as evidence:\n${evidence}`
        : 'No connections yet. Stay general and brief.',
      links ? `When mentioning a connected page, embed a note link:\n${links}` : '',
      'Return JSON { "objects": [...] } now.',
    ]
      .filter(Boolean)
      .join('\n\n')

    let lastEmitAt = 0
    let lastLen = 0
    const raw = await streamJson<unknown>(promptBody, {
      system: getCreateSystemPrompt(),
      timeoutMs: 120_000,
      numPredict: 700,
      numCtx: 4096,
      constrained: false,
      onStart: () => {
        emit({ type: 'status', status: 'Generating…', progress: 0.2, text: '' })
      },
      onContent: (full) => {
        const now = Date.now()
        const isFirst = lastLen === 0
        // Show the first token immediately; then refresh ~every 40ms.
        if (!isFirst && now - lastEmitAt < 40 && full.length - lastLen < 12) return
        lastEmitAt = now
        lastLen = full.length
        emit({
          type: 'partial',
          status: 'Writing objects…',
          progress: Math.min(0.78, 0.22 + full.length / 3500),
          text: full.length > 1600 ? full.slice(-1600) : full,
        })
      },
    })
    objects = normalizeDrafts(raw)
  } catch (e) {
    // Fall back to non-streaming once if stream failed mid-flight.
    try {
      emit({ type: 'status', status: 'Retrying without stream…', progress: 0.35 })
      const raw = await generateJson<unknown>(
        [
          noteTitle ? `Current note title: ${noteTitle}` : '',
          world ? formatWorldPrompt(world) : '',
          `The user wants: ${q}`,
          exploration ? `What we already learned from the notes:\n${exploration}` : '',
          evidence
            ? `Use only these connections as evidence:\n${evidence}`
            : 'No connections yet. Stay general and brief.',
          links ? `When mentioning a connected page, embed a note link:\n${links}` : '',
          'Return JSON { "objects": [...] } now.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        {
          system: getCreateSystemPrompt(),
          timeoutMs: 120_000,
          numPredict: 700,
          numCtx: 4096,
        },
      )
      objects = normalizeDrafts(raw)
    } catch {
      objects = []
      if (e instanceof Error && !/empty response/i.test(e.message)) {
        emit({ type: 'error', error: e.message, status: e.message, progress: 1 })
      }
    }
  }
  if (!objects.length) {
    objects = [{ type: 'paragraph', text: q }]
  }
  emit({ type: 'status', status: 'Placing objects in the note…', progress: 0.88 })
  const output = serializeMineObjects(objects, agent.id)
  const turn: AgentTurn = {
    id: `t_${Date.now().toString(36)}`,
    mode: 'create',
    query: q,
    answer: output,
    connections: agent.connections,
    createdAt: nowIso(),
  }
  const updated = updateNoteAgent(id, {
    mode: 'create',
    thread: [...agent.thread, turn],
    objects,
    output,
  })!
  emit({ type: 'done', status: 'Mine Objects ready.', progress: 1, agent: updated })
  return updated
}

export async function createFromAgent(
  id: string,
  prompt: string,
  noteTitle = '',
  world?: WorldSnapshot | null,
): Promise<NoteAgent> {
  return createFromAgentWithProgress(id, prompt, noteTitle, world, () => {})
}

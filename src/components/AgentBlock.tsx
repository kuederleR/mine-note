import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Bot, Sparkles, X } from 'lucide-react'
import { api } from '../api'
import { useAppStore } from '../store'
import type { NoteAgent } from '../types'
import { ChatSlashMenu } from './ChatSlashMenu'
import {
  collectWorldSnapshot,
  filterChatSlashCommands,
  findChatSlashTrigger,
  insertChatSlashCommand,
  parseWorldCommand,
  shouldIncludeWorld,
  type ChatSlashTrigger,
} from '../lib/world'

type Props = {
  id: string
  output: string
  onClose: () => void
}

export function AgentBlock({ id, output, onClose }: Props) {
  const noteId = useAppStore((s) => s.activeNoteId)
  const selectNote = useAppStore((s) => s.selectNote)
  const startNoteCreate = useAppStore((s) => s.startNoteCreate)
  const job = useAppStore((s) =>
    s.agents.find((item) => item.kind === 'note-create' && item.noteAgentId === id),
  )
  const [agent, setAgent] = useState<NoteAgent | null>(null)
  const [mode, setMode] = useState<'explore' | 'create'>('explore')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slash, setSlash] = useState<ChatSlashTrigger | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const creating = job?.status === 'running'
  const working = busy || creating
  const slashHits = slash ? filterChatSlashCommands(slash.query) : []

  useEffect(() => {
    let cancelled = false
    void api
      .getAgent(id)
      .then((next) => {
        if (cancelled) return
        setAgent(next)
        setMode(next.output || next.objects?.length ? 'create' : next.mode)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load agent')
      })
    return () => {
      cancelled = true
    }
  }, [id, job?.status, output])

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [id])

  useEffect(() => {
    if (job?.status === 'error' && job.error) setError(job.error)
  }, [job?.status, job?.error])

  const worldFor = (raw: string) => {
    const parsed = parseWorldCommand(raw)
    const include = shouldIncludeWorld(raw)
    return {
      query: parsed.query,
      world: include ? collectWorldSnapshot() : null,
    }
  }

  const pickSlash = (cmd: (typeof slashHits)[number]) => {
    if (!slash) return
    setQuery(insertChatSlashCommand(query, slash, cmd.token))
    setSlash(null)
  }

  const submit = async () => {
    const raw = query.trim()
    if (!raw || working || !noteId) return
    const next = worldFor(raw)
    if (!next.query && !next.world) return
    setError(null)
    setSlash(null)
    if (mode === 'create') {
      startNoteCreate({ noteAgentId: id, noteId, prompt: next.query || raw, world: next.world })
      setQuery('')
      return
    }
    setBusy(true)
    try {
      const updated = await api.exploreAgent(id, next.query, next.world)
      setAgent(updated)
      setQuery('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  const removeConnection = async (connectionId: string) => {
    if (!agent) return
    const connections = agent.connections.filter((c) => c.id !== connectionId)
    const next = await api.updateAgent(id, { connections })
    setAgent(next)
  }

  const regenerate = () => {
    if (!noteId || working) return
    const lastCreate = [...(agent?.thread || [])].reverse().find((turn) => turn.mode === 'create')
    const prompt = query.trim() || lastCreate?.query
    if (!prompt) {
      setError('Describe what to add to the note.')
      return
    }
    const next = worldFor(prompt)
    setMode('create')
    setError(null)
    startNoteCreate({
      noteAgentId: id,
      noteId,
      prompt: next.query || prompt,
      world: next.world,
    })
    setQuery('')
  }

  return (
    <div className="agent-block" onMouseDown={(e) => e.stopPropagation()}>
      <header className="agent-block-head">
        <span className="agent-block-title">
          <Bot size={14} />
          Inline AI
        </span>
        <div className="agent-mode" role="tablist" aria-label="Agent mode">
          <button
            type="button"
            className={mode === 'explore' ? 'active' : ''}
            onClick={() => setMode('explore')}
          >
            Explore
          </button>
          <button
            type="button"
            className={mode === 'create' ? 'active' : ''}
            onClick={() => setMode('create')}
          >
            Create
          </button>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Collapse setup">
          <X size={14} />
        </button>
      </header>

      {agent?.connections.length ? (
        <div className="agent-connections">
          {agent.connections.map((connection) => (
            <span key={connection.id} className="agent-chip">
              <button
                type="button"
                title={connection.snippet}
                onClick={() => void selectNote(connection.noteId)}
              >
                {connection.noteTitle}
              </button>
              <button
                type="button"
                className="agent-chip-x"
                aria-label={`Remove ${connection.noteTitle}`}
                onClick={() => void removeConnection(connection.id)}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="agent-hint">
          {mode === 'explore'
            ? 'Ask questions across your notes. Type /world to include local date and time. Sources become connections for Create.'
            : 'Describe what to write. Gemma will compose Mine Objects from the connections.'}
        </p>
      )}

      <div className="agent-thread">
        {(agent?.thread || []).map((turn) => (
          <article key={turn.id} className={`agent-turn ${turn.mode}`}>
            <div className="agent-q">
              {turn.mode === 'create' ? 'Create' : 'Explore'}: {turn.query}
            </div>
            {turn.answer && turn.mode === 'explore' ? <p className="agent-a">{turn.answer}</p> : null}
            {turn.mode === 'create' ? (
              <p className="agent-a muted">Wrote Mine Objects into the note.</p>
            ) : null}
          </article>
        ))}
      </div>

      {creating ? (
        <div className="agent-stream">
          <p className="agent-hint">{job?.message || 'Starting Gemma…'}</p>
          <pre className={`agent-stream-text ${job?.streamText ? '' : 'is-waiting'}`}>
            {job?.streamText || 'Waiting for first token…'}
          </pre>
        </div>
      ) : null}
      {error ? <p className="cat-error">{error}</p> : null}

      <form
        className="agent-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="mine-composer agent-composer">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              const next = e.target.value
              setQuery(next)
              const trigger = findChatSlashTrigger(next, e.target.selectionStart ?? next.length)
              setSlash(trigger)
              if (trigger) setMenuIndex(0)
            }}
            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
              if (!slash || !slashHits.length) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMenuIndex((n) => (n + 1) % slashHits.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMenuIndex((n) => (n - 1 + slashHits.length) % slashHits.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pickSlash(slashHits[menuIndex] || slashHits[0])
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlash(null)
              }
            }}
            placeholder={
              mode === 'explore' ? 'Ask about your notes…  /world' : 'What objects should be added?  /world'
            }
            disabled={working}
          />
          {slash ? (
            <ChatSlashMenu
              commands={slashHits}
              activeIndex={menuIndex}
              onHover={setMenuIndex}
              onPick={pickSlash}
            />
          ) : null}
        </div>
        <button type="submit" className="btn primary" disabled={working || !query.trim()}>
          {working ? 'Working…' : mode === 'explore' ? 'Ask' : 'Write'}
        </button>
        {agent?.connections.length ? (
          <button type="button" className="btn ghost" disabled={working} onClick={regenerate}>
            <Sparkles size={14} />
            {output.trim() ? 'Regenerate' : 'Write from connections'}
          </button>
        ) : null}
      </form>
    </div>
  )
}

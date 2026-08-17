import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Globe } from 'lucide-react'
import { useAppStore } from '../store'
import { ConnectionGraph } from './ConnectionGraph'
import { CatIcon } from './CatIcon'
import { ChatSlashMenu } from './ChatSlashMenu'
import {
  collectWorldSnapshot,
  filterChatSlashCommands,
  findChatSlashTrigger,
  formatWorldHint,
  insertChatSlashCommand,
  parseWorldCommand,
  shouldIncludeWorld,
  type ChatSlashTrigger,
} from '../lib/world'
import type { ChatTurn, GraphEdge, GraphNode, SearchProgress } from '../types'

const SUGGESTIONS = [
  'What did I leave unfinished?',
  'How does product vision connect to research?',
  'Show notes about copper or local models',
  'Where do I talk about weekly review?',
]

function snippet(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function latestTurnGraph(turns: ChatTurn[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const result = turns[i]?.result
    if (!result?.nodes?.length) continue
    const qid = `query:${turns[i].id}`
    const remap = (id: string) => (id === 'query' ? qid : id)
    return {
      nodes: result.nodes.map((node) => ({
        ...node,
        id: remap(node.id),
        label: node.kind === 'query' ? snippet(turns[i].query) : node.label,
      })),
      edges: result.edges.map((edge) => ({
        ...edge,
        id: `${edge.relation}:${[remap(edge.source), remap(edge.target)].sort().join('|')}`,
        source: remap(edge.source),
        target: remap(edge.target),
      })),
    }
  }
  return { nodes: [], edges: [] }
}

function TurnCard({
  turn,
  latest,
  searching,
  progress,
  onOpenNote,
  onConfirmProposal,
  onDismissProposal,
}: {
  turn: ChatTurn
  latest: boolean
  searching?: boolean
  progress?: SearchProgress | null
  onOpenNote: (noteId: string) => void
  onConfirmProposal: (proposalId: string, entityNoteId: string) => void
  onDismissProposal: (proposalId: string) => void
}) {
  const answer = turn.result?.answer
  const proposals = turn.result?.proposals || []
  const waiting = Boolean(searching && !answer && !turn.error)
  return (
    <article className={`chat-turn ${latest ? 'latest' : ''} ${waiting ? 'working' : ''}`}>
      <div className="chat-q">
        {turn.world ? (
          <span className="world-chip" title={formatWorldHint(turn.world)}>
            <Globe size={12} /> World
          </span>
        ) : null}
        {turn.query || (turn.world ? 'Current date and time' : '')}
      </div>
      {turn.error && <div className="chat-err">{turn.error}</div>}
      {waiting && (
        <div className="search-activity">
          <p className="search-status">{progress?.status || 'Looking through your notes…'}</p>
          {progress?.notes.length ? (
            <div className="search-notes">
              {progress.notes.map((note) => (
                <button
                  key={note.noteId}
                  type="button"
                  className="search-note-chip"
                  style={note.categoryColor ? { borderColor: note.categoryColor } : undefined}
                  onClick={() => onOpenNote(note.noteId)}
                >
                  {note.categoryName ? `${note.categoryName} · ` : ''}
                  {note.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {answer && (
        <>
          {turn.result?.followUp && <div className="answer-kicker">Follow-up</div>}
          <p className="chat-a">{answer.text}</p>
          {latest && answer.bullets.length > 0 && (
            <ul className="answer-bullets">
              {answer.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {answer.sources.length > 0 && (
            <div className="source-row compact">
              {answer.sources.map((s) => (
                <button
                  key={s.componentId}
                  type="button"
                  className="source-chip"
                  title={s.snippet}
                  onClick={() => onOpenNote(s.noteId)}
                >
                  <span className="source-title">
                    {s.categoryName ? `${s.categoryName} · ` : ''}
                    {s.noteTitle}
                  </span>
                  {latest && s.snippet ? <span className="source-snip">{s.snippet}</span> : null}
                </button>
              ))}
            </div>
          )}
          {latest && proposals.length > 0 && (
            <div className="entity-proposals">
              {proposals.map((p) => (
                <div key={p.id} className="entity-proposal">
                  <p className="entity-proposal-msg">{p.message}</p>
                  <div className="entity-proposal-actions">
                    {p.candidates.map((c) => (
                      <button
                        key={c.noteId}
                        type="button"
                        className="btn primary small"
                        onClick={() => onConfirmProposal(p.id, c.noteId)}
                      >
                        Link {c.noteTitle}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onOpenNote(p.sourceNoteId)}
                    >
                      Open {p.sourceNoteTitle}
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => onDismissProposal(p.id)}
                    >
                      Not the same
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {!turn.error && !answer && !waiting && <p className="muted">Looking through your notes…</p>}
    </article>
  )
}

export function MinePanel() {
  const open = useAppStore((s) => s.mineOpen)
  const toggleMine = useAppStore((s) => s.toggleMine)
  const askMine = useAppStore((s) => s.askMine)
  const clearMineChat = useAppStore((s) => s.clearMineChat)
  const confirmEntityProposal = useAppStore((s) => s.confirmEntityProposal)
  const dismissEntityProposal = useAppStore((s) => s.dismissEntityProposal)
  const chat = useAppStore((s) => s.chat)
  const activeResult = useAppStore((s) => s.activeResult)
  const searching = useAppStore((s) => s.searching)
  const searchProgress = useAppStore((s) => s.searchProgress)
  const openNoteFromGraph = useAppStore((s) => s.openNoteFromGraph)
  const categories = useAppStore((s) => s.categories)
  const searchCategoryId = useAppStore((s) => s.searchCategoryId)
  const setSearchCategory = useAppStore((s) => s.setSearchCategory)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [slash, setSlash] = useState<ChatSlashTrigger | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  const threadRef = useRef<HTMLDivElement>(null)
  const slashHits = slash ? filterChatSlashCommands(slash.query) : []

  useEffect(() => {
    setSelected(null)
    const el = threadRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chat.length, searching, activeResult?.query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleMine(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, toggleMine])

  const submit = (value?: string) => {
    const raw = (value ?? query).trim()
    if (!raw) return
    const parsed = parseWorldCommand(raw)
    const include = shouldIncludeWorld(raw)
    if (!parsed.query && !include) return
    setQuery('')
    setSlash(null)
    setSelected(null)
    void askMine(parsed.query, include ? collectWorldSnapshot() : null)
  }

  const pickSlash = (cmd: (typeof slashHits)[number]) => {
    if (!slash) return
    setQuery(insertChatSlashCommand(query, slash, cmd.token))
    setSlash(null)
  }

  const onComposerKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
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
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSlash(null)
    }
  }

  const hasThread = chat.length > 0
  const latestId = chat[chat.length - 1]?.id
  const threadGraph = useMemo(() => latestTurnGraph(chat), [chat])

  return (
    <>
      <div
        className={`mine-backdrop ${open ? 'open' : ''}`}
        onClick={() => toggleMine(false)}
        aria-hidden={!open}
      />
      <aside className={`mine-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <header className="mine-header">
          <div>
            <div className="mine-kicker">Ask your notes</div>
            <h2>Mine</h2>
          </div>
          <div className="mine-header-actions">
            {hasThread && (
              <button type="button" className="btn ghost" onClick={() => clearMineChat()}>
                New thread
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => toggleMine(false)} aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        {!hasThread && (
          <p className="mine-intro">
            Ask a question, then follow up — Mine keeps the last pages in mind. Type{' '}
            <kbd>/world</kbd> to include the local date, time, and timezone.
          </p>
        )}

        {categories.length > 0 && (
          <div className="suggestion-row">
            <button
              type="button"
              className={`chip ${searchCategoryId == null ? 'active' : ''}`}
              onClick={() => setSearchCategory(null)}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`chip ${searchCategoryId === c.id ? 'active' : ''}`}
                onClick={() => setSearchCategory(searchCategoryId === c.id ? null : c.id)}
              >
                {c.icon && <CatIcon name={c.icon} color={c.color} size={13} />} {c.name}
              </button>
            ))}
          </div>
        )}

        <div className={`mine-body ${searching ? 'is-searching' : ''}`}>
          {searching && (searchProgress?.nodes.length || 0) > 0 && (
            <div className="mine-graph-live" aria-hidden>
              <ConnectionGraph
                nodes={searchProgress?.nodes || []}
                edges={searchProgress?.edges || []}
                variant="backdrop"
                interactive={false}
                onSelect={() => {}}
              />
            </div>
          )}
          <div className="mine-thread" ref={threadRef}>
          {!hasThread && (
            <div className="suggestion-row">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {chat.map((turn) => (
            <TurnCard
              key={turn.id}
              turn={turn}
              latest={turn.id === latestId && !searching}
              searching={turn.id === latestId && searching}
              progress={turn.id === latestId ? searchProgress : null}
              onOpenNote={(id) => void openNoteFromGraph(id)}
              onConfirmProposal={(proposalId, entityNoteId) =>
                void confirmEntityProposal(turn.id, proposalId, entityNoteId)
              }
              onDismissProposal={(proposalId) => void dismissEntityProposal(turn.id, proposalId)}
            />
          ))}

          {threadGraph.nodes.length > 0 && !searching && (
            <details className="graph-disclosure" open>
              <summary>Connection graph</summary>
              <p className="summary">{activeResult?.summary}</p>
              <ConnectionGraph
                nodes={threadGraph.nodes}
                edges={threadGraph.edges}
                onSelect={(node) => {
                  setSelected(node)
                  if (node.noteId) void openNoteFromGraph(node.noteId)
                }}
              />
              <div className="legend">
                <span><i className="swatch query" /> query</span>
                <span><i className="swatch note" /> page</span>
                <span><i className="swatch component" /> block</span>
              </div>
            </details>
          )}

          {selected && (
            <section className="selected-node">
              <div className="selected-type">{selected.kind} · {selected.type}</div>
              <h4>{selected.noteTitle || selected.label}</h4>
              <p>{selected.content}</p>
              {selected.noteId && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void openNoteFromGraph(selected.noteId)}
                >
                  Open page
                </button>
              )}
            </section>
          )}
          </div>
        </div>

        <form
          className="mine-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="mine-composer">
            <input
              value={query}
              onChange={(e) => {
                const next = e.target.value
                setQuery(next)
                const trigger = findChatSlashTrigger(next, e.target.selectionStart ?? next.length)
                setSlash(trigger)
                if (trigger) setMenuIndex(0)
              }}
              onKeyDown={onComposerKey}
              placeholder={hasThread ? 'Ask a follow-up…  /world for date & time' : 'Ask anything about your notes…  /world for date & time'}
              aria-label="Mine search"
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
          <button type="submit" className="btn primary" disabled={searching}>
            {searching ? 'Thinking…' : 'Ask'}
          </button>
        </form>
      </aside>
    </>
  )
}

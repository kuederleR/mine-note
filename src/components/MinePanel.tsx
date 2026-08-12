import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { ConnectionGraph } from './ConnectionGraph'
import type { GraphNode } from '../types'

const SUGGESTIONS = [
  'What did I leave unfinished?',
  'How does product vision connect to research?',
  'Show notes about copper or local models',
  'Where do I talk about weekly review?',
]

export function MinePanel() {
  const open = useAppStore((s) => s.mineOpen)
  const toggleMine = useAppStore((s) => s.toggleMine)
  const askMine = useAppStore((s) => s.askMine)
  const chat = useAppStore((s) => s.chat)
  const activeResult = useAppStore((s) => s.activeResult)
  const searching = useAppStore((s) => s.searching)
  const openNoteFromGraph = useAppStore((s) => s.openNoteFromGraph)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<GraphNode | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleMine(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, toggleMine])

  const submit = (value?: string) => {
    const q = (value ?? query).trim()
    if (!q) return
    setQuery('')
    setSelected(null)
    void askMine(q)
  }

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
            <div className="mine-kicker">Intelligent search</div>
            <h2>Mine</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => toggleMine(false)} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="mine-intro">
          Ask in plain language. Mine embeds your query locally and draws a connection graph across
          note components — a searchable mind map, not an answer engine.
        </p>

        <form
          className="mine-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library…"
            aria-label="Mine search"
          />
          <button type="submit" className="btn copper" disabled={searching}>
            {searching ? 'Mapping…' : 'Map'}
          </button>
        </form>

        <div className="suggestion-row">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => submit(s)}>
              {s}
            </button>
          ))}
        </div>

        <div className="mine-body">
          {activeResult && (
            <section className="graph-section">
              <h3>Connection graph</h3>
              <p className="summary">{activeResult.summary}</p>
              <ConnectionGraph
                nodes={activeResult.nodes}
                edges={activeResult.edges}
                onSelect={(node) => {
                  setSelected(node)
                  if (node.noteId) void openNoteFromGraph(node.noteId)
                }}
              />
              <div className="legend">
                <span><i className="swatch query" /> query</span>
                <span><i className="swatch note" /> note</span>
                <span><i className="swatch component" /> component</span>
              </div>
            </section>
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
                  Open note
                </button>
              )}
            </section>
          )}

          <section className="chat-log">
            <h3>Trail</h3>
            {chat.length === 0 && (
              <p className="muted">Your searches stay in this session as a trail through the graph.</p>
            )}
            {[...chat].reverse().map((turn) => (
              <article key={turn.id} className="chat-turn">
                <div className="chat-q">{turn.query}</div>
                {turn.error && <div className="chat-err">{turn.error}</div>}
                {turn.result && (
                  <ul className="match-list">
                    {turn.result.matches.slice(0, 5).map((m) => (
                      <li key={m.componentId}>
                        <button
                          type="button"
                          onClick={() => void openNoteFromGraph(m.noteId)}
                        >
                          <span className="match-note">{m.noteTitle}</span>
                          <span className="match-type">{m.type}</span>
                          <span className="match-body">{m.content}</span>
                          <span className="match-score">{m.score.toFixed(2)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>
        </div>
      </aside>
    </>
  )
}

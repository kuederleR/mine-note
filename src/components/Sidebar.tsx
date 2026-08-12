import { formatDistanceToNowStrict } from 'date-fns'
import { useAppStore } from '../store'

export function Sidebar() {
  const notes = useAppStore((s) => s.notes)
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const selectNote = useAppStore((s) => s.selectNote)
  const createNote = useAppStore((s) => s.createNote)
  const health = useAppStore((s) => s.health)
  const toggleMine = useAppStore((s) => s.toggleMine)

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="28" height="28">
            <path d="M6 24 L16 6 L26 24 Z" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="16" cy="19" r="2.4" fill="var(--copper)" stroke="none" />
          </svg>
        </div>
        <div>
          <div className="brand-name">Mine</div>
          <div className="brand-tag">local notes</div>
        </div>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="btn primary" onClick={() => void createNote()}>
          New note
        </button>
        <button type="button" className="btn ghost" onClick={() => toggleMine(true)}>
          Open Mine
        </button>
      </div>

      <div className="note-list-label">Library</div>
      <ul className="note-list">
        {notes.map((note) => (
          <li key={note.id}>
            <button
              type="button"
              className={`note-item ${note.id === activeNoteId ? 'active' : ''}`}
              onClick={() => void selectNote(note.id)}
            >
              <span className="note-item-title">{note.title}</span>
              <span className="note-item-meta">
                {note.componentCount ?? 0} parts ·{' '}
                {formatDistanceToNowStrict(new Date(note.updatedAt), { addSuffix: true })}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        <div className="pill-status">
          <span className={`dot ${health?.embeddings.ready ? 'on' : 'warm'}`} />
          {health?.embeddings.ready ? 'Local model ready' : 'Warming local model'}
        </div>
        <div className="muted tiny">
          {health ? `${health.notes} notes · ${health.components} components` : '—'}
        </div>
      </div>
    </aside>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { renderNoteHtml } from '../lib/renderMarkdown'

export function Editor() {
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const draftTitle = useAppStore((s) => s.draftTitle)
  const draftContent = useAppStore((s) => s.draftContent)
  const dirty = useAppStore((s) => s.dirty)
  const saving = useAppStore((s) => s.saving)
  const statusMessage = useAppStore((s) => s.statusMessage)
  const setTitle = useAppStore((s) => s.setTitle)
  const setContent = useAppStore((s) => s.setContent)
  const save = useAppStore((s) => s.save)
  const deleteActive = useAppStore((s) => s.deleteActive)
  const notes = useAppStore((s) => s.notes)
  const selectNote = useAppStore((s) => s.selectNote)
  const createNote = useAppStore((s) => s.createNote)
  const toggleMine = useAppStore((s) => s.toggleMine)

  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const previewRef = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderNoteHtml(draftContent), [draftContent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        toggleMine(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, toggleMine])

  useEffect(() => {
    const root = previewRef.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const btn = target.closest('.wiki-link') as HTMLButtonElement | null
      if (!btn) return
      const title = btn.dataset.wiki
      if (!title) return
      const match = notes.find((n) => n.title.toLowerCase() === title.toLowerCase())
      if (match) void selectNote(match.id)
      else void createNote(title)
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [notes, selectNote, createNote, setTitle, html, mode])

  if (!activeNoteId) {
    return (
      <main className="editor empty">
        <div className="empty-state">
          <h1 className="brand-hero">Mine</h1>
          <p>A private notebook that maps how your ideas connect.</p>
          <button type="button" className="btn primary" onClick={() => void createNote()}>
            Create your first note
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="editor">
      <header className="editor-toolbar">
        <div className="mode-switch" role="tablist">
          <button
            type="button"
            className={mode === 'write' ? 'active' : ''}
            onClick={() => setMode('write')}
          >
            Write
          </button>
          <button
            type="button"
            className={mode === 'preview' ? 'active' : ''}
            onClick={() => setMode('preview')}
          >
            Preview
          </button>
        </div>
        <div className="toolbar-right">
          <span className="status-line">{saving ? 'Embedding…' : statusMessage || (dirty ? 'Unsaved' : 'Saved')}</span>
          <button type="button" className="btn ghost danger" onClick={() => void deleteActive()}>
            Delete
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            Save
          </button>
          <button type="button" className="btn copper" onClick={() => toggleMine(true)}>
            Mine
          </button>
        </div>
      </header>

      <div className="editor-scroll">
        <input
          className="title-input"
          value={draftTitle}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled"
          aria-label="Note title"
        />

        {mode === 'write' ? (
          <textarea
            className="content-input"
            value={draftContent}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write in markdown. Special blocks: > [!NOTE], :::toggle, [[wiki links]], - [ ] todos"
            spellCheck
          />
        ) : (
          <div
            ref={previewRef}
            className="preview prose"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        <section className="component-legend">
          <h3>Component types</h3>
          <p>
            On save, Mine splits this note into headings, paragraphs, lists, todos, code, callouts,
            toggles, and wiki links — then embeds each piece locally.
          </p>
        </section>
      </div>
    </main>
  )
}

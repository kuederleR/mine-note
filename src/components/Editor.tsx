import { Fragment, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useAppStore } from '../store'
import { LiveMarkdown } from './LiveMarkdown'
import { NestedDragLayer } from './NestedDragLayer'
import { RemindersPane } from './RemindersPane'
import { CatIcon } from './CatIcon'
import { peekMineDrag, writeMineDrag } from '../lib/mineDrag'
import {
  allPanes,
  hitTestSplitSide,
  lastPaneIn,
  MAX_EDITOR_PANES,
  panesAfterExtract,
  tabInsertIndex,
  type EditorLayout,
  type EditorPane,
  type SplitDir,
  type SplitNode,
  type SplitSide,
  type WorkspaceDrop,
} from '../lib/workspaceLayout'

function useNoteOverscroll(scrollerRef: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const scroller = scrollerRef.current
    const page = scroller?.querySelector('.page') as HTMLElement | null
    if (!scroller || !page) return

    let pull = 0
    let vel = 0
    let raf = 0
    let last = 0
    const max = 96
    const stiffness = 920
    const damping = 38

    page.style.willChange = 'transform'
    page.style.transition = 'none'

    const paint = () => {
      page.style.transform = pull > 0.05 ? `translate3d(0, ${pull}px, 0)` : ''
    }

    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000)
      last = now
      vel += (-stiffness * pull - damping * vel) * dt
      pull += vel * dt
      if (pull < 0) {
        pull = 0
        vel = 0
      }
      if (pull > max) {
        pull = max
        vel *= 0.4
      }
      paint()
      if (pull > 0.05 || Math.abs(vel) > 2) {
        raf = requestAnimationFrame(tick)
      } else {
        pull = 0
        vel = 0
        raf = 0
        paint()
      }
    }

    const kick = () => {
      if (raf) return
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }

    const onWheel = (event: WheelEvent) => {
      const atTop = scroller.scrollTop <= 0
      if (!atTop && pull <= 0) return
      if (event.deltaY >= 0 && pull <= 0.05) return
      event.preventDefault()
      const rubber = Math.exp(-pull / 48)
      vel += -event.deltaY * 6 * rubber
      pull = Math.max(0, Math.min(max, pull - event.deltaY * 0.22 * rubber))
      paint()
      kick()
    }

    const onScroll = () => {
      if (scroller.scrollTop > 0 && pull > 0) {
        vel = 0
        pull = 0
        paint()
      }
    }

    scroller.addEventListener('wheel', onWheel, { passive: false })
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('scroll', onScroll)
      page.style.transform = ''
      page.style.transition = ''
      page.style.willChange = ''
    }
  }, [scrollerRef, enabled])
}

type Ghost = { mode: 'left' | 'right' | 'top' | 'bottom' | 'gap' | 'center'; x: number; y: number; w: number; h: number }

function noteDrag(e: DragEvent) {
  const drag = peekMineDrag()
  if (!drag || drag.kind !== 'note') return null
  e.preventDefault()
  e.dataTransfer.dropEffect = drag.paneId ? 'move' : 'copy'
  return drag
}

function tabGhost(
  tabBar: HTMLElement,
  clientX: number,
  draggingId: string | undefined,
): { index: number; ghost: Ghost } {
  const tabRect = tabBar.getBoundingClientRect()
  const tabs = [...tabBar.querySelectorAll('[data-tab-id]')].map((el) => {
    const rect = (el as HTMLElement).getBoundingClientRect()
    return { id: (el as HTMLElement).dataset.tabId || '', left: rect.left, width: rect.width }
  })
  const index = tabInsertIndex(tabs, clientX, draggingId)
  const visible = tabs.filter((tab) => tab.id !== draggingId)
  const at = visible[index]
  const last = visible[visible.length - 1]
  const x = at ? at.left : last ? last.left + last.width : tabRect.left + 8
  return {
    index,
    ghost: { mode: 'gap', x: x - 1, y: tabRect.top + 4, w: 3, h: tabRect.height - 8 },
  }
}

function hitPaneDrop(
  e: DragEvent,
  pane: EditorPane,
  layout: EditorLayout,
): { drop: WorkspaceDrop; ghost: Ghost } | null {
  const drag = peekMineDrag()
  if (!drag || drag.kind !== 'note') return null
  const paneEl = e.currentTarget as HTMLElement
  const tabBar = paneEl.querySelector('.note-tabs') as HTMLElement | null
  const body = paneEl.querySelector('.note-pane-body') as HTMLElement | null
  const tabRect = tabBar?.getBoundingClientRect()
  if (tabBar && tabRect && e.clientY >= tabRect.top && e.clientY <= tabRect.bottom) {
    const hit = tabGhost(tabBar, e.clientX, drag.id)
    return { drop: { type: 'tab', paneId: pane.id, index: hit.index }, ghost: hit.ghost }
  }
  const selfOnly = drag.paneId === pane.id && pane.tabs.length === 1 && pane.tabs[0] === drag.id
  const canSplit = !selfOnly && panesAfterExtract(layout, drag.id, drag.paneId) < MAX_EDITOR_PANES
  const rect = (body || paneEl).getBoundingClientRect()
  const side = hitTestSplitSide(e.clientX, e.clientY, rect, canSplit)
  if (side !== 'center') {
    const vertical = side === 'top' || side === 'bottom'
    return {
      drop: { type: 'split', paneId: pane.id, side },
      ghost: vertical
        ? {
            mode: side,
            x: rect.left,
            y: side === 'top' ? rect.top : rect.top + rect.height * 0.5 + 4,
            w: rect.width,
            h: rect.height * 0.5 - 4,
          }
        : {
            mode: side,
            x: side === 'left' ? rect.left : rect.left + rect.width * 0.5 + 4,
            y: rect.top,
            w: rect.width * 0.5 - 4,
            h: rect.height,
          },
    }
  }
  const already = pane.tabs.includes(drag.id)
  return {
    drop: {
      type: 'tab',
      paneId: pane.id,
      index: already ? pane.tabs.indexOf(drag.id) : pane.tabs.length,
    },
    ghost: {
      mode: 'center',
      x: rect.left + 4,
      y: rect.top + 4,
      w: rect.width - 8,
      h: rect.height - 8,
    },
  }
}

export function Editor() {
  const draftTitle = useAppStore((s) => s.draftTitle)
  const dirty = useAppStore((s) => s.dirty)
  const saving = useAppStore((s) => s.saving)
  const statusMessage = useAppStore((s) => s.statusMessage)
  const save = useAppStore((s) => s.save)
  const deleteActive = useAppStore((s) => s.deleteActive)
  const createNote = useAppStore((s) => s.createNote)
  const toggleMine = useAppStore((s) => s.toggleMine)
  const remindersOpen = useAppStore((s) => s.remindersOpen)
  const notes = useAppStore((s) => s.notes)
  const layout = useAppStore((s) => s.editorLayout)
  const dropNoteOnWorkspace = useAppStore((s) => s.dropNoteOnWorkspace)
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
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
    const clear = () => {
      setGhost(null)
      setDraggingId(null)
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  if (remindersOpen) return <RemindersPane />

  const clearHover = (e: DragEvent) => {
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    setGhost(null)
  }

  const dropEmpty = (e: DragEvent) => {
    const drag = noteDrag(e)
    if (!drag) return
    e.preventDefault()
    void dropNoteOnWorkspace(drag.id, { type: 'empty' })
    setGhost(null)
    setDraggingId(null)
  }

  if (!layout.root) {
    const empty = !notes.length
    return (
      <main
        className="editor empty"
        onDragOver={(e) => {
          if (!noteDrag(e) || empty) return
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setGhost({ mode: 'center', x: rect.left + 8, y: rect.top + 8, w: rect.width - 16, h: rect.height - 16 })
        }}
        onDragEnter={(e) => {
          if (!empty) noteDrag(e)
        }}
        onDragLeave={clearHover}
        onDrop={dropEmpty}
      >
        <div className="empty-state">
          <div className="empty-icon" aria-hidden>
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
              <rect x="10" y="6" width="28" height="36" rx="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M16 16h16M16 22h16M16 28h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <h1>{empty ? 'This workspace is empty' : 'No pages open'}</h1>
          <p>
            {empty
              ? 'Create a page to start writing. Markdown renders as you type.'
              : 'Drop a page from the sidebar, or open one to start writing.'}
          </p>
          <button type="button" className="btn primary" onClick={() => void createNote()}>
            New page
          </button>
        </div>
        {ghost ? <DropGhost ghost={ghost} /> : null}
      </main>
    )
  }

  const status = saving ? 'Saving…' : statusMessage || (dirty ? 'Edited' : 'Saved')
  const split = allPanes(layout).length > 1

  return (
    <main className={`editor${split ? ' has-splits' : ''}`}>
      <header className="editor-toolbar">
        <div className="toolbar-crumb">{draftTitle.trim() || 'Untitled'}</div>
        <div className="toolbar-right">
          <span className="status-line">{status}</span>
          <button type="button" className="btn ghost danger" onClick={() => void deleteActive()}>
            Delete
          </button>
          <button type="button" className="btn ghost" disabled={saving || !dirty} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="btn primary" onClick={() => toggleMine(true)}>
            Mine
          </button>
        </div>
      </header>

      <div className="editor-workspace">
        <SplitBranch
          node={layout.root}
          layout={layout}
          draggingId={draggingId}
          onDraggingId={setDraggingId}
          onGhost={setGhost}
          onLeave={clearHover}
        />
      </div>
      {ghost ? <DropGhost ghost={ghost} /> : null}
      <NestedDragLayer />
    </main>
  )
}

function DropGhost({ ghost }: { ghost: Ghost }) {
  return createPortal(
    <div
      className={`live-drop-ghost mode-${ghost.mode}`}
      style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}
    />,
    document.body,
  )
}

function SplitBranch({
  node,
  layout,
  grow = 1,
  draggingId,
  onDraggingId,
  onGhost,
  onLeave,
}: {
  node: SplitNode
  layout: EditorLayout
  grow?: number
  draggingId: string | null
  onDraggingId: (id: string | null) => void
  onGhost: (ghost: Ghost | null) => void
  onLeave: (e: DragEvent) => void
}) {
  const dropNoteOnWorkspace = useAppStore((s) => s.dropNoteOnWorkspace)
  const style = { flexGrow: grow, flexShrink: 1, flexBasis: 0 }

  if (node.type === 'pane') {
    return (
      <NotePane
        pane={node}
        grow={grow}
        focused={node.id === layout.focusedPaneId}
        draggingId={draggingId}
        onDraggingId={onDraggingId}
        onDragOver={(e) => {
          if (!noteDrag(e)) return
          const hit = hitPaneDrop(e, node, layout)
          if (!hit) return
          onGhost(hit.ghost)
        }}
        onDragLeave={onLeave}
        onDrop={(e) => {
          const drag = noteDrag(e)
          if (!drag) return
          const hit = hitPaneDrop(e, node, layout)
          if (!hit) return
          void dropNoteOnWorkspace(drag.id, hit.drop)
          onGhost(null)
          onDraggingId(null)
        }}
      />
    )
  }

  return (
    <div className={`editor-splits dir-${node.dir}`} style={style}>
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 ? (
            <SplitGutter
              dir={node.dir}
              groupId={node.id}
              index={index - 1}
              sizes={node.sizes}
              dropPaneId={lastPaneIn(node.children[index - 1]).id}
              dropSide={node.dir === 'row' ? 'right' : 'bottom'}
            />
          ) : null}
          <SplitBranch
            node={child}
            layout={layout}
            grow={node.sizes[index] ?? 1}
            draggingId={draggingId}
            onDraggingId={onDraggingId}
            onGhost={onGhost}
            onLeave={onLeave}
          />
        </Fragment>
      ))}
    </div>
  )
}

function SplitGutter({
  dir,
  groupId,
  index,
  sizes,
  dropPaneId,
  dropSide,
}: {
  dir: SplitDir
  groupId: string
  index: number
  sizes: number[]
  dropPaneId: string
  dropSide: SplitSide
}) {
  const setSplitSizes = useAppStore((s) => s.setSplitSizes)
  const dropNoteOnWorkspace = useAppStore((s) => s.dropNoteOnWorkspace)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const start = e.clientX
    const startY = e.clientY
    const prev = handle.previousElementSibling as HTMLElement | null
    const startPx =
      (dir === 'row' ? prev?.getBoundingClientRect().width : prev?.getBoundingClientRect().height) || 1
    const total = sizes[index] + sizes[index + 1]
    const min = Math.max(0.18 * total, 0.15)

    const onMove = (ev: PointerEvent) => {
      const delta = dir === 'row' ? ev.clientX - start : ev.clientY - startY
      const unit = sizes[index] / startPx
      let a = sizes[index] + delta * unit
      let b = total - a
      if (a < min) {
        a = min
        b = total - a
      }
      if (b < min) {
        b = min
        a = total - b
      }
      const next = [...sizes]
      next[index] = a
      next[index + 1] = b
      setSplitSizes(groupId, next)
    }
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
  }

  return (
    <div
      className={`editor-split-gutter dir-${dir}`}
      onPointerDown={onPointerDown}
      onDragOver={(e) => {
        if (!noteDrag(e)) return
      }}
      onDrop={(e) => {
        const drag = noteDrag(e)
        if (!drag) return
        e.preventDefault()
        void dropNoteOnWorkspace(drag.id, { type: 'split', paneId: dropPaneId, side: dropSide })
      }}
    />
  )
}

function NotePane({
  pane,
  grow = 1,
  focused,
  draggingId,
  onDraggingId,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  pane: EditorPane
  grow?: number
  focused: boolean
  draggingId: string | null
  onDraggingId: (id: string | null) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}) {
  const notes = useAppStore((s) => s.notes)
  const sessions = useAppStore((s) => s.noteSessions)
  const focusWorkspacePane = useAppStore((s) => s.focusWorkspacePane)
  const closeWorkspaceTab = useAppStore((s) => s.closeWorkspaceTab)

  return (
    <section
      className={`note-pane${focused ? ' focused' : ''}`}
      style={{ flexGrow: grow, flexShrink: 1, flexBasis: 0 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if ((e.target as HTMLElement).closest('.note-tab-close')) return
        focusWorkspacePane(pane.id)
      }}
      onDragOver={onDragOver}
      onDragEnter={(e) => {
        if (peekMineDrag()?.kind === 'note') e.preventDefault()
      }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="note-tabs" role="tablist" aria-label="Open pages">
        {pane.tabs.map((tabId) => {
          const session = sessions[tabId]
          const note = notes.find((item) => item.id === tabId)
          const title = (session?.title || note?.title || 'Untitled').trim() || 'Untitled'
          const active = pane.activeTabId === tabId
          return (
            <div
              key={tabId}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              data-tab-id={tabId}
              draggable
              className={`note-tab${active ? ' active' : ''}${draggingId === tabId ? ' dragging' : ''}${session?.dirty ? ' dirty' : ''}`}
              onClick={() => focusWorkspacePane(pane.id, tabId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  focusWorkspacePane(pane.id, tabId)
                }
              }}
              onDragStart={(e) => {
                writeMineDrag(e, { kind: 'note', id: tabId, paneId: pane.id })
                onDraggingId(tabId)
                try {
                  e.dataTransfer.setDragImage(e.currentTarget, 24, 12)
                } catch {
                  /* native preview */
                }
              }}
              onDragEnd={() => onDraggingId(null)}
            >
              <span className="note-tab-title">{title}</span>
              <button
                type="button"
                className="note-tab-close"
                aria-label={`Close ${title}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void closeWorkspaceTab(pane.id, tabId)
                }}
              >
                <X size={12} strokeWidth={2.2} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="note-pane-body">
        {pane.activeTabId ? <NotePage noteId={pane.activeTabId} focused={focused} /> : null}
      </div>
    </section>
  )
}

function NotePage({ noteId, focused }: { noteId: string; focused: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const session = useAppStore((s) => s.noteSessions[noteId])
  const setNoteTitle = useAppStore((s) => s.setNoteTitle)
  const setNoteContent = useAppStore((s) => s.setNoteContent)
  const categories = useAppStore((s) => s.categories)
  const setNoteCategory = useAppStore((s) => s.setNoteCategory)
  const startCategorize = useAppStore((s) => s.startCategorize)
  const resolveCategorize = useAppStore((s) => s.resolveCategorize)
  const dismissAgent = useAppStore((s) => s.dismissAgent)
  const aiShortcut = useAppStore((s) => s.workspaceSettings.aiShortcut) || '>'
  const reminderShortcut = useAppStore((s) => s.workspaceSettings.reminderShortcut) || '!'
  const split = useAppStore((s) => allPanes(s.editorLayout).length > 1)
  const agent = useAppStore((s) =>
    s.agents.find(
      (item) =>
        item.kind === 'categorize' && item.view.kind === 'note' && item.view.noteId === noteId,
    ),
  )

  useNoteOverscroll(scrollerRef, focused)

  if (!session) return null

  const currentCategory = categories.find((c) => c.id === session.categoryId)
  const categorizing = agent?.status === 'running'
  const suggestion = agent?.status === 'needs_response' ? agent.suggestion : null
  const catMessage = agent?.message || null

  const categorize = () => {
    if (!focused) return
    startCategorize({ noteId, title: session.title, content: session.content })
  }

  return (
    <div className="editor-scroll" ref={scrollerRef}>
      <div className="page">
        <input
          className="title-input"
          value={session.title}
          onChange={(e) => setNoteTitle(noteId, e.target.value)}
          placeholder="Untitled"
          aria-label="Note title"
        />

        <div className="page-props">
          <label className="prop">
            <span>Category</span>
            {currentCategory && (
              <CatIcon name={currentCategory.icon} color={currentCategory.color} size={14} />
            )}
            <select
              value={session.categoryId || ''}
              onChange={(e) => void setNoteCategory(e.target.value || null, noteId)}
              aria-label="Note category"
            >
              <option value="">Pages</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost cat-btn"
              disabled={categorizing || !focused}
              onClick={() => void categorize()}
            >
              {categorizing ? 'Categorizing…' : 'Categorize'}
            </button>
          </label>
          {catMessage && (
            <p className="prop-hint">
              {catMessage}
              {agent?.status === 'error' ? (
                <>
                  {' '}
                  <button type="button" className="btn ghost" onClick={() => dismissAgent(agent.id)}>
                    Dismiss
                  </button>
                </>
              ) : null}
            </p>
          )}
          {suggestion && agent && (
            <div className="cat-suggest">
              <div className="cat-suggest-head">
                <CatIcon name={suggestion.icon} color={suggestion.color} size={16} />
                <strong>{suggestion.name}</strong>
              </div>
              <p>{suggestion.description || suggestion.embedInstruction}</p>
              <div className="cat-suggest-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={categorizing}
                  onClick={() => void resolveCategorize(agent.id, 'accept')}
                >
                  Create and link
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void resolveCategorize(agent.id, 'dismiss')}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {session.categoryId && !suggestion && (
            <p className="prop-hint">
              Saving indexes a {currentCategory?.name || 'category'} embedding for this page.
            </p>
          )}
        </div>

        <LiveMarkdown
          key={noteId}
          noteId={noteId}
          value={session.content}
          onChange={(content) => setNoteContent(noteId, content)}
          placeholder={`Write, type / for a heading or table, or :${reminderShortcut} for a reminder…`}
          autoFocus={focused && !session.content.trim()}
        />

        {split ? null : (
          <section className="component-legend">
            <p>
              Headings, lists, todos, tables, <code>[[wiki links]]</code>, category tags like{' '}
              <code>:@[Name]</code>, callouts <code>&gt; [!NOTE]</code>, and toggles{' '}
              <code>:::toggle</code> are indexed locally on save. Type <code>/</code> to insert a
              heading, list, table, or other block. Type <code>:</code> then a
              category shortcut to link a page. Type <code>:{reminderShortcut}</code> to drop a reminder
              into the page, or <code>:{aiShortcut}</code> to explore your notes
              and write into this page. Hover a block for the drag handle; agent blocks also
              have a robot icon. Create writes Mine Objects (lists, tables, and nested links) into
              the page; the robot opens the thread that made them.
            </p>
          </section>
        )}
      </div>
    </div>
  )
}

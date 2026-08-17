import { useEffect, useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { formatDistanceToNowStrict } from 'date-fns'
import { Check, Bell, FolderPlus } from 'lucide-react'
import { useAppStore } from '../store'
import { api } from '../api'
import { CatIcon } from './CatIcon'
import { FOLDER_COLORS, type Agent, type Category, type Folder, type Note } from '../types'
import { readMineDrag, writeMineDrag } from '../lib/mineDrag'
import { allPanes } from '../lib/workspaceLayout'

type MenuTarget =
  | { kind: 'folder'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'library' }
  | { kind: 'category'; categoryId: string; folderId: string | null }

type MenuState = { x: number; y: number; target: MenuTarget }

function readDrag(e: DragEvent) {
  return readMineDrag(e)
}

function writeDrag(e: DragEvent, payload: { kind: 'note'; id: string } | { kind: 'folder'; id: string }) {
  writeMineDrag(e, payload)
}

function loadOpenMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('mine.folderOpen') || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

function saveOpenMap(map: Record<string, boolean>) {
  try {
    localStorage.setItem('mine.folderOpen', JSON.stringify(map))
  } catch {
    /* ignore */
  }
}

function openAt(e: ReactMouseEvent, target: MenuTarget, setMenu: (menu: MenuState | null) => void) {
  e.preventDefault()
  e.stopPropagation()
  setMenu({ x: e.clientX, y: e.clientY, target })
}

export function Sidebar() {
  const notes = useAppStore((s) => s.notes)
  const categories = useAppStore((s) => s.categories)
  const folders = useAppStore((s) => s.folders)
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const selectNote = useAppStore((s) => s.selectNote)
  const createNote = useAppStore((s) => s.createNote)
  const createFolder = useAppStore((s) => s.createFolder)
  const openSettings = useAppStore((s) => s.openSettings)
  const health = useAppStore((s) => s.health)
  const toggleMine = useAppStore((s) => s.toggleMine)
  const toggleReminders = useAppStore((s) => s.toggleReminders)
  const remindersOpen = useAppStore((s) => s.remindersOpen)
  const setNoteFolder = useAppStore((s) => s.setNoteFolder)
  const moveFolder = useAppStore((s) => s.moveFolder)
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(loadOpenMap)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)

  const rootFolders = useMemo(
    () => folders.filter((f) => !f.parentId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [folders],
  )
  const rootNotes = useMemo(() => notes.filter((n) => !n.folderId), [notes])

  const setOpen = (id: string, open: boolean) => {
    setOpenMap((prev) => {
      const next = { ...prev, [id]: open }
      saveOpenMap(next)
      return next
    })
  }

  const onDropOnFolder = async (folderId: string | null, e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const payload = readDrag(e)
    if (!payload) return
    if (payload.kind === 'note') {
      await setNoteFolder(payload.id, folderId)
      return
    }
    if (payload.kind === 'folder') {
      if (payload.id === folderId) return
      await moveFolder(payload.id, folderId)
    }
  }

  return (
    <aside className="sidebar" onContextMenu={(e) => e.preventDefault()}>
      <div className="sidebar-brand">
        <div className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="20" height="20">
            <rect width="32" height="32" rx="8" fill="#0F3D38" />
            <path d="M8 22 L16 8 L24 22 Z" stroke="#E8F0EE" strokeWidth="2" fill="none" strokeLinejoin="round" />
            <circle cx="16" cy="18" r="2.2" fill="#C06A3A" />
          </svg>
        </div>
        <div>
          <div className="brand-name">Mine</div>
          <div className="brand-tag">Private workspace</div>
        </div>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="btn sidebar-btn" onClick={() => toggleMine(true)}>
          <SearchIcon />
          Search
        </button>
        <button
          type="button"
          className={`btn sidebar-btn ${remindersOpen ? 'active' : ''}`}
          onClick={() => toggleReminders(true)}
        >
          <Bell size={16} />
          Reminders
        </button>
        <button type="button" className="btn sidebar-btn" onClick={() => void createNote()}>
          <PlusIcon />
          New page
        </button>
        <button
          type="button"
          className="btn sidebar-btn"
          onClick={() => void createFolder({ name: 'Untitled folder' })}
        >
          <FolderPlus size={14} />
          New folder
        </button>
      </div>

      <div
        className={`sidebar-scroll ${dropTarget === 'root' ? 'drop-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDropTarget('root')
        }}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => void onDropOnFolder(null, e)}
        onContextMenu={(e) => openAt(e, { kind: 'library' }, setMenu)}
      >
        <AgentsSection />

        <div className="note-list-label">Folders</div>
        {rootFolders.map((folder) => (
          <FolderNode
            key={folder.id}
            folder={folder}
            depth={0}
            folders={folders}
            notes={notes}
            categories={categories}
            activeNoteId={activeNoteId}
            openMap={openMap}
            dropTarget={dropTarget}
            renamingFolderId={renamingFolderId}
            setOpen={setOpen}
            setDropTarget={setDropTarget}
            setRenamingFolderId={setRenamingFolderId}
            onSelectNote={selectNote}
            onDropOnFolder={onDropOnFolder}
            onEditCategory={(id) => openSettings(id)}
            onOpenMenu={setMenu}
          />
        ))}

        <div className="note-list-label">Library</div>
        <FolderContents
          folderId={null}
          notes={rootNotes}
          categories={categories}
          activeNoteId={activeNoteId}
          depth={0}
          onSelectNote={selectNote}
          onCreateNote={(categoryId) => void createNote('Untitled', categoryId, { folderId: null })}
          onEditCategory={(id) => openSettings(id)}
          onOpenMenu={setMenu}
        />

        <button
          type="button"
          className="btn sidebar-btn add-category"
          onClick={() => openSettings('new')}
        >
          <PlusIcon />
          New category
        </button>
      </div>

      <div className="sidebar-footer">
        <div className="pill-status">
          <span className={`dot ${health?.embeddings.ready ? 'on' : 'warm'}`} />
          {health?.embeddings.ready
            ? health.generator?.ready
              ? 'Local models ready'
              : 'Embeddings ready'
            : health?.embeddings.error
              ? 'Local model failed'
              : 'Warming local model'}
        </div>
        <button type="button" className="btn sidebar-btn" onClick={() => openSettings()}>
          Settings
        </button>
        <div className="muted tiny">
          {health ? `${health.notes} pages · ${health.components} blocks` : '—'}
        </div>
      </div>

      {menu ? (
        <ExplorerContextMenu
          menu={menu}
          folders={folders}
          notes={notes}
          onClose={() => setMenu(null)}
          onRenameFolder={(id) => {
            setRenamingFolderId(id)
            setOpen(id, true)
          }}
          onExpandFolder={(id) => setOpen(id, true)}
        />
      ) : null}
    </aside>
  )
}

function ExplorerContextMenu({
  menu,
  folders,
  notes,
  onClose,
  onRenameFolder,
  onExpandFolder,
}: {
  menu: MenuState
  folders: Folder[]
  notes: Note[]
  onClose: () => void
  onRenameFolder: (id: string) => void
  onExpandFolder: (id: string) => void
}) {
  const createNote = useAppStore((s) => s.createNote)
  const createFolder = useAppStore((s) => s.createFolder)
  const updateFolder = useAppStore((s) => s.updateFolder)
  const deleteFolder = useAppStore((s) => s.deleteFolder)
  const moveFolder = useAppStore((s) => s.moveFolder)
  const setNoteFolder = useAppStore((s) => s.setNoteFolder)
  const deleteNote = useAppStore((s) => s.deleteNote)
  const selectNote = useAppStore((s) => s.selectNote)
  const openSettings = useAppStore((s) => s.openSettings)
  const setTitle = useAppStore((s) => s.setTitle)
  const [moveOpen, setMoveOpen] = useState(false)

  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const pad = 8
  const width = 200
  const left = Math.min(menu.x, window.innerWidth - width - pad)
  const top = Math.min(menu.y, window.innerHeight - 280)

  const run = (fn: () => void | Promise<unknown>) => {
    onClose()
    void fn()
  }

  const target = menu.target
  const folder = target.kind === 'folder' ? folders.find((f) => f.id === target.id) : null
  const note = target.kind === 'note' ? notes.find((n) => n.id === target.id) : null

  const moveTargets = folders.filter((f) => {
    if (target.kind === 'folder') return f.id !== target.id && f.parentId !== target.id
    return true
  })

  return createPortal(
    <div
      className="explorer-menu"
      style={{ left, top, width }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {target.kind === 'folder' && folder ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(async () => {
              await createNote('Untitled', null, { folderId: folder.id })
            })}
          >
            New note
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              run(() => {
                void createFolder({ name: 'Untitled folder', parentId: folder.id })
                onExpandFolder(folder.id)
              })
            }
          >
            New folder
          </button>
          <div className="explorer-menu-sep" />
          <button type="button" role="menuitem" onClick={() => run(() => onRenameFolder(folder.id))}>
            Rename
          </button>
          {folder.parentId ? (
            <button type="button" role="menuitem" onClick={() => run(() => moveFolder(folder.id, null))}>
              Move to Library
            </button>
          ) : null}
          <div className="explorer-menu-label">Color</div>
          <div className="folder-color-row">
            {FOLDER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`folder-color-dot ${folder.color === color ? 'active' : ''}`}
                style={{ background: color }}
                aria-label={`Color ${color}`}
                onClick={() => run(() => updateFolder(folder.id, { color }))}
              />
            ))}
          </div>
          <div className="explorer-menu-sep" />
          <button type="button" role="menuitem" className="danger" onClick={() => run(() => deleteFolder(folder.id))}>
            Delete folder
          </button>
        </>
      ) : null}

      {target.kind === 'note' && note ? (
        <>
          <button type="button" role="menuitem" onClick={() => run(() => selectNote(note.id))}>
            Open
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              run(async () => {
                const next = window.prompt('Rename page', note.title || 'Untitled')
                if (next == null) return
                const title = next.trim() || 'Untitled'
                if (useAppStore.getState().activeNoteId === note.id) {
                  setTitle(title)
                  await useAppStore.getState().flushSave()
                  return
                }
                await api.updateNote(note.id, {
                  title,
                  content: note.content,
                  categoryId: note.categoryId,
                  folderId: note.folderId,
                })
                const listed = await api.listNotes()
                useAppStore.setState({ notes: listed })
              })
            }
          >
            Rename
          </button>
          <button type="button" role="menuitem" className={moveOpen ? 'active' : ''} onClick={() => setMoveOpen((v) => !v)}>
            Move to…
          </button>
          {moveOpen ? (
            <div className="explorer-submenu">
              <button
                type="button"
                role="menuitem"
                disabled={!note.folderId}
                onClick={() => run(() => setNoteFolder(note.id, null))}
              >
                Library
              </button>
              {moveTargets.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  disabled={note.folderId === f.id}
                  onClick={() => run(() => setNoteFolder(note.id, f.id))}
                >
                  <span className="folder-swatch tiny" style={{ background: f.color }} />
                  {f.name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="explorer-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() =>
              run(() => {
                if (window.confirm(`Delete “${note.title || 'Untitled'}”?`)) {
                  void deleteNote(note.id)
                }
              })
            }
          >
            Delete
          </button>
        </>
      ) : null}

      {target.kind === 'library' ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(async () => {
              await createNote('Untitled', null, { folderId: null })
            })}
          >
            New note
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(async () => {
              await createFolder({ name: 'Untitled folder' })
            })}
          >
            New folder
          </button>
        </>
      ) : null}

      {target.kind === 'category' ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              run(async () => {
                await createNote('Untitled', target.categoryId, { folderId: target.folderId })
              })
            }
          >
            New note here
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => openSettings(target.categoryId))}>
            Category settings
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  )
}

function FolderNode({
  folder,
  depth,
  folders,
  notes,
  categories,
  activeNoteId,
  openMap,
  dropTarget,
  renamingFolderId,
  setOpen,
  setDropTarget,
  setRenamingFolderId,
  onSelectNote,
  onDropOnFolder,
  onEditCategory,
  onOpenMenu,
}: {
  folder: Folder
  depth: number
  folders: Folder[]
  notes: Note[]
  categories: Category[]
  activeNoteId: string | null
  openMap: Record<string, boolean>
  dropTarget: string | null
  renamingFolderId: string | null
  setOpen: (id: string, open: boolean) => void
  setDropTarget: (id: string | null) => void
  setRenamingFolderId: (id: string | null) => void
  onSelectNote: (id: string) => Promise<void>
  onDropOnFolder: (folderId: string | null, e: DragEvent) => Promise<void>
  onEditCategory: (id: string) => void
  onOpenMenu: (menu: MenuState | null) => void
}) {
  const open = openMap[folder.id] !== false
  const children = folders
    .filter((f) => f.parentId === folder.id)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  const folderNotes = notes.filter((n) => n.folderId === folder.id)
  const updateFolder = useAppStore((s) => s.updateFolder)
  const createNote = useAppStore((s) => s.createNote)
  const renaming = renamingFolderId === folder.id
  const [nameDraft, setNameDraft] = useState(folder.name)

  useEffect(() => {
    setNameDraft(folder.name)
  }, [folder.name])

  const makeNote = (categoryId: string | null) => {
    void createNote('Untitled', categoryId, { folderId: folder.id })
  }

  const dropId = `folder:${folder.id}`
  const isDrop = dropTarget === dropId

  return (
    <section
      className={`folder-node ${isDrop ? 'drop-active' : ''}`}
      style={{ ['--folder-depth' as string]: depth }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDropTarget(dropId)
      }}
      onDragLeave={(e) => {
        e.stopPropagation()
        setDropTarget(null)
      }}
      onDrop={(e) => void onDropOnFolder(folder.id, e)}
      onContextMenu={(e) => openAt(e, { kind: 'folder', id: folder.id }, onOpenMenu)}
    >
      <div
        className="folder-head"
        draggable={!renaming}
        onDragStart={(e) => {
          writeDrag(e, { kind: 'folder', id: folder.id })
          e.stopPropagation()
        }}
      >
        <button type="button" className="cat-toggle" onClick={() => setOpen(folder.id, !open)}>
          <span className={`cat-caret ${open ? 'open' : ''}`}>▸</span>
          <span className="folder-swatch" style={{ background: folder.color }} aria-hidden />
          {renaming ? (
            <input
              className="folder-rename"
              value={nameDraft}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                setRenamingFolderId(null)
                if (nameDraft.trim() && nameDraft.trim() !== folder.name) {
                  void updateFolder(folder.id, { name: nameDraft.trim() })
                } else setNameDraft(folder.name)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setNameDraft(folder.name)
                  setRenamingFolderId(null)
                }
              }}
            />
          ) : (
            <span className="cat-name">{folder.name}</span>
          )}
          <span className="cat-count">{folderNotes.length}</span>
        </button>
        <button
          type="button"
          className="cat-icon-btn"
          title="New page in folder"
          onClick={() => makeNote(null)}
        >
          +
        </button>
      </div>

      {open ? (
        <div className="folder-body">
          {children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              folders={folders}
              notes={notes}
              categories={categories}
              activeNoteId={activeNoteId}
              openMap={openMap}
              dropTarget={dropTarget}
              renamingFolderId={renamingFolderId}
              setOpen={setOpen}
              setDropTarget={setDropTarget}
              setRenamingFolderId={setRenamingFolderId}
              onSelectNote={onSelectNote}
              onDropOnFolder={onDropOnFolder}
              onEditCategory={onEditCategory}
              onOpenMenu={onOpenMenu}
            />
          ))}
          <FolderContents
            folderId={folder.id}
            notes={folderNotes}
            categories={categories}
            activeNoteId={activeNoteId}
            depth={depth + 1}
            onSelectNote={onSelectNote}
            onCreateNote={makeNote}
            onEditCategory={onEditCategory}
            onOpenMenu={onOpenMenu}
          />
        </div>
      ) : null}
    </section>
  )
}

function FolderContents({
  folderId,
  notes,
  categories,
  activeNoteId,
  depth,
  onSelectNote,
  onCreateNote,
  onEditCategory,
  onOpenMenu,
}: {
  folderId: string | null
  notes: Note[]
  categories: Category[]
  activeNoteId: string | null
  depth: number
  onSelectNote: (id: string) => Promise<void>
  onCreateNote: (categoryId: string | null) => void
  onEditCategory: (id: string) => void
  onOpenMenu: (menu: MenuState | null) => void
}) {
  const uncategorized = notes.filter((n) => !n.categoryId)
  return (
    <div className="folder-contents" style={{ ['--folder-depth' as string]: depth }}>
      {categories.map((category) => {
        const catNotes = notes.filter((n) => n.categoryId === category.id)
        if (folderId !== null && !catNotes.length) return null
        return (
          <CategorySection
            key={`${folderId || 'root'}-${category.id}`}
            category={category}
            folderId={folderId}
            notes={catNotes}
            activeNoteId={activeNoteId}
            onSelect={onSelectNote}
            onCreate={() => onCreateNote(category.id)}
            onEdit={() => onEditCategory(category.id)}
            onOpenMenu={onOpenMenu}
          />
        )
      })}
      {(folderId === null || uncategorized.length > 0) && (
        <section className="cat-section">
          <div className="cat-head">
            <div className="cat-toggle static">
              <span className="cat-name muted-label">{folderId ? 'Pages' : 'Unfiled pages'}</span>
              <span className="cat-count">{uncategorized.length}</span>
            </div>
            <button type="button" className="cat-icon-btn" title="New page" onClick={() => onCreateNote(null)}>
              +
            </button>
          </div>
          <ul className="note-list static">
            {uncategorized.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                active={note.id === activeNoteId}
                onSelect={() => void onSelectNote(note.id)}
                onOpenMenu={onOpenMenu}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function AgentsSection() {
  const agents = useAppStore((s) => s.agents)
  const agentsOpen = useAppStore((s) => s.agentsOpen)
  const toggleAgents = useAppStore((s) => s.toggleAgents)
  const openAgent = useAppStore((s) => s.openAgent)
  const confirmAgent = useAppStore((s) => s.confirmAgent)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const settingsCategoryId = useAppStore((s) => s.settingsCategoryId)
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const unread = agents.filter((agent) => agent.unread).length
  const needsAttention = agents.some(
    (agent) => agent.unread && (agent.status === 'needs_response' || agent.status === 'error'),
  )

  return (
    <section className="cat-section agents-section">
      <div className="cat-head">
        <button type="button" className="cat-toggle" onClick={() => toggleAgents()}>
          <span className={`cat-caret ${agentsOpen ? 'open' : ''}`}>▸</span>
          <span className="cat-icon">
            <AgentIcon />
          </span>
          <span className="cat-name">Agents</span>
          {unread > 0 ? (
            <span className={`agent-badge ${needsAttention ? 'attention' : ''}`}>{unread}</span>
          ) : null}
        </button>
      </div>
      {agentsOpen && (
        <ul className="note-list static">
          {agents.length === 0 ? (
            <li className="agent-empty">Gemma tasks will appear here</li>
          ) : (
            agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                active={isAgentActive(agent, settingsOpen, settingsCategoryId, activeNoteId)}
                onOpen={() => void openAgent(agent.id)}
                onConfirm={() => void confirmAgent(agent.id)}
              />
            ))
          )}
        </ul>
      )}
    </section>
  )
}

function isAgentActive(
  agent: Agent,
  settingsOpen: boolean,
  settingsCategoryId: string | null,
  activeNoteId: string | null,
) {
  if (agent.view.kind === 'settings') {
    return settingsOpen && settingsCategoryId === agent.view.categoryId
  }
  return !settingsOpen && activeNoteId === agent.view.noteId
}

function agentMeta(agent: Agent) {
  if (agent.status === 'running') {
    return `${Math.round(agent.progress * 100)}%`
  }
  if (agent.status === 'needs_response' || agent.status === 'error') {
    return 'Needs a response'
  }
  return 'Done'
}

function AgentRow({
  agent,
  active,
  onOpen,
  onConfirm,
}: {
  agent: Agent
  active: boolean
  onOpen: () => void
  onConfirm: () => void
}) {
  const needsResponse = agent.status === 'needs_response' || agent.status === 'error'
  const confirmLabel =
    agent.kind === 'category-build'
      ? 'Save category'
      : agent.kind === 'note-create'
        ? 'Keep objects'
        : 'Dismiss agent'
  return (
    <li>
      <div className={`note-item agent-item ${active ? 'active' : ''} ${agent.unread ? 'unread' : ''}`}>
        <button type="button" className="agent-item-main" onClick={onOpen}>
          <span className="note-item-body">
            <span className="note-item-title">{agent.title}</span>
            <span className="note-item-meta">{agentMeta(agent)}</span>
          </span>
        </button>
        {needsResponse ? <span className="agent-dot" aria-label="Needs a response" /> : null}
        {agent.status === 'done' ? (
          <button type="button" className="agent-check" aria-label={confirmLabel} title={confirmLabel} onClick={onConfirm}>
            <Check size={14} strokeWidth={2.4} />
          </button>
        ) : null}
      </div>
    </li>
  )
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <rect x="3" y="4.5" width="10" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 4.5V3.5M10 4.5V3.5M6.5 8h3M6.75 10.25h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function CategorySection({
  category,
  folderId,
  notes,
  activeNoteId,
  onSelect,
  onCreate,
  onEdit,
  onOpenMenu,
}: {
  category: Category
  folderId: string | null
  notes: Note[]
  activeNoteId: string | null
  onSelect: (id: string) => Promise<void>
  onCreate: () => void
  onEdit: () => void
  onOpenMenu: (menu: MenuState | null) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <section
      className="cat-section"
      onContextMenu={(e) => openAt(e, { kind: 'category', categoryId: category.id, folderId }, onOpenMenu)}
    >
      <div className="cat-head">
        <button type="button" className="cat-toggle" onClick={() => setOpen((v) => !v)}>
          <span className={`cat-caret ${open ? 'open' : ''}`}>▸</span>
          <span className="cat-icon" style={{ color: category.color }}>
            <CatIcon name={category.icon} color={category.color} size={14} />
          </span>
          <span className="cat-name">{category.name}</span>
          <span className="cat-count">{notes.length}</span>
        </button>
        <button type="button" className="cat-icon-btn" title="New page" onClick={onCreate}>
          +
        </button>
        <button type="button" className="cat-icon-btn" title="Category settings" onClick={onEdit}>
          ⚙
        </button>
      </div>
      {open && (
        <ul className="note-list static">
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              active={note.id === activeNoteId}
              onSelect={() => void onSelect(note.id)}
              onOpenMenu={onOpenMenu}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function NoteRow({
  note,
  active,
  onSelect,
  onOpenMenu,
}: {
  note: Note
  active: boolean
  onSelect: () => void
  onOpenMenu: (menu: MenuState | null) => void
}) {
  const open = useAppStore((s) => allPanes(s.editorLayout).some((pane) => pane.tabs.includes(note.id)))
  return (
    <li
      draggable
      onDragStart={(e) => {
        writeDrag(e, { kind: 'note', id: note.id })
      }}
      onContextMenu={(e) => openAt(e, { kind: 'note', id: note.id }, onOpenMenu)}
    >
      <button
        type="button"
        className={`note-item${active ? ' active' : open ? ' open' : ''}`}
        onClick={onSelect}
      >
        <PageIcon />
        <span className="note-item-body">
          <span className="note-item-title">{note.title || 'Untitled'}</span>
          <span className="note-item-meta">
            {formatDistanceToNowStrict(new Date(note.updatedAt), { addSuffix: true })}
          </span>
        </span>
      </button>
    </li>
  )
}

function PageIcon() {
  return (
    <svg className="note-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden>
      <path
        d="M6 3.5h5.2L15 7.3V16a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 16V5A1.5 1.5 0 0 1 6 3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M11 3.5V7h3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.2 10.2 13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

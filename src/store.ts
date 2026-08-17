import { create } from 'zustand'
import { api, type CategoryInput } from './api'
import { applyCategoryDraft } from './lib/categoryDraft'
import type {
  Agent,
  AgentView,
  Category,
  CategoryDraft,
  ChatTurn,
  Folder,
  Health,
  Note,
  SearchResult,
  ChatHistoryTurn,
  SearchProgress,
  SettingsSection,
  WorkspaceSettings,
  Reminder,
  StorageSettings,
  GitStatus,
  WorldSnapshot,
  MineObjectRecord,
} from './types'
import { DEFAULT_WORKSPACE_SETTINGS } from './lib/shortcuts'
import {
  allPanes,
  allTabIds,
  applyWorkspaceDrop,
  closeTab,
  emptyLayout,
  findPane,
  findPaneForNote,
  focusNote,
  focusedNoteId,
  normalizeLayout,
  openInPane,
  readStoredLayout,
  setActiveTab,
  setFocusedPane,
  setSplitSizes as withSplitSizes,
  writeStoredLayout,
  type EditorLayout,
  type WorkspaceDrop,
} from './lib/workspaceLayout'
import {
  findCanonicalMineObject,
  formatMineBlock,
  innerMineMarkdown,
  parseMineFence,
  replaceAgentRegion,
  unwrapEmbed,
} from './lib/mineObjects'
import {
  DOC_VERSION,
  applyCanonicalObjectUpdate,
  syncDocFromMarkdown,
  type DocObject,
  type StructuredDoc,
} from './lib/structuredDoc'
import { firstColumnId, formatReminder, newReminderId, replaceReminderInContent } from './lib/reminders'
import {
  checkpointNoteHistory,
  pushNoteHistory,
  redoNoteHistory,
  resetNoteHistory,
  undoNoteHistory,
  type NoteSnapshot,
} from './lib/noteHistory'

let embeddingsPoll: number | null = null
const agentControllers = new Map<string, AbortController>()
const confirmingAgents = new Set<string>()
let autosaveTimer: number | null = null
let saveQueue: Promise<void> = Promise.resolve()
const propagateTimers: Record<string, number> = {}

function nowIso() {
  return new Date().toISOString()
}

function sessionFromContent(
  content: string,
  opts?: { doc?: StructuredDoc; objects?: DocObject[]; docVersion?: number },
): Pick<NoteSession, 'content' | 'doc' | 'objects' | 'docVersion'> {
  if (opts?.doc && opts.objects && (opts.docVersion ?? 0) >= DOC_VERSION) {
    return {
      content,
      doc: opts.doc,
      objects: opts.objects,
      docVersion: opts.docVersion ?? DOC_VERSION,
    }
  }
  const synced = syncDocFromMarkdown(content)
  return {
    content,
    doc: synced.doc,
    objects: synced.objects,
    docVersion: opts?.docVersion ?? 0,
  }
}

function noteToSession(note: Note, dirty = false): NoteSession {
  const structured = sessionFromContent(note.content, {
    doc: note.doc,
    objects: note.objects,
    docVersion: note.docVersion,
  })
  return {
    title: note.title,
    categoryId: note.categoryId,
    folderId: note.folderId,
    dirty,
    ...structured,
  }
}

function currentSnapshot(state: { draftTitle: string; draftContent: string }): NoteSnapshot {
  return { title: state.draftTitle, content: state.draftContent }
}

export type NoteSession = {
  title: string
  content: string
  categoryId: string | null
  folderId: string | null
  dirty: boolean
  doc: StructuredDoc
  objects: DocObject[]
  docVersion: number
}

function anyDirty(sessions: Record<string, NoteSession>) {
  return Object.values(sessions).some((session) => session.dirty)
}

function sessionMirror(session: NoteSession | undefined) {
  if (!session) {
    return {
      draftTitle: '',
      draftContent: '',
      draftCategoryId: null as string | null,
      draftFolderId: null as string | null,
    }
  }
  return {
    draftTitle: session.title,
    draftContent: session.content,
    draftCategoryId: session.categoryId,
    draftFolderId: session.folderId,
  }
}

function scheduleAutosave() {
  if (typeof window === 'undefined') return
  if (autosaveTimer !== null) window.clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = null
    void useAppStore.getState().flushSave()
  }, 1200)
}

function clearAutosaveTimer() {
  if (autosaveTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function abortController(id: string) {
  agentControllers.get(id)?.abort()
  agentControllers.delete(id)
}

function removeAgents(match: (agent: Agent) => boolean) {
  const existing = useAppStore.getState().agents.filter(match)
  for (const agent of existing) abortController(agent.id)
  if (!existing.length) return
  const ids = new Set(existing.map((agent) => agent.id))
  useAppStore.setState((s) => ({ agents: s.agents.filter((agent) => !ids.has(agent.id)) }))
}

async function applyNoteCategory(noteId: string, categoryId: string) {
  const state = useAppStore.getState()
  if (state.activeNoteId === noteId) {
    await state.setNoteCategory(categoryId)
    return
  }
  const session = state.noteSessions[noteId]
  if (session) {
    await api.updateNote(noteId, {
      title: session.title,
      content: session.content,
      categoryId,
      folderId: session.folderId,
    })
    const sessions = { ...useAppStore.getState().noteSessions }
    if (sessions[noteId]) sessions[noteId] = { ...sessions[noteId], categoryId, dirty: false }
    useAppStore.setState({ noteSessions: sessions, dirty: anyDirty(sessions) })
    await refreshLibrary()
    return
  }
  const note = await api.getNote(noteId)
  await api.updateNote(noteId, {
    title: note.title,
    content: note.content,
    categoryId,
  })
  await refreshLibrary()
}

function modelsSettled(health: Health | null) {
  const emb = health?.embeddings
  const gen = health?.generator
  const embOk = Boolean(emb?.ready || emb?.error)
  const genBusy = Boolean(gen && (gen.warming || gen.pulling) && !gen.ready && !gen.error)
  return embOk && !genBusy
}

function pollEmbeddingsUntilSettled() {
  if (embeddingsPoll !== null) {
    window.clearInterval(embeddingsPoll)
    embeddingsPoll = null
  }
  if (modelsSettled(useAppStore.getState().health)) return

  embeddingsPoll = window.setInterval(() => {
    void api
      .health()
      .then((health) => {
        useAppStore.setState({ health })
        if (modelsSettled(health) && embeddingsPoll !== null) {
          window.clearInterval(embeddingsPoll)
          embeddingsPoll = null
        }
      })
      .catch(() => {
        /* keep polling until the model settles */
      })
  }, 1500)
}

async function refreshLibrary() {
  const [notes, categories, folders, reminders] = await Promise.all([
    api.listNotes(),
    api.listCategories(),
    api.listFolders().catch(() => useAppStore.getState().folders),
    api.listReminders().catch(() => useAppStore.getState().reminders),
  ])
  useAppStore.setState({ notes, categories, folders, reminders })
}

type AppState = {
  notes: Note[]
  categories: Category[]
  folders: Folder[]
  activeNoteId: string | null
  draftTitle: string
  draftContent: string
  draftCategoryId: string | null
  draftFolderId: string | null
  dirty: boolean
  saving: boolean
  loading: boolean
  mineOpen: boolean
  searchCategoryId: string | null
  health: Health | null
  chat: ChatTurn[]
  activeResult: SearchResult | null
  searching: boolean
  searchProgress: SearchProgress | null
  statusMessage: string | null
  settingsOpen: boolean
  settingsCategoryId: string | null
  settingsSection: SettingsSection
  workspaceSettings: WorkspaceSettings
  storageSettings: StorageSettings | null
  gitStatus: GitStatus | null
  agents: Agent[]
  agentsOpen: boolean
  focusInlineAgentId: string | null
  remindersOpen: boolean
  remindersView: 'list' | 'board'
  reminders: Reminder[]
  focusReminderId: string | null
  focusMineObjectId: string | null
  mineObjects: Record<string, MineObjectRecord>
  editorLayout: EditorLayout
  noteSessions: Record<string, NoteSession>
  load: () => Promise<void>
  selectNote: (id: string, opts?: { focusReminderId?: string | null; focusMineObjectId?: string | null }) => Promise<void>
  dropNoteOnWorkspace: (noteId: string, drop: WorkspaceDrop) => Promise<void>
  closeWorkspaceTab: (paneId: string, noteId: string) => Promise<void>
  focusWorkspacePane: (paneId: string, noteId?: string) => void
  setSplitSizes: (groupId: string, sizes: number[]) => void
  setNoteTitle: (noteId: string, title: string) => void
  setNoteContent: (noteId: string, content: string) => void
  createNote: (
    title?: string,
    categoryId?: string | null,
    opts?: { select?: boolean; folderId?: string | null },
  ) => Promise<Note>
  deleteActive: () => Promise<void>
  deleteNote: (id: string) => Promise<void>
  setTitle: (title: string) => void
  setContent: (content: string) => void
  setNoteCategory: (categoryId: string | null, noteId?: string) => Promise<void>
  setNoteFolder: (noteId: string, folderId: string | null) => Promise<void>
  save: (opts?: { quiet?: boolean; keepalive?: boolean }) => Promise<void>
  flushSave: (opts?: { keepalive?: boolean }) => Promise<void>
  undo: () => void
  redo: () => void
  toggleMine: (open?: boolean) => void
  setSearchCategory: (categoryId: string | null) => void
  askMine: (query: string, world?: WorldSnapshot | null) => Promise<void>
  clearMineChat: () => void
  confirmEntityProposal: (
    turnId: string,
    proposalId: string,
    entityNoteId: string,
  ) => Promise<void>
  dismissEntityProposal: (turnId: string, proposalId: string) => Promise<void>
  openNoteFromGraph: (noteId: string) => Promise<void>
  createCategory: (input?: CategoryInput) => Promise<Category>
  updateCategory: (id: string, input: CategoryInput) => Promise<void>
  deleteCategory: (id: string) => Promise<void>
  createFolder: (input?: { name?: string; color?: string; parentId?: string | null }) => Promise<Folder>
  updateFolder: (
    id: string,
    input: { name?: string; color?: string; parentId?: string | null; position?: number },
  ) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  moveFolder: (id: string, parentId: string | null) => Promise<void>
  openSettings: (categoryId?: string | null, section?: SettingsSection) => void
  closeSettings: () => void
  setSettingsSection: (section: SettingsSection) => void
  saveWorkspaceSettings: (input: Partial<WorkspaceSettings>) => Promise<void>
  loadStorageSettings: () => Promise<void>
  saveStorageSettings: (input: {
    notesDir?: string
    gitEnabled?: boolean
    copyExisting?: boolean
  }) => Promise<void>
  refreshGitStatus: () => Promise<void>
  initGitRepo: () => Promise<void>
  syncGitRepo: (message?: string) => Promise<{ ok: boolean; message: string }>
  toggleAgents: (open?: boolean) => void
  draftCategory: (input: { name?: string; prompt?: string }) => Promise<CategoryDraft>
  startCategoryBuild: (input: {
    categoryId: string
    form: CategoryDraft
    lockedKeys?: string[]
  }) => string
  startCategorize: (input: { noteId: string; title: string; content: string }) => string
  startNoteCreate: (input: { noteAgentId: string; noteId: string; prompt: string; world?: WorldSnapshot | null }) => string
  setFocusInlineAgentId: (id: string | null) => void
  openAgent: (id: string) => Promise<void>
  dismissAgent: (id: string) => void
  confirmAgent: (id: string) => Promise<void>
  resolveCategorize: (id: string, action: 'accept' | 'dismiss') => Promise<void>
  patchAgentDraft: (id: string, form: CategoryDraft, lockedKeys: string[]) => void
  retargetAgentView: (id: string, view: AgentView) => void
  toggleReminders: (open?: boolean) => void
  setRemindersView: (view: 'list' | 'board') => void
  loadReminders: () => Promise<void>
  patchReminder: (
    id: string,
    input: {
      title?: string
      dueAt?: string | null
      status?: string
      position?: number
      objectId?: string | null
      objectType?: string | null
      objectNoteId?: string | null
      objectLabel?: string | null
    },
  ) => Promise<void>
  addReminder: (input?: { title?: string; dueAt?: string | null }) => Promise<void>
  openReminder: (id: string) => Promise<void>
  openMineObject: (noteId: string, objectId: string) => Promise<void>
  setFocusReminderId: (id: string | null) => void
  setFocusMineObjectId: (id: string | null) => void
  syncReminderLocal: (reminder: Reminder) => void
  loadMineObject: (id: string, noteId?: string) => Promise<MineObjectRecord | null>
  saveMineObject: (id: string, inner: string, noteId?: string) => Promise<MineObjectRecord | null>
  rememberMineObject: (record: MineObjectRecord) => void
  /** Write through to the canonical object everywhere it appears (sessions + cache + DB). */
  propagateMineObjectUpdate: (
    srcId: string,
    sourceMarkdown: string,
    opts?: { noteId?: string },
  ) => void
}

export const useAppStore = create<AppState>((set, get) => {
  const persistLayout = (layout: EditorLayout, extra: Partial<AppState> = {}) => {
    const normalized = normalizeLayout(layout)
    writeStoredLayout(normalized)
    const activeNoteId = focusedNoteId(normalized)
    const session = activeNoteId ? get().noteSessions[activeNoteId] : undefined
    set({
      editorLayout: normalized,
      activeNoteId,
      dirty: anyDirty(get().noteSessions),
      ...sessionMirror(session),
      ...extra,
    })
  }

  const writeSession = (
    noteId: string,
    patch: Partial<NoteSession>,
    extra: Partial<AppState> = {},
  ) => {
    const sessions = { ...get().noteSessions }
    const cur = sessions[noteId]
    if (!cur) return
    let next: NoteSession = { ...cur, ...patch }
    if (patch.content !== undefined && patch.doc === undefined) {
      const structured = sessionFromContent(patch.content, {
        docVersion: Math.max(cur.docVersion, DOC_VERSION),
      })
      next = { ...next, ...structured }
    }
    sessions[noteId] = next
    set({
      noteSessions: sessions,
      dirty: anyDirty(sessions),
      ...(get().activeNoteId === noteId ? sessionMirror(sessions[noteId]) : {}),
      ...extra,
    })
  }

  const ensureSession = async (id: string): Promise<NoteSession | null> => {
    const existing = get().noteSessions[id]
    if (existing) return existing
    try {
      const note = await api.getNote(id)
      const raced = get().noteSessions[id]
      if (raced) return raced
      const session = noteToSession(note, false)
      set({ noteSessions: { ...get().noteSessions, [id]: session } })
      return session
    } catch {
      return null
    }
  }

  return {
  notes: [],
  categories: [],
  folders: [],
  activeNoteId: null,
  draftTitle: '',
  draftContent: '',
  draftCategoryId: null,
  draftFolderId: null,
  dirty: false,
  editorLayout: emptyLayout(),
  noteSessions: {},
  saving: false,
  loading: true,
  mineOpen: false,
  searchCategoryId: null,
  health: null,
  chat: [],
  activeResult: null,
  searching: false,
  searchProgress: null,
  statusMessage: null,
  settingsOpen: false,
  settingsCategoryId: null,
  settingsSection: 'categories',
  workspaceSettings: DEFAULT_WORKSPACE_SETTINGS,
  storageSettings: null,
  gitStatus: null,
  agents: [],
  agentsOpen: true,
  focusInlineAgentId: null,
  remindersOpen: false,
  remindersView: 'list',
  reminders: [],
  focusReminderId: null,
  focusMineObjectId: null,
  mineObjects: {},

  load: async () => {
    set({ loading: true })
    try {
      const [notes, categories, folders, health, workspaceSettings, reminders, storageSettings] =
        await Promise.all([
          api.listNotes(),
          api.listCategories(),
          api.listFolders().catch(() => []),
          api.health(),
          api.getSettings().catch(() => DEFAULT_WORKSPACE_SETTINGS),
          api.listReminders().catch(() => []),
          api.getStorage().catch(() => null),
        ])
      set({
        notes,
        categories,
        folders,
        health,
        workspaceSettings,
        reminders,
        storageSettings,
      })
      if (!notes.length) {
        clearAutosaveTimer()
        persistLayout(emptyLayout(), {
          noteSessions: {},
          activeNoteId: null,
          dirty: false,
          ...sessionMirror(undefined),
        })
      }
      if (storageSettings?.gitEnabled) {
        void get().refreshGitStatus()
      }
      pollEmbeddingsUntilSettled()
      if (!notes.length) {
        set({ loading: false })
        return
      }
      if (!get().activeNoteId) {
        const valid = new Set(notes.map((note) => note.id))
        const stored = readStoredLayout()
        if (stored) {
          const restored = normalizeLayout(stored, valid)
          if (allPanes(restored).length) {
            await Promise.all(allTabIds(restored).map((id) => ensureSession(id)))
            persistLayout(normalizeLayout(restored, new Set(Object.keys(get().noteSessions))))
          } else if (!stored.root) {
            persistLayout(emptyLayout())
          } else if (notes.length) {
            await get().selectNote(notes[0].id)
          }
        } else if (notes.length) {
          await get().selectNote(notes[0].id)
        }
      }
      set({ loading: false })
    } catch (e) {
      set({
        loading: false,
        statusMessage: e instanceof Error ? e.message : 'Failed to load',
      })
    }
  },

  selectNote: async (id, opts) => {
    const session = await ensureSession(id)
    if (!session) {
      set({ statusMessage: 'Failed to open page' })
      return
    }
    const prev = get().activeNoteId
    const layout = get().editorLayout
    const next = findPaneForNote(layout, id)
      ? focusNote(layout, id)
      : openInPane(layout, layout.focusedPaneId, id)
    if (prev !== id) resetNoteHistory()
    if (!anyDirty(get().noteSessions)) clearAutosaveTimer()
    persistLayout(next, {
      statusMessage: null,
      remindersOpen: false,
      focusReminderId: opts?.focusReminderId ?? null,
      focusMineObjectId: opts?.focusMineObjectId ?? null,
    })
  },

  dropNoteOnWorkspace: async (noteId, drop) => {
    const session = await ensureSession(noteId)
    if (!session) return
    const prev = get().activeNoteId
    const next = applyWorkspaceDrop(get().editorLayout, noteId, drop)
    if (focusedNoteId(next) !== prev) resetNoteHistory()
    persistLayout(next, { remindersOpen: false })
  },

  closeWorkspaceTab: async (paneId, noteId) => {
    const session = get().noteSessions[noteId]
    if (session?.dirty) {
      try {
        await api.updateNote(noteId, {
          title: session.title,
          content: session.content,
          categoryId: session.categoryId,
          folderId: session.folderId,
        })
      } catch {
        /* keep the tab if save failed */
        set({ statusMessage: 'Save failed' })
        return
      }
    }
    const sessions = { ...get().noteSessions }
    delete sessions[noteId]
    const prev = get().activeNoteId
    set({ noteSessions: sessions, dirty: anyDirty(sessions) })
    const next = closeTab(get().editorLayout, paneId, noteId)
    if (focusedNoteId(next) !== prev) resetNoteHistory()
    persistLayout(next)
  },

  focusWorkspacePane: (paneId, noteId) => {
    const current = get().editorLayout
    const pane = findPane(current, paneId)
    if (!pane) return
    if (current.focusedPaneId === paneId && (!noteId || pane.activeTabId === noteId)) return
    let layout = setFocusedPane(current, paneId)
    if (noteId) layout = setActiveTab(layout, paneId, noteId)
    const nextFocus = focusedNoteId(layout)
    if (nextFocus !== get().activeNoteId) resetNoteHistory()
    persistLayout(layout)
  },

  setSplitSizes: (groupId, sizes) => {
    persistLayout(withSplitSizes(get().editorLayout, groupId, sizes))
  },

  createNote: async (title, categoryId, opts) => {
    if (anyDirty(get().noteSessions)) await get().flushSave()
    const resolved = (title || 'Untitled').trim() || 'Untitled'
    const note = await api.createNote({
      title: resolved,
      categoryId: categoryId ?? null,
      folderId: opts?.folderId ?? null,
    })
    await refreshLibrary()
    if (opts?.select !== false) await get().selectNote(note.id)
    return note
  },

  deleteActive: async () => {
    const id = get().activeNoteId
    if (!id) return
    await get().deleteNote(id)
  },

  deleteNote: async (id) => {
    await api.deleteNote(id)
    await refreshLibrary()
    const sessions = { ...get().noteSessions }
    delete sessions[id]
    const prev = get().activeNoteId
    set({ noteSessions: sessions, dirty: anyDirty(sessions) })
    const pane = findPaneForNote(get().editorLayout, id)
    const next = pane ? closeTab(get().editorLayout, pane.id, id) : get().editorLayout
    if (prev === id) resetNoteHistory()
    persistLayout(next)
    if (!anyDirty(get().noteSessions)) clearAutosaveTimer()
  },

  setNoteTitle: (noteId, title) => {
    const session = get().noteSessions[noteId]
    if (!session || title === session.title) return
    if (get().activeNoteId === noteId) pushNoteHistory(currentSnapshot(get()))
    writeSession(noteId, { title, dirty: true })
    scheduleAutosave()
  },

  setNoteContent: (noteId, content) => {
    const session = get().noteSessions[noteId]
    if (!session || content === session.content) return
    if (get().activeNoteId === noteId) pushNoteHistory(currentSnapshot(get()))
    const structured = sessionFromContent(content, { docVersion: Math.max(session.docVersion, DOC_VERSION) })
    writeSession(noteId, { ...structured, dirty: true })
    scheduleAutosave()
  },

  setTitle: (title) => {
    const id = get().activeNoteId
    if (id) get().setNoteTitle(id, title)
  },

  setContent: (content) => {
    const id = get().activeNoteId
    if (id) get().setNoteContent(id, content)
  },

  undo: () => {
    const state = get()
    const prev = undoNoteHistory(currentSnapshot(state))
    if (!prev) return
    const id = state.activeNoteId
    if (id) writeSession(id, { title: prev.title, content: prev.content, dirty: true })
    else set({ draftTitle: prev.title, draftContent: prev.content, dirty: true })
    scheduleAutosave()
  },

  redo: () => {
    const state = get()
    const next = redoNoteHistory(currentSnapshot(state))
    if (!next) return
    const id = state.activeNoteId
    if (id) writeSession(id, { title: next.title, content: next.content, dirty: true })
    else set({ draftTitle: next.title, draftContent: next.content, dirty: true })
    scheduleAutosave()
  },

  setNoteCategory: async (categoryId, noteId) => {
    const id = noteId ?? get().activeNoteId
    if (!id) return
    writeSession(id, { categoryId })
    const session = get().noteSessions[id]
    if (!session) return
    set({ saving: true, statusMessage: 'Updating category embedding…' })
    try {
      await api.updateNote(id, {
        title: session.title,
        content: session.content,
        categoryId,
        folderId: session.folderId,
      })
      await refreshLibrary()
      writeSession(id, { categoryId, dirty: false }, {
        saving: false,
        statusMessage: 'Indexed locally',
      })
      window.setTimeout(() => {
        if (get().statusMessage === 'Indexed locally') set({ statusMessage: null })
      }, 1800)
    } catch (e) {
      set({
        saving: false,
        statusMessage: e instanceof Error ? e.message : 'Category update failed',
      })
    }
  },

  setNoteFolder: async (noteId, folderId) => {
    const note = get().notes.find((item) => item.id === noteId)
    if (!note) return
    const session = get().noteSessions[noteId]
    await api.updateNote(noteId, {
      title: session?.title ?? note.title,
      content: session?.content ?? note.content,
      categoryId: session?.categoryId ?? note.categoryId,
      folderId,
    })
    if (session) writeSession(noteId, { folderId, dirty: false })
    await refreshLibrary()
  },

  flushSave: async (opts) => {
    clearAutosaveTimer()
    if (!anyDirty(get().noteSessions)) return
    await get().save({ quiet: true, keepalive: opts?.keepalive })
  },

  save: async (opts) => {
    const run = async () => {
      const snapshots = Object.entries(get().noteSessions)
        .filter(([, session]) => session.dirty)
        .map(([id, session]) => ({ id, ...session }))
      if (!snapshots.length) return
      const quiet = Boolean(opts?.quiet)
      set({
        saving: true,
        statusMessage: quiet ? get().statusMessage : 'Saving & embedding…',
      })
      try {
        for (const snap of snapshots) {
          await api.updateNote(
            snap.id,
            {
              title: snap.title,
              content: snap.content,
              categoryId: snap.categoryId,
              folderId: snap.folderId,
            },
            { keepalive: opts?.keepalive },
          )
        }
        const sessions = { ...get().noteSessions }
        for (const snap of snapshots) {
          const cur = sessions[snap.id]
          if (cur && cur.title === snap.title && cur.content === snap.content) {
            sessions[snap.id] = { ...cur, dirty: false }
          }
        }
        const [notes, categories, folders, health, reminders] = await Promise.all([
          api.listNotes(),
          api.listCategories(),
          api.listFolders().catch(() => get().folders),
          api.health(),
          api.listReminders().catch(() => get().reminders),
        ])
        const active = get().activeNoteId
        const remainingDirty = anyDirty(sessions)
        set({
          notes,
          categories,
          folders,
          health,
          reminders,
          noteSessions: sessions,
          dirty: remainingDirty,
          saving: false,
          statusMessage: quiet ? (remainingDirty ? get().statusMessage : null) : 'Indexed locally',
          ...(active && sessions[active] ? sessionMirror(sessions[active]) : {}),
        })
        if (!quiet) {
          window.setTimeout(() => {
            if (get().statusMessage === 'Indexed locally') set({ statusMessage: null })
          }, 1800)
        }
      } catch (e) {
        set({
          saving: false,
          statusMessage: e instanceof Error ? e.message : 'Save failed',
        })
      }
    }
    const next = saveQueue.then(run, run)
    saveQueue = next.catch(() => {})
    await next
  },

  toggleMine: (open) => {
    const next = typeof open === 'boolean' ? open : !get().mineOpen
    if (next && get().dirty) void get().flushSave()
    set({ mineOpen: next })
  },

  setSearchCategory: (categoryId) => set({ searchCategoryId: categoryId }),

  askMine: async (query, world) => {
    const q = query.trim()
    if (!q && !world) return
    const turnId = `t_${Date.now()}`
    const categoryId = get().searchCategoryId
    const history: ChatHistoryTurn[] = get()
      .chat.filter((t) => t.result)
      .slice(-4)
      .map((t) => {
        const sources = t.result!.answer.sources.map((s) => ({
          noteId: s.noteId,
          noteTitle: s.noteTitle,
          snippet: s.snippet,
          categoryName: s.categoryName,
        }))
        if (!sources.length) {
          for (const node of t.result!.nodes) {
            if (node.kind !== 'note' || sources.some((s) => s.noteId === node.noteId)) continue
            sources.push({
              noteId: node.noteId,
              noteTitle: node.noteTitle || node.label,
              snippet: node.content,
              categoryName: node.categoryName,
            })
          }
        }
        return {
          query: t.query,
          answer: t.result!.answer.text,
          bullets: t.result!.answer.bullets,
          sources,
          discourse: t.result!.discourse || null,
        }
      })
    set((s) => ({
      searching: true,
      searchProgress: {
        status: 'Looking through your notes…',
        notes: [],
        nodes: [
          {
            id: 'query',
            label: q.length > 48 ? `${q.slice(0, 47)}…` : q,
            type: 'query',
            noteId: '',
            noteTitle: '',
            content: q,
            score: 1,
            kind: 'query',
          },
        ],
        edges: [],
      },
      mineOpen: true,
      chat: [
        ...s.chat,
        { id: turnId, query: q, world: world || null, result: null, createdAt: new Date().toISOString() },
      ],
    }))
    try {
      const result = await api.searchStream(
        q,
        categoryId,
        history,
        (event) => {
        set((s) => {
          const prev = s.searchProgress || {
            status: 'Looking through your notes…',
            notes: [],
            nodes: [],
            edges: [],
          }
          if (event.type === 'status') {
            return { searchProgress: { ...prev, status: event.message } }
          }
          if (event.type === 'note') {
            if (prev.notes.some((n) => n.noteId === event.note.noteId)) return s
            return { searchProgress: { ...prev, notes: [...prev.notes, event.note] } }
          }
          if (event.type === 'graph') {
            return { searchProgress: { ...prev, nodes: event.nodes, edges: event.edges } }
          }
          return s
        })
      },
        world,
      )
      set((s) => ({
        searching: false,
        searchProgress: null,
        activeResult: result,
        chat: s.chat.map((t) => (t.id === turnId ? { ...t, result } : t)),
      }))
    } catch (e) {
      set((s) => ({
        searching: false,
        searchProgress: null,
        chat: s.chat.map((t) =>
          t.id === turnId
            ? { ...t, error: e instanceof Error ? e.message : 'Search failed' }
            : t,
        ),
      }))
    }
  },

  clearMineChat: () => set({ chat: [], activeResult: null, searchProgress: null }),

  confirmEntityProposal: async (turnId, proposalId, entityNoteId) => {
    const turn = get().chat.find((t) => t.id === turnId)
    const proposal = turn?.result?.proposals?.find((p) => p.id === proposalId)
    if (!proposal) return
    try {
      const result = await api.confirmMention({
        mentionId: proposal.id,
        sourceNoteId: proposal.sourceNoteId,
        surface: proposal.surface,
        entityNoteId,
      })
      set((s) => ({
        chat: s.chat.map((t) => {
          if (t.id !== turnId || !t.result?.proposals) return t
          return {
            ...t,
            result: {
              ...t.result,
              proposals: t.result.proposals.filter(
                (p) =>
                  p.id !== proposalId &&
                  !(p.sourceNoteId === proposal.sourceNoteId && p.surface === proposal.surface),
              ),
            },
          }
        }),
        activeResult:
          s.activeResult && s.chat[s.chat.length - 1]?.id === turnId
            ? {
                ...s.activeResult,
                proposals: (s.activeResult.proposals || []).filter(
                  (p) =>
                    p.id !== proposalId &&
                    !(p.sourceNoteId === proposal.sourceNoteId && p.surface === proposal.surface),
                ),
              }
            : s.activeResult,
      }))
      await refreshLibrary()
      if (result.noteId) await get().selectNote(result.noteId)
    } catch (e) {
      console.error(e)
    }
  },

  dismissEntityProposal: async (turnId, proposalId) => {
    try {
      await api.dismissMention(proposalId)
    } catch {
      /* still remove from UI */
    }
    set((s) => ({
      chat: s.chat.map((t) => {
        if (t.id !== turnId || !t.result?.proposals) return t
        return {
          ...t,
          result: {
            ...t.result,
            proposals: t.result.proposals.filter((p) => p.id !== proposalId),
          },
        }
      }),
      activeResult:
        s.activeResult?.proposals
          ? {
              ...s.activeResult,
              proposals: s.activeResult.proposals.filter((p) => p.id !== proposalId),
            }
          : s.activeResult,
    }))
  },

  openNoteFromGraph: async (noteId) => {
    if (!noteId) return
    await get().selectNote(noteId)
  },

  createCategory: async (input) => {
    const category = await api.createCategory(input || { name: 'New category' })
    await refreshLibrary()
    return category
  },

  updateCategory: async (id, input) => {
    await api.updateCategory(id, input)
    await refreshLibrary()
  },

  deleteCategory: async (id) => {
    await api.deleteCategory(id)
    const { draftCategoryId, activeNoteId, settingsCategoryId } = get()
    await refreshLibrary()
    if (draftCategoryId === id) {
      set({ draftCategoryId: null })
      if (activeNoteId) await get().selectNote(activeNoteId)
    }
    if (settingsCategoryId === id) set({ settingsCategoryId: 'new' })
  },

  createFolder: async (input) => {
    const folder = await api.createFolder(input || { name: 'Untitled folder' })
    await refreshLibrary()
    return folder
  },

  updateFolder: async (id, input) => {
    await api.updateFolder(id, input)
    await refreshLibrary()
  },

  deleteFolder: async (id) => {
    await api.deleteFolder(id)
    if (get().draftFolderId === id) set({ draftFolderId: null })
    await refreshLibrary()
  },

  moveFolder: async (id, parentId) => {
    await api.updateFolder(id, { parentId })
    await refreshLibrary()
  },

  openSettings: (categoryId, section) => {
    if (get().dirty) void get().flushSave()
    set({
      settingsOpen: true,
      settingsCategoryId: categoryId === undefined ? get().settingsCategoryId : categoryId,
      settingsSection: section ?? (categoryId ? 'categories' : get().settingsSection),
    })
  },

  closeSettings: () => set({ settingsOpen: false }),

  setSettingsSection: (section) => set({ settingsSection: section }),

  saveWorkspaceSettings: async (input) => {
    const workspaceSettings = await api.updateSettings(input)
    await refreshLibrary()
    set({ workspaceSettings })
  },

  loadStorageSettings: async () => {
    const storageSettings = await api.getStorage()
    set({ storageSettings })
    if (storageSettings.gitEnabled) await get().refreshGitStatus()
  },

  saveStorageSettings: async (input) => {
    const result = await api.updateStorage(input)
    set({
      storageSettings: {
        notesDir: result.notesDir,
        dbPath: result.dbPath,
        defaultNotesDir: result.defaultNotesDir,
        gitEnabled: result.gitEnabled,
        configPath: result.configPath || get().storageSettings?.configPath || '',
      },
    })
    if (result.reopened) await get().load()
    else await refreshLibrary()
    if (result.gitEnabled) await get().refreshGitStatus()
    else set({ gitStatus: null })
  },

  refreshGitStatus: async () => {
    try {
      const gitStatus = await api.getGitStatus()
      set({ gitStatus })
    } catch {
      set({ gitStatus: null })
    }
  },

  initGitRepo: async () => {
    await api.updateStorage({ gitEnabled: true })
    const gitStatus = await api.initGit()
    const storageSettings = await api.getStorage()
    set({ gitStatus, storageSettings })
  },

  syncGitRepo: async (message) => {
    await get().flushSave()
    const result = await api.syncGit(message)
    set({ gitStatus: result.status })
    if (result.ok) await refreshLibrary()
    return { ok: result.ok, message: result.message }
  },

  toggleAgents: (open) =>
    set((s) => ({ agentsOpen: typeof open === 'boolean' ? open : !s.agentsOpen })),

  draftCategory: (input) => api.draftCategory(input),

  startCategoryBuild: ({ categoryId, form, lockedKeys }) => {
    const view: AgentView = { kind: 'settings', section: 'categories', categoryId }
    removeAgents(
      (agent) =>
        agent.kind === 'category-build' &&
        agent.view.kind === 'settings' &&
        agent.view.categoryId === categoryId,
    )
    const id = `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const name = form.name.trim() || 'category'
    const agent: Agent = {
      id,
      kind: 'category-build',
      title: `Build ${name}`,
      status: 'running',
      progress: 0.04,
      message: 'Starting build…',
      view,
      unread: false,
      error: null,
      draft: form,
      lockedKeys: lockedKeys || [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    set((s) => ({ agents: [agent, ...s.agents], agentsOpen: true }))

    const abort = new AbortController()
    agentControllers.set(id, abort)

    void (async () => {
      try {
        await api.draftCategoryStream(
          { name: form.name.trim(), prompt: form.description },
          (event) => {
            if (abort.signal.aborted) return
            set((s) => ({
              agents: s.agents.map((current) => {
                if (current.id !== id) return current
                const locked = new Set(current.lockedKeys || [])
                return {
                  ...current,
                  message: event.status || current.message,
                  progress: typeof event.progress === 'number' ? event.progress : current.progress,
                  draft: event.draft
                    ? applyCategoryDraft(current.draft || form, event.draft, locked)
                    : current.draft,
                  error: event.type === 'error' ? event.error || 'Build failed' : current.error,
                  updatedAt: nowIso(),
                }
              }),
            }))
          },
          abort.signal,
        )
        if (abort.signal.aborted) return
        set((s) => ({
          agents: s.agents.map((current) => {
            if (current.id !== id) return current
            const failed = Boolean(current.error)
            return {
              ...current,
              status: failed ? 'error' : 'done',
              unread: true,
              progress: failed ? current.progress : 1,
              message: failed ? current.message || 'Build failed.' : current.message || 'Category ready.',
              updatedAt: nowIso(),
            }
          }),
        }))
      } catch (e) {
        if (abort.signal.aborted || isAbortError(e)) return
        set((s) => ({
          agents: s.agents.map((current) =>
            current.id !== id
              ? current
              : {
                  ...current,
                  status: 'error',
                  unread: true,
                  error: e instanceof Error ? e.message : 'Build failed',
                  message: 'Build failed.',
                  updatedAt: nowIso(),
                },
          ),
        }))
      } finally {
        agentControllers.delete(id)
      }
    })()

    return id
  },

  startCategorize: ({ noteId, title, content }) => {
    const view: AgentView = { kind: 'note', noteId }
    removeAgents(
      (agent) =>
        agent.kind === 'categorize' && agent.view.kind === 'note' && agent.view.noteId === noteId,
    )
    const id = `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const name = title.trim() || 'Untitled'
    const agent: Agent = {
      id,
      kind: 'categorize',
      title: `Categorize ${name}`,
      status: 'running',
      progress: 0.12,
      message: 'Matching this page…',
      view,
      unread: false,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    set((s) => ({ agents: [agent, ...s.agents], agentsOpen: true }))

    const abort = new AbortController()
    agentControllers.set(id, abort)

    void (async () => {
      try {
        const result = await api.categorize({ title, content }, abort.signal)
        if (abort.signal.aborted) return
        if (result.match) {
          await applyNoteCategory(noteId, result.match.id)
          if (abort.signal.aborted) return
          set((s) => ({
            agents: s.agents.map((current) =>
              current.id !== id
                ? current
                : {
                    ...current,
                    status: 'done',
                    unread: true,
                    progress: 1,
                    matchName: result.match!.name,
                    message: `Linked to ${result.match!.name}.`,
                    updatedAt: nowIso(),
                  },
            ),
          }))
          return
        }
        if (result.suggestion) {
          set((s) => ({
            agents: s.agents.map((current) =>
              current.id !== id
                ? current
                : {
                    ...current,
                    status: 'needs_response',
                    unread: true,
                    progress: 1,
                    suggestion: result.suggestion,
                    message: 'No existing category is a good fit.',
                    updatedAt: nowIso(),
                  },
            ),
          }))
          return
        }
        set((s) => ({
          agents: s.agents.map((current) =>
            current.id !== id
              ? current
              : {
                  ...current,
                  status: 'error',
                  unread: true,
                  message: 'Could not categorize this page.',
                  error: 'Could not categorize this page.',
                  updatedAt: nowIso(),
                },
          ),
        }))
      } catch (e) {
        if (abort.signal.aborted || isAbortError(e)) return
        set((s) => ({
          agents: s.agents.map((current) =>
            current.id !== id
              ? current
              : {
                  ...current,
                  status: 'error',
                  unread: true,
                  error: e instanceof Error ? e.message : 'Categorize failed',
                  message: e instanceof Error ? e.message : 'Categorize failed',
                  updatedAt: nowIso(),
                },
          ),
        }))
      } finally {
        agentControllers.delete(id)
      }
    })()

    return id
  },

  startNoteCreate: ({ noteAgentId, noteId, prompt, world }) => {
    const q = prompt.trim()
    if (!q) return ''
    removeAgents((agent) => agent.kind === 'note-create' && agent.noteAgentId === noteAgentId)
    const id = `ag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const snippet = q.length > 42 ? `${q.slice(0, 41)}…` : q
    const job: Agent = {
      id,
      kind: 'note-create',
      title: `Write ${snippet}`,
      status: 'running',
      progress: 0.12,
      message: 'Composing Mine Objects…',
      streamText: '',
      view: { kind: 'note', noteId, noteAgentId },
      noteAgentId,
      unread: false,
      error: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    set((s) => ({ agents: [job, ...s.agents], agentsOpen: true, focusInlineAgentId: null }))

    const abort = new AbortController()
    agentControllers.set(id, abort)

    void (async () => {
      try {
        const result = await api.createFromAgentStream(
          noteAgentId,
          q,
          get().draftTitle,
          world,
          (event) => {
            if (abort.signal.aborted) return
            set((s) => ({
              agents: s.agents.map((current) =>
                current.id !== id
                  ? current
                  : {
                      ...current,
                      progress: event.progress ?? current.progress,
                      message: event.status || current.message,
                      streamText:
                        event.text != null
                          ? event.text
                          : event.type === 'done'
                            ? null
                            : current.streamText,
                      updatedAt: nowIso(),
                    },
              ),
            }))
          },
          abort.signal,
        )
        if (abort.signal.aborted) return
        set((s) => ({
          agents: s.agents.map((current) =>
            current.id !== id
              ? current
              : {
                  ...current,
                  progress: 0.82,
                  message: 'Placing objects in the note…',
                  streamText: null,
                  updatedAt: nowIso(),
                },
          ),
        }))
        const state = get()
        const session = state.noteSessions[noteId]
        let title = session?.title ?? state.draftTitle
        let content = session?.content ?? state.draftContent
        let categoryId = session?.categoryId ?? state.draftCategoryId
        if (!session && state.activeNoteId !== noteId) {
          const note = await api.getNote(noteId)
          if (abort.signal.aborted) return
          title = note.title
          content = note.content
          categoryId = note.categoryId
        }
        const next = replaceAgentRegion(content, noteAgentId, result.output)
        await api.updateNote(noteId, { title, content: next, categoryId })
        if (abort.signal.aborted) return
        await refreshLibrary()
        if (get().noteSessions[noteId]) {
          if (get().activeNoteId === noteId) {
            checkpointNoteHistory()
            pushNoteHistory(currentSnapshot(get()))
          }
          writeSession(noteId, { content: next, dirty: false })
        } else if (get().activeNoteId === noteId) {
          checkpointNoteHistory()
          pushNoteHistory(currentSnapshot(get()))
          set({ draftContent: next, dirty: false })
        }
        set((s) => ({
          agents: s.agents.map((current) =>
            current.id !== id
              ? current
              : {
                  ...current,
                  status: 'done',
                  unread: true,
                  progress: 1,
                  message: 'Mine Objects added to the note.',
                  streamText: null,
                  updatedAt: nowIso(),
                },
          ),
        }))
      } catch (e) {
        if (abort.signal.aborted || isAbortError(e)) return
        set((s) => ({
          agents: s.agents.map((current) =>
            current.id !== id
              ? current
              : {
                  ...current,
                  status: 'error',
                  unread: true,
                  error: e instanceof Error ? e.message : 'Create failed',
                  message: e instanceof Error ? e.message : 'Create failed',
                  streamText: null,
                  updatedAt: nowIso(),
                },
          ),
        }))
      } finally {
        agentControllers.delete(id)
      }
    })()

    return id
  },

  setFocusInlineAgentId: (id) => set({ focusInlineAgentId: id }),

  openAgent: async (id) => {
    const agent = get().agents.find((item) => item.id === id)
    if (!agent) return
    set((s) => ({
      agents: s.agents.map((item) => (item.id === id ? { ...item, unread: false } : item)),
      agentsOpen: true,
    }))
    if (agent.view.kind === 'settings') {
      get().openSettings(agent.view.categoryId, 'categories')
      return
    }
    get().closeSettings()
    await get().selectNote(agent.view.noteId)
    if (agent.kind === 'note-create' && agent.noteAgentId) {
      set({ focusInlineAgentId: agent.noteAgentId })
    }
  },

  dismissAgent: (id) => {
    abortController(id)
    set((s) => ({ agents: s.agents.filter((agent) => agent.id !== id) }))
  },

  confirmAgent: async (id) => {
    if (confirmingAgents.has(id)) return
    const agent = get().agents.find((item) => item.id === id)
    if (!agent || agent.status !== 'done') return
    if (agent.kind !== 'category-build') {
      get().dismissAgent(id)
      return
    }
    const draft = agent.draft
    if (!draft?.name.trim()) {
      set((s) => ({
        agents: s.agents.map((item) =>
          item.id !== id
            ? item
            : {
                ...item,
                status: 'error',
                unread: true,
                error: 'Name is required',
                message: 'Name is required',
                updatedAt: nowIso(),
              },
        ),
      }))
      return
    }
    confirmingAgents.add(id)
    try {
      const categoryId = agent.view.kind === 'settings' ? agent.view.categoryId : 'new'
      if (categoryId && categoryId !== 'new') {
        await get().updateCategory(categoryId, draft)
      } else {
        const created = await get().createCategory(draft)
        if (get().settingsOpen && (get().settingsCategoryId === 'new' || !get().settingsCategoryId)) {
          set({ settingsCategoryId: created.id, settingsSection: 'categories' })
        }
      }
      get().dismissAgent(id)
    } catch (e) {
      set((s) => ({
        agents: s.agents.map((item) =>
          item.id !== id
            ? item
            : {
                ...item,
                status: 'error',
                unread: true,
                error: e instanceof Error ? e.message : 'Save failed',
                message: e instanceof Error ? e.message : 'Save failed',
                updatedAt: nowIso(),
              },
        ),
      }))
    } finally {
      confirmingAgents.delete(id)
    }
  },

  resolveCategorize: async (id, action) => {
    const agent = get().agents.find((item) => item.id === id)
    if (!agent || agent.view.kind !== 'note') return
    if (action === 'dismiss') {
      get().dismissAgent(id)
      return
    }
    if (!agent.suggestion) return
    try {
      const created = await get().createCategory(agent.suggestion)
      await applyNoteCategory(agent.view.noteId, created.id)
      set((s) => ({
        agents: s.agents.map((item) =>
          item.id !== id
            ? item
            : {
                ...item,
                status: 'done',
                unread: true,
                suggestion: null,
                matchName: created.name,
                message: `Created ${created.name} and linked this page.`,
                updatedAt: nowIso(),
              },
        ),
      }))
    } catch (e) {
      set((s) => ({
        agents: s.agents.map((item) =>
          item.id !== id
            ? item
            : {
                ...item,
                status: 'error',
                unread: true,
                error: e instanceof Error ? e.message : 'Could not create category',
                message: e instanceof Error ? e.message : 'Could not create category',
                updatedAt: nowIso(),
              },
        ),
      }))
    }
  },

  patchAgentDraft: (id, form, lockedKeys) => {
    set((s) => ({
      agents: s.agents.map((agent) =>
        agent.id !== id
          ? agent
          : {
              ...agent,
              draft: form,
              lockedKeys,
              title:
                agent.kind === 'category-build'
                  ? `Build ${form.name.trim() || 'category'}`
                  : agent.title,
              updatedAt: nowIso(),
            },
      ),
    }))
  },

  retargetAgentView: (id, view) => {
    set((s) => ({
      agents: s.agents.map((agent) =>
        agent.id !== id ? agent : { ...agent, view, updatedAt: nowIso() },
      ),
    }))
  },

  toggleReminders: (open) => {
    const next = typeof open === 'boolean' ? open : !get().remindersOpen
    if (next && get().dirty) void get().flushSave()
    set({ remindersOpen: next })
  },

  setRemindersView: (view) => set({ remindersView: view }),

  loadReminders: async () => {
    try {
      const reminders = await api.listReminders()
      set({ reminders })
    } catch {
      /* keep current */
    }
  },

  patchReminder: async (id, input) => {
    const state = get()
    const inDraft = new RegExp(`mine:reminder:${id}(?:\\s|-->)`).test(state.draftContent)
    if (inDraft && state.activeNoteId) {
      const next = replaceReminderInContent(state.draftContent, id, input)
      if (next) {
        checkpointNoteHistory()
        pushNoteHistory(currentSnapshot(state))
        writeSession(state.activeNoteId, { content: next, dirty: true }, {
          reminders: state.reminders.map((item) =>
            item.id !== id
              ? item
              : {
                  ...item,
                  title: input.title ?? item.title,
                  dueAt: input.dueAt !== undefined ? input.dueAt : item.dueAt,
                  status: input.status ?? item.status,
                  position: input.position ?? item.position,
                  objectId: input.objectId !== undefined ? input.objectId : item.objectId,
                  objectType: input.objectType !== undefined ? input.objectType : item.objectType,
                  objectNoteId: input.objectNoteId !== undefined ? input.objectNoteId : item.objectNoteId,
                  objectLabel: input.objectLabel !== undefined ? input.objectLabel : item.objectLabel,
                  updatedAt: nowIso(),
                },
          ),
        })
        scheduleAutosave()
        return
      }
    }
    const result = await api.updateReminder(id, input)
    set((s) => ({
      reminders: s.reminders.map((item) => (item.id === id ? result.reminder : item)),
      draftContent:
        s.activeNoteId === result.noteId && !inDraft && !s.dirty ? result.content : s.draftContent,
    }))
  },

  addReminder: async (input) => {
    let noteId = get().activeNoteId
    if (!noteId) {
      const note = await get().createNote('Reminders')
      noteId = note.id
    }
    const columns = get().workspaceSettings.reminderColumns || []
    const status = firstColumnId(columns)
    const reminder = {
      id: newReminderId(),
      title: input?.title || '',
      dueAt: input?.dueAt || null,
      status,
      position: get().reminders.filter((item) => item.status === status).length,
    }
    const block = formatReminder(reminder)
    const state = get()
    const content = state.draftContent.replace(/\s+$/, '')
    const next = content ? `${content}\n\n${block}\n` : `${block}\n`
    const note = state.notes.find((item) => item.id === noteId)
    checkpointNoteHistory()
    pushNoteHistory(currentSnapshot(state))
    writeSession(noteId, { content: next, dirty: true }, {
      remindersOpen: true,
      reminders: [
        ...state.reminders,
        {
          ...reminder,
          noteId,
          noteTitle: state.draftTitle || note?.title || 'Untitled',
          updatedAt: nowIso(),
        },
      ],
    })
    scheduleAutosave()
  },

  openReminder: async (id) => {
    const reminder = get().reminders.find((item) => item.id === id)
    if (!reminder) return
    if (get().activeNoteId !== reminder.noteId) {
      await get().selectNote(reminder.noteId, { focusReminderId: id })
      return
    }
    set({ remindersOpen: false, focusReminderId: id })
  },

  setFocusReminderId: (id) => set({ focusReminderId: id }),

  openMineObject: async (noteId, objectId) => {
    if (!noteId || get().activeNoteId === noteId) {
      set({ remindersOpen: false, focusMineObjectId: objectId })
      return
    }
    await get().selectNote(noteId, { focusMineObjectId: objectId })
  },

  setFocusMineObjectId: (id) => set({ focusMineObjectId: id }),

  rememberMineObject: (record) => {
    set((s) => ({ mineObjects: { ...s.mineObjects, [record.id]: record } }))
  },

  propagateMineObjectUpdate: (srcId, sourceMarkdown, opts) => {
    const source = unwrapEmbed(sourceMarkdown)
    const fence = parseMineFence(source)
    const inner = fence ? innerMineMarkdown(source) : source
    const type = fence?.type && fence.type !== 'embed' ? fence.type : 'paragraph'
    const noteId = opts?.noteId || get().activeNoteId || ''
    const record: MineObjectRecord = {
      id: srcId,
      type,
      noteId,
      noteTitle:
        (noteId && get().noteSessions[noteId]?.title) ||
        get().draftTitle ||
        get().notes.find((n) => n.id === noteId)?.title ||
        '',
      inner,
      markdown: fence ? source : formatMineBlock(type, srcId, inner),
    }

    const sessions = { ...get().noteSessions }
    let touched = false
    for (const [id, session] of Object.entries(sessions)) {
      if (!session.content.includes(srcId)) continue
      const next = applyCanonicalObjectUpdate(session.content, srcId, record.markdown)
      if (next === session.content) continue
      const structured = sessionFromContent(next, {
        docVersion: Math.max(session.docVersion, DOC_VERSION),
      })
      sessions[id] = { ...session, ...structured, dirty: true }
      touched = true
    }

    const activeId = get().activeNoteId
    set({
      mineObjects: { ...get().mineObjects, [srcId]: record },
      noteSessions: sessions,
      dirty: anyDirty(sessions),
      ...(activeId && sessions[activeId] ? sessionMirror(sessions[activeId]) : {}),
    })
    if (touched) scheduleAutosave()

    window.clearTimeout((propagateTimers[srcId] as number) || 0)
    propagateTimers[srcId] = window.setTimeout(() => {
      void get().saveMineObject(srcId, inner, noteId || undefined)
    }, 400)
  },

  loadMineObject: async (id, noteId) => {
    const state = get()
    const local = findCanonicalMineObject(state.draftContent, id)
    if (local && state.activeNoteId) {
      const record: MineObjectRecord = {
        id: local.fence.id,
        type: local.fence.type,
        noteId: state.activeNoteId,
        noteTitle: state.draftTitle,
        inner: local.inner,
        markdown: local.block,
      }
      set((s) => ({ mineObjects: { ...s.mineObjects, [id]: record } }))
      return record
    }
    const cached = state.mineObjects[id]
    if (cached && (!noteId || cached.noteId === noteId)) return cached
    try {
      const record = await api.getMineObject(id, noteId)
      set((s) => ({ mineObjects: { ...s.mineObjects, [id]: record } }))
      return record
    } catch {
      return get().mineObjects[id] || null
    }
  },

  saveMineObject: async (id, inner, noteId) => {
    const state = get()
    const preferred =
      (noteId && state.noteSessions[noteId]
        ? noteId
        : Object.keys(state.noteSessions).find((nid) =>
            Boolean(findCanonicalMineObject(state.noteSessions[nid]?.content || '', id)),
          )) ||
      state.activeNoteId ||
      noteId

    if (preferred && state.noteSessions[preferred]) {
      const session = state.noteSessions[preferred]
      const local = findCanonicalMineObject(session.content, id)
      if (local) {
        const markdown = formatMineBlock(
          local.fence.type,
          local.fence.id,
          inner,
          local.fence.agentId,
          local.fence.attrs,
        )
        const sessions = { ...state.noteSessions }
        let touched = false
        for (const [nid, sess] of Object.entries(sessions)) {
          if (!sess.content.includes(id)) continue
          const next = applyCanonicalObjectUpdate(sess.content, id, markdown)
          if (next === sess.content) continue
          sessions[nid] = {
            ...sess,
            ...sessionFromContent(next, { docVersion: Math.max(sess.docVersion, DOC_VERSION) }),
            dirty: true,
          }
          touched = true
        }
        const record: MineObjectRecord = {
          id,
          type: local.fence.type,
          noteId: preferred,
          noteTitle: sessions[preferred]?.title || state.draftTitle,
          inner,
          markdown,
        }
        const activeId = state.activeNoteId
        set({
          mineObjects: { ...state.mineObjects, [id]: record },
          noteSessions: sessions,
          dirty: anyDirty(sessions),
          ...(activeId && sessions[activeId] ? sessionMirror(sessions[activeId]) : {}),
        })
        if (touched) scheduleAutosave()
        return record
      }
    }
    try {
      const record = await api.updateMineObject(id, { inner, noteId: preferred || noteId })
      set((s) => ({ mineObjects: { ...s.mineObjects, [id]: record } }))
      return record
    } catch {
      return null
    }
  },

  syncReminderLocal: (reminder) => {
    set((s) => {
      const exists = s.reminders.some((item) => item.id === reminder.id)
      return {
        reminders: exists
          ? s.reminders.map((item) => (item.id === reminder.id ? { ...item, ...reminder } : item))
          : [...s.reminders, reminder],
      }
    })
  },
  }
})

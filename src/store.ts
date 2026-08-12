import { create } from 'zustand'
import { api } from './api'
import type { ChatTurn, Health, Note, SearchResult } from './types'

type AppState = {
  notes: Note[]
  activeNoteId: string | null
  draftTitle: string
  draftContent: string
  dirty: boolean
  saving: boolean
  loading: boolean
  mineOpen: boolean
  health: Health | null
  chat: ChatTurn[]
  activeResult: SearchResult | null
  searching: boolean
  statusMessage: string | null
  load: () => Promise<void>
  selectNote: (id: string) => Promise<void>
  createNote: (title?: string) => Promise<void>
  deleteActive: () => Promise<void>
  setTitle: (title: string) => void
  setContent: (content: string) => void
  save: () => Promise<void>
  toggleMine: (open?: boolean) => void
  askMine: (query: string) => Promise<void>
  openNoteFromGraph: (noteId: string) => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  notes: [],
  activeNoteId: null,
  draftTitle: '',
  draftContent: '',
  dirty: false,
  saving: false,
  loading: true,
  mineOpen: false,
  health: null,
  chat: [],
  activeResult: null,
  searching: false,
  statusMessage: null,

  load: async () => {
    set({ loading: true })
    try {
      const [notes, health] = await Promise.all([api.listNotes(), api.health()])
      set({ notes, health, loading: false })
      if (notes.length && !get().activeNoteId) {
        await get().selectNote(notes[0].id)
      }
    } catch (e) {
      set({
        loading: false,
        statusMessage: e instanceof Error ? e.message : 'Failed to load',
      })
    }
  },

  selectNote: async (id) => {
    const note = await api.getNote(id)
    set({
      activeNoteId: note.id,
      draftTitle: note.title,
      draftContent: note.content,
      dirty: false,
      statusMessage: null,
    })
  },

  createNote: async (title) => {
    const resolved = (title || 'Untitled').trim() || 'Untitled'
    const note = await api.createNote({
      title: resolved,
      content: `# ${resolved}\n\nStart writing. Use [[wiki links]], callouts, toggles, and todos.\n\n> [!NOTE]\n> Save to index components locally.\n`,
    })
    const notes = await api.listNotes()
    set({ notes })
    await get().selectNote(note.id)
  },

  deleteActive: async () => {
    const id = get().activeNoteId
    if (!id) return
    await api.deleteNote(id)
    const notes = await api.listNotes()
    set({ notes, activeNoteId: null, draftTitle: '', draftContent: '', dirty: false })
    if (notes[0]) await get().selectNote(notes[0].id)
  },

  setTitle: (title) => set({ draftTitle: title, dirty: true }),
  setContent: (content) => set({ draftContent: content, dirty: true }),

  save: async () => {
    const { activeNoteId, draftTitle, draftContent } = get()
    if (!activeNoteId) return
    set({ saving: true, statusMessage: 'Saving & embedding components…' })
    try {
      await api.updateNote(activeNoteId, { title: draftTitle, content: draftContent })
      const [notes, health] = await Promise.all([api.listNotes(), api.health()])
      set({
        notes,
        health,
        dirty: false,
        saving: false,
        statusMessage: 'Indexed locally',
      })
      window.setTimeout(() => {
        if (get().statusMessage === 'Indexed locally') set({ statusMessage: null })
      }, 1800)
    } catch (e) {
      set({
        saving: false,
        statusMessage: e instanceof Error ? e.message : 'Save failed',
      })
    }
  },

  toggleMine: (open) =>
    set((s) => ({ mineOpen: typeof open === 'boolean' ? open : !s.mineOpen })),

  askMine: async (query) => {
    const q = query.trim()
    if (!q) return
    const turnId = `t_${Date.now()}`
    set((s) => ({
      searching: true,
      mineOpen: true,
      chat: [
        ...s.chat,
        { id: turnId, query: q, result: null, createdAt: new Date().toISOString() },
      ],
    }))
    try {
      const result = await api.search(q)
      set((s) => ({
        searching: false,
        activeResult: result,
        chat: s.chat.map((t) => (t.id === turnId ? { ...t, result } : t)),
      }))
    } catch (e) {
      set((s) => ({
        searching: false,
        chat: s.chat.map((t) =>
          t.id === turnId
            ? { ...t, error: e instanceof Error ? e.message : 'Search failed' }
            : t,
        ),
      }))
    }
  },

  openNoteFromGraph: async (noteId) => {
    if (!noteId) return
    await get().selectNote(noteId)
  },
}))

import type {
  Category,
  CategoryDraft,
  CategorizeResult,
  Health,
  Note,
  Component,
  NoteAgent,
  Reminder,
  Folder,
  StorageSettings,
  GitStatus,
  GitSyncResult,
  SearchResult,
  ChatHistoryTurn,
  SearchProgressEvent,
  WorkspaceSettings,
  WorldSnapshot,
  MineObjectRecord,
} from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = await res.json()
      message = body.error || message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export type CategoryInput = {
  name?: string
  icon?: string
  color?: string
  description?: string
  embedInstruction?: string
  queryHints?: string
  template?: string
  tag?: string
}

export const api = {
  health: () => request<Health>('/api/health'),
  listNotes: () => request<Note[]>('/api/notes'),
  getNote: (id: string) => request<Note>(`/api/notes/${id}`),
  getComponents: (id: string) => request<Component[]>(`/api/notes/${id}/components`),
  createNote: (input: {
    title?: string
    content?: string
    categoryId?: string | null
    folderId?: string | null
  }) => request<Note>('/api/notes', { method: 'POST', body: JSON.stringify(input) }),
  updateNote: (
    id: string,
    input: {
      title?: string
      content?: string
      categoryId?: string | null
      folderId?: string | null
    },
    opts?: { keepalive?: boolean },
  ) =>
    request<Note>(`/api/notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
      keepalive: opts?.keepalive,
    }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  resetNotes: () =>
    request<{ ok: boolean; notes: number }>('/api/workspace/reset-notes', { method: 'POST' }),
  backfillDocs: () =>
    request<{ ok: boolean; backfilled: number }>('/api/workspace/backfill-docs', {
      method: 'POST',
    }),
  listFolders: () => request<Folder[]>('/api/folders'),
  createFolder: (input: { name?: string; color?: string; parentId?: string | null }) =>
    request<Folder>('/api/folders', { method: 'POST', body: JSON.stringify(input) }),
  updateFolder: (
    id: string,
    input: { name?: string; color?: string; parentId?: string | null; position?: number },
  ) => request<Folder>(`/api/folders/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: 'DELETE' }),
  listCategories: () => request<Category[]>('/api/categories'),
  createCategory: (input: CategoryInput) =>
    request<Category>('/api/categories', { method: 'POST', body: JSON.stringify(input) }),
  updateCategory: (id: string, input: CategoryInput) =>
    request<Category>(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteCategory: (id: string) => request<void>(`/api/categories/${id}`, { method: 'DELETE' }),
  draftCategory: (input: { name?: string; prompt?: string }) =>
    request<CategoryDraft>('/api/categories/draft', { method: 'POST', body: JSON.stringify(input) }),
  draftCategoryStream: async (
    input: { name?: string; prompt?: string },
    onEvent: (event: {
      type: 'status' | 'partial' | 'done' | 'error'
      status?: string
      progress?: number
      draft?: CategoryDraft
      error?: string
    }) => void,
    signal?: AbortSignal,
  ) => {
    const res = await fetch('/api/categories/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ ...input, stream: true }),
      signal,
    })
    if (!res.ok || !res.body) {
      let message = res.statusText
      try {
        const body = await res.json()
        message = body.error || message
      } catch {
        /* ignore */
      }
      throw new Error(message || 'Category setup failed')
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() || ''
      for (const chunk of chunks) {
        const line = chunk
          .split('\n')
          .filter((row) => row.startsWith('data:'))
          .map((row) => row.slice(5).trim())
          .join('')
        if (!line) continue
        onEvent(JSON.parse(line))
      }
    }
  },
  categorize: (input: { title: string; content: string }, signal?: AbortSignal) =>
    request<CategorizeResult>('/api/categorize', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
  search: (query: string, categoryId?: string | null, history?: ChatHistoryTurn[], world?: WorldSnapshot | null) =>
    request<SearchResult>('/api/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        categoryId: categoryId || undefined,
        history: history?.length ? history : undefined,
        world: world || undefined,
      }),
    }),
  searchStream: async (
    query: string,
    categoryId: string | null | undefined,
    history: ChatHistoryTurn[] | undefined,
    onEvent: (event: SearchProgressEvent) => void,
    world?: WorldSnapshot | null,
  ): Promise<SearchResult> => {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify({
        query,
        categoryId: categoryId || undefined,
        history: history?.length ? history : undefined,
        world: world || undefined,
        stream: true,
      }),
    })
    if (!res.ok || !res.body) {
      let message = res.statusText
      try {
        const body = await res.json()
        message = body.error || message
      } catch {
        /* ignore */
      }
      throw new Error(message || 'Search failed')
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let result: SearchResult | null = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as SearchProgressEvent
        onEvent(event)
        if (event.type === 'done') result = event.result
        if (event.type === 'error') throw new Error(event.error)
      }
    }
    if (buf.trim()) {
      const event = JSON.parse(buf) as SearchProgressEvent
      onEvent(event)
      if (event.type === 'done') result = event.result
      if (event.type === 'error') throw new Error(event.error)
    }
    if (!result) throw new Error('Search ended without a result')
    return result
  },
  retrieve: (
    query: string,
    opts?: { limit?: number; categoryId?: string | null; noteIds?: string[] },
  ) =>
    request<{
      query: string
      hits: Array<{
        chunkId: string
        noteId: string
        noteTitle: string
        content: string
        contextPath: string
        type: string
        score: number
        denseScore: number | null
        lexicalScore: number | null
        highlights: Array<{ start: number; end: number }>
      }>
    }>('/api/retrieve', {
      method: 'POST',
      body: JSON.stringify({
        query,
        limit: opts?.limit,
        categoryId: opts?.categoryId || undefined,
        noteIds: opts?.noteIds,
      }),
    }),
  confirmMention: (input: {
    mentionId?: string
    sourceNoteId: string
    surface: string
    entityNoteId: string
  }) =>
    request<{ ok: boolean; noteId: string; replaced: number; link: string }>('/api/mentions/confirm', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  dismissMention: (mentionId: string) =>
    request<{ ok: boolean }>('/api/mentions/dismiss', {
      method: 'POST',
      body: JSON.stringify({ mentionId }),
    }),
  getSettings: () => request<WorkspaceSettings>('/api/settings'),
  updateSettings: (input: Partial<WorkspaceSettings>) =>
    request<WorkspaceSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }),
  getMineObject: (id: string, noteId?: string) =>
    request<MineObjectRecord>(`/api/objects/${id}${noteId ? `?note=${encodeURIComponent(noteId)}` : ''}`),
  updateMineObject: (id: string, input: { inner: string; noteId?: string }) =>
    request<MineObjectRecord>(`/api/objects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  getStorage: () => request<StorageSettings>('/api/storage'),
  updateStorage: (input: {
    notesDir?: string
    gitEnabled?: boolean
    copyExisting?: boolean
  }) =>
    request<StorageSettings & { reopened?: boolean }>('/api/storage', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  getGitStatus: () => request<GitStatus>('/api/git/status'),
  initGit: () => request<GitStatus>('/api/git/init', { method: 'POST', body: '{}' }),
  syncGit: (message?: string) =>
    request<GitSyncResult>('/api/git/sync', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  createAgent: (noteId: string) =>
    request<NoteAgent>('/api/agents', { method: 'POST', body: JSON.stringify({ noteId }) }),
  getAgent: (id: string) => request<NoteAgent>(`/api/agents/${id}`),
  updateAgent: (
    id: string,
    input: Partial<Pick<NoteAgent, 'mode' | 'thread' | 'connections' | 'output' | 'objects'>>,
  ) => request<NoteAgent>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteAgent: (id: string) => request<void>(`/api/agents/${id}`, { method: 'DELETE' }),
  exploreAgent: (id: string, query: string, world?: WorldSnapshot | null) =>
    request<NoteAgent>(`/api/agents/${id}/explore`, {
      method: 'POST',
      body: JSON.stringify({ query, world: world || undefined }),
    }),
  createFromAgent: (id: string, prompt: string, noteTitle?: string, world?: WorldSnapshot | null) =>
    request<NoteAgent>(`/api/agents/${id}/create`, {
      method: 'POST',
      body: JSON.stringify({ prompt, noteTitle, world: world || undefined }),
    }),
  createFromAgentStream: async (
    id: string,
    prompt: string,
    noteTitle: string | undefined,
    world: WorldSnapshot | null | undefined,
    onEvent: (event: {
      type: 'status' | 'partial' | 'done' | 'error'
      status?: string
      progress?: number
      text?: string
      agent?: NoteAgent
      error?: string
    }) => void,
    signal?: AbortSignal,
  ) => {
    const res = await fetch(`/api/agents/${id}/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ prompt, noteTitle, world: world || undefined, stream: true }),
      signal,
    })
    if (!res.ok || !res.body) {
      let message = res.statusText
      try {
        const body = await res.json()
        message = body.error || message
      } catch {
        /* ignore */
      }
      throw new Error(message || 'Create failed')
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let agent: NoteAgent | null = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const chunks = buf.split('\n\n')
      buf = chunks.pop() || ''
      for (const chunk of chunks) {
        const line = chunk
          .split('\n')
          .filter((row) => row.startsWith('data:'))
          .map((row) => row.slice(5).trim())
          .join('')
        if (!line) continue
        const event = JSON.parse(line) as {
          type: 'status' | 'partial' | 'done' | 'error'
          status?: string
          progress?: number
          text?: string
          agent?: NoteAgent
          error?: string
        }
        onEvent(event)
        if (event.type === 'done' && event.agent) agent = event.agent
        if (event.type === 'error') throw new Error(event.error || 'Create failed')
      }
    }
    if (!agent) throw new Error('Create finished without a result')
    return agent
  },
  listReminders: () => request<Reminder[]>('/api/reminders'),
  createReminder: (input: { noteId: string; title?: string; dueAt?: string | null; status?: string }) =>
    request<{ reminder: Reminder; content: string }>('/api/reminders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateReminder: (
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
  ) =>
    request<{ reminder: Reminder; noteId: string; content: string }>(`/api/reminders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
}

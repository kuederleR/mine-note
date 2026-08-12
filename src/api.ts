import type { Health, Note, Component, SearchResult } from './types'

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

export const api = {
  health: () => request<Health>('/api/health'),
  listNotes: () => request<Note[]>('/api/notes'),
  getNote: (id: string) => request<Note>(`/api/notes/${id}`),
  getComponents: (id: string) => request<Component[]>(`/api/notes/${id}/components`),
  createNote: (input: { title?: string; content?: string }) =>
    request<Note>('/api/notes', { method: 'POST', body: JSON.stringify(input) }),
  updateNote: (id: string, input: { title?: string; content?: string }) =>
    request<Note>(`/api/notes/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteNote: (id: string) => request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
  search: (query: string) =>
    request<SearchResult>('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query }),
    }),
}

export type NoteSnapshot = {
  title: string
  content: string
}

const MAX_DEPTH = 150
const COALESCE_MS = 700

let past: NoteSnapshot[] = []
let future: NoteSnapshot[] = []
let lastPushAt = 0

export function resetNoteHistory() {
  past = []
  future = []
  lastPushAt = 0
}

export function canUndo() {
  return past.length > 0
}

export function canRedo() {
  return future.length > 0
}

/** Record the state *before* a draft change. Coalesces rapid typing into one step. */
export function pushNoteHistory(before: NoteSnapshot) {
  const now = Date.now()
  if (now - lastPushAt < COALESCE_MS && past.length > 0) {
    lastPushAt = now
    future = []
    return
  }
  const top = past[past.length - 1]
  if (top && top.title === before.title && top.content === before.content) {
    lastPushAt = now
    future = []
    return
  }
  past.push(before)
  if (past.length > MAX_DEPTH) past.shift()
  future = []
  lastPushAt = now
}

/** Force a checkpoint (e.g. before a structural edit) so the next change won't coalesce away. */
export function checkpointNoteHistory() {
  lastPushAt = 0
}

export function undoNoteHistory(current: NoteSnapshot): NoteSnapshot | null {
  const prev = past.pop()
  if (!prev) return null
  future.push(current)
  lastPushAt = 0
  return prev
}

export function redoNoteHistory(current: NoteSnapshot): NoteSnapshot | null {
  const next = future.pop()
  if (!next) return null
  past.push(current)
  lastPushAt = 0
  return next
}

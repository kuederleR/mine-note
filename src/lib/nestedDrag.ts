export type NestedDragState = {
  markdown: string
  previewHtml: string
  x: number
  y: number
  width: number
  height: number
  grabX: number
  grabY: number
  settling: boolean
  remove: () => void
}

let active: NestedDragState | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeNestedDrag(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getNestedDrag(): NestedDragState | null {
  return active
}

export function peekNestedDrag(): NestedDragState | null {
  return active
}

export function beginNestedDrag(state: Omit<NestedDragState, 'settling'>): void {
  active = { ...state, settling: false }
  emit()
}

export function moveNestedDrag(x: number, y: number): void {
  if (!active || active.settling) return
  active = { ...active, x, y }
  emit()
}

export function settleNestedDrag(x: number, y: number, width?: number): void {
  if (!active) return
  active = {
    ...active,
    settling: true,
    x,
    y,
    width: width ?? active.width,
  }
  emit()
}

export function takeNestedDrag(): NestedDragState | null {
  const next = active
  active = null
  emit()
  return next
}

export function clearNestedDrag(): void {
  if (!active) return
  active = null
  emit()
}
